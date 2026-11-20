import { DEFAULT_GOALS, METRICS } from './model.js';

const $ = id => document.getElementById(id);

function create(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

/** Rebuild a roster only when it changes, preserving keyboard focus and the selected agent. */
export function displayRoster(agents, selectedId) {
  const picker = $('team-agent');
  if (picker.options.length !== Math.max(1, agents.length) ||
      agents.some((agent, i) => picker.options[i]?.value !== agent.id || picker.options[i]?.text !== agent.username)) {
    const options = agents.length ? agents.map(agent => new Option(agent.username,agent.id)) : [new Option('No agents assigned','')];
    picker.replaceChildren(...options);
  }
  picker.value = selectedId || '';
  picker.disabled = !agents.length;
}

export function createTeamGoals(applyGoals) {
  const form = $('team-goals-form'), metric = $('target-metric'), value = $('target-value');
  const agentList = $('target-agent-list'), status = $('team-goal-status');
  let agents = [], submitting = false, generation = 0, targetEdited = false;
  metric.replaceChildren(...METRICS.map(item => new Option(item.label,item.key)));

  function selected() {
    return form.elements.audience.value === 'all' ? agents : agents.filter(agent =>
      Array.from(agentList.querySelectorAll('input:checked')).some(input => input.value === agent.id));
  }
  function summarize(prefill = false) {
    const recipients = selected();
    const values = recipients.map(agent => agent.goals[metric.value] ?? DEFAULT_GOALS[metric.value]);
    const current = new Set(values);
    if (prefill) value.value = current.size === 1 ? values[0] : '';
    const unit = recipients.length === 1 ? 'agent' : 'agents';
    $('current-target').textContent = current.size === 1 ? 'Current goal: ' + values[0] + '%' :
      current.size ? 'Current goals vary across these agents.' : 'Choose agents to see their current goal.';
    $('apply-team-goal').textContent = 'Apply to ' + recipients.length + ' ' + unit;
    $('apply-team-goal').disabled = !recipients.length || submitting;
    agentList.hidden = form.elements.audience.value === 'all';
    form.querySelector('fieldset').disabled = submitting;
  }
  // A drafted percentage belongs to its metric and survives recipient or roster changes.
  value.addEventListener('input', () => { targetEdited = true; status.textContent = ''; });
  form.addEventListener('change', e => {
    if (e.target === metric) targetEdited = false;
    if (e.target !== value) summarize(!targetEdited);
    status.textContent = '';
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting || !form.reportValidity() || !selected().length) return;
    submitting = true;
    const version = generation;
    const ids = form.elements.audience.value === 'all' ? null : selected().map(agent => agent.id);
    const key = metric.value, target = Number(value.value);
    status.textContent = 'Applying goal…';
    summarize();
    try {
      const result = await applyGoals(ids,{[key]:target});
      if (version !== generation) return;
      targetEdited = false;
      agents = agents.map(agent => !ids || ids.includes(agent.id) ? {...agent,goals:{...agent.goals,[key]:target}} : agent);
      status.textContent = 'Goal set to ' + target + '% for ' + result.updated + (result.updated === 1 ? ' agent.' : ' agents.');
    } catch (error) {
      if (version === generation) status.textContent = error.message || 'Could not apply this goal. Try again.';
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
      summarize(!targetEdited && !submitting);
    },
    reset() {
      generation++; submitting = false; targetEdited = false; agents = [];
      form.reset(); agentList.replaceChildren(); status.textContent = ''; summarize(true);
    }
  };
}
