import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import {createHash, randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

let db, admin;
const digest = () => createHash('sha256').update(randomBytes(32)).digest('hex');
const credential = () => 'scrypt$32768$8$3$' + randomBytes(16).toString('hex') + '$' + randomBytes(64).toString('hex');
const sql = async (query, values = []) => (await db.query(query,values)).rows;
const rpc = async (name,...values) => (await sql('select public.' + name + '(' +
  values.map((_,i) => '$' + (i+1)).join(',') + ') as result',values))[0].result;
const active = async (name,role='agent') => (await sql(
  'insert into workspace_private.users(username,username_key,password_hash,role) values($1,lower($1),$2,$3) returning id,username,password_hash',
  [name,credential(),role]))[0];
const request = name => rpc('auth_request_password_change',name);
const directory = () => rpc('workspace_admin_accounts',admin.id);
const pending = async name => (await directory()).passwordChanges.find(r => r.username===name);
const review = (id,decision,hash=null,actor=admin.id) => rpc('workspace_admin_review_password_change',actor,id,decision,hash);
const complete = (name,code,hash=credential()) => rpc('auth_complete_password_change',name,code,hash);
const login = (user,session) => rpc('auth_create_verified_session',user.id,user.password_hash,session,new Date(Date.now()+3600000).toISOString());
const issue = async (user,code) => {
  await request(user.username);
  return review((await pending(user.username)).id,'approve',code);
};

before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role');
  const dir = new URL('../supabase/migrations/',import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    await db.exec('begin;\n' + await readFile(new URL(file,dir),'utf8') + '\ncommit;');
  }
  admin = await active('Admin','admin');
});
after(async () => { await db?.close(); });

test('public requests acknowledge every name equally and queue each active account once, including legacy names', async () => {
  const user = await active('Preexisting legacy username');
  await rpc('auth_request_signup','Newbie',credential(),'agent');
  for (const name of ['unknown','NEWBIE','',null,'  PREEXISTING LEGACY USERNAME ']) {
    assert.deepEqual(await request(name),{ok:true});
  }
  const first = await pending(user.username);
  assert.deepEqual(Object.keys(first).sort(),['id','requestedAt','username']);
  await request(user.username);
  assert.deepEqual((await directory()).passwordChanges,[first]);
  assert.equal((await directory()).pending[0].username,'Newbie');
  assert.equal(JSON.stringify(await directory()).includes(user.password_hash),false);
  await assert.rejects(rpc('workspace_admin_accounts',user.id),/FORBIDDEN/);
  await assert.rejects(review(first.id,'approve',digest(),user.id),/FORBIDDEN/);
  for (const [decision,hash] of [['allow',null],['approve','plain code'],['deny',digest()]]) {
    await assert.rejects(review(first.id,decision,hash),/VALIDATION/);
  }
  assert.deepEqual(await review(first.id,'deny'),{ok:true});
  assert.equal(await pending(user.username),undefined);
  await assert.rejects(review(first.id,'approve',digest()),/CONFLICT/);
  await assert.rejects(complete(user.username,digest()),/INVALID_RESET/);
});

test('new requests leave the existing code valid until approval; reapproval replaces the code for 30 minutes', async () => {
  const user = await active('Shift'), other = await active('Other');
  const first = digest(), second = digest();
  await issue(user,first);
  assert.equal(await pending(user.username),undefined);
  assert.ok(!JSON.stringify(await directory()).includes(first));
  await request(user.username);
  await review((await pending(user.username)).id,'deny');
  let codes = await sql('select token_hash from workspace_private.password_change_codes where user_id=$1',[user.id]);
  assert.deepEqual(codes,[{token_hash:first}]);
  await request(user.username);
  const row = await pending(user.username);
  assert.deepEqual(await review(row.id,'approve',second),{ok:true});
  await assert.rejects(review(row.id,'approve',digest()),/CONFLICT/);
  codes = await sql("select token_hash,expires_at between clock_timestamp()+interval '29 minutes' and clock_timestamp()+interval '30 minutes' as valid from workspace_private.password_change_codes where user_id=$1",[user.id]);
  assert.deepEqual(codes,[{token_hash:second,valid:true}]);
  for (const [name,code] of [[user.username,first],[other.username,second],['missing',second],[user.username,null]]) {
    await assert.rejects(complete(name,code),/INVALID_RESET/);
  }
  await assert.rejects(complete(user.username,second,'not-a-hash'),/VALIDATION/);
  assert.equal((await rpc('auth_get_user',user.username)).password_hash,user.password_hash);
  await sql("update workspace_private.password_change_codes set expires_at=clock_timestamp()-interval '1 second' where user_id=$1",[user.id]);
  await assert.rejects(complete(user.username,second),/INVALID_RESET/);
  await request(user.username);
  assert.ok(await pending(user.username));
  assert.deepEqual(await sql('select user_id from workspace_private.password_change_codes where user_id=$1',[user.id]),[]);
});

