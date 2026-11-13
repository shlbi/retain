import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tallyForCall, groupsFromDays } from '../dist/tally.js';
import { PGlite } from '@electric-sql/pglite';
import { DEFAULT_GOALS } from '../dist/model.js';
import { MAX_BACKUP_BYTES, validateCall } from '../dist/validation.js';

const tallyMigration = '20261113033103_grouped_tallies.sql';
let db, upgradeUser, legacyState;
before(async()=>{
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const directory = new URL('../supabase/migrations/',import.meta.url);
  for (const file of (await readdir(directory)).filter(file=>file.endsWith('.sql')).sort()) {
    // The legacy RPC tests run immediately before the aggregate cutover tested below.
    if (file === tallyMigration) break;
    // Supabase's GitHub runner applies each migration in a transaction.
    await db.exec('begin;\n' + await readFile(new URL(file,directory),'utf8') + '\ncommit;');
    if (file === '20261106005417_workspace.sql') {
      upgradeUser = await register('pre-upgrade');
      await save(upgradeUser,call());
      await rpc('workspace_goal',{p_user_id:upgradeUser.id,p_key:'tv',p_value:70});
      legacyState = await state(upgradeUser);
    }
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

test('SQL registers case-insensitive usernames and returns all default goals for an empty workspace',async()=>{
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


test('upgrading a populated workspace preserves legacy calls, goal overrides and backup compatibility',async()=>{
  const user = upgradeUser;
  assert.equal('bundle' in legacyState.goals,false);
  assert.deepEqual(await state(user),{...legacyState,goals:{...legacyState.goals,bundle:80}});
  await rpc('workspace_goal',{p_user_id:user.id,p_key:'bundle',p_value:90});
  const original = legacyState.calls[0];
  const account = {account:original.account,before:original.before,kept:original.kept};
  const explicit = {...original,accounts:[account],callback:null};
  for (const record of [original,explicit]) {
    assert.deepEqual(await rpc('workspace_import',{p_user_id:user.id,p_backup:{...legacyState,calls:[record]}}),{imported:0,skipped:1});
  }
  assert.equal((await state(user)).goals.bundle,90);
  const updated = await save(user,explicit,original.revision);
  assert.deepEqual(updated.accounts,[{...account,added:[]}]);
  assert.deepEqual(await rpc('workspace_import',{p_user_id:user.id,p_backup:legacyState}),{imported:0,skipped:1});
  const {sp, ...incomplete} = legacyState.goals;
  await assert.rejects(rpc('workspace_import',{p_user_id:user.id,p_backup:{...legacyState,goals:incomplete}}),/VALIDATION/);
});

test('SQL stores all accounts and approved callbacks on save, edit, undo and export/import',async()=>{
  const user = await register('multiple accounts'), other = await register('other accounts');
  const {account,before,kept,...base} = call();
  const accounts = [
    {account:' 00123 ',before:['tv','internet'],kept:['tv'],added:['mobile','phone']},
    {before:['internet','tv'],kept:[]},
    ...Array.from({length:24},(_,i)=>({account:String(i),before:['mobile'],kept:['mobile']}))
  ];
  const callback = {approved:true,dueAt:'2028-02-29T16:23:01.1Z',note:'Check order\nCall back after lunch',status:'scheduled'};
  const raw = {...base,accounts,callback};
  const stored = await save(user,raw);
  assert.deepEqual(stored,validateCall(raw));
  assert.deepEqual((await state(user)).calls,[stored]);
  assert.deepEqual((await state(other)).calls,[]);
  const {accounts:omitAccounts,...withoutAccounts} = stored;
  const {callback:omitCallback,...withoutCallback} = stored;
  await assert.rejects(save(user,withoutAccounts,stored.revision),/CONFLICT/);
  await assert.rejects(save(user,withoutCallback,stored.revision),/CONFLICT/);
  assert.deepEqual((await state(user)).calls,[stored]);
  const done = await save(user,{...stored,callback:{...stored.callback,status:'done'}},stored.revision);
  assert.equal(done.callback.status,'done');
  const removed = await rpc('workspace_remove',{p_user_id:user.id,p_id:done.id,p_expected_revision:done.revision});
  const restored = await rpc('workspace_restore',{p_user_id:user.id,p_call:removed});
  assert.deepEqual(restored,{...done,revision:done.revision+2});
  const backup = await state(user);
  const importBackup = p_backup=>rpc('workspace_import',{p_user_id:other.id,p_backup});
  assert.deepEqual(await importBackup(backup),{imported:1,skipped:0});
  assert.deepEqual(await importBackup(backup),{imported:0,skipped:1});
  assert.deepEqual((await state(other)).calls,[{...restored,revision:1}]);
  await assert.rejects(importBackup({...backup,calls:[{...restored,callback:null}]}),/CONFLICT/);
  const cleared = await save(user,{...restored,accounts:[restored.accounts[0]],callback:null},restored.revision);
  assert.equal(cleared.callback,null);
  assert.equal(cleared.accounts.length,1);
  // A single-account call may still carry new services that an old client would drop.
  await assert.rejects(save(user,call(),cleared.revision),/CONFLICT/);
});

test('SQL rejects invalid service changes, inconsistent aliases and unapproved or malformed callbacks',async()=>{
  const user = await register('account validation');
  const valid = {account:'00123',before:['internet','tv'],kept:['tv'],added:['phone']};
  for (const accounts of [null,[],[null],[{...valid,other:true}],[{...valid,added:null}],
    [{...valid,added:['internet']}],[{...valid,added:['phone','phone']}],[{...valid,added:['fax']}],
    [valid,{before:['internet'],kept:['phone']}],[{...valid,account:'conflicting'}]]) {
    await assert.rejects(save(user,call({accounts})),/VALIDATION/);
  }
  const callback = {approved:true,dueAt:'2028-02-29T13:00:00Z',note:'',status:'scheduled'};
  for (const invalid of [false,{}, {...callback,approved:false}, {...callback,approved:'true'},
    {...callback,dueAt:'2027-02-29T13:00:00Z'}, {...callback,dueAt:'2028-02-29T24:00:00Z'},
    {...callback,dueAt:'2028-02-29T13:00:00-05:00'}, {...callback,dueAt:'0000-01-01T00:00:00Z'},
    {...callback,note:'🐱'.repeat(2001)}, {...callback,status:'cancelled'}, {...callback,extra:true}]) {
    await assert.rejects(save(user,call({callback:invalid})),/VALIDATION/);
  }
  assert.deepEqual((await state(user)).calls,[]);
  const stored = await save(user,call({callback:{...callback,note:'🐱'.repeat(2000)}}));
  assert.equal(stored.callback.dueAt,'2028-02-29T13:00:00.000Z');
  assert.deepEqual(stored.callback.note,'🐱'.repeat(2000));
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

test('SQL migrates and serves grouped daily tallies and retires raw call access', async t => {
  const user = await register('daily tallies'), other = await register('separate tally user');
  const day = '2026-11-07';
  const account = (before,kept,added=[]) => ({before,kept,added,account:'private account'});
  const unusual = [
    account(['tv','mobile'],['tv','mobile'],['internet']),
    account(['tv','mobile'],[]),
    account(['tv','mobile'],['tv','mobile'],['phone']),
    account(['internet','phone'],['internet'])
  ];
  const seed = async (accounts, orders) => {
    const record = call({id:randomUUID(),ucid:randomUUID(),account:'private account',day,accounts,
      before:accounts[0].before,kept:accounts[0].kept,mobileOrders:orders,sold:!!orders.length,
      soldLines:orders.reduce((sum,n)=>sum+n,0),callback:{approved:true,status:'scheduled',note:'private note',dueAt:'2028-11-07T12:00:00.000Z'}});
    await save(user,record);
    return tallyForCall(record);
  };
  const first = await seed(unusual,[2,12]);
  const second = await seed([account(['mobile'],[])],[]);
  const wash = await seed([account(['phone'],[]),account(['phone'],['phone'])],[]);
  await rpc('workspace_goal',{p_user_id:user.id,p_key:'tp',p_value:88});
  const migrations = new URL('../supabase/migrations/',import.meta.url);
  for (const file of (await readdir(migrations)).filter(file=>file.endsWith('.sql') && file>=tallyMigration).sort()) {
    await db.exec('begin;\n' + await readFile(new URL(file,migrations),'utf8') + '\ncommit;');
  }
  const read = u => rpc('workspace_tally_state',{p_user_id:u.id});
  const write = (u,delta,key=randomUUID())=>rpc('workspace_tally',{p_user_id:u.id,p_day:day,p_delta:delta,p_request_id:key});
  const expectedGroups = (...deltas)=>groupsFromDays(deltas);
  const sort = current => ({...current,groups:expectedGroups(current)});
  const initial = {day,calls:3,eligibleCalls:2,savedCalls:1,saleCalls:1,mobileOrders:2,mobileLines:14,
    groups:expectedGroups(first,second,wash)};

  await t.test('backfill agrees with model and exposes only counts, tags and goals',async()=>{
    const migrated=await read(user);
    assert.deepEqual(migrated.goals,{...DEFAULT_GOALS,tp:88});
    assert.deepEqual(migrated.days.map(sort),[initial]);
    assert.equal(migrated.version,4);
    assert.deepEqual((await read(other)).days,[]);
    assert.doesNotMatch(JSON.stringify(migrated),/private note|private account|UCID|callback/i);
    const historical=await read(upgradeUser);
    assert.equal(historical.days[0].calls,1);
    assert.equal(historical.days[0].mobileLines,3);
  });

  await t.test('atomic same-day merge and retry return durable totals including independent concurrent saves',async()=>{
    const key=randomUUID(), groupCall=tallyForCall({before:['tv'],kept:['tv'],mobileOrders:[12]});
    const expected = {...initial,calls:4,eligibleCalls:3,savedCalls:2,saleCalls:2,mobileOrders:3,mobileLines:26,
      groups:expectedGroups(initial,groupCall)};
    assert.deepEqual(sort(await write(user,groupCall,key)),expected);
    assert.deepEqual(sort(await write(user,groupCall,key)),expected);
    await assert.rejects(write(user,first,key),/CONFLICT/);
    const latest=await write(user,groupCall);
    assert.equal(latest.calls,5);
    assert.deepEqual(await write(user,groupCall,key),latest);
    assert.deepEqual((await read(user)).days,[latest]);
    assert.deepEqual((await read(other)).days,[]);
    assert.equal((await write(other,groupCall,key)).calls,1);
  });

  await t.test('validation rejects aliases, unpaired washes and inconsistent counts without incrementing',async()=>{
    const before=await read(other);
    const good=tallyForCall({before:['tv'],kept:['tv']});
    const key=randomUUID();
    for(const delta of [{...good,ucid:'x'},{...good,groups:[{...good.groups[0],account:'x'}]},
      {...good,groups:[{...good.groups[0],washed:true}],eligibleCalls:0,savedCalls:0},
      {...good,groups:[...good.groups,...good.groups]}, {...good,eligibleCalls:0}, {...good,foo:2},
      {...good,saleCalls:1}, {...good,mobileOrders:1,mobileLines:13,saleCalls:1},
      {...good,groups:[{...good.groups[0],count:-1}]}, {...good,savedCalls:null}]) {
      await assert.rejects(write(other,delta,key),/VALIDATION/);
    }
    assert.deepEqual(await read(other),before);
    assert.equal((await write(other,good,key)).calls,2);
  });

  await t.test('authenticated API role cannot read or change archived calls or access raw aggregate tables',async()=>{
    await assert.rejects(save(user,call()),/does not exist/);
    await assert.rejects(state(user),/does not exist/);
    await assert.rejects(db.query('delete from workspace_private.calls where user_id=$1',[user.id]),/CONFLICT/);
    const {rows}=await db.query("select bool_and(relrowsecurity) as all_rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='workspace_private' and c.relkind='r'");
    assert.equal(rows[0].all_rls,true);
    for(const role of ['anon','authenticated','service_role']){
      await db.exec('set role '+role);
      try {
        await assert.rejects(db.query('select * from workspace_private.tally_groups'),/permission denied/);
        await assert.rejects(db.query('select * from workspace_private.calls'),/permission denied/);
        if(role==='service_role') assert.equal((await read(user)).days.length,1);
        else {
          await assert.rejects(read(user),/permission denied/);
          await assert.rejects(write(user,first),/permission denied/);
        }
      }finally{await db.exec('reset role');}
    }
  });
});
