import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

let db, owner, legacy;
const hash = 'salted-test-hash';
const token = (char) => char.repeat(64);
const expiry = () => new Date(Date.now()+300000).toISOString();

async function rpc(name,...args) {
  const params = args.map((_,i) => '$'+(i+1)).join(',');
  return (await db.query(`select public.${name}(${params}) as result`,args)).rows[0].result;
}
const directory = (actor=owner) => rpc('workspace_admin_accounts',actor);
const findUser = async name => (await directory()).accounts.find(e => e.username === name);
const request = (username,role='agent') => rpc('auth_request_signup',username,hash,role);
const review = (id,decision,role=null,supervisorId=null) =>
  rpc('workspace_admin_review_signup',owner,id,decision,role,supervisorId);
const create = (name,role,supervisorId=null) => rpc('workspace_admin_create_account',owner,name,hash,role,supervisorId);
const assign = (actor,account,role,supervisorId=null) => rpc('workspace_admin_assign_account',
  actor,account.id,role,supervisorId,account.role,account.supervisorId);

before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const dir = new URL('../supabase/migrations/',import.meta.url);
  for (const file of (await readdir(dir)).filter(file=>file.endsWith('.sql')).sort()) {
    if (file.endsWith('_account_management.sql')) {
      owner=(await rpc('auth_register','owner',hash)).id;
      legacy=(await rpc('auth_register','Preexisting legacy name',hash)).id;
      await db.query("update workspace_private.users set role='admin' where id=$1",[owner]);
      await rpc('auth_create_session',legacy,token('a'),expiry());
    }
    await db.exec('begin;'+await readFile(new URL(file,dir),'utf8')+'commit;');
  }
});
after(async()=>{await db?.close();});

test('upgrade preserves existing roles, credentials, goals and sessions and closes instant signup',async()=>{
  assert.equal((await directory()).accounts.find(row=>row.id===owner).role,'admin');
  const identity = await rpc('auth_get_user','preexisting LEGACY NAME');
  assert.deepEqual(identity,{id:legacy,username:'Preexisting legacy name',password_hash:hash,status:'active'});
  assert.equal((await rpc('auth_session',token('a'))).id,legacy);
  assert.equal((await rpc('workspace_tally_state',legacy)).goals.overall,85);
  assert.deepEqual(await rpc('auth_register','former',hash),{status:'pending'});
  const queued = (await directory()).pending.find(row=>row.username==='former');
  assert.equal(queued.requestedRole,'agent');
  assert.equal((await directory()).accounts.some(row=>row.username==='former'),false);
  await review(queued.id,'deny',null);
});

test('new requests hold a username without opening a workspace, and review is atomic',async()=>{
  await assert.rejects(request('rogue','admin'),/VALIDATION/);
  assert.deepEqual(await request('Cara','supervisor'),{status:'pending'});
  await assert.rejects(request('CARA'),/DUPLICATE/);
  await assert.rejects(create('cara','agent'),/DUPLICATE/);
  const pending = await rpc('auth_get_user','CaRa');
  assert.equal(pending.status,'pending');
  assert.equal(await rpc('auth_create_verified_session',pending.id,hash,token('b'),expiry()),false);
  assert.equal(await rpc('auth_session',token('b')),null);
  const roster = await directory();
  assert.equal(roster.accounts.some(a=>a.username==='Cara'),false);
  assert.deepEqual(Object.keys(roster.pending[0]).sort(),['id','requestedAt','requestedRole','username']);
  assert.equal(roster.pending[0].requestedRole,'supervisor');
  await assert.rejects(review(pending.id,'approve','admin'),/VALIDATION/);
  await assert.rejects(review(pending.id,'approve','agent',legacy),/INVALID_TEAM/);
  assert.equal((await directory()).pending.length,1);
  assert.deepEqual(await review(pending.id,'approve','supervisor'),{ok:true});
  await assert.rejects(review(pending.id,'deny'),/CONFLICT/);
  assert.equal((await directory()).pending.length,0);
  const approved = await rpc('auth_get_user','cara');
  assert.equal(approved.status,'active');
  assert.equal(approved.password_hash,hash);
  assert.notEqual(approved.id,pending.id);
  assert.equal(await rpc('auth_create_verified_session',approved.id,hash,token('c'),expiry()),true);
  assert.equal((await rpc('auth_session',token('c'))).id,approved.id);
  assert.equal((await findUser('Cara')).role,'supervisor');
  await assert.rejects(request('cara'),/DUPLICATE/);
});

