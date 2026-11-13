const callbackTime = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
});
const maxTimerDelay = 2 ** 31 - 1;
let nextReminderTimer;
let previousRows = '';

export function formatCallbackTime(dueAt) {
  return callbackTime.format(new Date(dueAt));
}

export function pendingReminders(calls, now = Date.now()) {
  return calls.filter(call => call.callback?.status === 'scheduled' && call.callback.approved)
    .map(call => {
      const dueAt = Date.parse(call.callback.dueAt);
      return {call, dueAt, due: dueAt <= now};
    })
    .sort((a, b) => a.dueAt - b.dueAt || a.call.id.localeCompare(b.call.id));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function reminderRow({call, due}) {
  const row = document.createElement('li');
  const info = element('div', 'callback-info', '');
  const when = element('div', 'callback-when', '');
  const time = element('time', '', formatCallbackTime(call.callback.dueAt));
  time.dateTime = call.callback.dueAt;
  when.append(time);
  if (due) when.append(element('span', 'callback-due-badge', 'Due'));
  info.append(when);

  const account = call.account || call.accounts?.find(item => item.account)?.account;
  const identifier = account ? 'Account ' + account : call.ucid ? 'UCID ' + call.ucid : 'Call on ' + call.day + ' at ' + call.time + ' ET';
  const open = element('button', 'callback-record text-button', identifier);
  open.type = 'button';
  open.dataset.call = call.id;
  open.setAttribute('aria-label', 'View call details for ' + identifier);
  info.append(open);
  if (call.callback.note) info.append(element('p', 'callback-note', call.callback.note));

  const done = element('button', 'button secondary callback-complete', 'Mark done');
  done.type = 'button';
  done.dataset.action = 'complete-callback';
  done.dataset.callbackId = call.id;
  done.dataset.revision = call.revision;
  done.setAttribute('aria-label', 'Mark callback done for ' + identifier);
  row.append(info, done);
  return row;
}

export function renderCallbackReminders(calls) {
  clearTimeout(nextReminderTimer);
  const reminders = pendingReminders(calls);
  const list = document.getElementById('callback-reminder-list');
  const panel = document.getElementById('callback-reminder-panel');
  const alert = document.getElementById('callback-due-alert');
  const message = document.getElementById('callback-due-message');
  const dueCount = reminders.filter(item => item.due).length;
  const dueMessage = dueCount === 1 ? '1 callback is due.' : dueCount + ' callbacks are due.';

  alert.hidden = !dueCount;
  if (message.textContent !== (dueCount ? dueMessage : '')) message.textContent = dueCount ? dueMessage : '';
  panel.hidden = !reminders.length;
  document.getElementById('callback-reminder-count').textContent = reminders.length;

  // Keep focused rows in place during the routine cloud refresh.
  const rowKey = JSON.stringify(reminders.map(({call, due}) => [
    call.id, call.revision, due, call.callback.dueAt, call.callback.note, call.ucid, call.account,
    call.accounts?.map(item => item.account), call.day, call.time
  ]));
  if (rowKey !== previousRows) {
    const focused = list.contains(document.activeElement) ? document.activeElement.dataset : null;
    previousRows = rowKey;
    list.replaceChildren(...reminders.map(reminderRow));
    if (focused) {
      const id = focused.callbackId || focused.call;
      const key = focused.callbackId ? 'callbackId' : 'call';
      Array.from(list.querySelectorAll('button')).find(button => button.dataset[key] === id)?.focus({preventScroll: true});
    }
  }

  const next = reminders.find(item => !item.due);
  if (next) {
    const delay = Math.min(maxTimerDelay, Math.max(0, next.dueAt - Date.now()));
    nextReminderTimer = setTimeout(() => renderCallbackReminders(calls), delay);
  }
}
