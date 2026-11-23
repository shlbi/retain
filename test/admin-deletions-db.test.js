import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {dayKey} from '../dist/model.js';
import {tallyForCall} from '../dist/tally.js';

let db, admin, legacy;
const migrationDir = new URL('../supabase/migrations/', import.meta.url);
const sql = async (query, args=[]) => (await db.query(query,args)).rows;
const rpc = async (name, ...args) => (await sql('select public.' + name + '(' +
  args.map((_,i) => '$' + (i+1)).join(',') + ') as result',args))[0].result;
const createUser = async (username, role) => (await sql(
  'insert into workspace_private.users(username,username_key,password_hash,role) values ($1,lower($1),$2,$3) returning id',
  [username,'synthetic',role]))[0].id;
const directory = () => rpc('workspace_admin_accounts',admin);
const account = async id => (await directory()).accounts.find(person => person.id===id);
const deleteAccount = (snapshot, members=[], actor=admin) =>
  rpc('workspace_admin_delete_account',actor,snapshot.id,snapshot.username,snapshot.role,snapshot.supervisorId,
    snapshot.ownedTeamId,snapshot.ownedTeamName,'{' + members.join(',') + '}');
const deleteTeam = (owner, members=[], actor=admin) => rpc('workspace_admin_delete_team',actor,owner.id,
  owner.ownedTeamId,owner.ownedTeamName,'{' + members.join(',') + '}');
const createTeam = async (supervisor,name,ids=[]) => {
  await rpc('workspace_game_access',admin,supervisor,'bingo',true);
  await rpc('workspace_admin_save_team',admin,supervisor,name,null);
  if (ids.length) await rpc('workspace_admin_add_team_members',admin,supervisor,
    JSON.stringify(ids.map(id => ({id,expectedSupervisorId:null}))));
};
const launch = async (supervisor, hours=0) => {
  const start = Date.now() - 60000 + 3600000*hours;
  await rpc('workspace_launch_game',supervisor,JSON.stringify({title:'Game '+hours,incentive:'Coffee',pattern:'line',
    startsAt:new Date(start).toISOString(),endsAt:new Date(start+3600000).toISOString(),
    squares:Array.from({length:9},()=>({metric:'calls',target:2}))}));
};
const tally = id => rpc('workspace_tally',id,dayKey(),JSON.stringify(
  tallyForCall({before:['internet'],kept:['internet'],mobileOrders:[]})),randomUUID());
const makeSession = (id,token) => rpc('auth_create_verified_session',id,'synthetic',token,new Date(Date.now()+3600000).toISOString());
const count = async (table, key, value) => (await sql('select count(*)::int as n from workspace_private.'+table+
  ' where '+key+'=$1',[value]))[0].n;
const games = async supervisor => (await sql('select id from workspace_private.bingo_games where supervisor_id=$1 order by starts_at',[supervisor])).map(row=>row.id);

before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role');
  for (const file of (await readdir(migrationDir)).filter(f=>f.endsWith('.sql')).sort()) {
    if (file.endsWith('_grouped_tallies.sql')) {
      legacy = (await rpc('auth_register','Legacy','synthetic')).id;
      const record = {id:'archived',revision:1,day:'2025-02-08',before:['internet'],kept:['internet'],mobileOrders:[],soldLines:0};
      await sql('insert into workspace_private.calls(user_id,id,record,revision) values($1,$2,$3,1)',[legacy,record.id,JSON.stringify(record)]);
      await sql('insert into workspace_private.call_versions(user_id,id,revision) values($1,$2,1)',[legacy,record.id]);
    }
    await db.exec('begin;\n'+await readFile(new URL(file,migrationDir),'utf8')+'\ncommit;');
  }
  admin = await createUser('owner','admin');
});
after(async () => { await db?.close(); });

