import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GOALS } from '../dist/model.js';
import { createRepository, openStore } from '../dist/storage.js';
import { StorageError } from '../dist/validation.js';

const day = '2026-11-13', key = '7ab58825-2134-4221-89a7-1d8dbd41233d';
const group = {before:['internet','tv'],kept:['tv'],added:[],washed:false,count:1};
const delta = {calls:1,savedCalls:1,eligibleCalls:1,saleCalls:1,mobileOrders:2,mobileLines:5,groups:[group]};
const state = {version:4,goals:{...DEFAULT_GOALS},days:[{day,...delta}]};

function server(respond) {
  const requests = [];
  return {requests,async request(action,data,userId) { requests.push({action,data,userId});return respond(action,data,userId); }};
}

test('repositories require a nonblank authenticated account before any request',async()=>{
  for(const userId of [undefined,null,'','   ',123])assert.throws(()=>createRepository(userId),{code:'AUTH'});
  await assert.rejects(openStore(),{code:'AUTH'});
});

test('every aggregate read and mutation remains bound to its signed-in account',async()=>{
  const remote=server((action,data)=>action==='state'?state:action==='tally'?{day,...data.delta}:data.value);
  const repository=createRepository('user-original',remote.request);
  assert.deepEqual(await repository.read(),state);
  assert.deepEqual(await repository.tally(day,delta,key),{day,...delta});
  await repository.setGoal('orders',25);
  assert.deepEqual(remote.requests.map(entry=>entry.action),['state','tally','goal']);
  assert.ok(remote.requests.every(entry=>entry.userId==='user-original'));
});

test('invalid or identifying updates are rejected before any network transmission',async()=>{
  const remote=server(()=>{throw new Error('Unexpected request.');});
  const repository=createRepository('user-1',remote.request);
  const updates=[
    {...delta,account:'12345'}, {...delta,time:'13:01'}, {...delta,mobileOrders:0}, {...delta,savedCalls:0},
    {...delta,groups:[{...group,note:'customer callback'}]}, {...delta,groups:[{...group,washed:true}]},
    {...delta,groups:[{...group,before:['internet','internet']}]}, {...delta,groups:[{...group,count:-1}]},
    {...delta,groups:[{...group,kept:[...group.before]}, {...group,kept:[]}]},
    {...delta,groups:[{...group,added:['tv']}]}, {...delta,groups:[group,group]}, {...delta,calls:2}
  ];
  for(const update of updates)await assert.rejects(repository.tally(day,update,key),{code:'VALIDATION'});
  await assert.rejects(repository.tally('2026-02-30',delta,key),{code:'VALIDATION'});
  await assert.rejects(repository.tally(day,delta,'UCID-123'),{code:'VALIDATION'});
  assert.equal(remote.requests.length,0);
});

test('offline requests fail explicitly without reading or writing browser storage',async(t)=>{
  let browserStorageAccesses=0;
  for(const prop of ['localStorage','sessionStorage','indexedDB']){
    const previous=Object.getOwnPropertyDescriptor(globalThis,prop);
    Object.defineProperty(globalThis,prop,{configurable:true,get(){browserStorageAccesses++;throw new Error('Browser persistence must not be used.');}});
    t.after(()=>{if(previous)Object.defineProperty(globalThis,prop,previous);else delete globalThis[prop];});
  }
  const failure=new StorageError('NETWORK','Connection unavailable.');
  let online=true;
  const remote=server(()=>{if(!online)throw failure;return state;});
  const repository=createRepository('user-1',remote.request);
  await repository.read();
  online=false;
  await assert.rejects(repository.read(),error=>error===failure);
  await assert.rejects(repository.tally(day,delta,key),error=>error===failure);
  assert.equal(remote.requests.length,3);assert.equal(browserStorageAccesses,0);
});

test('closing a repository blocks all authenticated operations',async()=>{
  const remote=server(()=>{throw new Error('Unexpected request.');});
  const repository=createRepository('user-1',remote.request);repository.close();repository.close();
  for(const operation of [()=>repository.read(),()=>repository.tally(day,delta,key),()=>repository.setGoal('sales',25)])await assert.rejects(operation(),{code:'AUTH'});
  assert.equal(remote.requests.length,0);
});

test('read never accepts a legacy snapshot, invalid goals, duplicate days or unexpected fields',async()=>{
  for(const value of [
    null,{}, {version:3,calls:[],goals:DEFAULT_GOALS}, {...state,calls:[]}, {...state,goals:{overall:99}},
    {...state,days:[...state.days,...state.days]}, {...state,days:[{...state.days[0],callback:null}]}
  ]) {
    const remote=server(()=>value);
    await assert.rejects(createRepository('user-1',remote.request).read(),{code:'VALIDATION'});
  }
});

test('the update acknowledgment is a complete saved day and must match the requested date',async()=>{
  for(const response of [null,{ok:true},{...state.days[0],day:'2026-11-14'}]) {
    const remote=server(()=>response);
    await assert.rejects(createRepository('user-1',remote.request).tally(day,delta,key),{code:'STORAGE'});
  }
});

test('a caller can repeat the identical request token after an ambiguous response',async()=>{
  const remote=server((_action,data)=>{if(remote.requests.length===1)throw new StorageError('NETWORK','Connection lost');return {day:data.day,...data.delta};});
  const repo=createRepository('agent',remote.request);
  await assert.rejects(repo.tally(day,delta,key),{code:'NETWORK'});
  const result=await repo.tally(day,delta,key);
  assert.deepEqual(remote.requests[0],remote.requests[1]);assert.equal(result.calls,1);
});
