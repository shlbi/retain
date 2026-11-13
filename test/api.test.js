import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, readJson, MAX_REQUEST_BYTES } from '../server/workspace-handler.js';
import { createDatabase, ApiError } from '../server/database.js';
import { hashPassword, newSession } from '../server/auth.js';
import { DEFAULT_GOALS } from '../dist/model.js';
import { MAX_BACKUP_BYTES } from '../dist/validation.js';

const USER_A = {id:'11111111-1111-4111-8111-111111111111',username:'Agent A'};
const USER_B = {id:'22222222-2222-4222-8222-222222222222',username:'Agent B'};
const ENV = {APP_ORIGIN:'https://calls.example',VERCEL:'1'};
const sample = (overrides={})=>({id:'call-1',day:'2026-11-06',time:'14:05',order:1793973900000,ucid:'',account:'',before:['internet'],kept:['internet'],mobileOrders:[2,3],sold:true,soldLines:5,revision:1,...overrides});

/** Capture the complete HTTP boundary without a real server or database credentials. */
async function request(handler,{method='POST',body,url='/api/workspace',headers={},cookie,expected=USER_A.id}={}) {
  const req = {method,url,body,headers:{host:'calls.example',origin:'https://calls.example','content-type':'application/json','x-workspace-user':expected,...headers},socket:{remoteAddress:'127.0.0.1'}};
  if (cookie) req.headers.cookie=cookie;
  const responseHeaders = {};
  const res = {statusCode:200,setHeader(key,value){responseHeaders[key.toLowerCase()]=value;},end(value){this.text=value;}};
  await handler(req,res);
  return {status:res.statusCode,headers:responseHeaders,body:JSON.parse(res.text)};
}

function fakeDatabase({user=USER_A,fail,allowed=true}={}) {
  const calls=[];
  return {calls,async rpc(name,args){calls.push({name,args});if(fail?.[name])throw fail[name];
    if(name==='auth_rate_limit')return allowed;
    if(name==='auth_session')return user;
    if(name==='workspace_state')return {version:3,calls:[sample()],goals:{...DEFAULT_GOALS}};
    if(name==='workspace_save'||name==='workspace_restore')return {...args.p_call,revision:2};
    if(name==='workspace_remove')return sample();
    if(name==='workspace_goal')return args.p_value;
    if(name==='workspace_import')return {imported:1,skipped:0};
    if(name==='auth_register')return USER_A;
    return null;
  }};
}
function session(){const value=newSession();return `workspace_session=${value.token}`;}

test('identity is optional while every state/data route requires a verified session',async()=>{
  const db=fakeDatabase();const handler=createHandler({env:ENV,database:db});
  assert.deepEqual((await request(handler,{method:'GET'})).body,{user:null});
  assert.equal((await request(handler,{method:'GET',url:'/api/workspace?action=state'})).status,401);
  assert.equal((await request(handler,{body:{action:'goal',key:'sales',value:25}})).status,401);
  assert.equal(db.calls.filter(call=>call.name.startsWith('workspace_')).length,0);
});

test('state and mutation ownership always come from the session, and stale tabs cannot write',async()=>{
  const db=fakeDatabase({user:USER_B}),handler=createHandler({env:ENV,database:db}),cookie=session();
  for(const options of [{method:'GET',url:'/api/workspace?action=state'},{body:{action:'save',call:sample(),expectedRevision:null}}]){
    const response=await request(handler,{...options,cookie,expected:USER_A.id});
    assert.equal(response.status,401);assert.equal(response.body.error.message,'Your session changed. Sign in again.');
  }
  const okay=await request(handler,{body:{action:'save',call:sample(),expectedRevision:7},cookie,expected:USER_B.id});
  assert.equal(okay.status,200);
  const write=db.calls.find(call=>call.name==='workspace_save');
  assert.equal(write.args.p_user_id,USER_B.id);assert.equal(write.args.p_expected_revision,7);
  const spoof=await request(handler,{body:{action:'goal',key:'sales',value:25,userId:USER_A.id},cookie,expected:USER_B.id});
  assert.equal(spoof.status,400);
});

test('cross-origin, missing-origin, non-JSON and unsupported mutations fail before database access',async()=>{
  const db=fakeDatabase(),handler=createHandler({env:ENV,database:db});
  for(const headers of [{origin:'https://evil.example'},{origin:''},{origin:'null'},{'content-type':'text/plain'},{'sec-fetch-site':'cross-site'}]){
    assert.equal((await request(handler,{headers,body:{action:'login',username:'a',password:'x'}})).status,400);
  }
  const unsupported=await request(handler,{method:'DELETE',body:{action:'logout'}});
  assert.equal(unsupported.status,405);assert.equal(unsupported.headers.allow,'GET, POST');
  assert.equal(db.calls.length,0);
});

