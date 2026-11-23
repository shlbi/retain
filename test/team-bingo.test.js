import assert from 'node:assert/strict';
import test, {before,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {dayKey} from '../dist/model.js';
import {tallyForCall} from '../dist/tally.js';

const db = new PGlite();
const team = {}, base = Date.now();
const metrics = ['calls','savedCalls','mobileOrders','mobileLines','internet','tv','phone','mobile','dp'];
const board = {
  title:'Team bingo', incentive:'Choose the team playlist', pattern:'line',
  startsAt:new Date(base - 60000).toISOString(), endsAt:new Date(base + 3600000).toISOString(),
  squares:metrics.map(metric=>({metric,target:1}))
};
async function rpc(name,...args) {
  const sql = 'select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as result';
  return (await db.query(sql,args.map(arg=>typeof arg==='object'?JSON.stringify(arg):arg))).rows[0].result;
}
const status = user => rpc('workspace_game_state',team[user]);
const launch = (user,game=board) => rpc('workspace_launch_game',team[user],game);
const tally = (user,delta,key=randomUUID(),day=dayKey()) => rpc('workspace_tally',team[user],day,delta,key);
const sale = tallyForCall({before:['internet','tv'],kept:['internet','tv'],mobileOrders:[4]});

before(async()=>{
  await db.exec('create role anon;create role authenticated;create role service_role;');
  const dir = new URL('../supabase/migrations/',import.meta.url);
  for (const file of (await readdir(dir)).filter(file=>file.endsWith('.sql')).sort()) {
    await db.exec('begin;'+await readFile(new URL(file,dir),'utf8')+'commit;');
  }
  for (const user of ['sue','lee','amber','jane','kai','ali','maya','saif']) {
    const {rows} = await db.query(
      'insert into workspace_private.users(username,username_key,password_hash) values ($1,$1,$2) returning id',
      [user,'synthetic-hash']);
    team[user]=rows[0].id;
  }
  await db.query("update workspace_private.users set role='supervisor' where id in ($1,$2)",[team.sue,team.lee]);
  await db.query("update workspace_private.users set role='admin' where id=$1",[team.saif]);
  await db.query("update workspace_private.users set supervisor_id=$1 where id in ($2,$3,$4,$5,$6)",
    [team.sue,team.amber,team.jane,team.kai,team.ali,team.saif]);
  await db.query('update workspace_private.users set supervisor_id=$1 where id=$2',[team.lee,team.maya]);
  for (const supervisor of [team.sue,team.lee]) await rpc('workspace_game_access',team.saif,supervisor,'bingo',true);
});
after(async()=>await db.close());

test('team bingo enforces its schedule, awards only live new tallies and scopes score visibility',async()=>{
  assert.equal((await status('sue')).game,null);
  await assert.rejects(launch('saif'),/FORBIDDEN/);
  await assert.rejects(launch('jane'),/FORBIDDEN/);
  await assert.rejects(launch('sue',{...board,squares:[{metric:'name',target:1}]}),/VALIDATION/);
  await assert.rejects(launch('sue',{...board,squares:board.squares.map(cell=>({...cell,target:1.5}))}),/VALIDATION/);
  await assert.rejects(launch('sue',{...board,squares:board.squares.map(cell=>({...cell,notes:'no'}))}),/VALIDATION/);
  await assert.rejects(launch('sue',{...board,startsAt:'yesterday'}),/VALIDATION/);
  await assert.rejects(launch('sue',{...board,incentive:'x'.repeat(241)}),/VALIDATION/);
  await assert.rejects(launch('sue',{...board,endsAt:board.startsAt}),/VALIDATION/);
  const priorKey=randomUUID();
  await tally('saif',sale,priorKey);
  const live=await launch('sue');
  assert.equal(live.game.status,'live');
  assert.equal(live.members.length,5);
  assert.deepEqual((await launch('sue')).game.id,live.game.id);
  await assert.rejects(launch('sue',{...board,title:'Overlapping'}),/CONFLICT/);
  const scheduled={...board,title:'Next game',pattern:'blackout',startsAt:board.endsAt,endsAt:new Date(base+7200000).toISOString()};
  await launch('sue',scheduled);
  assert.equal((await status('maya')).game,null);
  assert.equal((await status('lee')).members.length,0);
  assert.equal((await status('saif')).me.completed,0);
  await tally('saif',sale,priorKey);
  await tally('saif',sale,randomUUID(),'2024-01-02');
  assert.equal((await status('saif')).me.completed,0);
  const liveKey=randomUUID();
  await tally('saif',sale,liveKey);
  await tally('saif',sale,liveKey);
  const adminBoard=await status('saif');
  assert.equal(adminBoard.me.won,true);
  assert.equal(adminBoard.me.completed,7);
  assert.equal(adminBoard.me.rank,1);
  assert.equal(adminBoard.me.stats.mobileLines,4);
  assert.equal(adminBoard.me.stats.dp,1);
  assert.equal(adminBoard.me.stats.calls,1);
  assert.equal(adminBoard.members.length,0);
  assert.equal(adminBoard.leaders.length,3);
  assert.equal(adminBoard.leaders[0].username,'saif');
  assert.equal(adminBoard.leaders[0].stats,undefined);
  assert.equal((await status('sue')).members[0].stats.mobileLines,4);
  const wash = tallyForCall({accounts:[
    {before:['internet'],kept:['internet'],added:['phone']},{before:['internet'],kept:[],added:[]}
  ],mobileOrders:[]});
  await tally('ali',wash);
  const washed=await status('ali');
  assert.equal(washed.me.stats.phone,1);
  assert.equal(washed.me.stats.internet,undefined);
  assert.equal(washed.me.stats.savedCalls,0);
  assert.equal(washed.me.stats.sp,undefined);
  const before=await status('saif');
  await assert.rejects(tally('saif',wash,liveKey),/CONFLICT/);
  assert.deepEqual(await status('saif'),before);
  // Moving time windows in an isolated test database exercises expiration without a sleep.
  await db.query("update workspace_private.bingo_games set starts_at=now()-interval '4 hours',ends_at=now()-interval '2 hours' where id=$1",[live.game.id]);
  assert.equal((await status('saif')).game.status,'scheduled');
  await tally('saif',sale);
  assert.equal((await status('saif')).me.completed,0);
  await db.query("update workspace_private.bingo_games set starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' where title='Next game'");
  assert.equal((await status('saif')).game.status,'finished');
  assert.equal((await status('saif')).me.completed,0);
  await db.exec('set role authenticated');
  await assert.rejects(status('sue'),/permission denied/);
  await assert.rejects(launch('sue'),/permission denied/);
  await assert.rejects(db.exec('select * from workspace_private.bingo_scores'),/permission denied/);
  await db.exec('reset role');
});

test('blackout requires all nine marks while lines include both diagonals',async()=>{
  const won=async(marks,pattern)=>(await db.query(
    'select workspace_private.bingo_won($1::boolean[],$2) as won',
    ['{'+marks.map(x=>x?'t':'f').join(',')+'}',pattern])).rows[0].won;
  for(const diagonal of [[1,0,0,0,1,0,0,0,1],[0,0,1,0,1,0,1,0,0]]){
    assert.equal(await won(diagonal,'line'),true);
    assert.equal(await won(diagonal,'blackout'),false);
  }
  assert.equal(await won([1,0,0,0,0,1,0,1,0],'line'),false);
  assert.equal(await won(Array(9).fill(1),'blackout'),true);
});

test('realtime uses empty invalidations and abandons the old topic when a player departs', async()=>{
  assert.equal((await status('jane')).channel,null);
  // Record database calls to the real Supabase signature, without opening a live channel.
  await db.exec(`create schema realtime;
    create table realtime.test_delivery(payload jsonb,event text,topic text,private boolean);
    create function realtime.send(jsonb,text,text,boolean) returns void language sql as
      'insert into realtime.test_delivery values ($1,$2,$3,$4)';`);
  const channel=(await status('sue')).channel;
  assert.match(channel,/^bingo-[0-9a-f-]{36}$/);
  assert.equal((await status('jane')).channel,channel);
  const game=await launch('sue',{...board,title:'Live push test'});
  assert.equal(game.channel,channel);
  const token=randomUUID();
  await tally('saif',sale,token);
  await tally('saif',sale,token);
  const delivered=async()=> (await db.query('select * from realtime.test_delivery')).rows;
  const expected={payload:{},event:'refresh',topic:channel,private:false};
  assert.deepEqual(await delivered(),[expected,expected]);
  await db.query('update workspace_private.users set supervisor_id=$1 where id=$2',[team.lee,team.jane]);
  const nextChannel=(await status('sue')).channel;
  assert.notEqual(nextChannel,channel);
  assert.notEqual((await status('jane')).channel,nextChannel);
  await tally('saif',sale);
  assert.deepEqual((await delivered()).at(-1),{...expected,topic:nextChannel});
  // Production retired the legacy calls table via the standalone cleanup installer.
  await db.exec('drop table if exists workspace_private.calls restrict');
  await db.query('delete from workspace_private.users where id=$1',[team.kai]);
  assert.notEqual((await status('sue')).channel,nextChannel);
  // Delivery errors do not roll back call logging or score updates.
  await db.exec(`create or replace function realtime.send(jsonb,text,text,boolean) returns void
    language plpgsql as $$begin raise exception 'delivery outage'; end;$$;`);
  const prior=(await status('saif')).me.stats.calls;
  await tally('saif',sale);
  assert.equal((await status('saif')).me.stats.calls,prior+1);
});

test('admin grants, concurrent moves and checkpoint scoring stay scoped to the current team',async()=>{
  const day=dayKey(), config={metric:'savedCalls',bonus:'mobileOrders',target:1,mode:'Standard'};
  const game={...board,title:'Tower',startsAt:new Date(Date.now()-5000).toISOString(),endsAt:new Date(Date.now()+300000).toISOString()};
  await db.exec('delete from workspace_private.bingo_games');
  const schedule=()=>rpc('workspace_arcade_launch',team.sue,team.sue,'elevator',config,game);
  await assert.rejects(schedule(),/FORBIDDEN/);
  await assert.rejects(rpc('workspace_game_access',team.lee,team.sue,'elevator',true),/FORBIDDEN/);
  await rpc('workspace_game_access',team.saif,team.sue,'elevator',true);
  assert.ok((await rpc('workspace_game_library',team.sue)).games.includes('elevator'));
  assert.ok(!(await rpc('workspace_game_library',team.lee)).games.includes('elevator'));
  await schedule();await rpc('workspace_game_access',team.saif,team.sue,'elevator',false);
  await assert.rejects(schedule(),/FORBIDDEN/);
  const snap=()=>rpc('workspace_arcade_snapshot',team.amber);
  let s=await snap();assert.equal(s.kind,'elevator');assert.equal((await rpc('workspace_arcade_snapshot',team.maya)).game,null);
  const world={[team.amber]:{ride:{calls:0,primary:0,bonus:0}}};
  const move=(u,v)=>rpc('workspace_arcade_move',team[u],s.game.id,v,world);
  assert.equal(await move('maya',s.revision),false);assert.equal(await move('amber',s.revision),true);assert.equal(await move('amber',s.revision),false);
  const token=randomUUID();await tally('amber',sale,token,day);await tally('amber',sale,token,day);
  s=await snap();assert.equal(s.world[team.amber].floor,1);assert.equal(s.world[team.amber].ride,undefined);
  assert.equal(s.players.find(p=>p.id===team.amber).stats.calls,1);
  for (const role of ['anon','authenticated']) {
    const {rows:[row]}=await db.query("select has_function_privilege($1,'public.workspace_arcade_snapshot(uuid)','execute') as allowed",[role]);
    assert.equal(row.allowed,false);
  }
});

test('The Belt counts only calls inside each duel and starts a fresh quota for the defending champion',async()=>{
  await db.exec('delete from workspace_private.bingo_games');
  const config={metric:'savedCalls',bonus:'mobileOrders',target:1,mode:'Standard'};
  const game={...board,title:'The Belt',startsAt:new Date(Date.now()-4000).toISOString(),endsAt:new Date(Date.now()+300000).toISOString()};
  await rpc('workspace_arcade_launch',team.saif,team.sue,'belt',config,game);
  const snapshot=()=>rpc('workspace_arcade_snapshot',team.sue);
  const [champ,rival,next]= (await snapshot()).players;
  const hit=async p=>rpc('workspace_tally',p.id,dayKey(),sale,randomUUID());
  await hit(next);await hit(champ);await hit(champ);await hit(rival);
  let d=(await snapshot()).world.duel;
  assert.equal(d.champ,champ.id);assert.equal(d.opponent,next.id);assert.deepEqual(d.scores,{});
  await hit(next);
  d=(await snapshot()).world.duel;
  assert.equal(d.scores[next.id].calls,1);assert.equal(d.scores[next.id].points,3);
  assert.equal(d.scores[champ.id],undefined);
});
