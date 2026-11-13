import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GOALS } from '../dist/model.js';
import { SCHEMA_VERSION, MAX_BACKUP_BYTES, MAX_BACKUP_CALLS, validateCall, validateGoals, validDay, validateBackup, parseBackup, planImport } from '../dist/validation.js';

/** Construct independent canonical records with two separate mobile orders. */
function call(overrides={}) { return {id:'call-001',day:'2026-11-05',time:'13:05',order:1793891100000,ucid:'UCID-001',account:'0000012345',before:['internet','tv'],kept:['tv'],mobileOrders:[2,3],sold:true,soldLines:5,revision:1,...overrides}; }
/** Construct versioned backups without sharing mutable arrays or goal maps. */
function backup(calls=[call()],overrides={}) { return {version:3,calls,goals:{...DEFAULT_GOALS},...overrides}; }
/** Recreate an old single-order record without fabricating a new canonical order list. */
function legacyCall(overrides={}) { const result=call({sold:true,soldLines:4,...overrides});delete result.mobileOrders;return result; }

test('version 3 round trip preserves leading zeros and the separate order sizes',()=>{
  const result=parseBackup(JSON.stringify(backup()));
  assert.equal(result.version,3);assert.equal(result.calls[0].account,'0000012345');assert.deepEqual(result.calls[0].mobileOrders,[2,3]);assert.equal(result.calls[0].soldLines,5);assert.equal(Object.keys(result.goals).length,11);
});
test('optional missing or whitespace-only UCID and account normalize to empty strings',()=>{
  const input=call({ucid:'   ',account:'   '});const result=validateCall(input);
  assert.equal(result.ucid,'');assert.equal(result.account,'');
  delete input.ucid;delete input.account;assert.equal(validateCall(input).ucid,'');assert.equal(validateCall(input).account,'');
  assert.throws(()=>validateCall(call({account:123})),{code:'VALIDATION'});assert.throws(()=>validateCall(call({ucid:null})),{code:'VALIDATION'});
});
test('record identity, times, dates, and revisions remain strict',()=>{
  for(const overrides of [{id:''},{id:'x'.repeat(101)},{id:'A\nB'},{day:'2026-02-29'},{time:'24:00'},{order:NaN},{revision:0},{revision:1.5},{extra:'unknown'}])assert.throws(()=>validateCall(call(overrides)),{code:'VALIDATION'});
  assert.equal(validDay('2024-02-29'),true);assert.equal(validDay('1900-02-29'),false);assert.equal(validDay('2000-02-29'),true);
});
test('sales flags and line totals are derived from orders and optional redundant fields must agree',()=>{
  const input=call({mobileOrders:[12,12]});delete input.sold;delete input.soldLines;
  assert.deepEqual(validateCall(input).mobileOrders,[12,12]);assert.equal(validateCall(input).soldLines,24);assert.equal(validateCall(input).sold,true);
  input.mobileOrders=[];assert.equal(validateCall(input).sold,false);assert.equal(validateCall(input).soldLines,0);
  for(const overrides of [{sold:false},{soldLines:4},{sold:'yes'},{soldLines:'5'}])assert.throws(()=>validateCall(call(overrides)),{code:'VALIDATION'});
});
test('every order contains 1–12 lines and each call supports at most 20 orders',()=>{
  for(const mobileOrders of [[0],[13],[1.5],['2'],[NaN],Array(1),Array(21).fill(1),null])assert.throws(()=>validateCall(call({mobileOrders})),{code:'VALIDATION'});
  const result=validateCall(call({mobileOrders:Array(20).fill(12),soldLines:240}));assert.equal(result.mobileOrders.length,20);assert.equal(result.soldLines,240);
});
test('legacy zero through twelve lines convert to zero or one order without invented splits',()=>{
  assert.deepEqual(validateCall(legacyCall({sold:false,soldLines:0})).mobileOrders,[]);
  assert.deepEqual(validateCall(legacyCall({sold:true,soldLines:12})).mobileOrders,[12]);
  const booleanOnly=legacyCall();delete booleanOnly.soldLines;assert.deepEqual(validateCall(booleanOnly).mobileOrders,[1]);
  assert.throws(()=>validateCall(legacyCall({soldLines:13})),/Split it into orders of at most 12/);
});
test('version 2 backup upgrades to version 3 and defaults only the missing orders goal',()=>{
  const goals={...DEFAULT_GOALS};delete goals.orders;
  const result=validateBackup(backup([legacyCall()],{version:2,goals}));
  assert.equal(result.version,3);assert.deepEqual(result.calls[0].mobileOrders,[4]);assert.equal(result.goals.orders,DEFAULT_GOALS.orders);
  delete goals.tv;assert.throws(()=>validateGoals(goals,2),{code:'VALIDATION'});
});
test('version 3 backups require explicit orders and pre-existing targets',()=>{
  assert.throws(()=>validateBackup(backup([legacyCall()])),{code:'VALIDATION'});
  const goals={...DEFAULT_GOALS};delete goals.orders;assert.throws(()=>validateGoals(goals),{code:'VALIDATION'});
  assert.throws(()=>validateGoals({...DEFAULT_GOALS,unexpected:20}),{code:'VALIDATION'});
  assert.throws(()=>validateGoals({...DEFAULT_GOALS,sales:101}),{code:'VALIDATION'});
});
test('blank UCIDs never collide while nonempty UCIDs remain case-insensitively unique',()=>{
  const blanks=[call({id:'blank-1',ucid:''}),call({id:'blank-2',ucid:'  '})];
  assert.equal(validateBackup(backup(blanks)).calls.length,2);
  assert.throws(()=>validateBackup(backup([call(),call({id:'other',ucid:'ucid-001'})])),{code:'VALIDATION'});
  assert.throws(()=>validateBackup(backup([blanks[0],blanks[0]])),{code:'VALIDATION'});
});
test('merge skips an unchanged blank-UCID call by ID and imports other blank calls',()=>{
  const old=call({id:'blank-1',ucid:'',revision:8});
  const result=planImport([old],[call({id:'blank-1',ucid:''}),call({id:'blank-2',ucid:''})]);
  assert.equal(result.skipped,1);assert.equal(result.additions.length,1);assert.equal(result.additions[0].id,'blank-2');
});
test('canonical comparison ignores revision, service ordering, and UCID letter case',()=>{
  const result=planImport([call({revision:5})],[call({ucid:'ucid-001',before:['tv','internet'],revision:1})]);
  assert.equal(result.skipped,1);assert.equal(result.additions.length,0);
});
test('conflicting content or IDs reject the full merge without mutating original records',()=>{
  const existing=[call({ucid:''})],copy=structuredClone(existing);
  assert.throws(()=>planImport(existing,[call({id:'new',ucid:''}),call({ucid:'',mobileOrders:[5],soldLines:5})]),{code:'CONFLICT'});
  assert.deepEqual(existing,copy);
  assert.throws(()=>planImport([call()],[call({id:'other',ucid:'ucid-001'})]),{code:'CONFLICT'});
});
test('services must stay unique and kept services must have existed at the start',()=>{
  for(const overrides of [{before:[]},{before:Array(1)},{before:['tv','tv']},{before:['satellite']},{kept:Array(1)},{kept:['mobile']},{kept:['tv','tv']}])assert.throws(()=>validateCall(call(overrides)),{code:'VALIDATION'});
});

