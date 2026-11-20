import assert from 'node:assert/strict';
import {test, before, after} from 'node:test';
import {readFile, readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {dayKey} from '../dist/model.js';
import {tallyForCall} from '../dist/tally.js';

let db;
const users = {};
const board = {
  title:'Retained board',incentive:'Coffee',pattern:'line',
  startsAt:new Date(Date.now()-60000).toISOString(),endsAt:new Date(Date.now()+3600000).toISOString(),
  squares:Array.from({length:9},()=>({metric:'calls',target:2}))
};

async function rpc(name,...values) {
  return (await db.query('select public.' + name + '(' + values.map((_,i)=>'$'+(i+1)).join(',') + ') as result',values)).rows[0].result;
}
const context = name => rpc('workspace_team_context',users[name]);
const state = name => rpc('workspace_game_state',users[name]);
const getDirectory = () => rpc('workspace_admin_accounts',users.owner);
const save = (supervisor,name,expected=null,actor='owner') =>
  rpc('workspace_admin_save_team',users[actor],users[supervisor],name,expected);
const add = (supervisor,members,actor='owner') => rpc('workspace_admin_add_team_members',users[actor],users[supervisor],
  JSON.stringify(members.map(([member,previous])=>({id:users[member],expectedSupervisorId:previous ? users[previous] : null}))));
const createUser = async (name,role) => {
  const {rows:[row]} = await db.query('insert into workspace_private.users(username,username_key,password_hash,role) values ($1,lower($1),$2,$3) returning id',[name,'synthetic',role]);
  users[name]=row.id;
};

before(async()=>{
  db=new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role');
  const dir=new URL('../supabase/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort()){
    if(file.endsWith('_named_teams.sql')){
      await createUser('owner','admin');
      await createUser('legacy','supervisor');
      await createUser('first','agent');
      await createUser('gameonly','supervisor');
      await createUser('former','supervisor');
      await createUser('other','supervisor');
      await createUser('second','agent');
      await createUser('third','agent');
      await db.query('update workspace_private.users set supervisor_id=$1 where id=$2',[users.legacy,users.first]);
      await rpc('workspace_launch_game',users.legacy,JSON.stringify(board));
      await rpc('workspace_launch_game',users.gameonly,JSON.stringify({...board,title:'Legacy game only'}));
      await rpc('workspace_launch_game',users.former,JSON.stringify({...board,title:'Prior team'}));
      await db.query("update workspace_private.users set role='agent' where id=$1",[users.former]);
    }
    await db.exec('begin;'+await readFile(new URL(file,dir),'utf8')+'commit;');
  }
});
after(async()=>{await db?.close()});

test('existing rosters and games gain a name without moving their identities',async()=>{
  const {teams}=await getDirectory();
  assert.deepEqual(teams.map(t=>t.name),['gameonly’s team','legacy’s team']);
  assert.equal((await context('legacy')).teamName,'legacy’s team');
  assert.equal((await context('other')).teamName,null);
  assert.equal((await context('first')).teamName,'legacy’s team');
  assert.equal((await state('first')).game.id,(await state('legacy')).game.id);
  assert.equal((await state('gameonly')).game.title,'Legacy game only');
  assert.equal((await state('former')).game,null);
  await assert.rejects(save('other','former’s team'),/CONFLICT/);
  await rpc('workspace_admin_assign_account',users.owner,users.former,'supervisor',null,'agent',null);
  assert.equal((await context('former')).teamName,'former’s team');
  assert.equal((await state('former')).game.title,'Prior team');
  await assert.rejects(rpc('workspace_launch_game',users.other,JSON.stringify(board)),/TEAM_REQUIRED/);
});

test('admins create and rename distinct teams with literal punctuation and locked edits',async()=>{
  const team = "O'Brien's Crew";
  await assert.rejects(save('other',team,null,'legacy'),/FORBIDDEN/);
  await assert.rejects(save('other',team,null,'second'),/FORBIDDEN/);
  await assert.rejects(save('first',team),/INVALID_TEAM/);
  for(const name of ['','   ','a'.repeat(61),'Box\nTwo']) await assert.rejects(save('other',name),/VALIDATION/);
  await save('other','  '+team+'  ');
  assert.equal((await context('other')).teamName,team);
  await assert.rejects(save('other','Unexpected overwrite'),/CONFLICT/);
  await assert.rejects(save('legacy',team.toUpperCase(),'legacy’s team'),/CONFLICT/);
  await assert.rejects(save('other','New name','stale team name'),/CONFLICT/);
  await save('other','Coastal',team);
  assert.equal((await context('other')).teamName,'Coastal');
  for(const role of ['anon','authenticated','service_role']){
    const {rows:[r]}=await db.query(`select has_function_privilege($1,'public.workspace_admin_save_team(uuid,uuid,text,text)','execute') as save,
      has_function_privilege($1,'public.workspace_admin_add_team_members(uuid,uuid,jsonb)','execute') as add,
      has_table_privilege($1,'workspace_private.teams','select') as read`,[role]);
    assert.deepEqual(r,{save:role==='service_role',add:role==='service_role',read:false});
  }
});

test('member transfers are atomic and immediately change supervisors, goals and game scope',async()=>{
  const namedBoard = {...board,title:'Coastal game'};
  const game=await rpc('workspace_launch_game',users.other,JSON.stringify(namedBoard));
  await assert.rejects(rpc('workspace_launch_game',users.legacy,JSON.stringify({...board,supervisorId:users.other})),/VALIDATION/);
  await assert.rejects(add('other',[['second']],'legacy'),/FORBIDDEN/);
  await assert.rejects(add('other',[['second'],['first']]),/CONFLICT/);
  assert.equal((await context('second')).teamName,null);
  assert.equal((await context('first')).teamName,'legacy’s team');
  await assert.rejects(add('other',[['second'],['second']]),/CONFLICT/);
  await assert.rejects(add('other',[['legacy']]),/CONFLICT/);
  await add('other',[['second'],['first','legacy']]);
  assert.deepEqual((await context('other')).agents.map(a=>a.username),['first','second']);
  assert.equal((await context('first')).teamName,'Coastal');
  assert.deepEqual((await context('legacy')).agents,[]);
  await assert.rejects(rpc('workspace_agent_state',users.legacy,users.first),/FORBIDDEN/);
  await assert.rejects(rpc('workspace_team_goals',users.legacy,'{'+users.first+'}','{"overall":80}'),/FORBIDDEN/);
  assert.deepEqual((await state('legacy')).members,[]);
  assert.equal((await state('first')).game.id,game.game.id);
  assert.equal((await state('third')).game,null);
  assert.deepEqual((await state('other')).members.map(m=>m.username),['first','second']);
  await assert.rejects(rpc('workspace_admin_accounts',users.other),/FORBIDDEN/);
  await assert.rejects(rpc('workspace_launch_game',users.first,JSON.stringify(board)),/FORBIDDEN/);
});

test('a legacy single-agent assignment provisions a unique team; empty supervisor demotion retires it',async()=>{
  await createUser('newlead','supervisor');
  await save('other','newlead’s team','Coastal');
  await rpc('workspace_admin_assign_account',users.owner,users.third,'agent',users.newlead,'agent',null);
  assert.equal((await context('newlead')).teamName,'newlead’s team 2');
  assert.equal((await context('third')).teamName,'newlead’s team 2');
  await assert.rejects(rpc('workspace_admin_assign_account',users.owner,users.newlead,'agent',null,'supervisor',null),/TEAM_IN_USE/);
  await rpc('workspace_admin_assign_account',users.owner,users.third,'agent',null,'agent',users.newlead);
  await rpc('workspace_admin_assign_account',users.owner,users.newlead,'agent',null,'supervisor',null);
  assert.equal((await getDirectory()).teams.some(t=>t.supervisorId===users.newlead),false);
});

test('a demoted supervisor can only see and score in their assigned team; promotion reactivates the same prior team',async()=>{
  await createUser('keeper','supervisor');
  await createUser('recruit','agent');
  await createUser('fresh','supervisor');
  await save('keeper','Northern');
  const prior = await rpc('workspace_launch_game',users.keeper,JSON.stringify({...board,title:'Northern game'}));
  await rpc('workspace_admin_assign_account',users.owner,users.keeper,'agent',null,'supervisor',null);
  assert.equal((await context('keeper')).teamName,null);
  assert.equal((await state('keeper')).game,null);
  assert.equal((await getDirectory()).teams.some(t=>t.supervisorId===users.keeper),false);
  await assert.rejects(save('fresh','Northern'),/CONFLICT/);
  await assert.rejects(add('keeper',[['recruit']]),/INVALID_TEAM/);
  await assert.rejects(rpc('workspace_launch_game',users.keeper,JSON.stringify(board)),/FORBIDDEN/);
  await assert.rejects(db.query('delete from workspace_private.teams where supervisor_id=$1',[users.keeper]),/foreign key/);
  await add('other',[['keeper']]);
  const otherGame = (await state('other')).game;
  assert.notEqual(otherGame.id,prior.game.id);
  assert.equal((await state('keeper')).game.id,otherGame.id);
  const tally=tallyForCall({before:['internet'],kept:['internet'],mobileOrders:[]});
  await rpc('workspace_tally',users.keeper,dayKey(),JSON.stringify(tally),randomUUID());
  assert.equal((await state('keeper')).me.stats.calls,1);
  const {rows}=await db.query('select game_id from workspace_private.bingo_scores where user_id=$1',[users.keeper]);
  assert.deepEqual(rows,[{game_id:otherGame.id}]);
  await rpc('workspace_admin_assign_account',users.owner,users.keeper,'supervisor',null,'agent',users.other);
  assert.equal((await context('keeper')).teamName,'Northern');
  assert.equal((await state('keeper')).game.id,prior.game.id);
  assert.deepEqual((await state('keeper')).members,[]);
  await assert.rejects(save('keeper','Brand new'),/CONFLICT/);
  await save('fresh','Brand new');
  await add('fresh',[['recruit']]);
  assert.equal((await state('recruit')).game,null);
  await rpc('workspace_tally',users.recruit,dayKey(),JSON.stringify(tally),randomUUID());
  assert.deepEqual((await db.query('select game_id from workspace_private.bingo_scores where user_id=$1',[users.recruit])).rows,[]);
});
