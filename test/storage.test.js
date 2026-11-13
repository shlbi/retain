import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GOALS } from '../dist/model.js';
import { createRepository, openStore } from '../dist/storage.js';
import { StorageError, validateCall } from '../dist/validation.js';

/** Construct a call with independent order sizes and optional customer identifiers. */
function record(overrides = {}) { return {id:'record-1',day:'2026-11-05',time:'13:05',order:1793891100000,before:['internet','tv'],kept:['tv'],mobileOrders:[2,3],revision:1,...overrides}; }

/** Build a complete authenticated server response without shared mutable state. */
function state(calls = [record()], overrides = {}) { return {version:3,calls,goals:{...DEFAULT_GOALS},...overrides}; }

/** Capture injected requests while letting each scenario control the server response. */
function server(respond) {
  const requests = [];
  return {requests,async request(action,data,userId) { requests.push({action,data,userId});return respond(action,data,userId); }};
}

/** Recognize explicit validation/storage errors instead of accidental runtime exceptions. */
function unsafeState(error) { return error instanceof StorageError && ['VALIDATION','STORAGE'].includes(error.code); }

test('repositories require a nonblank authenticated account before any request',async()=>{
  for(const userId of [undefined,null,'','   ',123])assert.throws(()=>createRepository(userId),{code:'AUTH'});
  await assert.rejects(openStore(),{code:'AUTH'});
});

test('every operation remains bound to the account used when the repository opened',async()=>{
  const remote=server((action,data)=>{
    if(action==='state')return state([]);
    if(action==='save'||action==='restore')return data.call;
    if(action==='remove')return validateCall(record());
    if(action==='import')return {imported:1,skipped:0};
    return data.value;
  });
  const repository=createRepository('user-original',remote.request);
  await repository.read();await repository.saveCall(record());await repository.removeCall('record-1',1);await repository.restoreCall(record());await repository.setGoal('orders',25);await repository.importBackup(state());
  assert.deepEqual(remote.requests.map(entry=>entry.action),['state','save','remove','restore','goal','import']);
  assert.ok(remote.requests.every(entry=>entry.userId==='user-original'));
  assert.equal(remote.requests[0].data,undefined);
});

test('empty customer identifiers and multiple mobile orders are canonical on read and save',async()=>{
  const remote=server((action,data)=>action==='state'?state():data.call);
  const repository=createRepository('user-1',remote.request);
  const saved=await repository.saveCall(record({ucid:'  ',account:'  '}));
  assert.equal(saved.ucid,'');assert.equal(saved.account,'');assert.deepEqual(saved.mobileOrders,[2,3]);assert.equal(saved.sold,true);assert.equal(saved.soldLines,5);
  assert.deepEqual(remote.requests[0].data.call,saved);
  const loaded=await repository.read();
  assert.equal(loaded.calls[0].ucid,'');assert.equal(loaded.calls[0].account,'');assert.equal(loaded.calls[0].soldLines,5);
  assert.equal(Object.keys(loaded.goals).length,11);
});

test('save and deletion forward exact optimistic revisions and expose server revision updates',async()=>{
  const remote=server((action,data)=>action==='remove'?validateCall(record({revision:data.expectedRevision})):validateCall({...data.call,revision:data.expectedRevision===null?1:data.expectedRevision+1}));
  const repository=createRepository('user-1',remote.request);
  assert.equal((await repository.saveCall(record())).revision,1);
  assert.equal((await repository.saveCall(record({revision:7}),7)).revision,8);
  assert.equal((await repository.removeCall('record-1',8)).revision,8);
  assert.equal(remote.requests[0].data.expectedRevision,null);
  assert.equal(remote.requests[1].data.expectedRevision,7);
  assert.deepEqual(remote.requests[2].data,{id:'record-1',expectedRevision:8});
});

test('reading and completing a reminder preserves every account and its service changes',async()=>{
  const accounts=[
    {account:'001',before:['internet','tv'],kept:['tv'],added:['phone']},
    {account:'002',before:['mobile'],kept:['mobile'],added:[]}
  ];
  const callback={approved:true,dueAt:'2026-11-10T20:15:00.000Z',note:'Ask about voice.',status:'scheduled'};
  const original=record({account:'001',accounts,callback});
  const remote=server((action,data)=>action==='state'?state([original]):{...data.call,revision:2});
  const repository=createRepository('user-1',remote.request);
  const {calls:[loaded]}=await repository.read();
  assert.deepEqual(loaded.accounts,accounts);
  assert.deepEqual(loaded.callback,callback);
  const saved=await repository.saveCall({...loaded,callback:{...loaded.callback,status:'done'}},loaded.revision);
  assert.deepEqual(saved.callback,{...callback,status:'done'});
  assert.deepEqual(saved.accounts,accounts);
  assert.deepEqual(remote.requests[1].data.call.accounts,accounts);
  assert.equal(remote.requests[1].data.expectedRevision,1);
});

