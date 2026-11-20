import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, readJson, MAX_REQUEST_BYTES } from '../server/workspace-handler.js';
import { createDatabase, ApiError } from '../server/database.js';
import { hashPassword, verifyPassword, newSession } from '../server/auth.js';
import { DEFAULT_GOALS } from '../dist/model.js';

const USER_A = {id:'11111111-1111-4111-8111-111111111111',username:'Agent A'};
const USER_B = {id:'22222222-2222-4222-8222-222222222222',username:'Agent B'};
const ENV = {APP_ORIGIN:'https://calls.example',VERCEL:'1'};
const day='2026-11-13', requestId='799eb91d-bb6d-4111-a13a-5402fd4bb0f0';
const delta={calls:1,eligibleCalls:1,savedCalls:1,saleCalls:1,mobileOrders:2,mobileLines:5,
  groups:[{before:['internet'],kept:['internet'],added:[],washed:false,count:1}]};
const tally={action:'tally',day,delta,requestId};

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
    if(name==='workspace_tally_state')return {version:4,days:[{day,...delta}],goals:{...DEFAULT_GOALS}};
    if(name==='workspace_edit_day')return args.p_replacement;
    if(name==='workspace_tally')return {day:args.p_day,...args.p_delta};
    if(name==='workspace_goal')return args.p_value;
    if(name==='auth_request_signup')return {status:'pending'};
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
  for(const options of [{method:'GET',url:'/api/workspace?action=state'},{body:tally}]){
    const response=await request(handler,{...options,cookie,expected:USER_A.id});
    assert.equal(response.status,401);assert.equal(response.body.error.message,'Your session changed. Sign in again.');
  }
  const okay=await request(handler,{body:tally,cookie,expected:USER_B.id});
  assert.equal(okay.status,200);
  const write=db.calls.find(call=>call.name==='workspace_tally');
  assert.equal(write.args.p_user_id,USER_B.id);assert.equal(write.args.p_request_id,requestId);
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

test('signup accepts a one-character password and requests approval without a session',async()=>{
  const db=fakeDatabase(),handler=createHandler({env:ENV,database:db});
  const response=await request(handler,{body:{action:'signup',username:'  One  ',password:'x'}});
  assert.equal(response.status,202);assert.deepEqual(response.body,{status:'pending'});
  const register=db.calls.find(call=>call.name==='auth_request_signup');
  assert.equal(register.args.p_username,'One');assert.equal(register.args.p_requested_role,'agent');
  assert.ok(await verifyPassword('x',register.args.p_password_hash));
  assert.equal(response.headers['set-cookie'],undefined);
  assert.ok(!db.calls.some(call=>['auth_create_session','auth_register'].includes(call.name)));
});

test('registration enforces credential rules before writing to the database', async () => {
  const db = fakeDatabase(), handler = createHandler({env:ENV, database:db});
  for (const [username, password] of [['Peter', 'x'], ['7agent', 'x'], ['NineChars', 'x'], ['agent', 'ninechars']]) {
    const response = await request(handler, {body:{action:'signup', username, password}});
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'VALIDATION');
  }
  assert.equal(db.calls.length, 0);
});

test('an existing account can still log in with credentials outside current signup rules', async () => {
  const username = 'PreviousAgent', password = 'old long password';
  const stored = {...USER_A, username, status:'active', password_hash:await hashPassword(password)};
  const db = fakeDatabase(), rpc = db.rpc.bind(db);
  db.rpc = async (name, args) => name === 'auth_get_user' ? stored : rpc(name, args);
  const response = await request(createHandler({env:ENV, database:db}), {body:{action:'login', username, password}});
  assert.equal(response.status, 200);
  assert.equal(response.body.user.username, username);
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
  const stored={...USER_A,status:'active',password_hash:await hashPassword(' ')};
  const db=fakeDatabase(),rpc=db.rpc.bind(db);db.rpc=async(name,args)=>name==='auth_get_user'?stored:rpc(name,args);
  const response=await request(createHandler({env:ENV,database:db}),{body:{action:'login',username:'Agent A',password:' '},cookie:session()});
  assert.equal(response.status,200);assert.deepEqual(response.body,{user:USER_A});
  assert.deepEqual(db.calls.filter(call=>['auth_create_session','auth_logout'].includes(call.name)).map(call=>call.name),['auth_create_session','auth_logout']);
  assert.match(response.headers['set-cookie'],/workspace_session=[A-Za-z0-9_-]{43};/);
  assert.match(response.headers['set-cookie'],/HttpOnly; SameSite=Strict;.*Secure/);
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
  assert.equal(state.status,200);assert.equal(state.body.version,4);assert.equal(Object.keys(state.body.goals).length,11);
  const response=await request(handler,{body:{action:'logout'},cookie,expected:'stale'});
  assert.deepEqual(response.body,{ok:true});assert.match(response.headers['set-cookie'],/Max-Age=0/);
  assert.match(db.calls.find(call=>call.name==='auth_logout').args.p_token_hash,/^[a-f0-9]{64}$/);
});

