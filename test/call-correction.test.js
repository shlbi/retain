import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { correctionChanges, revisedTally } from '../dist/call-correction.js';
import { tallyForCall, metricsForDay } from '../dist/tally.js';

const day = '2025-11-06', otherDay = '2025-11-05';
const internet = {before:['internet'], kept:['internet'], added:[]};
const saved = tallyForCall(internet);
const lost = tallyForCall({...internet,kept:[]});
const withDay = delta => ({...delta,day});
const correction = (source, original, revised, options) => ({source,original,revised,destinationDay:source.day,
  destination:null,requestId:randomUUID(),...options});

test('editing one of several identical calls recalculates only its contribution', () => {
  const three = {...saved,day,calls:3,eligibleCalls:3,savedCalls:3,groups:[{...saved.groups[0],count:3}]};
  const [change] = correctionChanges(correction(three,saved,lost));
  assert.equal(change.replacement.savedCalls,2);
  assert.equal(change.replacement.calls,3);
  assert.deepEqual(change.replacement.groups.map(g=>g.count),[2,1]);
  assert.equal(metricsForDay(change.replacement)[0].rate,2/3*100);
  assert.deepEqual(three.groups[0].count,3);
  assert.throws(()=>correctionChanges(correction(three,lost,saved)));
  assert.throws(()=>correctionChanges(correction(three,saved,lost,{destinationDay:'2999-05-06'})));
});

test('multi-account edits pair washes and separate mobile service credit from sales', () => {
  const disconnect = {...internet,kept:[],added:['mobile']};
  const delta = revisedTally([{...internet,count:2},{...disconnect,count:1}],2,16);
  assert.deepEqual(delta,tallyForCall({accounts:[internet,internet,disconnect],mobileOrders:[4,12]}));
  const allWashed = revisedTally([{...internet,count:1},{...disconnect,count:1}],0,0);
  const [change] = correctionChanges(correction(withDay(delta),delta,allWashed));
  assert.equal(change.replacement.savedCalls,0);
  assert.equal(change.replacement.eligibleCalls,0);
  assert.equal(change.replacement.mobileOrders,0);
  assert.ok(change.replacement.groups.every(g=>g.washed));
});

test('moving, removing and retrying calls commits both dates together and enforces ownership', async () => {
  const db = new PGlite();
  const rpc = async (name,...args) => (await db.query('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as result',
    args.map(a=>typeof a === 'object' ? JSON.stringify(a) : a))).rows[0].result;
  try {
    await db.exec('create role anon; create role authenticated; create role service_role');
    const dir = new URL('../supabase/migrations/',import.meta.url);
    for (const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()) {
      await db.exec('begin;\n'+await readFile(new URL(file,dir),'utf8')+'\ncommit;');
    }
    const {rows:[agent,other,leader]} = await db.query(`insert into workspace_private.users(username,username_key,password_hash,role)
      values ('a','a','synthetic','agent'),('b','b','synthetic','agent'),('s','s','synthetic','supervisor') returning id`);
    await db.exec('set role service_role');
    const write = (req,actor=agent) => rpc('workspace_correct_call',actor.id,correctionChanges(req),req.requestId);
    const log = (date,outcome) => rpc('workspace_tally',agent.id,date,outcome,randomUUID());
    const state = async () => (await rpc('workspace_tally_state',agent.id)).days;
    const source = await log(day,saved);
    const move = correction(source,saved,lost,{destinationDay:otherDay});
    await assert.rejects(write(move,other),/CONFLICT/);
    await assert.rejects(write(move,leader),/FORBIDDEN/);
    const destination = await log(otherDay,saved);
    await assert.rejects(write(move),/CONFLICT/);
    assert.equal((await state()).length,2);
    move.destination = destination;
    const result = await write(move);
    assert.equal(result[0].summary,null);
    assert.equal(result[1].summary.calls,2);
    assert.equal(result[1].summary.savedCalls,1);
    assert.deepEqual(await write(move),result);
    const later = await log(otherDay,saved);
    assert.deepEqual((await write(move))[1].summary,later);
    await assert.rejects(write({...move,revised:saved}),/CONFLICT/);
    const remove = correction(later,lost,null);
    const [remaining] = await write(remove);
    assert.equal(remaining.summary.calls,2);
    assert.equal((await write(remove))[0].summary.calls,2);
    const [single] = await write(correction(remaining.summary,saved,null));
    const empty = correction(single.summary,saved,null);
    assert.deepEqual(await write(empty),[{day:otherDay,summary:null}]);
    assert.deepEqual(await state(),[]);
    const create = await log(day,saved);
    const createMove = correction(create,saved,lost,{destinationDay:otherDay});
    assert.deepEqual((await write(createMove))[1].summary,{...lost,day:otherDay});
    await db.exec('reset role; set role authenticated');
    await assert.rejects(write(createMove),/permission denied/);
  } finally { await db.close(); }
});

test('an ambiguous original selection cannot leave a single call with an impossible wash', () => {
  const first = {accounts:[internet,{before:['tv'],kept:['tv']}]};
  const second = {accounts:[{...internet,kept:[]},{before:['phone'],kept:['phone']}]};
  const a = tallyForCall(first), b = tallyForCall(second);
  const dayTotals = {...a,day,calls:2,eligibleCalls:2,savedCalls:2,groups:[...a.groups,...b.groups]};
  const mistaken = tallyForCall({accounts:[first.accounts[1],second.accounts[1]]});
  assert.throws(()=>correctionChanges(correction(dayTotals,mistaken,null)),/remaining totals/);
});
