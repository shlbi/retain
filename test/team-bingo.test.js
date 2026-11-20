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
    team[user]=(await rpc('auth_register',user,'synthetic-hash')).id;
  }
  await db.query("update workspace_private.users set role='supervisor' where id in ($1,$2)",[team.sue,team.lee]);
  await db.query("update workspace_private.users set role='admin' where id=$1",[team.saif]);
  await db.query("update workspace_private.users set supervisor_id=$1 where id in ($2,$3,$4,$5,$6)",
    [team.sue,team.amber,team.jane,team.kai,team.ali,team.saif]);
  await db.query('update workspace_private.users set supervisor_id=$1 where id=$2',[team.lee,team.maya]);
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
