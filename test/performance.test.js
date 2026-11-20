import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

let db, admin, agent;
const today = "(now() at time zone 'America/New_York')::date";
const report = async actor => (await db.query('select public.workspace_admin_performance($1) as data',[actor])).rows[0].data;

before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const dir = new URL('../supabase/migrations/', import.meta.url);
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) {
    await db.exec('begin;' + await readFile(new URL(name, dir), 'utf8') + 'commit;');
  }
  ({rows:[{id:admin},{id:agent}]} = await db.query(
    "insert into workspace_private.users (username,username_key,password_hash,role) values ('admin','admin','test','admin'),('agent','agent','test','agent') returning id"
  ));
});

after(async () => { await db?.close(); });

test('performance charts preserve reporting dates, historical work after role changes, and measured request time', async () => {
  const initial = await report(admin);
  assert.deepEqual(Object.keys(initial), ['days']);
  assert.equal(initial.days.length, 28);
  assert.ok(initial.days.every(row => row.requests === 0 && row.calls === 0 && row.activeAgents === 0));
  await db.query(`insert into workspace_private.tally_days values
    ($1,${today},2,2,1,0,0,0),($2,${today},4,4,4,0,0,0),($1,${today}-1,0,0,0,0,0,0),
    ($1,${today}-27,3,3,2,0,0,0),($2,${today}-28,100,100,100,0,0,0)`,[agent,admin]);
  await db.query("update workspace_private.users set role='supervisor' where id=$1",[agent]);
  await db.query(`insert into workspace_private.request_days values
    (${today},3,1,801),(${today}-27,1,0,200),(${today}-28,100,50,900)`);
  const {days} = await report(admin);
  assert.deepEqual(days[0],{day:initial.days[0].day,activeAgents:1,calls:3,requests:1,errors:0,totalMs:200});
  assert.deepEqual(days.at(-1),{day:initial.days.at(-1).day,activeAgents:2,calls:6,requests:3,errors:1,totalMs:801});
  assert.equal(days.at(-2).activeAgents,0);
  assert.equal(days.reduce((n,d) => n + d.calls,0),9);
  assert.equal(new Set(days.map(d => d.day)).size, 28);
  assert.deepEqual(days.map(d=>d.day),days.map(d=>d.day).sort());
});

test('only the service-role RPC bound to an administrator can read performance', async () => {
  await assert.rejects(report(agent), /FORBIDDEN/);
  for (const role of ['anon','authenticated','service_role']) {
    const {rows:[row]} = await db.query("select has_function_privilege($1,'public.workspace_admin_performance(uuid)','execute') as permitted",[role]);
    assert.equal(row.permitted, role === 'service_role');
  }
});
