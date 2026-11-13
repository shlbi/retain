import test from 'node:test';
import assert from 'node:assert/strict';
import { callsToCsv, matchesFilter } from '../dist/reporting.js';

const account = (before, kept, added = []) => ({account: '', before, kept, added});

test('legacy downgrades appear in both service filters and use the new outcome in CSV', () => {
  const call = {before:['tv','internet','phone'], kept:['tv','phone'], mobileOrders:[]};
  for (const filter of ['saved', 'disconnected', 'downgrade']) assert.equal(matchesFilter(call, filter), true);
  assert.equal(matchesFilter(call, 'wash'), false);
  assert.match(callsToCsv([call]), /"TP → DP","Internet, Video, Voice","Video, Voice","Internet"/);
});

test('wash filters preserve independent additions and multiple orders within one CSV row', () => {
  const call = {
    ucid:'=1+1', accounts:[account(['tv'], ['tv'], ['mobile']), account(['tv'], [])],
    mobileOrders:[2,5], callback:{dueAt:'2026-11-13T19:00:00.000Z',status:'scheduled',note:'@call "later"'}
  };
  for (const filter of ['wash','saved','mobile']) assert.equal(matchesFilter(call, filter), true);
  for (const filter of ['disconnected','downgrade']) assert.equal(matchesFilter(call, filter), false);
  const csv = callsToCsv([call]);
  assert.equal(csv.split('\r\n').length, 2);
  assert.match(csv, /"Account 1: Wash \(SPS\) \| Account 2: Wash \(SPD\)"/);
  assert.match(csv, /"Account 1: Mobile \| Account 2: —","2","7","2; 5"/);
  assert.match(csv, /"'=1\+1"/);
  assert.match(csv, /"'@call ""later"""/);
});
