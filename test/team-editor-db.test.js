import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import {after, before, beforeEach, test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {dayKey} from '../dist/model.js';
import {tallyForCall} from '../dist/tally.js';

let db;
let ids;
const rpc = async (name, ...args) => {
  const params = args.map((_, i) => '$' + (i + 1)).join(',');
  return (await db.query('select public.' + name + '(' + params + ') as result', args)).rows[0].result;
};
const member = (name, supervisor = null) => ({id:ids[name], expectedSupervisorId:ids[supervisor] ?? null});
const directory = () => rpc('workspace_admin_accounts', ids.owner);
const context = name => rpc('workspace_team_context', ids[name]);
const gameState = name => rpc('workspace_game_state', ids[name]);
const roster = async name => (await context(name)).agents.map(agent => agent.username);
const save = ({original = null, supervisor, name, expectedName = null, expectedMembers = [], members = [], actor = 'owner'}) =>
  rpc('workspace_admin_save_team_details', ids[actor], ids[original] ?? null, ids[supervisor] ?? null,
    name, expectedName, '{' + expectedMembers.map(username => ids[username]).join(',') + '}', JSON.stringify(members));
const launch = (supervisor, hoursAhead = 0) => {
  const start = Date.now() + 3600000 * hoursAhead - 60000;
  return rpc('workspace_launch_game', ids[supervisor], JSON.stringify({
    title:'Game ' + hoursAhead, incentive:'Coffee', pattern:'line',
    startsAt:new Date(start).toISOString(), endsAt:new Date(start + 3600000).toISOString(),
    squares:Array.from({length:9}, () => ({metric:'calls', target:2}))
  }));
};
const recordTally = name => rpc('workspace_tally', ids[name], dayKey(),
  JSON.stringify(tallyForCall({before:['internet'], kept:['internet'], mobileOrders:[]})), randomUUID());

before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role');
  const path = new URL('../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(path)).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec('begin;\n' + await readFile(new URL(file, path), 'utf8') + '\ncommit;');
  }
});
after(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec('truncate workspace_private.users cascade');
  ids = {};
  for (const [role, names] of Object.entries({admin:['owner'], supervisor:['alpha','beta','spare'], agent:['ann','ben','cam','dee']})) {
    for (const name of names) {
      const {rows:[user]} = await db.query(
        'insert into workspace_private.users(username,username_key,password_hash,role) values ($1,$1,$2,$3) returning id',
        [name,'synthetic',role]);
      ids[name] = user.id;
    }
  }
  await rpc('workspace_admin_save_team', ids.owner, ids.alpha, 'First', null);
  await rpc('workspace_admin_add_team_members', ids.owner, ids.alpha, JSON.stringify([member('ann'),member('ben')]));
  await rpc('workspace_admin_save_team', ids.owner, ids.beta, 'Second', null);
  await rpc('workspace_admin_add_team_members', ids.owner, ids.beta, JSON.stringify([member('cam')]));
});

const editFirst = overrides => save({original:'alpha', supervisor:'alpha', name:'First', expectedName:'First',
  expectedMembers:['ben','ann'], members:[member('ann','alpha'),member('ben','alpha')], ...overrides});

test('create and edit use a complete selection, including confirmed transfers and an empty roster', async () => {
  assert.deepEqual(await save({supervisor:'spare', name:' Third ', members:[member('cam','beta'),member('dee')]}), {ok:true});
  assert.equal((await context('spare')).teamName, 'Third');
  assert.deepEqual(await roster('spare'), ['cam','dee']);
  assert.deepEqual(await roster('beta'), []);
  assert.deepEqual(await editFirst({name:'First Shift', members:[member('ben','alpha'),member('owner')]}), {ok:true});
  assert.deepEqual(await roster('alpha'), ['ben','owner']);
  assert.equal((await context('ann')).supervisorId, null);
  await save({original:'spare', supervisor:'spare', name:'Third', expectedName:'Third', expectedMembers:['dee','cam']});
  assert.deepEqual(await roster('spare'), []);
  assert.deepEqual((await directory()).teams.map(team => team.name), ['First Shift','Second','Third']);
});