const secondAccount = {account:'00002',before:['tv','phone'],kept:[],added:['mobile']};
const approvedCallback = {dueAt:'2026-11-14T02:00:00Z',note:'Call after work.\nAsk for Pat.',approved:true,status:'scheduled'};

test('multiple accounts and approved callback survive backup validation, including leading zeros and multiline notes',()=>{
  const accounts = [
    {account:' 0000012345 ',before:['tv','internet'],kept:['tv'],added:['phone']},
    secondAccount
  ];
  const input = call({accounts,callback:approvedCallback});
  delete input.account; delete input.before; delete input.kept;
  const result = parseBackup(JSON.stringify(backup([input]))).calls[0];
  assert.equal(result.account,'0000012345');
  assert.deepEqual(result.before,['internet','tv']);
  assert.deepEqual(result.kept,['tv']);
  assert.deepEqual(result.accounts[0],{account:'0000012345',before:['internet','tv'],kept:['tv'],added:['phone']});
  assert.deepEqual(result.accounts[1],secondAccount);
  assert.deepEqual(result.callback,{...approvedCallback,dueAt:'2026-11-14T02:00:00.000Z'});
  assert.deepEqual(validateCall({...result,callback:null}).callback,null);
  assert.equal(validateCall({...result,callback:{...approvedCallback,status:'done'}}).callback.status,'done');
});