test('only daily counters and canonical grouped tags reach the aggregate RPC',async()=>{
  const db=fakeDatabase(),handler=createHandler({env:ENV,database:db}),cookie=session();
  assert.deepEqual((await request(handler,{body:tally,cookie})).body,{day,...delta});
  assert.deepEqual(db.calls.find(call=>call.name==='workspace_tally'),{name:'workspace_tally',args:{p_user_id:USER_A.id,p_day:day,p_delta:delta,p_request_id:requestId}});
  for (const body of [
    {action:'save',call:{account:'1234'}}, {action:'restore',call:{}}, {action:'remove'}, {action:'import',backup:{}},
    {...tally,notes:'free text'}, {...tally,day:'2026-11-99'}, {...tally,requestId:'customer-id'},
    {...tally,delta:{...delta,time:'14:30'}},
    {...tally,delta:{...delta,groups:[{...delta.groups[0],ucid:'linked'}]}}
  ]) assert.equal((await request(handler,{body,cookie})).status,400);
  assert.equal(db.calls.filter(call=>call.name==='workspace_tally').length,1);
});

test('the API cannot disclose unexpected columns returned by a database',async()=>{
  const db=fakeDatabase(),rpc=db.rpc.bind(db);
  db.rpc=async(name,args)=>name==='workspace_tally_state'
    ? {version:4,days:[],goals:DEFAULT_GOALS,calls:[{account:'123456'}]}
    : name==='workspace_tally' ? {day,...delta,account:'123456'} : rpc(name,args);
  const handler=createHandler({env:ENV,database:db}),cookie=session();
  for(const options of [{body:tally},{method:'GET',url:'/api/workspace?action=state'}]){
    const response=await request(handler,{...options,cookie});
    assert.equal(response.status,503);
    assert.doesNotMatch(JSON.stringify(response.body),/123456/);
  }
});

test('raw and platform-parsed requests enforce the size limit',async()=>{
  const body={action:'login',username:'a',password:'x'};
  const req=Readable.from([Buffer.from(JSON.stringify(body))]);req.headers={'content-type':'application/json'};
  assert.deepEqual(await readJson(req),body);
  for(const value of ['{',[],{action:'login',username:'a',password:'x'.repeat(MAX_REQUEST_BYTES)}]){
    await assert.rejects(readJson({headers:{},body:value}),error=>error.status===400);
  }
  await assert.rejects(readJson({headers:{'content-length':String(MAX_REQUEST_BYTES+1)},body}),/4 MiB/);
});

test('Supabase opaque keys use apikey only; legacy service-role JWTs also use Authorization',async()=>{
  for(const [key,authorization] of [['sb_secret_example',undefined],['legacy.jwt.value','Bearer legacy.jwt.value']]){
    let observed;
    const db=createDatabase({SUPABASE_URL:'https://database.supabase.co',SUPABASE_SECRET_KEY:key},async(url,options)=>{observed={url:String(url),options};return {ok:true,json:async()=>({ok:true})};});
    assert.deepEqual(await db.rpc('workspace_tally_state',{p_user_id:USER_A.id}),{ok:true});
    assert.equal(observed.options.headers.apikey,key);assert.equal(observed.options.headers.Authorization,authorization);
    assert.equal(observed.url,'https://database.supabase.co/rest/v1/rpc/workspace_tally_state');
  }
});