test('restore sends the deleted record including its revision and mobile order boundaries',async()=>{
  const remote=server((_action,data)=>({...data.call,revision:10}));
  const repository=createRepository('user-1',remote.request);
  const result=await repository.restoreCall(record({revision:9,mobileOrders:[12,1]}));
  assert.equal(remote.requests[0].data.call.revision,9);assert.deepEqual(remote.requests[0].data.call.mobileOrders,[12,1]);assert.equal(result.revision,10);assert.equal(result.soldLines,13);
});

test('server conflicts and account-switch errors are propagated without retries',async()=>{
  for(const code of ['CONFLICT','AUTH']){
    const rejection=new StorageError(code,'Server rejected this operation.');
    const remote=server(()=>{throw rejection;});
    const repository=createRepository('old-account',remote.request);
    await assert.rejects(repository.saveCall(record(),1),error=>error===rejection);
    assert.equal(remote.requests.length,1);assert.equal(remote.requests[0].userId,'old-account');
  }
});

test('offline requests fail explicitly without reading browser storage or returning cached records',async(t)=>{
  let browserStorageAccesses=0;
  for(const key of ['localStorage','indexedDB']){
    const previous=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{configurable:true,get(){browserStorageAccesses++;throw new Error('Browser persistence must not be used.');}});
    t.after(()=>{if(previous)Object.defineProperty(globalThis,key,previous);else delete globalThis[key];});
  }
  let online=true;
  const failure=new StorageError('NETWORK','Connection unavailable.');
  const remote=server(()=>{if(!online)throw failure;return state();});
  const repository=createRepository('user-1',remote.request);
  assert.equal((await repository.read()).calls.length,1);
  online=false;
  await assert.rejects(repository.read(),error=>error===failure);
  await assert.rejects(repository.saveCall(record()),error=>error===failure);
  assert.equal(remote.requests.length,3);assert.equal(browserStorageAccesses,0);
});

test('invalid outgoing calls and backups never reach the server',async()=>{
  const remote=server(()=>{throw new Error('Unexpected request.');});
  const repository=createRepository('user-1',remote.request);
  await assert.rejects(repository.saveCall(record({mobileOrders:[13]})),{code:'VALIDATION'});
  await assert.rejects(repository.restoreCall(record({before:[]})),{code:'VALIDATION'});
  assert.throws(()=>repository.importBackup(state([],{version:1})),{code:'VALIDATION'});
  assert.equal(remote.requests.length,0);
});

test('legacy backup imports are normalized before one atomic server request',async()=>{
  const remote=server(()=>({imported:1,skipped:2}));
  const repository=createRepository('user-1',remote.request);
  const oldRecord=record({sold:true,soldLines:12});delete oldRecord.mobileOrders;
  const goals={...DEFAULT_GOALS};delete goals.orders;
  assert.deepEqual(await repository.importBackup({version:2,calls:[oldRecord],goals}),{imported:1,skipped:2});
  const imported=remote.requests[0].data.backup;
  assert.equal(imported.version,3);assert.deepEqual(imported.calls[0].mobileOrders,[12]);assert.equal(imported.goals.orders,DEFAULT_GOALS.orders);assert.equal(remote.requests.length,1);
});

test('closing a repository rejects all operations before contacting the server',async()=>{
  const remote=server(()=>{throw new Error('Unexpected request.');});
  const repository=createRepository('user-1',remote.request);repository.close();repository.close();
  for(const operation of [()=>repository.read(),()=>repository.saveCall(record()),()=>repository.removeCall('record-1',1),()=>repository.restoreCall(record()),()=>repository.setGoal('sales',25),()=>repository.importBackup(state())])await assert.rejects(operation(),{code:'AUTH'});
  assert.equal(remote.requests.length,0);
});

test('malformed server state fails explicitly instead of silently accepting partial records',async()=>{
  const missingOrders=record();delete missingOrders.mobileOrders;
  const badStates=[null,{},state([],{version:2}),state(null),state([],{goals:{sales:20}}),state([record({day:'2026-02-31'})]),state([missingOrders]),state([record(),record()]),state([record({ucid:'UCID-A'}),record({id:'record-2',ucid:'ucid-a'})])];
  for(const result of badStates){
    const remote=server(()=>result);
    await assert.rejects(createRepository('user-1',remote.request).read(),unsafeState);
    assert.equal(remote.requests.length,1);
  }
});

test('malformed write responses are rejected even when the request succeeds',async()=>{
  const remote=server(()=>record({kept:['phone']}));
  const repository=createRepository('user-1',remote.request);
  await assert.rejects(repository.saveCall(record()),unsafeState);
  await assert.rejects(repository.removeCall('record-1',1),unsafeState);
  await assert.rejects(repository.restoreCall(record()),unsafeState);
});