test('denial releases the reservation, erases the password hash and permits a new request',async()=>{
  await request('denyMe');
  const old = await rpc('auth_get_user','denyme');
  await review(old.id,'deny');
  assert.equal(await rpc('auth_get_user','denyme'),null);
  await request('DenyMe');
  const next = await rpc('auth_get_user','denyme');
  assert.notEqual(next.id,old.id);
  await assert.rejects(review(old.id,'approve','agent'),/CONFLICT/);
  await review(next.id,'deny');
});

test('only an admin may list, create, review, and reassign roles and teams',async()=>{
  for (const actor of [legacy,randomUUID()]) {
    await assert.rejects(directory(actor),/FORBIDDEN/);
    await assert.rejects(rpc('workspace_admin_create_account',actor,'intruder',hash,'admin',null),/FORBIDDEN/);
    await assert.rejects(rpc('workspace_admin_review_signup',actor,randomUUID(),'deny',null,null),/FORBIDDEN/);
    await assert.rejects(rpc('workspace_admin_assign_account',actor,legacy,'admin',null,'agent',null),/FORBIDDEN/);
  }
  await create('TeamLead','supervisor');
  const sup = await findUser('TeamLead');
  await assert.rejects(directory(sup.id),/FORBIDDEN/);
  await request('Sally');
  const pending = await rpc('auth_get_user','sally');
  await review(pending.id,'approve','agent',sup.id);
  assert.equal((await findUser('Sally')).supervisorId,sup.id);
  await create('AgentB','agent',sup.id);
  await create('NextBoss','supervisor');
  await assert.rejects(create('bad','supervisor',sup.id),/INVALID_TEAM/);
  await assert.rejects(create('bad','admin',legacy),/INVALID_TEAM/);
  for (const invalid of ['','TooLongUser','pStart','5start']) await assert.rejects(create(invalid,'agent'),/VALIDATION/);
  await assert.rejects(assign(owner,sup,'agent'),/TEAM_IN_USE/);
  await assert.rejects(assign(owner,sup,'agent',sup.id),/INVALID_TEAM/);
  const nextBoss = await findUser('NextBoss');
  const agentB = await findUser('AgentB');
  await assign(owner,agentB,'agent',nextBoss.id);
  await assert.rejects(assign(owner,agentB,'supervisor'),/CONFLICT/);
  const sally = await findUser('Sally');
  await assign(owner,sally,'supervisor');
  await assign(owner,sup,'agent',nextBoss.id);
  assert.deepEqual((await rpc('workspace_team_context',nextBoss.id)).agents.map(a=>a.username),['AgentB','TeamLead']);
  assert.equal((await rpc('workspace_team_context',sup.id)).role,'agent');
  const me = await findUser('owner');
  await assert.rejects(assign(owner,me,'supervisor'),/SELF_ROLE/);
  await assign(owner,me,'admin',nextBoss.id);
  assert.ok((await directory()).accounts.length > 0);
  await create('AdminB','admin');
  const otherAdmin=await findUser('AdminB');
  await assign(owner,otherAdmin,'agent',nextBoss.id);
  await assert.rejects(directory(otherAdmin.id),/FORBIDDEN/);
  await assign(owner,await findUser('AdminB'),'admin');
  assert.ok((await directory(otherAdmin.id)).accounts.length > 0);
  assert.deepEqual(Object.keys((await directory()).accounts[0]).sort(),['id','ownedTeamId','ownedTeamName','role','supervisorId','username']);
});

test('public clients cannot run identity-management operations or read pending credentials',async()=>{
  const rpcSignatures = ['auth_request_signup(text,text,text)','workspace_admin_accounts(uuid)',
    'workspace_admin_review_signup(uuid,uuid,text,text,uuid)','workspace_admin_create_account(uuid,text,text,text,uuid)',
    'workspace_admin_assign_account(uuid,uuid,text,uuid,text,uuid)'];
  for(const role of ['anon','authenticated','service_role']){
    for(const fn of rpcSignatures) {
      const {rows} = await db.query("select has_function_privilege($1,$2,'execute') as allowed",[role,'public.'+fn]);
      assert.equal(rows[0].allowed,role==='service_role');
    }
    const {rows} = await db.query("select has_table_privilege($1,'workspace_private.signup_requests','select') as allowed",[role]);
    assert.equal(rows[0].allowed,false);
  }
});