test('database adapter hides raw errors, maps conflicts, and supports the legacy environment key',async()=>{
  for(const [message,code,status] of [['CONFLICT: private row details','P0001',409],['DUPLICATE: a secret username','P0001',409],['LIMIT: capacity','P0001',400],['leaked database text','XX000',503]]){
    const db=createDatabase({SUPABASE_URL:'https://database.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'legacy.jwt.key'},async()=>({ok:false,json:async()=>({message,code})}));
    await assert.rejects(db.rpc('workspace_tally_state'),error=>error.status===status&&!error.message.includes(message));
  }
});

test('history edits use session ownership and reject different report dates',async()=>{
  const db=fakeDatabase();
  const handler=createHandler({env:ENV,database:db});
  const expected={day,...delta}, replacement={...expected,mobileLines:7};
  const response=await request(handler,{cookie:session(),body:{action:'editDay',expected,replacement}});
  assert.equal(response.status,200);
  assert.deepEqual(response.body,replacement);
  assert.equal(db.calls.find(call=>call.name==='workspace_edit_day').args.p_user_id,USER_A.id);
  const invalid=await request(handler,{cookie:session(),body:{action:'editDay',expected,replacement:{...replacement,day:'2026-11-12'}}});
  assert.equal(invalid.status,400);
  const wrongUser=await request(handler,{cookie:session(),expected:USER_B.id,body:{action:'editDay',expected,replacement}});
  assert.equal(wrongUser.status,401);
});

test('team and games actions bind access to the signed-in actor',async()=>{
  const db=fakeDatabase(), cookie=session(), handler=createHandler({env:ENV,database:db});
  for (const [action,rpc] of [['teamContext','workspace_team_context'],['adminStats','workspace_admin_stats'],['adminPerformance','workspace_admin_performance'],['gameState','workspace_game_state']]) {
    const route={method:'GET',url:'/api/workspace?action='+action};
    assert.equal((await request(handler,route)).status,401);
    assert.equal((await request(handler,{...route,cookie})).status,200);
    assert.deepEqual(db.calls.find(c=>c.name===rpc).args,{p_user_id:USER_A.id});
  }
  assert.equal((await request(handler,{cookie,body:{action:'goal',key:'sales',value:50}})).status,403);
  const goals={sales:25};
  await request(handler,{cookie,body:{action:'teamGoals',agentIds:[USER_B.id],goals}});
  assert.deepEqual(db.calls.find(c=>c.name==='workspace_team_goals').args,{p_user_id:USER_A.id,p_agent_ids:[USER_B.id],p_goals:goals});
  assert.ok(db.calls.some(c=>c.name==='workspace_record_request'));
});

test('supervisor signups are requests and public signups cannot grant privileges',async()=>{
  const db=fakeDatabase(), handler=createHandler({env:ENV,database:db});
  const signup={action:'signup',username:'Leader',password:'x'};
  const pending=await request(handler,{body:{...signup,requestedRole:'supervisor'}});
  assert.equal(pending.status,202);
  assert.equal(db.calls.find(c=>c.name==='auth_request_signup').args.p_requested_role,'supervisor');
  for (const fields of [{requestedRole:'admin'},{requestedRole:null},{role:'supervisor'},{supervisorId:USER_A.id}]) {
    assert.equal((await request(handler,{body:{...signup,...fields}})).status,400);
  }
  assert.equal(db.calls.filter(c=>c.name==='auth_request_signup').length,1);
});

test('pending credentials disclose status only on a password match and cannot create sessions',async()=>{
  const stored={...USER_A,status:'pending',password_hash:await hashPassword('x')};
  const db=fakeDatabase(), rpc=db.rpc.bind(db);
  db.rpc=(name,args)=>name==='auth_get_user'?stored:rpc(name,args);
  const handler=createHandler({env:ENV,database:db});
  const login=password=>request(handler,{body:{action:'login',username:USER_A.username,password}});
  assert.equal((await login('wrong')).status,401);
  const pending=await login('x');
  assert.equal(pending.status,403);assert.equal(pending.body.error.code,'PENDING_APPROVAL');
  stored.status='unknown';
  assert.equal((await login('x')).status,503);
  assert.ok(!db.calls.some(c=>c.name==='auth_create_session'));
  assert.equal(pending.headers['set-cookie'],undefined);
});

test('admin management verifies actor and projection, binds writes and never returns hashes',async()=>{
  const db=fakeDatabase(), rpc=db.rpc.bind(db), cookie=session();
  const managed={id:USER_B.id,username:'Member',role:'agent',supervisorId:null};
  const requestedAt='2026-11-19T14:00:00Z';
  const pending={id:requestId,username:'Leader',requestedRole:'supervisor',requestedAt};
  const calls=[];
  db.rpc=(name,args)=>{
    calls.push({name,args});
    if(name==='workspace_admin_accounts')return {accounts:[{...managed,password_hash:'secret'}],pending:[{...pending,password_hash:'secret'}]};
    if(name==='workspace_team_context')return {role:'admin'};
    if(name.startsWith('workspace_admin_'))return {ok:true,password_hash:'secret'};
    return rpc(name,args);
  };
  const handler=createHandler({env:ENV,database:db});
  const directory={method:'GET',url:'/api/workspace?action=adminAccounts'};
  assert.equal((await request(handler,directory)).status,401);
  assert.deepEqual((await request(handler,{...directory,cookie})).body,{accounts:[managed],pending:[pending]});
  const assign={action:'adminAssignAccount',accountId:managed.id,role:'supervisor',supervisorId:null,expectedRole:'agent',expectedSupervisorId:null};
  assert.equal((await request(handler,{cookie,body:{...assign,expectedRole:undefined}})).status,400);
  assert.equal((await request(handler,{cookie,body:{...assign,supervisorId:USER_A.id}})).status,400);
  assert.equal((await request(handler,{cookie,expected:USER_B.id,body:assign})).status,401);
  assert.deepEqual((await request(handler,{cookie,body:assign})).body,{ok:true});
  assert.deepEqual(calls.find(c=>c.name==='workspace_admin_assign_account').args,{p_user_id:USER_A.id,p_account_id:USER_B.id,p_role:'supervisor',p_supervisor_id:null,p_expected_role:'agent',p_expected_supervisor_id:null});
  const review={action:'adminReviewSignup',requestId};
  assert.equal((await request(handler,{cookie,body:{...review,decision:'approve',role:'admin'}})).status,400);
  assert.equal((await request(handler,{cookie,body:{...review,decision:'deny',role:'agent'}})).status,400);
  for(const fields of [{decision:'approve',role:'supervisor',supervisorId:null},{decision:'deny'}]) {
    assert.deepEqual((await request(handler,{cookie,body:{...review,...fields}})).body,{ok:true});
  }
  assert.deepEqual(calls.filter(c=>c.name==='workspace_admin_review_signup').map(c=>[c.args.p_user_id,c.args.p_request_id,c.args.p_decision,c.args.p_role,c.args.p_supervisor_id]),[
    [USER_A.id,requestId,'approve','supervisor',null],[USER_A.id,requestId,'deny',null,null]
  ]);
  const create={action:'adminCreateAccount',username:'Lead',password:'X',role:'admin',supervisorId:null};
  assert.deepEqual((await request(handler,{cookie,body:create})).body,{ok:true});
  const write=calls.find(c=>c.name==='workspace_admin_create_account').args;
  assert.equal(write.p_user_id,USER_A.id);assert.equal(write.p_role,'admin');assert.equal(write.p_username,'Lead');
  assert.ok(await verifyPassword('X',write.p_password_hash));
});

test('account creation enforces signup rules and rejects non-admins before hashing',async()=>{
  const db=fakeDatabase(),cookie=session(),handler=createHandler({env:ENV,database:db});
  const create={action:'adminCreateAccount',username:'Agent',password:'x',role:'agent',supervisorId:null};
  assert.equal((await request(handler,{cookie,body:{...create,username:'Pete'}})).status,400);
  assert.equal((await request(handler,{cookie,body:create})).status,403);
  assert.ok(!db.calls.some(c=>c.name==='workspace_admin_create_account'));
});
