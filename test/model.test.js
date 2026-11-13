import test from 'node:test';
import assert from 'node:assert/strict';
import { accountsFor, classifyAccount, outcomesForCall, classifyCall, calculateMetrics, successesNeeded, ordersFor, soldOrdersFor, soldLinesFor, dayKey } from '../dist/model.js';

/** Build the minimal call facts needed to exercise metric rules. */
function call(before, kept, soldLines = 0) { return { before, kept, soldLines }; }
/** Retrieve one named metric from a set of call facts. */
function metric(calls, key, goals) { return calculateMetrics(calls, goals).find(item => item.key === key); }

test('single-service accounts score their service and single-play on full saves and losses', () => {
  for (const service of ['internet', 'tv', 'phone', 'mobile']) {
    const calls = [call([service], [service]), call([service], [])];
    assert.deepEqual(calls.map(c => classifyCall(c.before, c.kept).code), ['SPS', 'SPD']);
    assert.equal(metric(calls, service).rate, 50);
    assert.equal(metric(calls, 'sp').rate, 50);
    assert.equal(metric(calls, 'bundle').rate, null);
  }
});

test('full bundle outcomes score each original service, the starting tier, and bundle rate', () => {
  const dp = ['tv','internet'];
  const tp = ['tv','internet','phone'];
  const calls = [call(dp, dp), call(dp, []), call(tp, tp)];
  assert.deepEqual(calls.map(c => classifyCall(c.before, c.kept).code), ['DPS','DPD','TPS']);
  assert.equal(metric(calls, 'dp').rate, 50);
  assert.equal(metric(calls, 'tp').rate, 100);
  assert.equal(metric(calls, 'sp').total, 0);
  for (const key of ['internet','tv','bundle']) {
    assert.equal(metric(calls, key).successes, 2);
    assert.equal(metric(calls, key).total, 3);
  }
  assert.equal(metric(calls,'phone').total, 1);
});

test('downgrades on both new and historical records exclude every play tier and bundle', () => {
  const examples = [
    [['internet','tv'], ['tv'], 'DP → SP'],
    [['internet','tv','phone'], ['tv','phone'], 'TP → DP'],
    [['internet','tv','phone'], ['phone'], 'TP → SP'],
    [['internet','tv','phone','mobile'], ['tv','phone','mobile'], 'TP (4 → 3)']
  ];
  for (const [before,kept,code] of examples) {
    const account = {account:'A', before, kept, added:[]};
    for (const record of [account, {accounts:[account]}]) {
      const [outcome] = outcomesForCall(record);
      assert.equal(outcome.code, code);
      assert.equal(outcome.kind, 'downgrade');
      assert.equal(outcome.washed, false);
      for (const key of ['sp','dp','tp','bundle']) assert.equal(metric([record],key).total, 0);
      for (const key of before) {
        const service = metric([record],key);
        assert.equal(service.total, 1);
        assert.equal(service.successes, Number(kept.includes(key)));
      }
      assert.equal(metric([record],'overall').rate, 100);
    }
  }
});

test('new services earn one opportunity and one save, independently of the starting tier and lines sold', () => {
  const record = {accounts:[{account:'A', before:['internet','tv'], kept:['tv'], added:['mobile','phone']}],mobileOrders:[12,3]};
  assert.equal(outcomesForCall(record)[0].code, 'DP → SP');
  for (const key of ['mobile','phone']) {
    assert.equal(metric([record], key).successes, 1);
    assert.equal(metric([record], key).total, 1);
  }
  assert.equal(metric([record], 'orders').successes, 2);
  assert.equal(metric([record], 'sales').successes, 15);
  assert.equal(metric([record], 'bundle').total, 0);
  assert.equal(metric([record], 'internet').rate, 0);
});

test('wash pairs match by starting service set within one call and only cancel one account on each side', () => {
  const accounts = [
    {account:'A',before:['tv','internet'],kept:['internet','tv'],added:['phone']},
    {account:'B',before:['internet','tv'],kept:[]},
    {account:'C',before:['tv','internet'],kept:['tv','internet']},
    {account:'D',before:['mobile'],kept:[]}
  ];
  const record = {accounts, mobileOrders:[2,4]};
  const outcomes = outcomesForCall(record);
  assert.deepEqual(outcomes.map(o => [o.index, o.account, o.washed]), [
    [0,'A',true], [1,'B',true], [2,'C',false], [3,'D',false]
  ]);
  for (const key of ['dp','bundle','tv','internet','phone']) {
    const result = metric([record],key);
    assert.equal(result.successes, 1);
    assert.equal(result.total, 1);
  }
  assert.equal(metric([record], 'mobile').rate, 0);
  assert.equal(metric([record], 'sp').rate, 0);
  assert.equal(metric([record], 'overall').total, 1);
  assert.equal(metric([record], 'overall').rate, 100);
  assert.equal(metric([record], 'orders').total, 1);
  assert.equal(metric([record], 'orders').successes, 2);
  assert.equal(metric([record], 'sales').successes, 6);

  const washOnly = {accounts: accounts.slice(0, 2), mobileOrders:[3]};
  for (const key of ['overall','bundle','dp','tv','internet']) assert.equal(metric([washOnly],key).total, 0);
  assert.equal(metric([washOnly],'phone').rate, 100);
  assert.equal(metric([washOnly],'sales').rate, 300);
});

