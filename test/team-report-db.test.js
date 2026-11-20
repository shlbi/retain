import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { DEFAULT_GOALS } from '../dist/model.js';
import { metricsForDay, tallyForCall } from '../dist/tally.js';
import { validateDayTotals } from '../dist/tally-validation.js';

let db, owner, supervisor, otherSupervisor, agent, adminMember;
const day = '2026-01-20', earlier = '2026-01-19';
const kept = {before:['internet'],kept:['internet']};
const lost = {before:['internet'],kept:[]};

async function rpc(name,...params) {
  const args = params.map((_,i) => '$'+(i+1)).join(',');
  return (await db.query('select public.'+name+'('+args+') as result',params)).rows[0].result;
}
async function user(name,role,leader = null) {
  const {rows:[row]} = await db.query(
    'insert into workspace_private.users(username,username_key,password_hash,role,supervisor_id) values ($1,$1,$2,$3,$4) returning id',
    [name,'synthetic',role,leader]);
  return row.id;
}
const report = leader => rpc('workspace_team_report',leader);
const tally = (member,date,call) => rpc('workspace_tally',member,date,JSON.stringify(tallyForCall(call)),randomUUID());

before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role');
  const dir = new URL('../supabase/migrations/',import.meta.url);
  for (const file of (await readdir(dir)).filter(file => file.endsWith('.sql')).sort()) {
    await db.exec('begin;\n'+await readFile(new URL(file,dir),'utf8')+'\ncommit;');
  }
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate workspace_private.users cascade');
  owner = await user('owner','admin');
  supervisor = await user('lead','supervisor');
  otherSupervisor = await user('other','supervisor');
  await rpc('workspace_admin_save_team',owner,supervisor,'One',null);
  await rpc('workspace_admin_save_team',owner,otherSupervisor,'Two',null);
  agent = await user('agent','agent',supervisor);
  adminMember = await user('helper','admin',supervisor);
});

test('team totals combine calls once and merge identical outcomes across members per day',async () => {
  const outsider = await user('outside','agent',otherSupervisor);
  await tally(agent,day,kept);
  for (let i=0;i<3;i++) await tally(agent,day,lost);
  await tally(adminMember,day,{accounts:[kept,{before:['tv','phone'],kept:['tv']}],mobileOrders:[2,4]});
  await tally(adminMember,earlier,{accounts:[kept,lost]});
  await tally(outsider,day,lost);
  await tally(supervisor,day,lost);
  const state = await report(supervisor);
  assert.deepEqual(Object.keys(state).sort(),['days','goals','memberCount','version']);
  assert.equal(state.version,4);
  assert.equal(state.memberCount,2);
  assert.deepEqual(state.goals,DEFAULT_GOALS);
  assert.deepEqual(state.days.map(d => d.day),[day,earlier]);
  const [current,wash] = state.days.map(validateDayTotals);
  assert.deepEqual([current.calls,current.eligibleCalls,current.savedCalls,current.saleCalls,current.mobileOrders,current.mobileLines],
    [5,5,2,1,2,6]);
  assert.deepEqual(current.groups.map(g => g.count).sort(),[1,2,3]);
  assert.equal(current.groups.find(g => g.before.length===1 && g.kept.length===1).count,2);
  const rates = Object.fromEntries(metricsForDay(current,state.goals).map(m => [m.key,m.rate]));
  assert.equal(rates.overall,40);
  assert.equal(rates.internet,40);
  assert.equal(rates.orders,40);
  assert.equal(rates.sales,120);
  assert.deepEqual([wash.calls,wash.eligibleCalls,wash.savedCalls],[1,0,0]);
  assert.ok(wash.groups.every(g => g.washed && g.count===1));
  assert.equal((await report(otherSupervisor)).days[0].calls,1);
});

test('goals include idle members and current assignments determine access to every report date',async () => {
  await tally(agent,earlier,kept);
  await rpc('workspace_team_goals',supervisor,null,'{"overall":90}');
  await rpc('workspace_team_goals',supervisor,'{'+adminMember+'}','{"tv":60}');
  assert.deepEqual((await report(supervisor)).goals,{...DEFAULT_GOALS,overall:90,tv:null});
  const empty = await report(otherSupervisor);
  assert.equal(empty.memberCount,0);
  assert.deepEqual(empty.days,[]);
  assert.deepEqual(empty.goals,Object.fromEntries(Object.keys(DEFAULT_GOALS).map(key => [key,null])));

  await rpc('workspace_admin_assign_account',owner,agent,'agent',otherSupervisor,'agent',supervisor);
  const source = await report(supervisor), target = await report(otherSupervisor);
  assert.equal(source.memberCount,1);
  assert.deepEqual(source.days,[]);
  assert.equal(source.goals.tv,60);
  assert.equal(target.memberCount,1);
  assert.equal(target.days[0].day,earlier);
  assert.equal(target.days[0].savedCalls,1);
  assert.equal(target.goals.tv,DEFAULT_GOALS.tv);
});

test('the report RPC is service-only and requires an active supervisor with a named team',async () => {
  const teamless = await user('no_team','supervisor');
  for (const id of [agent,adminMember,owner,teamless,randomUUID(),null]) {
    await assert.rejects(report(id),/FORBIDDEN/);
  }
  for (const role of ['anon','authenticated','service_role']) {
    const {rows:[row]} = await db.query("select has_function_privilege($1,'public.workspace_team_report(uuid)','execute') as allowed",[role]);
    assert.equal(row.allowed,role==='service_role');
  }
});
