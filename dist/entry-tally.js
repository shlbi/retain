import { SERVICES, dayKey, outcomesForCall } from './model.js';

const emptyAccount = () => ({before: [], kept: [], added: []});
const emptyDraft = () => ({accounts: [emptyAccount()], mobileOrders: []});
const maxOrders = 20;
const maxLines = 12;
const buttonLabel = {save: 'save', downgrade: 'neutral', disconnect: 'disconnect'};

function toggle(list, key) {
  return list.includes(key) ? list.filter(item => item !== key) : [...list, key];
}

function serviceBadges(keys, label, style) {
  return SERVICES.filter(service => keys.includes(service.key))
    .map(service => `<span class="badge ${style}">${service.short} ${label}</span>`).join('');
}

function outcomePreview(draft) {
  return outcomesForCall(draft).map(outcome => {
    const wash = outcome.washed ? '<span class="badge neutral">Wash</span>' : '';
    const label = draft.accounts.length > 1 ? `<span class="entry-account-label">Account ${outcome.index + 1}</span>` : '';
    return `<div class="entry-tag-group">${label}${wash}
      <span class="badge ${buttonLabel[outcome.kind]}">${outcome.code}</span>
      ${serviceBadges(outcome.kept, 'kept', 'save')}
      ${serviceBadges(outcome.disconnected, 'disconnected', 'disconnect')}
      ${serviceBadges(outcome.added, 'added', 'save')}</div>`;
  }).join('');
}