test('similar but different bundles, separate calls, and partial saves do not wash', () => {
  const saved = call(['tv','internet'],['tv','internet']);
  const lost = call(['internet','mobile'],[]);
  const downgrade = call(['internet','mobile'],['mobile']);
  assert.deepEqual(outcomesForCall({accounts:[saved,lost,downgrade]}).map(o=>o.washed),[false,false,false]);
  const separate = [saved, call(saved.before,[])];
  assert.equal(metric(separate,'bundle').rate,50);
  assert.equal(metric(separate,'overall').total,2);
});

test('account reader handles legacy data and uses explicit new account facts in preference to old mirrors', () => {
  const old = {account:'A',before:['tv'],kept:['tv']};
  assert.deepEqual(accountsFor(old),[{...old,added:[]}]);
  const modern = {...old,accounts:[{account:'B',before:['mobile'],kept:[],added:['phone']}]};
  assert.equal(outcomesForCall(modern)[0].account, 'B');
  assert.equal(metric([modern],'tv').total, 0);
  assert.equal(classifyAccount({before:['phone'],kept:['phone'],added:['phone']}).added.length,0);
});

test('one mobile line sold across ten calls is ten percent', () => {
  const calls = Array.from({ length:10 }, (_, index) => call(['internet'], ['internet'], index === 0 ? 1 : 0));
  assert.equal(metric(calls, 'sales').rate, 10);
  assert.equal(metric(calls, 'mobile').rate, null);
});

test('multiple new lines count independently and may exceed 100 percent', () => {
  const calls = [call(['internet'], ['internet'], 3), call(['tv'], [], 1)];
  const sales = metric(calls, 'sales');
  assert.equal(sales.successes, 4);
  assert.equal(sales.total, 2);
  assert.equal(sales.rate, 200);
  assert.equal(sales.progress, 1);
  assert.equal(sales.needed, 0);
  assert.equal(metric(calls, 'overall').rate, 50);
});

test('existing mobile loss and new mobile line sales remain independent', () => {
  const calls = [call(['internet', 'mobile'], ['internet'], 2)];
  assert.equal(metric(calls, 'mobile').rate, 0);
  assert.equal(metric(calls, 'sales').rate, 200);
  assert.equal(classifyCall(calls[0].before, calls[0].kept).code, 'DP → SP');
});

test('legacy line helper prefers explicit zero and accepts one order of at most twelve lines', () => {
  assert.equal(soldLinesFor({ sold:true }), 1);
  assert.equal(soldLinesFor({ sold:false }), 0);
  assert.equal(soldLinesFor({ sold:true, soldLines:0 }), 0);
  assert.equal(soldLinesFor({ sold:false, soldLines:12 }), 12);
  assert.equal(soldOrdersFor({ soldLines:12 }), 1);
  for (const invalid of [-1, 13, 20, 1.5, '3', NaN, null]) {
    assert.equal(soldLinesFor({ soldLines:invalid }), 0);
    assert.equal(soldOrdersFor({ soldLines:invalid }), 0);
  }
});

test('one three-line order across ten calls yields ten percent orders and thirty percent lines', () => {
  const calls = Array.from({ length:10 }, (_, index) => ({ before:['internet'], kept:['internet'], mobileOrders:index === 0 ? [3] : [] }));
  const orders = metric(calls, 'orders');
  const lines = metric(calls, 'sales');
  assert.equal(orders.successes, 1);
  assert.equal(orders.rate, 10);
  assert.equal(orders.needed, 2);
  assert.equal(orders.reached, false);
  assert.equal(orders.progress, 0.5);
  assert.equal(lines.successes, 3);
  assert.equal(lines.rate, 30);
  assert.equal(lines.needed, 0);
  assert.equal(lines.reached, true);
  assert.equal(lines.progress, 1);
});

test('multiple independent orders count individually and sum their line quantities', () => {
  const multiple = { before:['internet'], kept:['internet'], mobileOrders:[12, 3, 1] };
  assert.deepEqual(ordersFor(multiple), [12, 3, 1]);
  assert.equal(soldOrdersFor(multiple), 3);
  assert.equal(soldLinesFor(multiple), 16);
  const calls = [multiple, { before:['tv'], kept:[], mobileOrders:[] }];
  assert.equal(metric(calls, 'orders').rate, 150);
  assert.equal(metric(calls, 'sales').rate, 800);
  assert.equal(metric(calls, 'orders').progress, 1);
  assert.equal(metric(calls, 'sales').progress, 1);
});