test('deleting a team removes its whole game history, keeps its people and personal records, and releases its name', async () => {
  const lead = await createUser('first','supervisor'), agent = await createUser('one','agent');
  const peer = await createUser('peer','agent'), keep = await createUser('keep','supervisor');
  await createTeam(lead,'Morning',[agent,peer]);
  await createTeam(keep,'Evening');
  await launch(keep);
  await launch(lead);
  await launch(lead,3);
  await tally(agent);
  await makeSession(agent,'a'.repeat(64));
  await rpc('workspace_team_goals',lead,null,'{"overall":91}');
  const personal = await rpc('workspace_tally_state',agent), gameIds = await games(lead);
  const topic = (await sql('select bingo_channel from workspace_private.users where id=$1',[lead]))[0].bingo_channel;
  assert.equal(gameIds.length,2);
  assert.deepEqual(await deleteTeam(await account(lead),[peer,agent]),{ok:true});
  for (const id of [agent,peer]) assert.equal((await account(id)).supervisorId,null);
  assert.equal((await account(lead)).role,'supervisor');
  assert.equal((await account(lead)).ownedTeamId,null);
  assert.notEqual((await sql('select bingo_channel from workspace_private.users where id=$1',[lead]))[0].bingo_channel,topic);
  assert.equal((await rpc('workspace_game_state',lead)).game,null);
  await assert.rejects(launch(lead),/TEAM_REQUIRED/);
  assert.deepEqual(await games(lead),[]);
  for (const id of gameIds) assert.equal(await count('bingo_scores','game_id',id),0);
  assert.deepEqual(await rpc('workspace_tally_state',agent),personal);
  assert.equal((await rpc('auth_session','a'.repeat(64))).id,agent);
  assert.equal((await games(keep)).length,1);
  await createTeam(lead,'Morning');
});

test('deleting an agent clears credentials, sessions, personal records and scores, including an optional frozen archive', async () => {
  const lead = await createUser('legLead','supervisor'), peer = await createUser('legPeer','agent');
  await createTeam(lead,'Archive test',[peer,legacy]);
  await launch(lead);
  await tally(legacy);
  await tally(peer);
  await makeSession(legacy,'b'.repeat(64));
  await assert.rejects(sql('delete from workspace_private.calls where user_id=$1',[legacy]),/CONFLICT/);
  await assert.rejects(sql('update workspace_private.calls set id=id where user_id=$1',[legacy]),/CONFLICT/);
  const tables = ['sessions','tally_days','tally_groups','tally_receipts','bingo_scores','calls','call_versions'];
  for (const table of tables) assert.ok(await count(table,'user_id',legacy)>0,table);
  const kept = await rpc('workspace_tally_state',peer);
  const snapshot = await account(legacy);
  assert.deepEqual(await deleteAccount(snapshot),{ok:true});
  for (const table of tables) assert.equal(await count(table,'user_id',legacy),0,table);
  assert.equal(await rpc('auth_get_user','Legacy'),null);
  assert.equal(await rpc('auth_session','b'.repeat(64)),null);
  assert.equal((await games(lead)).length,1);
  assert.deepEqual(await rpc('workspace_tally_state',peer),kept);
  assert.deepEqual(await rpc('auth_request_signup','Legacy','new-hash','agent'),{status:'pending'});
  await assert.rejects(deleteAccount(snapshot),/CONFLICT/);
});

test('an account deletion can include its active or dormant team, including when the target now belongs to another team', async () => {
  const active = await createUser('active','supervisor'), member = await createUser('member','agent');
  await createTeam(active,'Active team',[member]);
  await launch(active);
  await tally(member);
  const memberData = await rpc('workspace_tally_state',member);
  await deleteAccount(await account(active),[member]);
  assert.equal(await account(active),undefined);
  assert.equal((await account(member)).supervisorId,null);
  assert.deepEqual(await rpc('workspace_tally_state',member),memberData);
  assert.equal((await games(active)).length,0);

  const former = await createUser('former','supervisor'), other = await createUser('other','supervisor');
  await createTeam(former,'Dormant team');
  await launch(former);
  await createTeam(other,'Member team');
  await launch(other);
  await rpc('workspace_admin_assign_account',admin,former,'agent',other,'supervisor',null);
  await tally(former);
  const snapshot = await account(former);
  assert.equal(snapshot.ownedTeamName,'Dormant team');
  assert.equal((await directory()).teams.some(t => t.id===snapshot.ownedTeamId),false);
  assert.deepEqual(await deleteAccount(snapshot),{ok:true});
  assert.deepEqual(await games(former),[]);
  assert.equal((await games(other)).length,1);
  const empty = await createUser('empty','supervisor');
  await deleteAccount(await account(empty));
  assert.equal(await account(empty),undefined);
});

