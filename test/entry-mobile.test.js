import test from 'node:test';
import assert from 'node:assert/strict';
import { callFromEntry } from '../dist/entry-tally.js';
import { tallyForCall } from '../dist/tally.js';

test('orders add Mobile once to each new mobile account while existing subscribers keep their chosen outcome', () => {
  const draft = { accounts: [
    {before:['internet'],kept:['internet'],added:['tv'],mobileOrders:[12,2]},
    {before:['mobile'],kept:[],added:[],mobileOrders:[1]},
    {before:['phone'],kept:[],added:[],mobileOrders:[]}
  ] };
  const call = callFromEntry(draft);
  assert.deepEqual(call.accounts.map(account => account.added), [['tv','mobile'],[],[]]);
  const totals = tallyForCall(call);
  assert.equal(totals.calls,1);
  assert.equal(totals.mobileOrders,3);
  assert.equal(totals.mobileLines,15);
  assert.deepEqual(totals.groups.find(group => group.before.includes('mobile')).kept,[]);
  assert.deepEqual(draft.accounts[0].added,['tv']);

  draft.accounts[0].mobileOrders = [];
  draft.accounts[2].mobileOrders.push(1);
  assert.deepEqual(callFromEntry(draft).accounts.map(account => account.added), [['tv'],[],['mobile']]);
});