test('replacing a supervisor moves the team, active and scheduled games, and existing scores together', async () => {
  const activeId = (await launch('alpha')).game.id;
  await launch('alpha', 3);
  await recordTally('ann');
  const games = async () => (await db.query('select id,supervisor_id from workspace_private.bingo_games order by starts_at')).rows;
  const channels = async () => (await db.query(
    'select username,bingo_channel from workspace_private.users where id in ($1,$2) order by username', [ids.alpha,ids.spare])).rows;
  const oldGames = await games();
  const oldChannels = await channels();

  await editFirst({supervisor:'spare', name:'Night shift', members:[member('ann','alpha'),member('cam','beta')]});

  assert.deepEqual(await games(), oldGames.map(game => ({...game, supervisor_id:ids.spare})));
  assert.equal((await context('spare')).teamName, 'Night shift');
  assert.deepEqual(await roster('spare'), ['ann','cam']);
  assert.equal((await gameState('spare')).game.id, activeId);
  assert.equal((await gameState('ann')).me.stats.calls, 1);
  await recordTally('ann');
  assert.equal((await gameState('ann')).me.stats.calls, 2);
  assert.equal((await gameState('cam')).game.id, activeId);
  assert.equal((await gameState('ben')).game, null);
  assert.deepEqual((await directory()).teams.map(team => team.name), ['Night shift','Second']);
  assert.deepEqual(await context('alpha'), {role:'supervisor', supervisorId:null, teamName:null, agents:[]});
  assert.equal((await gameState('alpha')).game, null);
  await assert.rejects(rpc('workspace_agent_state', ids.alpha, ids.ann), /FORBIDDEN/);
  await assert.rejects(rpc('workspace_team_goals', ids.alpha, '{' + ids.ann + '}', '{"overall":80}'), /FORBIDDEN/);
  await assert.rejects(launch('alpha', 5), /TEAM_REQUIRED/);
  const newChannels = await channels();
  assert.ok(newChannels.every((row, i) => oldChannels[i].bingo_channel !== row.bingo_channel));
});

test('stale roster, transfer and name snapshots reject the whole submission', async () => {
  const expectUnchanged = async (saveAttempt, reason) => {
    const snapshot = await directory();
    await assert.rejects(saveAttempt(), reason);
    assert.deepEqual(await directory(), snapshot);
  };
  await expectUnchanged(() => save({supervisor:'spare', name:'Never created',
    members:[member('dee'),member('cam')]}), /CONFLICT/);
  await expectUnchanged(() => editFirst({supervisor:'spare', expectedName:'Old name'}), /CONFLICT/);
  await expectUnchanged(() => editFirst({supervisor:'spare', expectedMembers:['ann']}), /CONFLICT/);
  await expectUnchanged(() => editFirst({name:'Never renamed', members:[member('ann','alpha'),member('beta')]}), /CONFLICT/);
  await expectUnchanged(() => editFirst({name:'second'}), /TEAM_NAME_TAKEN/);
  await expectUnchanged(() => editFirst({supervisor:'beta'}), /SUPERVISOR_TAKEN/);
  await expectUnchanged(() => editFirst({supervisor:'dee'}), /INVALID_TEAM/);
  await expectUnchanged(() => editFirst({actor:'alpha'}), /FORBIDDEN/);
  await expectUnchanged(() => editFirst({actor:'dee'}), /FORBIDDEN/);
  // Another admin transfers an agent after the first editor opens.
  await rpc('workspace_admin_add_team_members', ids.owner, ids.beta, JSON.stringify([member('ann','alpha')]));
  await expectUnchanged(() => editFirst({supervisor:'spare', name:'Never moved'}), /CONFLICT/);
  await expectUnchanged(() => save({supervisor:'spare', name:'Never created',
    members:[member('ann','alpha'),member('dee')]}), /CONFLICT/);
});

test('only the server role may execute the RPC; malformed payloads cannot clear the roster', async () => {
  const signature = 'public.workspace_admin_save_team_details(uuid,uuid,uuid,text,text,uuid[],jsonb)';
  for (const role of ['anon','authenticated','service_role']) {
    const {rows:[result]} = await db.query("select has_function_privilege($1,$2,'execute') as allowed", [role, signature]);
    assert.equal(result.allowed, role === 'service_role');
  }
  const snapshot = await directory();
  for (const bad of [null, {}, [null], [member('ann','alpha'),member('ann','alpha')], [{id:ids.dee}],
    [{id:ids.dee, expectedSupervisorId:'invalid'}], [{...member('dee'), extra:true}]]) {
    await assert.rejects(editFirst({members:bad}), /INVALID_TEAM/);
  }
  await assert.rejects(editFirst({expectedMembers:['ann','ann','ben']}), /INVALID_TEAM/);
  await assert.rejects(editFirst({name:'a\nteam'}), /INVALID_TEAM/);
  assert.deepEqual(await directory(), snapshot);
});
