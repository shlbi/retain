import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { tallyForCall } from '../dist/tally.js';
import { historyEditor } from '../dist/history-editor.js';
import { createRepository } from '../dist/storage.js';

test('history corrections persist, retry safely, enforce ownership and reject stale snapshots',async()=>{
  const db = new PGlite();
  const rpc = async(name,args) => (await db.query('select public.'+name+'('+args.map((_,index)=>'$'+(index+1)).join(',')+') as r',
    args.map(value => typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].r;
  try {
    await db.exec('create role anon;create role authenticated;create role service_role;');
    const dir = new URL('../supabase/migrations/',import.meta.url);
    for (const file of (await readdir(dir)).filter(file=>file.endsWith('.sql')).sort()) {
      await db.exec('begin;'+await readFile(new URL(file,dir),'utf8')+'commit;');
    }
    const user=await rpc('auth_register',['edituser','test-hash']);
    const other=await rpc('auth_register',['other','test-hash']);
    const delta=tallyForCall({before:['internet','tv'],kept:['internet'],mobileOrders:[3]});
    const original=await rpc('workspace_tally',[user.id,'2026-11-06',delta,randomUUID()]);
    const form=historyEditor(original);
    assert.match(form,/data-edit-group="0"/);
    assert.match(form,/data-services="Kept"/);
    assert.match(form,/name="count-0" value="1"/);
    const replacement={...original,groups:[{...original.groups[0],kept:['tv']}],mobileLines:5};
    const write = (expected,next,id=user.id)=>rpc('workspace_edit_day',[id,expected,next]);
    assert.deepEqual(await write(original,replacement),replacement);
    assert.deepEqual(await write(original,replacement),replacement);
    assert.deepEqual((await rpc('workspace_tally_state',[user.id])).days,[replacement]);
    await assert.rejects(write(original,replacement,other.id),/CONFLICT/);
    const latest=await rpc('workspace_tally',[user.id,original.day,delta,randomUUID()]);
    await assert.rejects(write(replacement,{...replacement,mobileLines:7}),/CONFLICT/);
    await assert.rejects(write(latest,{...latest,mobileLines:100}),/VALIDATION/);
    await assert.rejects(write(latest,{...latest,groups:[{...latest.groups[0],account:'private'}]}),/VALIDATION/);
    await assert.rejects(write(latest,{...latest,savedCalls:0}),/VALIDATION/);
    assert.deepEqual((await rpc('workspace_tally_state',[user.id])).days,[latest]);
    await db.exec('set role authenticated');
    await assert.rejects(write(latest,latest),/permission denied/);
    await db.exec('reset role');
    const calls=[];
    const repository=createRepository(user.id,async(action,data,id)=>{
      calls.push({action,data,id});
      return write(data.expected,data.replacement,id);
    });
    const corrected={...latest,mobileLines:9};
    assert.deepEqual(await repository.editDay(latest,corrected),corrected);
    assert.equal(calls[0].id,user.id);
    assert.equal(calls[0].action,'editDay');
    repository.close();
    await assert.rejects(repository.editDay(corrected,latest),/Sign in/);
  } finally { await db.close(); }
});
