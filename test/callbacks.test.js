import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingReminders} from '../dist/callbacks.js';

const dueAt = '2026-12-01T05:00:00.000Z';

function call(id, dueAt, overrides = {}) {
  return {id, day: '2026-11-29', callback: {dueAt, note: '', status: 'scheduled', approved: true, ...overrides}};
}

test('a callback becomes due at the scheduled instant, including across report days', () => {
  const calls = [call('past-report-day', dueAt)];
  const midnight = Date.parse(dueAt);
  assert.equal(pendingReminders(calls, midnight - 1)[0].due, false);
  assert.equal(pendingReminders(calls, midnight)[0].due, true);
  assert.equal(pendingReminders(calls, midnight + 86_400_000)[0].due, true);
});

test('pending reminders include only approved outstanding callbacks in chronological order', () => {
  const calls = [
    call('later', '2026-12-02T08:15:00-05:00'),
    call('done', dueAt, {status: 'done'}),
    {id: 'legacy'},
    {id: 'removed', callback: null},
    call('unapproved', dueAt, {approved: false}),
    call('second', dueAt),
    call('first', '2026-11-30T21:00:00-08:00')
  ];
  const pending = pendingReminders(calls, Date.parse(dueAt));
  assert.deepEqual(pending.map(({call, due}) => [call.id, due]), [['first', true], ['second', true], ['later', false]]);
});