test('account validation rejects contradictory aliases, overlapping additions and invalid nested data',()=>{
  const first = {account:'0000012345',before:['internet','tv'],kept:['tv'],added:[]};
  for (const accounts of [
    [], null, [first, null], [{...first,account:'different'}],
    [{...first,before:['tv','phone']}], [{...first,kept:['internet']}],
    [first,{...secondAccount,added:['phone']}], [first,{...secondAccount,added:['mobile','mobile']}],
    [first,{...secondAccount,added:['fax']}], [first,{...secondAccount,added:null}],
    [first,{...secondAccount,extra:'unrecognized'}]
  ]) {
    assert.throws(()=>validateCall(call({accounts})),{code:'VALIDATION'});
  }
  const many = [first,...Array.from({length:100},()=>({...secondAccount,account:''}))];
  assert.equal(validateCall(call({accounts:many})).accounts.length,101);
});

test('callbacks require affirmative approval and a valid UTC calendar timestamp',()=>{
  for (const overrides of [
    {approved:false}, {approved:'yes'}, {dueAt:'2026-02-30T20:00:00Z'},
    {dueAt:'2026-11-14T02:00'}, {status:'later'}, {note:42}, {note:'x'.repeat(2001)},
    {note:'unpaired surrogate\uD800'}, {note:'null\x00byte'}
  ]) {
    assert.throws(()=>validateCall(call({callback:{...approvedCallback,...overrides}})),{code:'VALIDATION'});
  }
  assert.equal(validateCall(call({callback:{...approvedCallback,note:'💬'.repeat(2000)}})).callback.note.length,4000);
});

test('old backups inherit only the missing bundle target and merge with equivalent upgraded calls',()=>{
  const goals = {...DEFAULT_GOALS};
  delete goals.bundle;
  const legacy = call();
  assert.equal(validateBackup(backup([legacy],{goals})).goals.bundle,80);
  const explicit = {...legacy,accounts:[{account:legacy.account,before:legacy.before,kept:legacy.kept,added:[]}],callback:null};
  assert.deepEqual(planImport([legacy],[explicit]),{skipped:1,additions:[]});
  for (const changed of [
    {...explicit,accounts:[...explicit.accounts,secondAccount]},
    {...explicit,accounts:[{...explicit.accounts[0],added:['mobile']}]},
    {...explicit,callback:approvedCallback}
  ]) {
    assert.throws(()=>planImport([legacy],[changed]),{code:'CONFLICT'});
  }
});
test('backup limits stay under server request limits and reject malformed or oversized imports',()=>{
  assert.equal(SCHEMA_VERSION,3);assert.equal(MAX_BACKUP_BYTES,3*1024*1024);assert.equal(MAX_BACKUP_CALLS,10000);
  assert.throws(()=>parseBackup('{bad'),{code:'VALIDATION'});
  assert.throws(()=>parseBackup(' '.repeat(MAX_BACKUP_BYTES+1)),{code:'VALIDATION'});
  assert.throws(()=>validateBackup(backup(Array(10001).fill(call()))),{code:'VALIDATION'});
  assert.throws(()=>validateBackup(backup([],{version:1})),{code:'VALIDATION'});
  assert.throws(()=>validateBackup(backup([],{exportedAt:'2026-02-31T00:00:00Z'})),{code:'VALIDATION'});
});
