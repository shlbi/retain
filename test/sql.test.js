import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { DEFAULT_GOALS } from '../dist/model.js';
import { MAX_BACKUP_BYTES } from '../dist/validation.js';

let db;
before(async()=>{
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const directory = new URL('../supabase/migrations/',import.meta.url);
  for (const file of (await readdir(directory)).filter(file=>file.endsWith('.sql')).sort()) {
    // Supabase's GitHub runner applies each migration in a transaction.
    await db.exec('begin;\n' + await readFile(new URL(file,directory),'utf8') + '\ncommit;');
  }
});
after(async()=>{ await db?.close(); });

/** Exercise the same named-argument RPC contract used by the PostgREST adapter. */
async function rpc(name,args={}) {
  const keys = Object.keys(args);
  assert.match(name,/^[a-z_]+$/);
  keys.forEach(key=>assert.match(key,/^p_[a-z_]+$/));
  const values = keys.map(key=>typeof args[key] === 'object' && args[key] !== null ? JSON.stringify(args[key]) : args[key]);
  const result = await db.query(`select public.${name}(${keys.map((key,index)=>`${key} => $${index+1}`).join(',')}) as result`,values);
  return result.rows[0].result;
}
const register = username=>rpc('auth_register',{p_username:username,p_password_hash:'test-salted-hash'});
const state = user=>rpc('workspace_state',{p_user_id:user.id});
const call = (overrides={})=>({id:'record1',day:'2026-11-06',time:'12:45',order:1793970000000,ucid:'UCID-001',account:'00123',before:['internet','tv'],kept:['tv'],mobileOrders:[2,1],soldLines:3,sold:true,revision:1,...overrides});
const save = (user,record,revision=null)=>rpc('workspace_save',{p_user_id:user.id,p_call:record,p_expected_revision:revision});

test('SQL registers case-insensitive usernames and returns ten defaults for an empty workspace',async()=>{
  const user = await register(' Agent One ');
  assert.equal(user.username,'Agent One');
  await assert.rejects(register('agent one'),/DUPLICATE/);
  assert.equal((await rpc('auth_get_user',{p_username_key:' AGENT ONE '})).id,user.id);
  assert.equal(await rpc('auth_get_user',{p_username_key:'missing'}),null);
  assert.deepEqual(await state(user),{version:3,calls:[],goals:DEFAULT_GOALS});
});

test('SQL sessions expire, logout revokes them, and rate-limit counters persist and reset',async()=>{
  const user = await register('sessions'), token = 'a'.repeat(64);
  await rpc('auth_create_session',{p_user_id:user.id,p_token_hash:token,p_expires_at:new Date(Date.now()+30*86400000).toISOString()});
  assert.equal((await rpc('auth_session',{p_token_hash:token})).id,user.id);
  assert.equal(await rpc('auth_session',{p_token_hash:'b'.repeat(64)}),null);
  await db.query("update workspace_private.sessions set created_at=now()-interval '2 days',expires_at=now()-interval '1 day' where token_hash=$1",[token]);
  assert.equal(await rpc('auth_session',{p_token_hash:token}),null);
  await rpc('auth_create_session',{p_user_id:user.id,p_token_hash:token,p_expires_at:new Date(Date.now()+86400000).toISOString()});
  await rpc('auth_logout',{p_token_hash:token});
  assert.equal(await rpc('auth_session',{p_token_hash:token}),null);
  const bucket = {p_key:'test-key',p_limit:2,p_window_seconds:60};
  assert.equal(await rpc('auth_rate_limit',bucket),true);
  assert.equal(await rpc('auth_rate_limit',bucket),true);
  assert.equal(await rpc('auth_rate_limit',bucket),false);
  await db.query("update workspace_private.auth_limits set window_started=now()-interval '2 minutes' where bucket_key=$1",[bucket.p_key]);
  assert.equal(await rpc('auth_rate_limit',bucket),true);
});

test('SQL isolates accounts, enforces per-user nonempty UCIDs, and accepts multiple blank IDs',async()=>{
  const first = await register('isolation-first'), second = await register('isolation-second');
  await save(first,call());
  await save(second,call({account:'second-account'}));
  await assert.rejects(save(first,call({id:'duplicate',ucid:'ucid-001'})),/DUPLICATE/);
  for (const id of ['blank1','blank2']) await save(first,call({id,ucid:'',account:''}));
  const firstState = await state(first), secondState = await state(second);
  assert.equal(firstState.calls.length,3);assert.equal(secondState.calls.length,1);
  assert.equal(secondState.calls[0].account,'second-account');
  assert.ok(firstState.calls.every(record=>record.account!=='second-account'));
  await assert.rejects(rpc('workspace_remove',{p_user_id:second.id,p_id:'blank1',p_expected_revision:1}),/CONFLICT/);
  assert.equal((await state(first)).calls.length,3);
});

test('SQL revisions and deletion tombstones prevent stale edits and stale Undo',async()=>{
  const user = await register('revisions');
  let current = await save(user,call());
  assert.equal(current.revision,1);
  current = await save(user,{...current,kept:[]},1);
  assert.equal(current.revision,2);
  await assert.rejects(save(user,current,1),/CONFLICT/);
  await assert.rejects(rpc('workspace_remove',{p_user_id:user.id,p_id:current.id,p_expected_revision:1}),/CONFLICT/);
  const removed = await rpc('workspace_remove',{p_user_id:user.id,p_id:current.id,p_expected_revision:2});
  await assert.rejects(save(user,current,2),/CONFLICT/);
  current = await rpc('workspace_restore',{p_user_id:user.id,p_call:removed});
  assert.equal(current.revision,4);
  await assert.rejects(rpc('workspace_restore',{p_user_id:user.id,p_call:removed}),/CONFLICT/);
  await rpc('workspace_remove',{p_user_id:user.id,p_id:current.id,p_expected_revision:4});
  await assert.rejects(rpc('workspace_restore',{p_user_id:user.id,p_call:removed}),/CONFLICT/);
  assert.equal((await state(user)).calls.length,0);
});

