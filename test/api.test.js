import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHandler, readJson, MAX_REQUEST_BYTES } from '../server/workspace-handler.js';
import { createDatabase, ApiError, databaseError } from '../server/database.js';
import { hashPassword, verifyPassword, newSession, tokenHash } from '../server/auth.js';
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
    if(name==='auth_create_verified_session')return true;
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
  assert.ok(!db.calls.some(call=>['auth_create_session','auth_create_verified_session','auth_register'].includes(call.name)));
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
  assert.deepEqual(db.calls.filter(call=>['auth_create_verified_session','auth_logout'].includes(call.name)).map(call=>call.name),['auth_create_verified_session','auth_logout']);
  assert.equal(db.calls.find(call=>call.name==='auth_create_verified_session').args.p_expected_hash,stored.password_hash);
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

test('only a precisely identified pre-reset schema allows the legacy session RPC',async()=>{
  const stored={...USER_A,status:'active',password_hash:await hashPassword('x')};
  const missing={code:'PGRST202',message:'Could not find the function public.auth_create_verified_session(p_expected_hash, p_expires_at, p_token_hash, p_user_id) in the schema cache'};
  for (const [outcome,expectedStatus,useLegacy] of [
    [missing,200,true],[false,401,false],[null,503,false],
    [{...missing,code:'42501'},503,false],[{...missing,message:'Another function is missing'},503,false],
    [{code:'P0001',message:'FORBIDDEN: details'},403,false],[new Error('timeout'),503,false]
  ]) {
    const db=fakeDatabase(),rpc=db.rpc.bind(db),legacy=[];
    db.rpc=(name,args)=>{
      if (name==='auth_get_user') return stored;
      if (name==='auth_create_verified_session') {
        if (outcome instanceof Error) throw outcome;
        if (outcome?.code) throw databaseError(outcome,name);
        return outcome;
      }
      if (name==='auth_create_session') {legacy.push(args);return {ok:true};}
      return rpc(name,args);
    };
    const response=await request(createHandler({env:ENV,database:db}),{body:{action:'login',username:USER_A.username,password:'x'}});
    assert.equal(response.status,expectedStatus);
    assert.equal(legacy.length,useLegacy ? 1 : 0);
    assert.equal(Boolean(response.headers['set-cookie']),useLegacy);
    if (useLegacy) assert.deepEqual(Object.keys(legacy[0]).sort(),['p_expires_at','p_token_hash','p_user_id']);
  }
});

test('password change requests and completions are same-origin, rate limited and anonymous',async()=>{
  const username='Previous Agent',body={action:'requestPasswordChange',username};
  const db=fakeDatabase(),rpc=db.rpc.bind(db),calls=[];
  db.rpc=(name,args)=>{
    calls.push({name,args});
    if (name==='auth_request_password_change') return {ok:true,found:args.p_username===username};
    return rpc(name,args);
  };
  const handler=createHandler({env:ENV,database:db});
  for (const value of [username,'Missing','Pending']) {
    const before=calls.length;
    const response=await request(handler,{body:{...body,username:value}});
    assert.equal(response.status,200);
    assert.deepEqual(response.body,{ok:true});
    assert.equal(response.headers['set-cookie'],undefined);
    assert.deepEqual(calls.slice(before).map(call=>call.name),['auth_rate_limit','auth_rate_limit','auth_request_password_change']);
    assert.doesNotMatch(calls[before+1].args.p_key,/Previous|Missing|Pending/);
  }
  const complete={action:'completePasswordChange',username,code:'a'.repeat(32),password:'x'};
  const stopped=fakeDatabase({allowed:false});
  const limited=createHandler({env:ENV,database:stopped});
  for (const data of [body,complete]) {
    assert.equal((await request(limited,{body:data,headers:{origin:'https://unrelated.example'}})).status,400);
    assert.equal((await request(limited,{body:data})).status,429);
  }
  assert.deepEqual(stopped.calls.map(c=>c.name),['auth_rate_limit','auth_rate_limit']);
  const count=calls.length;
  for (const data of [{...body,username:'a'.repeat(65)},{...body,password:'x'},
    {...complete,password:'🔐'.repeat(9)},{...complete,password:''},{...complete,code:'short'}]) {
    assert.equal((await request(handler,{body:data})).status,400);
  }
  assert.ok(!calls.slice(count).some(call=>call.name.includes('password_change')));
});

