import { DEFAULT_GOALS, METRICS } from './model.js';

const $ = id => document.getElementById(id);

function create(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

/** Update the list independently of the supervisor's open or closed disclosure. */
export function displayRoster(agents, selectedId) {
  const list = $('team-agent-list');
  const buttons = list.querySelectorAll('button');
  const changed = buttons.length !== agents.length || agents.some((agent,i) =>
    buttons[i].dataset.agentId !== agent.id || buttons[i].textContent !== agent.username);
  if (changed) {
    const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.agentId : null;
    list.replaceChildren(...agents.map(agent => {
      const row = create('li'), button = create('button', agent.username);
      button.type = 'button';
      button.dataset.agentId = agent.id;
      row.append(button);
      return row;
    }));
    if (focusedId) {
      const next = agents.findIndex(agent => agent.id === focusedId);
      const fallback = next < 0 ? agents.findIndex(agent => agent.id === selectedId) : next;
      (list.children[fallback]?.firstElementChild || $('team-picker').querySelector('summary')).focus();
    }
  }
  for (const button of list.querySelectorAll('button')) {
    if (button.dataset.agentId === selectedId) button.setAttribute('aria-current','true');
    else button.removeAttribute('aria-current');
  }
  $('team-roster-empty').hidden = agents.length > 0;
}

export function createTeamGoals(applyGoals) {
  const form = $('team-goals-form');
  const agentList = $('target-agent-list'), status = $('team-goal-status');
  let agents = [], submitting = false, generation = 0;
  const edited = new Set(), inputs = new Map();
  for (const {key,label} of METRICS) {
    const row = create('label',label);
    const input = create('input');
    input.type = 'number'; input.name = key; input.min = '5'; input.max = '100';
    input.step = '1'; input.required = true; input.inputMode = 'numeric';
    const suffix = create('span','%');
    suffix.setAttribute('aria-hidden','true');
    row.append(input,suffix);
    $('goal-fields').append(row);
    inputs.set(key,input);
    input.addEventListener('input', () => { edited.add(key); status.textContent = ''; });
  }

  function selected() {
    return form.elements.audience.value === 'all' ? agents : agents.filter(agent =>
      Array.from(agentList.querySelectorAll('input:checked')).some(input => input.value === agent.id));
  }
  function summarize() {
    const recipients = selected();
    let mixed = false;
    for (const [key,input] of inputs) {
      const targets = new Set(recipients.map(agent => agent.goals[key] ?? DEFAULT_GOALS[key]));
      if (!edited.has(key)) input.value = targets.size === 1 ? [...targets][0] : '';
      input.placeholder = targets.size > 1 ? 'Varies' : '';
      mixed ||= targets.size > 1 && !input.value;
      input.disabled = !recipients.length;
    }
    $('mixed-goals').hidden = !mixed;
    const unit = recipients.length === 1 ? 'agent' : 'agents';
    $('apply-team-goal').textContent = recipients.length ? 'Save goals for ' + recipients.length + ' ' + unit : 'Save goals';
    $('apply-team-goal').disabled = !recipients.length || submitting;
    agentList.hidden = form.elements.audience.value === 'all';
    form.querySelector('fieldset').disabled = submitting;
  }
  form.addEventListener('change', event => {
    if (!event.target.matches('input[type="radio"],input[type="checkbox"]')) return;
    summarize();
    status.textContent = '';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || !form.reportValidity() || !selected().length) return;
    submitting = true;
    const version = generation;
    const ids = form.elements.audience.value === 'all' ? null : selected().map(agent => agent.id);
    const goals = Object.fromEntries(Array.from(inputs, ([key,input]) => [key,input.valueAsNumber]));
    status.textContent = 'Saving goals…';
    summarize();
    try {
      const result = await applyGoals(ids,goals);
      if (version !== generation) return;
      edited.clear();
      agents = agents.map(agent => !ids || ids.includes(agent.id) ? {...agent,goals:{...agent.goals,...goals}} : agent);
      status.textContent = 'Goals saved for ' + result.updated + (result.updated === 1 ? ' agent.' : ' agents.');
    } catch (error) {
      if (version === generation) status.textContent = error.message || 'Could not save goals. Try again.';
    } finally {
      if (version === generation) { submitting = false; summarize(); }
    }
  });
  return {
    update(roster) {
      const rosterChanged = roster.length !== agents.length || roster.some((agent,i) =>
        agent.id !== agents[i]?.id || agent.username !== agents[i]?.username);
      agents = roster;
      if (rosterChanged) {
        const checked = new Set(Array.from(agentList.querySelectorAll('input:checked'), el => el.value));
        agentList.replaceChildren(...agents.map(agent => {
          const label = create('label'), checkbox = create('input');
          checkbox.type = 'checkbox'; checkbox.value = agent.id; checkbox.checked = checked.has(agent.id);
          label.append(checkbox, document.createTextNode(agent.username));
          return label;
        }));
      }
      summarize();
    },
    reset() {
      generation++; submitting = false; edited.clear(); agents = [];
      form.reset(); agentList.replaceChildren(); status.textContent = ''; summarize();
    }
  };
}