test('SQL backup merge preserves explicit goals and rolls back all writes on a later conflict',async()=>{
  const user = await register('imports'), original = await save(user,call());
  await rpc('workspace_goal',{p_user_id:user.id,p_key:'overall',p_value:99});
  const backup = {version:3,calls:[{...original,ucid:'ucid-001',revision:500},call({id:'imported',ucid:'import-001'})],goals:{...DEFAULT_GOALS,overall:55,tv:30}};
  assert.deepEqual(await rpc('workspace_import',{p_user_id:user.id,p_backup:backup}),{imported:1,skipped:1});
  assert.deepEqual(await rpc('workspace_import',{p_user_id:user.id,p_backup:backup}),{imported:0,skipped:2});
  const before = await state(user);
  assert.equal(before.goals.overall,99);assert.equal(before.goals.tv,30);
  await assert.rejects(rpc('workspace_import',{p_user_id:user.id,p_backup:{...backup,calls:[call({id:'rollback',ucid:'new-rollback'}),{...original,account:'changed'}]}}),/CONFLICT/);
  assert.deepEqual(await state(user),before);
  assert.equal((await db.query('select count(*)::int as count from workspace_private.call_versions where user_id=$1 and id=$2',[user.id,'rollback'])).rows[0].count,0);
  await assert.rejects(rpc('workspace_import',{p_user_id:user.id,p_backup:{...backup,calls:[call({id:'dupe',ucid:''}),call({id:'dupe',ucid:''})]}}),/VALIDATION/);
  assert.deepEqual(await state(user),before);
});

test('SQL rejects malformed calls even when the JavaScript validator is bypassed',async()=>{
  const user = await register('validation');
  for (const overrides of [{day:'2026-02-31'},{soldLines:999},{mobileOrders:[13],soldLines:13},{before:['internet','internet']},{kept:['mobile']},{extra:'field'}]) {
    await assert.rejects(save(user,call(overrides)),/VALIDATION/);
  }
  assert.deepEqual((await state(user)).calls,[]);
});

test('SQL RLS and grants deny public roles and limit service_role to the RPC boundary',async()=>{
  const user = await register('permissions');
  const enabled = (await db.query("select count(*)::int as count from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='workspace_private' and c.relkind='r' and c.relrowsecurity")).rows[0].count;
  assert.equal(enabled,5);
  for (const role of ['anon','authenticated','service_role']) {
    const rights = (await db.query("select has_schema_privilege($1,'workspace_private','USAGE') as schema,has_table_privilege($1,'workspace_private.users','SELECT') as users,has_function_privilege($1,'public.workspace_state(uuid)','EXECUTE') as rpc",[role])).rows[0];
    assert.deepEqual(rights,{schema:false,users:false,rpc:role==='service_role'});
    await db.exec(`set role ${role}`);
    try {
      if (role === 'service_role') assert.equal((await state(user)).calls.length,0);
      else await assert.rejects(state(user),/permission denied/);
      await assert.rejects(db.query('select * from workspace_private.users'),/permission denied/);
    } finally { await db.exec('reset role'); }
  }
});

test('SQL capacity failures roll back save, import, and restore including Undo revisions',async()=>{
  const user = await register('capacity');
  const snapshotSize = async()=>(await db.query('select octet_length(workspace_private.state($1)::text) as size',[user.id])).rows[0].size;
  const emptySize = await snapshotSize();
  const record = call({id:'cap-999999',ucid:'U'.repeat(94)+'999999',account:'A'.repeat(100),before:['internet','tv','phone','mobile'],kept:['internet','tv','phone','mobile'],mobileOrders:Array(20).fill(12),soldLines:240});
  const rowSize = (await db.query('select octet_length(workspace_private.normalize_call($1)::text) as size',[JSON.stringify(record)])).rows[0].size;
  const count = Math.floor((MAX_BACKUP_BYTES-emptySize+2)/(rowSize+2));
  assert.ok(count>1000 && count<10000);
  // Seed the boundary efficiently; the mutations under test still use the real public RPCs.
  await db.query(`insert into workspace_private.calls(user_id,id,record,revision)
    select $1,'cap-' || lpad(g::text,6,'0'),
      $2::jsonb || jsonb_build_object('id','cap-' || lpad(g::text,6,'0'),'ucid',repeat('U',94) || lpad(g::text,6,'0')),1
    from generate_series(1,$3) g`,[user.id,JSON.stringify(record),count]);
  await db.query('insert into workspace_private.call_versions select user_id,id,revision from workspace_private.calls where user_id=$1',[user.id]);
  const before = await snapshotSize();
  assert.ok(before<=MAX_BACKUP_BYTES && before+rowSize+2>MAX_BACKUP_BYTES);
  await assert.rejects(save(user,record),/LIMIT/);
  await assert.rejects(rpc('workspace_import',{p_user_id:user.id,p_backup:{version:3,calls:[record],goals:DEFAULT_GOALS}}),/LIMIT/);
  await db.query('insert into workspace_private.call_versions(user_id,id,revision) values($1,$2,2)',[user.id,record.id]);
  await assert.rejects(rpc('workspace_restore',{p_user_id:user.id,p_call:record}),/LIMIT/);
  assert.equal((await state(user)).calls.length,count);
  assert.equal(await snapshotSize(),before);
  assert.equal((await db.query('select revision from workspace_private.call_versions where user_id=$1 and id=$2',[user.id,record.id])).rows[0].revision,2);
});
