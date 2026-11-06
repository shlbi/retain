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
  assert.equal(result.version,3);assert.equal(result.calls[0].account,'0000012345');assert.deepEqual(result.calls[0].mobileOrders,[2,3]);assert.equal(result.calls[0].soldLines,5);assert.equal(Object.keys(result.goals).length,10);
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
test('version 3 backups require explicit mobileOrders and all ten goals',()=>{
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
test('backup limits stay under server request limits and reject malformed or oversized imports',()=>{
  assert.equal(SCHEMA_VERSION,3);assert.equal(MAX_BACKUP_BYTES,3*1024*1024);assert.equal(MAX_BACKUP_CALLS,10000);
  assert.throws(()=>parseBackup('{bad'),{code:'VALIDATION'});
  assert.throws(()=>parseBackup(' '.repeat(MAX_BACKUP_BYTES+1)),{code:'VALIDATION'});
  assert.throws(()=>validateBackup(backup(Array(10001).fill(call()))),{code:'VALIDATION'});
  assert.throws(()=>validateBackup(backup([],{version:1})),{code:'VALIDATION'});
  assert.throws(()=>validateBackup(backup([],{exportedAt:'2026-02-31T00:00:00Z'})),{code:'VALIDATION'});
});