test('canonical order quantities override legacy fields and cannot mutate the stored array', () => {
  const empty = { mobileOrders:[], soldLines:12, sold:true };
  assert.deepEqual(ordersFor(empty), []);
  assert.equal(soldOrdersFor(empty), 0);
  assert.equal(soldLinesFor(empty), 0);
  const populated = { mobileOrders:[2, 4], soldLines:1, sold:false };
  assert.equal(soldOrdersFor(populated), 2);
  assert.equal(soldLinesFor(populated), 6);
  const copy = ordersFor(populated);
  copy.push(12);
  assert.deepEqual(populated.mobileOrders, [2, 4]);
});

test('invalid canonical orders are not silently split or replaced by legacy sale counts', () => {
  for (const invalid of [[13], [0], [1.5], ['3'], [2, -1], new Array(1), null, '3', 3]) {
    const record = { mobileOrders:invalid, soldLines:3, sold:true };
    assert.deepEqual(ordersFor(record), []);
    assert.equal(soldOrdersFor(record), 0);
    assert.equal(soldLinesFor(record), 0);
  }
});

test('remaining counts include new denominators and use the minimum possible wins', () => {
  assert.equal(successesNeeded(1, 10, 20), 2);
  assert.equal(successesNeeded(8, 10, 80), 0);
  assert.equal(successesNeeded(7, 10, 80), 5);
  assert.equal(successesNeeded(0, 0, 80), 1);
  for (const goal of [5, 20, 75, 80, 85, 95, 99]) {
    for (let total = 1; total <= 25; total++) {
      for (let saved = 0; saved <= total; saved++) {
        const needed = successesNeeded(saved, total, goal);
        assert.ok((saved + needed) / (total + needed) * 100 >= goal - 1e-8);
        if (needed) assert.ok((saved + needed - 1) / (total + needed - 1) * 100 < goal - 1e-8);
      }
    }
  }
});

test('zero and one-hundred-percent goals do not divide by zero', () => {
  assert.equal(successesNeeded(0, 0, 0), 0);
  assert.equal(successesNeeded(0, 10, 0), 0);
  assert.equal(successesNeeded(9, 10, 100), null);
  assert.equal(successesNeeded(10, 10, 100), 0);
  assert.equal(successesNeeded(0, 0, 100), 1);
  const zero = metric([call(['tv'], [])], 'overall', { overall:0 });
  assert.equal(zero.progress, 1);
  assert.equal(zero.reached, true);
});

test('invalid target inputs fail explicitly and invalid configured goals use defaults', () => {
  for (const target of [-1, 101, NaN, Infinity]) assert.throws(() => successesNeeded(1, 10, target), RangeError);
  assert.throws(() => successesNeeded(1.5, 10, 80), RangeError);
  assert.equal(metric([], 'overall', { overall:NaN }).goal, 85);
});

test('mobile counts as a service and TP explicitly groups three or four services', () => {
  const all = ['internet', 'tv', 'phone', 'mobile'];
  assert.equal(classifyCall(['mobile'], ['mobile']).code, 'SPS');
  assert.equal(classifyCall(all, all).code, 'TPS');
  assert.equal(classifyCall(all, []).code, 'TPD');
  assert.equal(classifyCall(all, ['internet', 'mobile']).code, 'TP → DP');
  const tp = metric([call(all, all), call(all, [])], 'tp');
  assert.equal(tp.rate, 50);
  assert.equal(tp.label, 'Triple-play (3+)');
});

test('an empty day has no fabricated rates and no reached goals', () => {
  for (const item of calculateMetrics([])) {
    assert.equal(item.rate, null);
    assert.equal(item.reached, false);
    assert.equal(item.progress, 0);
    assert.equal(item.needed, 1);
  }
});

test('unclassifiable calls do not contaminate reporting denominators', () => {
  assert.equal(classifyCall(null, []), null);
  assert.equal(classifyCall([], []), null);
  assert.equal(metric([call([], []), call(['tv'], ['tv'])], 'overall').total, 1);
});

test('Eastern reporting day remains stable across UTC midnight and daylight-saving transitions', () => {
  assert.equal(dayKey(new Date('2026-11-06T02:00:00Z')), '2026-11-05');
  assert.equal(dayKey(new Date('2026-11-06T05:00:00Z')), '2026-11-06');
  assert.equal(dayKey(new Date('2026-11-01T05:30:00Z')), '2026-11-01');
  assert.equal(dayKey(new Date('2026-11-01T06:30:00Z')), '2026-11-01');
});
