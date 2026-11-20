import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createHandler } from '../server/workspace-handler.js';
import { hashPassword, needsPasswordUpgrade, verifyPassword } from '../server/auth.js';

let db, oldHash, handler;
const lookup = async name => (await db.query('select public.auth_get_user($1) as result',[name])).rows[0].result;
// These are the exact parameter bindings used by the production HTTP login route.
const sql = {
  auth_rate_limit:'select public.auth_rate_limit($1,$2,$3) as result',
  auth_get_user:'select public.auth_get_user($1) as result',
  auth_upgrade_password_hash:'select public.auth_upgrade_password_hash($1,$2,$3,$4) as result',
  auth_create_session:'select public.auth_create_session($1,$2,$3) as result'
};
const login = async (name,password) => {
  const req={method:'POST',url:'/api/workspace',body:{action:'login',username:name,password},
    headers:{host:'localhost',origin:'http://localhost','content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}};
  const res={headers:{},setHeader(key,value){this.headers[key.toLowerCase()]=value;},end(value){this.body=JSON.parse(value);}};
  await handler(req,res);
  return res;
};

before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const dir = new URL('../supabase/migrations/',import.meta.url);
  for (const name of (await readdir(dir)).filter(n=>n.endsWith('.sql')).sort()) {
    await db.exec('begin;'+await readFile(new URL(name,dir),'utf8')+'commit;');
  }
  const salt=Buffer.alloc(16,0xb2);
  const key=scryptSync('correct',salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  oldHash='scrypt$32768$8$1$'+salt.toString('hex')+'$'+key.toString('hex');
  await db.query("insert into workspace_private.users(username,username_key,password_hash) values ('Legacy','legacy',$1)",[oldHash]);
  await db.query("select public.auth_request_signup('NewAgent',$1,'agent')",[oldHash]);
  handler=createHandler({env:{NODE_ENV:'development'},database:{async rpc(name,args) {
    assert.ok(Object.hasOwn(sql,name));
    return (await db.query(sql[name],Object.values(args))).rows[0].result;
  }}});
});
after(async()=>{await db?.close();});

test('legacy sign-in upgrades only a matching credential while preserving the authenticated session',async()=>{
  assert.ok(needsPasswordUpgrade(oldHash));
  assert.equal((await login('Legacy','wrong')).statusCode,401);
  assert.equal((await lookup('Legacy')).password_hash,oldHash);
  const first=await login('Legacy','correct');
  assert.equal(first.statusCode,200);
  assert.match(first.headers['set-cookie'],/HttpOnly/);
  const upgraded=(await lookup('Legacy')).password_hash;
  assert.ok(!needsPasswordUpgrade(upgraded));
  assert.ok(await verifyPassword('correct',upgraded));
  assert.equal((await login('Legacy','correct')).statusCode,200);
  assert.equal((await lookup('Legacy')).password_hash,upgraded);
  assert.ok(!JSON.stringify(first.body).includes(upgraded));
});

test('pending sign-in upgrades the hash without granting a session; stale observations lose the compare-and-swap',async()=>{
  const old=await lookup('NewAgent'), denied=await login('NewAgent','correct');
  assert.equal(denied.statusCode,403);
  assert.equal(denied.body.error.code,'PENDING_APPROVAL');
  assert.equal(denied.headers['set-cookie'],undefined);
  const upgraded=(await lookup('NewAgent')).password_hash;
  assert.ok(await verifyPassword('correct',upgraded));
  const collision=await db.query(sql.auth_upgrade_password_hash,[old.id,'pending',oldHash,await hashPassword('other')]);
  assert.equal(collision.rows[0].result,false);
  assert.equal((await lookup('NewAgent')).password_hash,upgraded);
  assert.equal((await db.query('select count(*) as n from workspace_private.sessions where user_id=$1',[old.id])).rows[0].n,0);
  for(const role of ['anon','authenticated','service_role']) {
    const result=await db.query("select has_function_privilege($1,'public.auth_upgrade_password_hash(uuid,text,text,text)','execute') as allowed",[role]);
    assert.equal(result.rows[0].allowed,role==='service_role');
  }
});

test('password work has bounded capacity and releases its slots after a burst',async()=>{
  const jobs=await Promise.allSettled(Array.from({length:11},()=>hashPassword('x')));
  assert.equal(jobs.filter(job=>job.status==='fulfilled').length,10);
  assert.equal(jobs.find(job=>job.status==='rejected').reason.code,'AUTH_BUSY');
  assert.ok(await verifyPassword('x',jobs[0].value));
});
