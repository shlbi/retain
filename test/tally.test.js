import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateMetrics } from '../dist/model.js';
import { tallyForCall, groupsFromDays, metricsForDay } from '../dist/tally.js';

test('one saved delta collapses repeat accounts and excludes all identifiers, order details and time', () => {
  const a = {before:['tv','internet'], kept:['tv'], added:['phone'], account:'example-123'};
  const b = {...a, before:['internet','tv'], account:'example-456'};
  const draft = {accounts:[a,b], mobileOrders:[3,2], time:'21:35', ucid:'example', note:'private'};
  assert.deepEqual(tallyForCall(draft), {
    calls:1, eligibleCalls:1, savedCalls:1, saleCalls:1, mobileOrders:2, mobileLines:5,
    groups:[{before:['internet','tv'],kept:['tv'],added:['phone'],washed:false,count:2}]
  });
  assert.throws(() => tallyForCall({accounts:[a,{before:[],kept:[]}]}));
});

test('group history combines only identical outcomes, independently of display or input order', () => {
  const one = tallyForCall({before:['tv','phone','internet'], kept:['phone','internet']});
  const two = tallyForCall({before:['internet','tv','phone'], kept:['internet','phone']});
  const mixed = tallyForCall({before:['tv','phone'], kept:['tv']});
  const merged = groupsFromDays([one,two,mixed]);
  assert.deepEqual(merged,groupsFromDays([mixed,two,one]));
  assert.equal(merged.length,2);
  assert.equal(merged.find(g=>g.before.length===3).count,2);
  assert.equal(one.groups[0].count,1);
});

test('metrics can be reconstructed after refresh including wash additions, bundles and orders', () => {
  const calls = [
    {accounts:[{before:['tv'],kept:['tv'],added:['mobile']},{before:['tv'],kept:[]}]},
    {accounts:[{before:['phone','internet'],kept:['internet']},{before:['mobile'],kept:[]}]},
    {before:['internet','tv','phone'],kept:['internet','tv','phone'],mobileOrders:[6,12]},
    {before:['mobile'],kept:[],mobileOrders:[]}
  ];
  const days = calls.map(tallyForCall);
  const day = {calls:4, eligibleCalls:3, savedCalls:2, saleCalls:1, mobileOrders:2, mobileLines:18,
    groups:groupsFromDays(days)};
  assert.deepEqual(metricsForDay(day),calculateMetrics(calls));
  const metrics = Object.fromEntries(metricsForDay(day).map(m=>[m.key,m]));
  assert.equal(metrics.overall.total,3);
  assert.equal(metrics.overall.successes,2);
  assert.equal(metrics.mobile.total,3);
  assert.equal(metrics.mobile.successes,1);
  assert.equal(metrics.bundle.total,1);
  assert.equal(metrics.sales.rate,450);
  assert.deepEqual(metricsForDay(undefined),calculateMetrics([]));
});
