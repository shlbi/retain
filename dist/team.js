import { DEFAULT_GOALS, METRICS } from './model.js';

const $ = id => document.getElementById(id);
const format = new Intl.NumberFormat('en-US', {maximumFractionDigits:1});
const percent = (part, total) => total ? format.format(part * 100 / total) + '%' : '—';

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

function card(label, amount, detail) {
  const el = create('article',undefined,'admin-card');
  el.append(create('span',label),create('strong',amount),create('small',detail));
  return el;
}

const sum = (rows, key) => rows.reduce((n,row) => n + row[key], 0);
function periodTrend(days) {
  const prev = days.slice(0,14), recent = days.slice(14);
  const windows = [prev,recent];
  const formatDate = day => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'});
  const headers = windows.map(period => period.length ? formatDate(period[0].day) + ' – ' + formatDate(period.at(-1).day) : '—');
  const measures = [
    ['Logged calls', period => format.format(sum(period,'calls'))],
    ['Overall save rate', period => percent(sum(period,'savedCalls'),sum(period,'eligibleCalls'))],
    ['Mobile orders per 100 calls', period => sum(period,'calls') ? format.format(100*sum(period,'mobileOrders')/sum(period,'calls')) : '—'],
    ['Mobiles sold', period => format.format(sum(period,'mobileLines'))]
  ];
  return table(['Measure',...headers], measures.map(([label,calc]) => [label,...windows.map(calc)]));
}

function table(headers, data) {
  const scroll = create('div',undefined,'admin-table-wrap'), tableEl = create('table',undefined,'admin-table');
  const thead = tableEl.createTHead().insertRow();
  for (const header of headers) { const cell = create('th',header); cell.scope='col'; thead.append(cell); }
  const tbody = tableEl.createTBody();
  for (const row of data) {
    const tr = tbody.insertRow();
    row.forEach((col, i) => {
      const cell = create(i === 0 ? 'th' : 'td',col);
      if (i === 0) cell.scope = 'row';
      tr.append(cell);
    });
  }
  scroll.append(tableEl);
  return scroll;
}

export function displayAdminStats(stats) {
  $('admin-summary').replaceChildren(
    card('Active agents',format.format(stats.activeAgents),format.format(stats.registered)+' registered accounts'),
    card('Calls logged',format.format(stats.calls),'Past 28 days'),
    card('Overall save rate',percent(stats.savedCalls,stats.eligibleCalls),format.format(stats.savedCalls)+' saved / '+format.format(stats.eligibleCalls)+' eligible'),
    card('Mobiles sold',format.format(stats.mobileLines),format.format(stats.mobileOrders)+' orders')
  );
  $('admin-trend').replaceChildren(periodTrend(stats.days));
  $('admin-team-table').replaceChildren(stats.teams.length ? table(['Supervisor','Active / members','Calls','Save rate','Orders','Lines'],
    stats.teams.map(t=>[t.username ?? 'Unassigned',t.activeAgents+' / '+t.members,format.format(t.calls),percent(t.savedCalls,t.eligibleCalls),format.format(t.mobileOrders),format.format(t.mobileLines)])) : create('p','No team results yet.'));
  const {requests, errors, meanMs} = stats.technical;
  $('admin-technical').replaceChildren(
    card('Authenticated API requests',format.format(requests),'Past 28 days'),
    card('Server errors',format.format(errors), requests ? percent(errors,requests)+' returned HTTP 5xx' : 'No requests measured yet'),
    card('Mean handling time', meanMs === null ? '—' : format.format(meanMs)+' ms','Measured on the server')
  );
}