test('stale snapshots roll back both deletes, even after recreation with the same supervisor, name and members', async () => {
  const lead = await createUser('sLead','supervisor'), replacement = await createUser('sNew','supervisor');
  const person = await createUser('sAgent','agent');
  await createTeam(lead,'Snapshot',[person]);
  const stale = await account(lead), originalTeamId = stale.ownedTeamId;
  await assert.rejects(deleteAccount({...stale,username:'old'},[person]),/CONFLICT/);
  await assert.rejects(deleteAccount({...stale,role:'agent'},[person]),/CONFLICT/);
  await assert.rejects(deleteAccount({...stale,supervisorId:replacement},[person]),/CONFLICT/);
  await assert.rejects(deleteAccount(stale),/CONFLICT/);
  await assert.rejects(deleteTeam({...stale,ownedTeamName:'Old'},[person]),/CONFLICT/);
  await assert.rejects(deleteTeam(stale,[],person),/FORBIDDEN/);
  await assert.rejects(deleteTeam(stale,[person,person]),/VALIDATION/);
  const noTeam = await account(replacement);
  await createTeam(replacement,'Bootstrap');
  await assert.rejects(deleteAccount(noTeam),/CONFLICT/);
  await deleteTeam(await account(replacement));
  await deleteTeam(stale,[person]);
  await createTeam(lead,'Snapshot',[person]);
  assert.notEqual((await account(lead)).ownedTeamId,originalTeamId);
  await assert.rejects(deleteTeam(stale,[person]),/CONFLICT/);
  await assert.rejects(deleteAccount(stale,[person]),/CONFLICT/);
  assert.equal((await account(person)).supervisorId,lead);
  const currentTeamId = (await account(lead)).ownedTeamId;
  await rpc('workspace_admin_save_team_details',admin,lead,replacement,'Renamed','Snapshot','{'+person+'}',
    JSON.stringify([{id:person,expectedSupervisorId:lead}]));
  assert.equal((await account(replacement)).ownedTeamId,currentTeamId);
  assert.equal((await directory()).teams.find(t=>t.supervisorId===replacement).id,currentTeamId);
  assert.equal((await account(lead)).ownedTeamId,null);
});

test('only service-side admins can delete agents and supervisors; admin identities are protected', async () => {
  const otherAdmin = await createUser('adminTwo','admin'), agent = await createUser('normal','agent');
  await assert.rejects(deleteAccount(await account(otherAdmin)),/FORBIDDEN/);
  await assert.rejects(deleteAccount({...await account(otherAdmin),role:'agent'}),/FORBIDDEN/);
  await assert.rejects(deleteAccount(await account(admin)),/FORBIDDEN/);
  await assert.rejects(deleteAccount(await account(agent),[],agent),/FORBIDDEN/);
  for (const role of ['anon','authenticated','service_role']) {
    for (const sig of ['workspace_admin_delete_team(uuid,uuid,uuid,text,uuid[])',
      'workspace_admin_delete_account(uuid,uuid,text,text,uuid,uuid,text,uuid[])']) {
      assert.equal((await sql('select has_function_privilege($1,$2,\'execute\') as ok',[role,'public.'+sig]))[0].ok,role==='service_role');
    }
    assert.equal((await sql('select has_function_privilege($1,$2,\'execute\') as ok',[role,
      'workspace_private.remove_confirmed_team(uuid,uuid,text,uuid[])']))[0].ok,false);
  }
});

test('the migration also applies when both optional legacy tables were already retired', async () => {
  const clean = new PGlite();
  try {
    await clean.exec('create role anon; create role authenticated; create role service_role');
    for (const file of (await readdir(migrationDir)).filter(f=>f.endsWith('.sql')).sort()) {
      if (file.endsWith('_admin_deletions.sql')) {
        await clean.exec('drop table workspace_private.calls, workspace_private.call_versions; drop function workspace_private.deny_legacy_write()');
      }
      await clean.exec('begin;\n'+await readFile(new URL(file,migrationDir),'utf8')+'\ncommit;');
    }
    assert.equal((await clean.query("select to_regclass('workspace_private.calls') is null as gone")).rows[0].gone,true);
    const {rows:[row]} = await clean.query("insert into workspace_private.users(username,username_key,password_hash,role) values ('Owner','owner','hash','admin') returning id");
    const {rows:[target]} = await clean.query("insert into workspace_private.users(username,username_key,password_hash) values ('Agent','agent','hash') returning id");
    const result = await clean.query("select public.workspace_admin_delete_account($1,$2,'Agent','agent',null,null,null,'{}') as result",[row.id,target.id]);
    assert.deepEqual(result.rows[0].result,{ok:true});
  } finally { await clean.close(); }
});