test('cloud setup errors are explicit and responses never enable CORS or caching',async()=>{
  const response=await request(createHandler({env:{}}),{method:'GET'});
  assert.equal(response.status,503);assert.equal(response.body.error.code,'SETUP');
  assert.equal(response.headers['cache-control'],'no-store');
  assert.equal(response.headers['access-control-allow-origin'],undefined);
  assert.equal(response.headers['content-type'],'application/json; charset=utf-8');
});

test('signup accepts a one-character password and stores only hashes with a secure cookie',async()=>{
  const db=fakeDatabase(),handler=createHandler({env:ENV,database:db,clock:()=>Date.UTC(2026,10,6)});
  const response=await request(handler,{body:{action:'signup',username:'  One  ',password:'x'}});
  assert.equal(response.status,200);assert.deepEqual(response.body,{user:USER_A});
  const register=db.calls.find(call=>call.name==='auth_register');
  assert.equal(register.args.p_username,'One');assert.match(register.args.p_password_hash,/^scrypt\$/);
  const created=db.calls.find(call=>call.name==='auth_create_session');
  assert.match(created.args.p_token_hash,/^[a-f0-9]{64}$/);
  assert.equal(created.args.p_expires_at,'2026-12-06T00:00:00.000Z');
  assert.match(response.headers['set-cookie'],/HttpOnly; SameSite=Strict;.*Secure/);
  assert.ok(!response.headers['set-cookie'].includes(created.args.p_token_hash));
  assert.doesNotMatch(JSON.stringify(response.body),/password|scrypt|token/i);
});

test('login uses identical public errors for unknown accounts and wrong passwords',async()=>{
  const password_hash=await hashPassword('x');
  for(const stored of [null,{...USER_A,password_hash}]){
    const db=fakeDatabase(),rpc=db.rpc.bind(db);db.rpc=async(name,args)=>name==='auth_get_user'?stored:rpc(name,args);
    const response=await request(createHandler({env:ENV,database:db}),{body:{action:'login',username:'agent',password:'wrong'}});
    assert.equal(response.status,401);assert.equal(response.body.error.message,'Username or password is incorrect.');
    assert.equal(response.headers['set-cookie'],undefined);
  }
});

test('successful login rotates the previous cookie session without exposing hashes',async()=>{
  const stored={...USER_A,password_hash:await hashPassword(' ')};
  const db=fakeDatabase(),rpc=db.rpc.bind(db);db.rpc=async(name,args)=>name==='auth_get_user'?stored:rpc(name,args);
  const response=await request(createHandler({env:ENV,database:db}),{body:{action:'login',username:'Agent A',password:' '},cookie:session()});
  assert.equal(response.status,200);assert.deepEqual(response.body,{user:USER_A});
  assert.deepEqual(db.calls.filter(call=>['auth_create_session','auth_logout'].includes(call.name)).map(call=>call.name),['auth_create_session','auth_logout']);
  assert.match(response.headers['set-cookie'],/workspace_session=[A-Za-z0-9_-]{43};/);
  assert.doesNotMatch(JSON.stringify(response.body),/scrypt|password_hash/);
});

test('only explicit development permits an HTTP cookie on a non-loopback preview host',async()=>{
  for(const [env,secure] of [[{NODE_ENV:'development'},false],[{NODE_ENV:'production'},true],[{NODE_ENV:'development',VERCEL:'1'},true]]){
    const db=fakeDatabase();const handler=createHandler({env,database:db});
    const origin=`${secure?'https':'http'}://terminal.local:4173`;
    const response=await request(handler,{body:{action:'logout'},headers:{host:'terminal.local:4173',origin}});
    assert.equal(response.status,200);assert.equal(response.headers['set-cookie'].includes('; Secure'),secure);
  }
});

test('database-backed rate limit stops hashing/account lookups and returns retry guidance',async()=>{
  const db=fakeDatabase({allowed:false});
  const response=await request(createHandler({env:ENV,database:db}),{body:{action:'login',username:'Agent',password:'x'}});
  assert.equal(response.status,429);assert.equal(response.headers['retry-after'],'900');
  assert.deepEqual(db.calls.map(call=>call.name),['auth_rate_limit']);
  assert.doesNotMatch(db.calls[0].args.p_key,/127\.0\.0\.1|Agent/);
});

test('state returns eleven validated goals and logout revokes the token digest',async()=>{
  const db=fakeDatabase(),handler=createHandler({env:ENV,database:db}),cookie=session();
  const state=await request(handler,{method:'GET',url:'/api/workspace?action=state',cookie});
  assert.equal(state.status,200);assert.equal(state.body.version,3);assert.equal(Object.keys(state.body.goals).length,11);
  const response=await request(handler,{body:{action:'logout'},cookie,expected:'stale'});
  assert.deepEqual(response.body,{ok:true});assert.match(response.headers['set-cookie'],/Max-Age=0/);
  assert.match(db.calls.find(call=>call.name==='auth_logout').args.p_token_hash,/^[a-f0-9]{64}$/);
});