test('admin approval returns a one-time displayed code and only digests reach storage',async()=>{
  const cookie=session(),username='1 Legacy User',calls=[];
  const db=fakeDatabase(), rpc=db.rpc.bind(db),pending={id:requestId,username,requestedAt:'2026-11-22T12:00:00Z'};
  db.rpc=(name,args)=>{
    calls.push({name,args});
    if (name==='workspace_admin_accounts') return {accounts:[],pending:[],teams:[],passwordChanges:[{...pending,token_hash:'secret'}]};
    if (name==='workspace_admin_review_password_change' || name==='auth_complete_password_change') return {ok:true,token_hash:'secret'};
    return rpc(name,args);
  };
  const handler=createHandler({env:ENV,database:db});
  const directory=await request(handler,{method:'GET',url:'/api/workspace?action=adminAccounts',cookie});
  assert.deepEqual(directory.body.passwordChanges,[pending]);
  const review={action:'adminReviewPasswordChange',requestId,decision:'approve'};
  assert.equal((await request(handler,{body:review})).status,401);
  for (const patch of [{requestId:'bad'},{decision:'open'},{code:'client-supplied'},{userId:USER_A.id}]) {
    assert.equal((await request(handler,{cookie,body:{...review,...patch}})).status,400);
  }
  const approved=await request(handler,{cookie,body:review});
  assert.equal(approved.headers['cache-control'],'no-store');
  const code=approved.body.code;
  assert.match(code,/^[0-9a-f]{32}$/);
  assert.deepEqual(approved.body,{ok:true,code});
  assert.deepEqual(calls.find(c=>c.name==='workspace_admin_review_password_change').args,
    {p_user_id:USER_A.id,p_request_id:requestId,p_decision:'approve',p_token_hash:tokenHash(code)});
  const denied=await request(handler,{cookie,body:{...review,decision:'deny'}});
  assert.deepEqual(denied.body,{ok:true});
  assert.equal(calls.filter(c=>c.name==='workspace_admin_review_password_change').at(-1).args.p_token_hash,null);
  const password='🔐'.repeat(8);
  const completed=await request(handler,{body:{action:'completePasswordChange',username,password,code:' '+code.toUpperCase()+' '}});
  assert.equal(completed.status,200);
  assert.deepEqual(completed.body,{ok:true});
  assert.equal(completed.headers['set-cookie'],undefined);
  const saved=calls.find(c=>c.name==='auth_complete_password_change').args;
  assert.equal(saved.p_username,username);
  assert.equal(saved.p_token_hash,tokenHash(code));
  assert.ok(await verifyPassword(password,saved.p_password_hash));
  assert.ok(!JSON.stringify(calls).includes(code));
  assert.ok(!JSON.stringify(calls).includes(password));
  const fail=databaseError({code:'P0001',message:'INVALID_RESET: internal state'},'auth_complete_password_change');
  const failures=createHandler({env:ENV,database:fakeDatabase({fail:{auth_complete_password_change:fail}})});
  const input={action:'completePasswordChange',username,password};
  const wrong=await request(failures,{body:{...input,code}});
  const malformed=await request(failures,{body:{...input,code:'wrong'}});
  assert.deepEqual(wrong.body,malformed.body);
  assert.equal(wrong.status,400);
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
  for(const value of ['{',[],{action:['login']},{action:{toString:'login'}},{action:'login',username:'a',password:'x'.repeat(MAX_REQUEST_BYTES)}]){
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
  for(const [message,code,status] of [['CONFLICT: private row details','P0001',409],['DUPLICATE: a secret username','P0001',409],['TEAM_REQUIRED: missing team row','P0001',403],['LIMIT: capacity','P0001',400],['leaked database text','XX000',503]]){
    const db=createDatabase({SUPABASE_URL:'https://database.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'legacy.jwt.key'},async()=>({ok:false,json:async()=>({message,code})}));
    await assert.rejects(db.rpc('workspace_tally_state'),error=>error.status===status&&!error.message.includes(message));
  }
});

test('an older directory still serves Accounts and reports that Teams needs its migration',async()=>{
  const db=fakeDatabase(), rpc=db.rpc.bind(db);
  db.rpc=(name,args)=>name==='workspace_admin_accounts' ? {accounts:[],pending:[]} : rpc(name,args);
  const handler=createHandler({env:ENV,database:db});
  const response=await request(handler,{method:'GET',url:'/api/workspace?action=adminAccounts',cookie:session()});
  assert.equal(response.status,200);
  assert.deepEqual(response.body,{accounts:[],pending:[],teams:null,passwordChanges:[]});

  const missing=createDatabase({SUPABASE_URL:'https://database.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_example'},
    async()=>({ok:false,json:async()=>({code:'PGRST202',message:'private schema cache details'})}));
  for(const name of ['workspace_admin_save_team','workspace_admin_add_team_members']) {
    await assert.rejects(missing.rpc(name),error=>error.code==='SETUP' && error.message.includes('named teams') && !error.message.includes('private'));
  }
  await assert.rejects(missing.rpc('workspace_tally_state'),error=>error.code==='STORAGE');
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

test('the team report takes its supervisor from the session and has no writable or selectable target',async()=>{
  const db=fakeDatabase(), rpc=db.rpc.bind(db), calls=[];
  const report={version:4,memberCount:2,goals:{...DEFAULT_GOALS,overall:null},days:[
    {day,...delta,calls:3_000_000_000,eligibleCalls:3_000_000_000,savedCalls:3_000_000_000,
      groups:[{...delta.groups[0],count:3_000_000_000}]}
  ]};
  db.rpc=(name,args)=>{
    if (name!=='workspace_team_report') return rpc(name,args);
    calls.push(args);
    return report;
  };
  const handler=createHandler({env:ENV,database:db});
  const route={method:'GET',url:'/api/workspace?action=teamReport'};
  const cookie=session();
  assert.equal((await request(handler,route)).status,401);
  assert.equal((await request(handler,{...route,cookie,expected:USER_B.id})).status,401);
  assert.equal((await request(handler,{...route,cookie,url:route.url+'&supervisorId='+USER_B.id})).status,400);
  assert.equal((await request(handler,{cookie,body:{action:'teamReport'}})).status,400);
  assert.deepEqual(calls,[]);
  const response=await request(handler,{...route,cookie});
  assert.equal(response.status,200);
  assert.deepEqual(response.body,report);
  assert.deepEqual(calls,[{p_user_id:USER_A.id}]);
});

test('team reports protect names, grouped data and the distinction between shared and varying goals',async()=>{
  const empty={version:4,memberCount:0,days:[],goals:Object.fromEntries(Object.keys(DEFAULT_GOALS).map(key=>[key,null]))};
  let report=empty;
  const db=fakeDatabase(), rpc=db.rpc.bind(db);
  db.rpc=(name,args)=>name==='workspace_team_report' ? report : rpc(name,args);
  const handler=createHandler({env:ENV,database:db});
  const read=()=>request(handler,{method:'GET',url:'/api/workspace?action=teamReport',cookie:session()});
  assert.deepEqual((await read()).body,empty);
  for (const invalid of [
    {...empty,agentName:'private-identifier'}, {...empty,goals:DEFAULT_GOALS}, {...empty,memberCount:1},
    {...empty,memberCount:2,goals:{...DEFAULT_GOALS,orders:101}}, {...empty,memberCount:-1},
    {...empty,memberCount:2,days:[{day,...delta,account:'private-identifier'}]},
    {...empty,memberCount:2,days:[{day,...delta},{day,...delta}]}
  ]) {
    report=invalid;
    const response=await read();
    assert.equal(response.status,503);
    assert.equal(response.body.error.code,'STORAGE');
    assert.ok(!JSON.stringify(response.body).includes('private-identifier'));
  }
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
  assert.ok(!db.calls.some(c=>['auth_create_session','auth_create_verified_session'].includes(c.name)));
  assert.equal(pending.headers['set-cookie'],undefined);
});

test('admin management verifies actor and projection, binds writes and never returns hashes',async()=>{
  const db=fakeDatabase(), rpc=db.rpc.bind(db), cookie=session();
  const managed={id:USER_B.id,username:'Member',role:'agent',supervisorId:null};
  const requestedAt='2026-11-19T14:00:00Z';
  const pending={id:requestId,username:'Leader',requestedRole:'supervisor',requestedAt};
  const team={supervisorId:USER_A.id,name:'North'};
  const calls=[];
  db.rpc=(name,args)=>{
    calls.push({name,args});
    if(name==='workspace_admin_accounts')return {accounts:[{...managed,password_hash:'secret'}],pending:[{...pending,password_hash:'secret'}],teams:[{...team,private_field:'secret'}]};
    if(name==='workspace_team_context')return {role:'admin'};
    if(name.startsWith('workspace_admin_'))return {ok:true,password_hash:'secret'};
    return rpc(name,args);
  };
  const handler=createHandler({env:ENV,database:db});
  const directory={method:'GET',url:'/api/workspace?action=adminAccounts'};
  assert.equal((await request(handler,directory)).status,401);
  assert.deepEqual((await request(handler,{...directory,cookie})).body,{accounts:[managed],pending:[pending],teams:[team],passwordChanges:[]});
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

test('named team and roster updates bind the verified admin and the prior assignments',async()=>{
  const db = fakeDatabase(), rpc = db.rpc.bind(db), cookie = session();
  const writes = [];
  db.rpc = (name,args) => {
    if (['workspace_admin_save_team','workspace_admin_add_team_members'].includes(name)) {
      writes.push({name,args}); return {ok:true};
    }
    return rpc(name,args);
  };
  const handler = createHandler({env:ENV,database:db});
  const save = {action:'adminSaveTeam',supervisorId:USER_B.id,name:' North ',expectedName:null};
  assert.equal((await request(handler,{body:save})).status,401);
  assert.equal((await request(handler,{cookie,expected:USER_B.id,body:save})).status,401);
  assert.equal((await request(handler,{cookie,body:save})).status,200);
  assert.deepEqual(writes[0].args,{p_user_id:USER_A.id,p_supervisor_id:USER_B.id,p_name:'North',p_expected_name:null});
  assert.equal((await request(handler,{cookie,body:{...save,name:"O'Brien's Team",expectedName:'North'}})).status,200);
  assert.deepEqual(writes[1].args,{p_user_id:USER_A.id,p_supervisor_id:USER_B.id,p_name:"O'Brien's Team",p_expected_name:'North'});
  const members = [{id:USER_A.id,expectedSupervisorId:null},{id:requestId,expectedSupervisorId:USER_A.id}];
  const transfer = {action:'adminAddTeamMembers',supervisorId:USER_B.id,members};
  assert.deepEqual((await request(handler,{cookie,body:transfer})).body,{ok:true});
  assert.deepEqual(writes[2],{name:'workspace_admin_add_team_members',args:{p_user_id:USER_A.id,p_supervisor_id:USER_B.id,p_members:members}});
  for (const body of [
    {...save,name:'   '},{...save,name:'A'.repeat(61)},{...save,name:'Night\nCrew'},{...save,expectedName:undefined},
    {...save,supervisorId:null},{...save,userId:USER_B.id},
    {...transfer,supervisorId:null},{...transfer,members:[]},{...transfer,members:[{id:USER_A.id}]},
    {...transfer,members:[{id:USER_B.id,expectedSupervisorId:null}]},
    {...transfer,members:[members[1],{...members[1],id:members[1].id.toUpperCase()}]},
    {...transfer,members:[{...members[1],role:'admin'}]},
    {...transfer,members:[{id:USER_A.id,expectedSupervisorId:'old team'}]}
  ]) assert.equal((await request(handler,{cookie,body})).status,400);
  assert.equal(writes.length,3);
  const forbidden = new ApiError(403,'FORBIDDEN','Administrator access required.');
  const denied = createHandler({env:ENV,database:fakeDatabase({fail:{
    workspace_admin_save_team:forbidden,workspace_admin_add_team_members:forbidden
  }})});
  for (const body of [save,transfer]) assert.equal((await request(denied,{cookie,body})).status,403);
});

test('the team editor submits the name, supervisor and complete roster as one authenticated write',async()=>{
  const rpcName='workspace_admin_save_team_details';
  const db=fakeDatabase(), rpc=db.rpc.bind(db), writes=[], cookie=session();
  db.rpc=(name,args)=>{
    if (name !== rpcName) return rpc(name,args);
    writes.push(args);
    return {ok:true,private_field:'not returned'};
  };
  const handler=createHandler({env:ENV,database:db});
  const create={action:'adminSaveTeamDetails',originalSupervisorId:null,supervisorId:USER_B.id,
    name:' North ',expectedName:null,expectedMemberIds:[],members:[{id:USER_A.id,expectedSupervisorId:requestId}]};
  const edit={...create,originalSupervisorId:USER_B.id,supervisorId:requestId,
    name:'Northwest',expectedName:'North',expectedMemberIds:[USER_A.id],members:[]};
  assert.equal((await request(handler,{body:create})).status,401);
  assert.equal((await request(handler,{cookie,expected:USER_B.id,body:create})).status,401);
  for (const body of [create,edit]) {
    const response=await request(handler,{cookie,body});
    assert.equal(response.status,200);
    assert.deepEqual(response.body,{ok:true});
  }
  assert.deepEqual(writes,[
    {p_user_id:USER_A.id,p_original_supervisor_id:null,p_supervisor_id:USER_B.id,p_name:'North',
      p_expected_name:null,p_expected_member_ids:[],p_members:create.members},
    {p_user_id:USER_A.id,p_original_supervisor_id:USER_B.id,p_supervisor_id:requestId,p_name:'Northwest',
      p_expected_name:'North',p_expected_member_ids:[USER_A.id],p_members:[]}
  ]);
  const forbidden=createHandler({env:ENV,database:fakeDatabase({fail:{[rpcName]:new ApiError(403,'FORBIDDEN','Only admins may manage teams.')}})});
  assert.equal((await request(forbidden,{cookie,body:create})).status,403);
  const unconfirmed=createHandler({env:ENV,database:fakeDatabase()});
  assert.equal((await request(unconfirmed,{cookie,body:edit})).status,503);
});

test('the team editor rejects invalid or incomplete snapshots before any write',async()=>{
  const db=fakeDatabase(), handler=createHandler({env:ENV,database:db}), cookie=session();
  const edit={action:'adminSaveTeamDetails',originalSupervisorId:USER_B.id,supervisorId:USER_B.id,
    name:'North',expectedName:'North',expectedMemberIds:[requestId],members:[{id:requestId,expectedSupervisorId:USER_B.id}]};
  for (const patch of [
    {userId:USER_A.id},{originalSupervisorId:'bad'},{originalSupervisorId:undefined},{supervisorId:null},
    {name:'   '},{name:'Night\nCrew'},{name:'a'.repeat(61)},{expectedName:null},{expectedName:undefined},
    {originalSupervisorId:null,expectedMemberIds:[]},{originalSupervisorId:null,expectedName:null},
    {expectedMemberIds:undefined},{expectedMemberIds:['bad']},{expectedMemberIds:[USER_B.id]},
    {expectedMemberIds:[requestId,requestId.toUpperCase()]},{members:null},{members:undefined},
    {members:[{id:requestId}]},{members:[{id:requestId,expectedSupervisorId:'bad'}]},
    {members:[{id:USER_B.id,expectedSupervisorId:null}]},{members:[{...edit.members[0],role:'agent'}]},
    {members:[edit.members[0],{...edit.members[0],id:requestId.toUpperCase()}]}
  ]) {
    assert.equal((await request(handler,{cookie,body:{...edit,...patch}})).status,400);
  }
  assert.ok(!db.calls.some(call=>call.name==='workspace_admin_save_team_details'));
});

test('team editor database conflicts and missing migrations have specific safe messages',async()=>{
  for (const [category,pgCode,status,expectedCode,word] of [
    ['CONFLICT','P0001',409,'CONFLICT','assignments'],
    ['TEAM_NAME_TAKEN','P0001',409,'TEAM_NAME_TAKEN','team name'],
    ['SUPERVISOR_TAKEN','P0001',409,'SUPERVISOR_TAKEN','supervisor'],
    ['INVALID_TEAM','P0001',400,'INVALID_TEAM','team'],
    ['unknown','23505',409,'CONFLICT','team'],
    ['unknown','PGRST202',503,'SETUP','Supabase']
  ]) {
    const db=createDatabase({SUPABASE_URL:'https://database.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_example'},
      async()=>({ok:false,json:async()=>({code:pgCode,message:category+': private database details'})}));
    await assert.rejects(db.rpc('workspace_admin_save_team_details'),error=>
      error.status===status && error.code===expectedCode && error.message.includes(word) && !error.message.includes('private'));
  }
});

const deleteTeam = {action:'adminDeleteTeam',supervisorId:USER_B.id,expectedTeamId:requestId,
  expectedName:'North',expectedMemberIds:[USER_A.id]};
const deleteAccount = {action:'adminDeleteAccount',accountId:USER_B.id,expectedUsername:'1 Legacy User',expectedRole:'supervisor',
  expectedSupervisorId:null,expectedTeamId:requestId,expectedTeamName:'North',expectedMemberIds:[USER_A.id]};

test('the directory publishes stable team identifiers and ownership for account deletion',async()=>{
  const owner={id:USER_B.id,username:'Member',role:'agent',supervisorId:null,ownedTeamId:requestId,ownedTeamName:'Dormant'};
  const team={id:requestId,supervisorId:USER_B.id,name:'North'};
  const db=fakeDatabase(), rpc=db.rpc.bind(db);
  db.rpc=(name,args)=>name==='workspace_admin_accounts'
    ? {accounts:[{...owner,password_hash:'secret'}],teams:[{...team,internal_detail:'private'}],pending:[]}
    : rpc(name,args);
  const actual=await request(createHandler({env:ENV,database:db}),{method:'GET',url:'/api/workspace?action=adminAccounts',cookie:session()});
  assert.deepEqual(actual.body,{accounts:[owner],teams:[team],pending:[],passwordChanges:[]});
});

test('deletion binds verified identity, complete snapshots, and database confirmation',async()=>{
  const db=fakeDatabase(), rpc=db.rpc.bind(db), writes=[], cookie=session();
  db.rpc=(name,args)=>{
    if (!name.startsWith('workspace_admin_delete_')) return rpc(name,args);
    writes.push({name,args});
    return {ok:true,private_field:'filtered'};
  };
  const handler=createHandler({env:ENV,database:db});
  const agent={...deleteAccount,expectedRole:'agent',expectedSupervisorId:requestId,
    expectedUsername:'🌷'.repeat(64),expectedTeamId:null,expectedTeamName:null,expectedMemberIds:[]};
  const forbidden=new ApiError(403,'FORBIDDEN','Administrator access required.');
  const denied=createHandler({env:ENV,database:fakeDatabase({fail:{workspace_admin_delete_team:forbidden,workspace_admin_delete_account:forbidden}})});
  const unconfirmed=createHandler({env:ENV,database:fakeDatabase()});
  for (const body of [deleteTeam,deleteAccount,agent]) {
    assert.equal((await request(handler,{body})).status,401);
    assert.equal((await request(handler,{cookie,expected:USER_B.id,body})).status,401);
    assert.equal((await request(denied,{cookie,body})).status,403);
    assert.equal((await request(unconfirmed,{cookie,body})).status,503);
    const result=await request(handler,{cookie,body});
    assert.equal(result.status,200);
    assert.deepEqual(result.body,{ok:true});
  }
  assert.deepEqual(writes,[
    {name:'workspace_admin_delete_team',args:{p_user_id:USER_A.id,p_supervisor_id:USER_B.id,
      p_expected_team_id:requestId,p_expected_name:'North',p_expected_member_ids:[USER_A.id]}},
    {name:'workspace_admin_delete_account',args:{p_user_id:USER_A.id,p_account_id:USER_B.id,p_expected_username:'1 Legacy User',
      p_expected_role:'supervisor',p_expected_supervisor_id:null,p_expected_team_id:requestId,p_expected_team_name:'North',p_expected_member_ids:[USER_A.id]}},
    {name:'workspace_admin_delete_account',args:{p_user_id:USER_A.id,p_account_id:USER_B.id,p_expected_username:agent.expectedUsername,
      p_expected_role:'agent',p_expected_supervisor_id:requestId,p_expected_team_id:null,p_expected_team_name:null,p_expected_member_ids:[]}}
  ]);
});

test('deletion rejects self, admin targets, and malformed snapshots before a delete RPC',async()=>{
  const db=fakeDatabase(), cookie=session(), handler=createHandler({env:ENV,database:db});
  for (const patch of [{accountId:USER_A.id},{expectedRole:'admin'}]) {
    assert.equal((await request(handler,{cookie,body:{...deleteAccount,...patch}})).status,403);
  }
  for (const body of [
    {...deleteTeam,expectedName:null},{...deleteTeam,expectedTeamId:null},{...deleteTeam,supervisorId:'bad'},
    {...deleteTeam,expectedMemberIds:[requestId,requestId.toUpperCase()]},{...deleteTeam,expectedMemberIds:[USER_B.id]},
    {...deleteAccount,accountId:'bad'},{...deleteAccount,expectedUsername:' '},{...deleteAccount,expectedUsername:'🌷'.repeat(65)},
    {...deleteAccount,expectedRole:'unknown'},{...deleteAccount,expectedSupervisorId:requestId},{...deleteAccount,userId:USER_A.id},
    {...deleteAccount,expectedTeamId:null},{...deleteAccount,expectedTeamName:null},
    {...deleteAccount,expectedTeamId:null,expectedTeamName:null}
  ]) assert.equal((await request(handler,{cookie,body})).status,400);
  for (const body of [deleteTeam,deleteAccount]) {
    for (const key of Object.keys(body)) {
      const incomplete={...body};
      delete incomplete[key];
      assert.equal((await request(handler,{cookie,body:incomplete})).status,400);
    }
  }
  assert.ok(!db.calls.some(call=>call.name.startsWith('workspace_admin_delete_')));
});

test('deletion diagnostics distinguish a changed team or account from a storage outage',async()=>{
  for (const name of ['workspace_admin_delete_team','workspace_admin_delete_account']) {
    for (const [category,pgCode,status,expectedCode] of [
      ['CONFLICT','P0001',409,'CONFLICT'],['FORBIDDEN','P0001',403,'FORBIDDEN'],['VALIDATION','P0001',400,'VALIDATION'],
      ['unknown','PGRST202',503,'SETUP'],['unknown','XX000',503,'STORAGE']
    ]) {
      const db=createDatabase({SUPABASE_URL:'https://database.supabase.co',SUPABASE_SECRET_KEY:'sb_secret_example'},
        async()=>({ok:false,json:async()=>({code:pgCode,message:category+': private data'})}));
      await assert.rejects(db.rpc(name),error=>error.status===status && error.code===expectedCode && !error.message.includes('private'));
    }
  }
});

test('game scheduling has no team override and game reads use the current session actor',async()=>{
  const db = fakeDatabase(), cookie = session(), handler = createHandler({env:ENV,database:db});
  const schedule = {action:'gameSchedule',title:'Bingo',incentive:'',startsAt:'2026-11-19T12:00:00Z',
    endsAt:'2026-11-19T19:00:00Z',pattern:'line',squares:Array(9).fill({metric:'calls',target:1})};
  for (const field of ['teamId','supervisorId','p_user_id']) {
    assert.equal((await request(handler,{cookie,body:{...schedule,[field]:USER_B.id}})).status,400);
  }
  await request(handler,{cookie,body:schedule});
  const launch = db.calls.find(c => c.name === 'workspace_launch_game');
  assert.equal(launch.args.p_user_id,USER_A.id);
  assert.equal(launch.args.p_game.title,'Bingo');
  await request(handler,{cookie,method:'GET',url:'/api/workspace?action=gameState&supervisorId='+USER_B.id});
  assert.deepEqual(db.calls.find(c => c.name === 'workspace_game_state').args,{p_user_id:USER_A.id});
});

test('one-call corrections bind both dates to the signed-in agent and reject spoofed fields',async()=>{
  const db = fakeDatabase(), cookie = session();
  const handler = createHandler({env:ENV,database:{async rpc(name,args) {
    if (name === 'workspace_correct_call') {
      assert.equal(args.p_user_id,USER_A.id);
      assert.equal(args.p_request_id,requestId);
      return args.p_changes.map(({day,replacement}) => ({day,summary:replacement}));
    }
    return db.rpc(name,args);
  }}});
  const body = {action:'correctCall',requestId,source:{day,...delta},original:delta,revised:null,destinationDay:day,destination:null};
  assert.deepEqual((await request(handler,{body,cookie})).body,[{day,summary:null}]);
  assert.equal((await request(handler,{body,cookie,expected:USER_B.id})).status,401);
  assert.equal((await request(handler,{body:{...body,userId:USER_B.id},cookie})).status,400);
  assert.equal((await request(handler,{body:{...body,original:{...delta,accountNumber:'ignored?'}},cookie})).status,400);
});
