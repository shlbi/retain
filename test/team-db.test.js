import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = '20261120005722_team_roles.sql';
let db, supervisor, agent, admin, outsider, otherSupervisor;

async function rpc(name, params = []) {
  const placeholders = params.map((_,i) => '$' + (i+1)).join(',');
  return (await db.query(`select public.${name}(${placeholders}) as result`,params)).rows[0].result;
}

before(async () => {
  db=new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role;');
  const dir = new URL('../supabase/migrations/',import.meta.url);
  for (const file of (await readdir(dir)).filter(file=>file.endsWith('.sql') && file<=migration).sort()) {
    await db.exec('begin;'+await readFile(new URL(file,dir),'utf8')+'commit;');
  }
  const users=[];
  for (const name of ['lead','first','owner','outside','other']) {
    users.push((await rpc('auth_register',[name,'test hash'])).id);
  }
  [supervisor,agent,admin,outsider,otherSupervisor]=users;
  await db.query("update workspace_private.users set role='supervisor' where id in ($1,$2)",[supervisor,otherSupervisor]);
  await db.query("update workspace_private.users set role='admin' where id=$1",[admin]);
  await db.query('update workspace_private.users set supervisor_id=$1 where id in ($2,$3)',[supervisor,agent,admin]);
  await db.query('update workspace_private.users set supervisor_id=$1 where id=$2',[otherSupervisor,outsider]);
});
after(async()=>{await db?.close();});

test('only supervisors can monitor their members and assign goals in one transaction',async()=>{
  const original=await rpc('workspace_team_context',[supervisor]);
  assert.equal(original.role,'supervisor');
  assert.deepEqual(original.agents.map(m=>m.username),['first','owner']);
  assert.deepEqual(await rpc('workspace_team_context',[agent]),{role:'agent',supervisorId:supervisor,agents:[]});
  await assert.rejects(rpc('workspace_agent_state',[supervisor,outsider]),/FORBIDDEN/);
  await assert.rejects(rpc('workspace_agent_state',[agent,admin]),/FORBIDDEN/);
  const bulk=(actor,targets,goals)=>rpc('workspace_team_goals',[actor,targets,JSON.stringify(goals)]);
  assert.deepEqual(await bulk(supervisor,null,{overall:90}),{updated:2});
  assert.deepEqual(await bulk(supervisor,'{'+agent+'}',{tv:66}),{updated:1});
  await assert.rejects(bulk(agent,null,{overall:50}),/FORBIDDEN/);
  await assert.rejects(bulk(admin,null,{overall:50}),/FORBIDDEN/);
  await assert.rejects(bulk(supervisor,'{'+agent+','+outsider+'}',{overall:50}),/FORBIDDEN/);
  await assert.rejects(bulk(supervisor,'{}',{overall:50}),/VALIDATION/);
  for(const bad of [{mode:5},{tv:6.5},{tv:101},{}]) await assert.rejects(bulk(supervisor,null,bad),/VALIDATION/);
  assert.equal((await rpc('workspace_agent_state',[supervisor,agent])).goals.overall,90);
  assert.equal((await rpc('workspace_agent_state',[supervisor,agent])).goals.tv,66);
  assert.equal((await rpc('workspace_agent_state',[supervisor,admin])).goals.tv,original.agents[1].goals.tv);
  assert.equal((await db.query("select to_regprocedure('public.workspace_goal(uuid,text,integer)') as old")).rows[0].old,null);
  await assert.rejects(db.query("update workspace_private.users set role='agent' where id=$1",[supervisor]),/foreign key/);
  await assert.rejects(db.query('update workspace_private.users set supervisor_id=$1 where id=$2',[agent,outsider]),/foreign key/);
});

test('admin reports actual 28-day totals, zero-filled dates and request measurements',async()=>{
  const localToday="(now() at time zone 'America/New_York')::date";
  await db.query(`insert into workspace_private.tally_days values
    ($1,${localToday},10,8,5,1,2,5),($2,${localToday}-27,5,4,1,0,0,0),
    ($1,${localToday}-28,100,100,100,0,0,0)`,[agent,outsider]);
  const metrics = () => rpc('workspace_admin_stats',[admin]);
  assert.deepEqual((await metrics()).technical,{requests:0,errors:0,meanMs:null});
  await rpc('workspace_record_request',[false,10]);
  await rpc('workspace_record_request',[true,30]);
  const summary=await metrics();
  assert.deepEqual(summary.technical,{requests:2,errors:1,meanMs:20});
  assert.equal(summary.registered,5);
  assert.equal(summary.activeAgents,2);
  assert.deepEqual([summary.calls,summary.eligibleCalls,summary.savedCalls,summary.mobileOrders,summary.mobileLines],[15,12,6,2,5]);
  assert.equal(summary.days.length,28);
  assert.deepEqual(summary.days.slice(0,2).map(d=>d.calls),[5,0]);
  assert.equal(summary.days.at(-1).calls,10);
  assert.equal(summary.teams.find(t=>t.id===supervisor).members,2);
  assert.equal(summary.teams.find(t=>t.id===supervisor).calls,10);
  await assert.rejects(rpc('workspace_admin_stats',[agent]),/FORBIDDEN/);
  await assert.rejects(rpc('workspace_admin_stats',[supervisor]),/FORBIDDEN/);
  for (const role of ['anon','authenticated']) {
    await db.exec('set role '+role);
    try {
      await assert.rejects(metrics(),/permission denied/);
      await assert.rejects(rpc('workspace_record_request',[false,1]),/permission denied/);
      await assert.rejects(rpc('workspace_agent_state',[supervisor,agent]),/permission denied/);
    } finally { await db.exec('reset role'); }
  }
});