test('one successful completion changes credentials, consumes requests and codes, and fences stale logins on either side of revocation', async () => {
  const user = await active('Changer'), neighbor = await active('Neighbor');
  const a = digest(), b = digest(), neighborSession = digest(), staleSession = digest(), currentSession = digest();
  assert.equal(await login(user,a),true);
  assert.equal(await login(neighbor,neighborSession),true);
  const code = digest(), newPassword = credential();
  await issue(user,code);
  await request(user.username);
  const waiting = await pending(user.username);
  assert.equal((await rpc('auth_session',a)).id,user.id);
  // A login that captured the original digest wins the lock immediately before
  // the reset. Its session must be revoked in the same commit as the update.
  assert.equal(await login(user,b),true);
  assert.deepEqual(await complete('  cHAnger ',code,newPassword),{ok:true});
  assert.equal((await rpc('auth_get_user',user.username)).password_hash,newPassword);
  assert.equal(await pending(user.username),undefined);
  await assert.rejects(review(waiting.id,'approve',digest()),/CONFLICT/);
  await assert.rejects(complete(user.username,code),/INVALID_RESET/);
  for (const session of [a,b]) assert.equal(await rpc('auth_session',session),null);
  // A login that captured the same original digest but resumes after the reset
  // cannot issue a replacement session.
  assert.equal(await login(user,staleSession),false);
  assert.equal(await rpc('auth_session',staleSession),null);
  assert.equal(await login({...user,password_hash:newPassword},currentSession),true);
  assert.equal((await rpc('auth_session',currentSession)).id,user.id);
  assert.equal((await rpc('auth_session',neighborSession)).id,neighbor.id);
});

test('account deletion clears both approved and pending recovery, including across username reuse', async () => {
  const user = await active('Recycle'), code = digest();
  await issue(user,code);
  await request(user.username);
  const old = await pending(user.username);
  await rpc('workspace_admin_delete_account',admin.id,user.id,user.username,'agent',null,null,null,'{}');
  assert.equal(await pending(user.username),undefined);
  for (const table of ['password_change_requests','password_change_codes']) {
    assert.deepEqual(await sql('select user_id from workspace_private.'+table+' where user_id=$1',[user.id]),[]);
  }
  await active(user.username);
  await assert.rejects(review(old.id,'approve',digest()),/CONFLICT/);
  await assert.rejects(complete(user.username,code),/INVALID_RESET/);
});

test('reset storage and unchecked session issuance are private, including for the server role', async () => {
  assert.equal((await sql("select to_regprocedure('public.auth_create_session(uuid,text,timestamptz)') is null as retired"))[0].retired,true);
  for (const role of ['anon','authenticated','service_role']) {
    for (const signature of ['auth_request_password_change(text)','workspace_admin_review_password_change(uuid,uuid,text,text)',
      'auth_complete_password_change(text,text,text)','auth_create_verified_session(uuid,text,text,timestamptz)']) {
      assert.equal((await sql("select has_function_privilege($1,$2,'execute') as allowed",[role,'public.'+signature]))[0].allowed,role==='service_role');
    }
    assert.equal((await sql("select has_function_privilege($1,'workspace_private.auth_create_session(uuid,text,timestamptz)','execute') as allowed",[role]))[0].allowed,false);
    for (const name of ['password_change_requests','password_change_codes']) {
      const table = 'workspace_private.'+name;
      assert.equal((await sql("select has_table_privilege($1,$2,'select,insert,update,delete') as allowed",[role,table]))[0].allowed,false);
      assert.equal((await sql('select relrowsecurity from pg_class where oid=$1::regclass',[table]))[0].relrowsecurity,true);
    }
  }
});