test('record validation keeps optional blanks and independent mobile orders canonical',async()=>{
  const db=fakeDatabase(),handler=createHandler({env:ENV,database:db}),cookie=session();
  const good=await request(handler,{body:{action:'save',call:sample({ucid:'',account:''}),expectedRevision:null},cookie});
  assert.equal(good.status,200);assert.deepEqual(good.body.mobileOrders,[2,3]);assert.equal(good.body.soldLines,5);
  for(const call of [sample({mobileOrders:[13]}),sample({kept:['tv']}),sample({userId:USER_B.id}),sample({soldLines:4})]){
    assert.equal((await request(handler,{body:{action:'save',call,expectedRevision:null},cookie})).status,400);
  }
  assert.equal(db.calls.filter(call=>call.name==='workspace_save').length,1);
});

test('account and approved callback details reach save, restore and import intact',async()=>{
  const db=fakeDatabase(),handler=createHandler({env:ENV,database:db}),cookie=session();
  const accounts=[
    {account:'',before:['internet'],kept:['internet'],added:['mobile']},
    {account:'000012',before:['internet'],kept:[],added:[]}
  ];
  const callback={dueAt:'2026-11-15T15:00:00.000Z',note:'Discuss the second account.',approved:true,status:'scheduled'};
  const call=sample({accounts,callback});
  const actions=[
    {action:'save',call,expectedRevision:1},
    {action:'restore',call},
    {action:'import',backup:{version:3,calls:[call],goals:{...DEFAULT_GOALS}}}
  ];
  for (const body of actions) {
    const response=await request(handler,{body,cookie});
    assert.equal(response.status,200);
    const args=db.calls.at(-1).args;
    const sent=body.action==='import'?args.p_backup.calls[0]:args.p_call;
    assert.deepEqual(sent.accounts,accounts);
    assert.deepEqual(sent.callback,callback);
  }
  const invalid=sample({accounts,callback:{...callback,approved:false}});
  const response=await request(handler,{body:{action:'save',call:invalid,expectedRevision:1},cookie});
  assert.equal(response.status,400);
  assert.equal(db.calls.filter(entry=>entry.name==='workspace_save').length,1);
});

test('restore and import preserve revision/conflict semantics and never return database details',async()=>{
  const db=fakeDatabase({fail:{workspace_restore:new ApiError(409,'CONFLICT','A newer change prevents Undo.')}}),handler=createHandler({env:ENV,database:db}),cookie=session();
  const response=await request(handler,{body:{action:'restore',call:sample({revision:4})},cookie});
  assert.equal(response.status,409);assert.equal(db.calls.find(call=>call.name==='workspace_restore').args.p_call.revision,4);
  const backup={version:3,calls:[sample()],goals:{...DEFAULT_GOALS}};
  const imported=await request(handler,{body:{action:'import',backup},cookie});
  assert.deepEqual(imported.body,{imported:1,skipped:0});
  assert.equal(db.calls.find(call=>call.name==='workspace_import').args.p_user_id,USER_A.id);
});

test('raw and platform-parsed requests allow a backup envelope and enforce the 4 MiB boundary',async()=>{
  const body={action:'login',username:'a',password:'x'};
  const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.headers={'content-type':'application/json'};
  assert.deepEqual(await readJson(req),body);
  const envelope={action:'import',backup:{padding:'x'.repeat(MAX_BACKUP_BYTES)}};
  assert.deepEqual(await readJson({headers:{},body:envelope}),envelope);
  for(const value of ['{',[],{action:'login',username:'a',password:'x'.repeat(MAX_REQUEST_BYTES)}]){
    await assert.rejects(readJson({headers:{},body:value}),error=>error.status===400);
  }
  await assert.rejects(readJson({headers:{'content-length':String(MAX_REQUEST_BYTES+1)},body}),/4 MiB/);
});

test('Supabase opaque keys use apikey only; legacy service-role JWTs also use Authorization',async()=>{
  for(const [key,authorization] of [['sb_secret_example',undefined],['legacy.jwt.value','Bearer legacy.jwt.value']]){
    let observed;
    const db=createDatabase({SUPABASE_URL:'https://database.supabase.co',SUPABASE_SECRET_KEY:key},async(url,options)=>{observed={url:String(url),options};return {ok:true,json:async()=>({ok:true})};});
    assert.deepEqual(await db.rpc('workspace_state',{p_user_id:USER_A.id}),{ok:true});
    assert.equal(observed.options.headers.apikey,key);assert.equal(observed.options.headers.Authorization,authorization);
    assert.equal(observed.url,'https://database.supabase.co/rest/v1/rpc/workspace_state');
  }
});

test('database adapter hides raw errors, maps conflicts, and supports the legacy environment key',async()=>{
  for(const [message,code,status] of [['CONFLICT: private row details','P0001',409],['DUPLICATE: a secret username','P0001',409],['LIMIT: capacity','P0001',400],['leaked database text','XX000',503]]){
    const db=createDatabase({SUPABASE_URL:'https://database.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'legacy.jwt.key'},async()=>({ok:false,json:async()=>({message,code})}));
    await assert.rejects(db.rpc('workspace_state'),error=>error.status===status&&!error.message.includes(message));
  }
});