export function createTallyEntry({submit, onClose, icon = () => ''}) {
  const panel = document.getElementById('entry-panel');
  const form = panel.querySelector('form');
  const field = id => panel.querySelector('#' + id);
  const accountSelect = field('account-select');
  const firstService = () => field('start-services').querySelector('button')?.focus();
  let draft = emptyDraft(), selected = 0;
  let writing = false, unavailable = false, submission = null;

  function message(text = '') {
    field('form-error').textContent = text;
    field('form-error').hidden = !text;
  }

  function lockControls() {
    const editable = !writing && !unavailable && !submission;
    for (const control of form.querySelectorAll('select,button')) {
      control.disabled = control.type === 'submit' ? writing || unavailable : !editable || control.hasAttribute('data-limit');
    }
    field('submit-label').textContent = writing ? 'Saving…' : submission ? 'Retry save' : 'Save tally';
    form.setAttribute('aria-busy', String(writing));
  }

  function orderRow(count, index) {
    const step = (action, name, atLimit) =>
      `<button type="button" data-action="${action}" data-order-index="${index}" aria-label="${name} in order ${index + 1}" ${atLimit ? 'data-limit' : ''}>${action === 'order-up' ? '+' : '−'}</button>`;
    return `<div class="mobile-order-row"><span>Order ${index + 1}</span>
      <div class="mobile-lines-stepper">${step('order-down','One fewer line',count === 1)}
      <output aria-live="polite">${count}</output>${step('order-up','One more line',count === maxLines)}</div>
      <button type="button" class="remove-order icon-button" data-action="remove-order" data-order-index="${index}" aria-label="Remove order ${index + 1}">×</button></div>`;
  }

  function draw() {
    const account = draft.accounts[selected];
    field('account-switcher').hidden = draft.accounts.length === 1;
    accountSelect.replaceChildren(...draft.accounts.map((_, index) =>
      new Option(`Account ${index + 1} of ${draft.accounts.length}`, String(index), false, index === selected)));
    field('start-services').innerHTML = SERVICES.map(service => `
      <button type="button" class="service-button" data-service="${service.key}" aria-pressed="${account.before.includes(service.key)}">
      ${icon(service.icon)}${service.short}</button>`).join('');
    field('end-services').innerHTML = SERVICES.filter(service => account.before.includes(service.key)).map(service => {
      const kept = account.kept.includes(service.key);
      return `<div class="end-row"><span class="end-name">${icon(service.icon)}${service.label}</span>
        <div class="outcome-toggle" role="group" aria-label="${service.label} outcome">
          <button type="button" data-end="${service.key}" data-kept="true" aria-label="Keep ${service.label}" aria-pressed="${kept}">Kept</button>
          <button type="button" data-end="${service.key}" data-kept="false" aria-label="Disconnect ${service.label}" aria-pressed="${!kept}">Disconnected</button>
        </div></div>`;
    }).join('') || '<p class="text-muted">Select the services the customer had.</p>';
    const available = SERVICES.filter(service => !account.before.includes(service.key));
    field('added-services-section').hidden = !account.before.length || !available.length;
    field('added-count').textContent = account.added.length ? `(${account.added.length})` : '';
    field('added-services').innerHTML = available.map(service => `
      <button type="button" class="service-button" data-added-service="${service.key}" aria-pressed="${account.added.includes(service.key)}">${service.short}</button>`).join('');
    const orders = draft.mobileOrders;
    const total = orders.reduce((sum, lines) => sum + lines, 0);
    field('mobile-orders').innerHTML = orders.map(orderRow).join('') + (total ?
      `<p class="orders-summary">${orders.length} order${orders.length === 1 ? '' : 's'} · ${total} line${total === 1 ? '' : 's'}</p>` : '');
    form.querySelector('[data-action="add-order"]').toggleAttribute('data-limit', orders.length >= maxOrders);
    field('outcome-preview').innerHTML = outcomePreview(draft);
    lockControls();
  }

  function selectAccount(index) {
    selected = index;
    field('added-services-section').open = draft.accounts[index].added.length > 0;
    draw();
  }

  function reset() {
    submission = null;
    writing = false;
    draft = emptyDraft();
    message();
    selectAccount(0);
  }

  accountSelect.addEventListener('change', () => selectAccount(accountSelect.selectedIndex));
  panel.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || button.type === 'submit') return;
    const {action, service, addedService, end, kept, orderIndex} = button.dataset;
    if (action === 'close-entry') { onClose(); return; }
    if (writing || unavailable || submission) return;
    const account = draft.accounts[selected];
    const index = Number(orderIndex);
    let focusSelector = '';
    message();
    if (service) {
      account.before = toggle(account.before, service);
      if (account.before.includes(service)) account.kept.push(service);
      else account.kept = account.kept.filter(key => key !== service);
      account.added = account.added.filter(key => key !== service);
      focusSelector = `[data-service="${service}"]`;
    } else if (addedService) {
      account.added = toggle(account.added, addedService);
      focusSelector = `[data-added-service="${addedService}"]`;
    } else if (end) {
      account.kept = account.kept.filter(key => key !== end);
      if (kept === 'true') account.kept.push(end);
      focusSelector = `[data-end="${end}"][data-kept="${kept}"]`;
    } else if (action === 'add-account' || action === 'remove-account') {
      if (action === 'add-account') {
        draft.accounts.push(emptyAccount());
        selectAccount(draft.accounts.length - 1);
      } else {
        if (draft.accounts.length === 1) return;
        draft.accounts.splice(selected, 1);
        selectAccount(Math.min(selected, draft.accounts.length - 1));
      }
      firstService();
      return;
    } else if (action === 'add-order') {
      draft.mobileOrders.push(1);
      focusSelector = `[data-action="order-up"][data-order-index="${draft.mobileOrders.length - 1}"]`;
    } else if (action === 'remove-order') {
      draft.mobileOrders.splice(index, 1);
      focusSelector = '[data-action="add-order"]';
    } else if (action === 'order-up' || action === 'order-down') {
      draft.mobileOrders[index] += action === 'order-up' ? 1 : -1;
      focusSelector = `[data-action="${action}"][data-order-index="${index}"]`;
    } else return;
    draw();
    const next = form.querySelector(focusSelector);
    if (next?.disabled && orderIndex !== undefined) {
      form.querySelector(`button[data-order-index="${index}"]:not(:disabled)`)?.focus();
    } else next?.focus();
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (writing || unavailable) return;
    const incomplete = draft.accounts.findIndex(account => !account.before.length);
    if (incomplete >= 0) {
      selectAccount(incomplete);
      message(`Choose a starting service${draft.accounts.length > 1 ? ' for account ' + (incomplete + 1) : ''}.`);
      firstService();
      return;
    }
    if (!submission) submission = {draft: structuredClone(draft), token: crypto.randomUUID(), day: dayKey()};
    const request = submission;
    message();
    writing = true;
    lockControls();
    try {
      await submit(request.draft, request.token, request.day);
    } catch (error) {
      if (submission !== request) return;
      writing = false;
      if (error?.code === 'VALIDATION') submission = null;
      message(error?.message || 'Could not confirm the tally. Retry to check and save it once.');
      lockControls();
      return;
    }
    if (submission !== request) return;
    reset();
    onClose();
  });

  draw();
  return {
    reset,
    busy(value) { unavailable = Boolean(value); lockControls(); },
    dirty: () => draft.accounts.length > 1 || draft.accounts[0].before.length > 0 || draft.mobileOrders.length > 0,
    pending: () => Boolean(submission),
    focus: firstService
  };
}
