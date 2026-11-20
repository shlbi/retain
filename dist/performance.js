const number = new Intl.NumberFormat('en-US', {maximumFractionDigits: 1});
const dateLabel = new Intl.DateTimeFormat('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'});
const showDate = day => dateLabel.format(new Date(day + 'T12:00:00Z'));
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const ratio = (part, total) => total ? part / total : null;
const display = value => value === null ? '—' : number.format(value);

const measures = {
  calls: {title: 'Calls logged', value: d => d.calls, summary: days => sum(days, 'calls'), caption: 'calls in this period'},
  perAgent: {title: 'Calls per active agent', value: d => ratio(d.calls, d.activeAgents),
    summary: days => ratio(sum(days, 'calls'), sum(days, 'activeAgents')), caption: 'calls per active agent-day'},
  agents: {title: 'Active agents', value: d => d.activeAgents, summary: days => Math.max(...days.map(d => d.activeAgents)), caption: 'peak in one day', line: true},
  requests: {title: 'Authenticated API requests', value: d => d.requests},
  latency: {title: 'Mean handling time', value: d => ratio(d.totalMs, d.requests), suffix: ' ms', line: true},
  errors: {title: 'Server errors', value: d => d.requests ? d.errors : null}
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function selector(label, options, selected) {
  const input = el('select', 'performance-select');
  input.setAttribute('aria-label', label);
  for (const [value, text] of options) input.add(new Option(text, value));
  input.value = selected;
  return input;
}

function chartCeiling(max) {
  if (max <= 1) return 2;
  const magnitude = 10 ** Math.floor(Math.log10(max / 2));
  const step = [1, 2, 2.5, 5, 10].find(step => step * magnitude >= max / 2);
  return 2 * step * magnitude;
}

// Build each contiguous run separately. A missing latency sample must never
// produce a zero-millisecond point or a line through an unmeasured date.
function lineSeries(values, ceiling) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  let points = [];
  function finishRun() {
    if (points.length > 1) {
      const coords = points.map(([x,y]) => x + ',' + y).join(' ');
      const fill = document.createElementNS(ns, 'polygon');
      fill.setAttribute('points', points[0][0] + ',100 ' + coords + ' ' + points.at(-1)[0] + ',100');
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', coords);
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(fill, line);
    }
    points = [];
  }
  values.forEach((v, i) => {
    if (v === null) finishRun();
    else points.push([(i + 0.5) * 100 / values.length, 100 - v * 100 / ceiling]);
  });
  finishRun();
  return svg;
}

function dailyChart(days, metric, emptyText) {
  const measure = measures[metric], values = days.map(measure.value);
  const figure = el('figure', 'perf-chart' + (measure.line ? ' line-chart' : ''));
  figure.setAttribute('aria-label', measure.title + ' by day');
  if (emptyText) {
    figure.append(el('p', 'perf-empty', emptyText));
    return figure;
  }

  const ceiling = chartCeiling(Math.max(...values.filter(v => v !== null)));
  const scale = el('div', 'perf-scale');
  for (const tick of [ceiling, ceiling / 2, 0]) scale.append(el('span', '', display(tick)));
  scale.setAttribute('aria-hidden', 'true');

  const plot = el('div', 'perf-plot');
  plot.tabIndex = 0;
  plot.setAttribute('role', 'slider');
  plot.setAttribute('aria-label', 'Inspect ' + measure.title.toLowerCase() + ' by date');
  plot.setAttribute('aria-valuemin', '1');
  plot.setAttribute('aria-valuemax', String(days.length));
  const tracks = values.map(value => {
    const track = el('div', 'perf-track');
    track.setAttribute('aria-hidden', 'true');
    if (value !== null) {
      const mark = el('i', 'perf-mark');
      mark.style.setProperty('--level', (value * 100 / ceiling) + '%');
      track.append(mark);
    }
    return track;
  });
  plot.append(...tracks);
  if (measure.line) plot.append(lineSeries(values, ceiling));
  const axis = el('div', 'perf-dates');
  for (const i of [0, Math.floor((days.length - 1) / 2), days.length - 1]) axis.append(el('span', '', showDate(days[i].day)));
  axis.setAttribute('aria-hidden', 'true');
  const readout = el('figcaption', 'perf-readout');
  let index = -1;
  function inspect(i) {
    const next = Math.max(0, Math.min(days.length - 1, i));
    if (next === index) return;
    tracks[index]?.classList.remove('selected');
    index = next;
    tracks[index].classList.add('selected');
    const value = values[index];
    const label = value === null ? 'No measurement' : display(value) + (measure.suffix || '');
    const text = showDate(days[index].day) + ' · ' + label;
    readout.textContent = text;
    plot.setAttribute('aria-valuenow', String(index + 1));
    plot.setAttribute('aria-valuetext', text);
  }
  function point(event) {
    const bounds = plot.getBoundingClientRect();
    inspect(Math.floor((event.clientX - bounds.left) * days.length / bounds.width));
  }
  plot.addEventListener('pointermove', point);
  plot.addEventListener('pointerdown', point);
  plot.addEventListener('keydown', event => {
    const move = {ArrowLeft: index-1, ArrowRight: index+1, ArrowDown: index-1, ArrowUp: index+1,
      PageDown: index-7, PageUp: index+7, Home: 0, End: days.length-1};
    if (Object.hasOwn(move, event.key)) { event.preventDefault(); inspect(move[event.key]); }
  });
  inspect(days.length - 1);
  figure.append(scale, plot, axis, readout);
  return figure;
}

function summaryCard(title, value, detail) {
  const card = el('article', 'admin-card');
  card.append(el('span', '', title), el('strong', '', value), el('small', '', detail));
  return card;
}

function chartPanel(title, select) {
  const panel = el('section', 'panel admin-panel perf-panel');
  const head = el('div', 'perf-panel-head'), body = el('div', 'perf-chart-body');
  head.append(el('h2', '', title));
  if (select) head.append(select);
  panel.append(head, body);
  return {panel, body};
}

function dailyTable(days, keys) {
  const details = el('details', 'perf-details');
  const summary = el('summary', '', 'View daily values');
  const scroll = el('div', 'admin-table-wrap'), table = el('table', 'admin-table');
  const head = table.createTHead().insertRow();
  for (const label of ['Date', ...keys.map(key => measures[key].title)]) {
    const cell = el('th', '', label);
    cell.scope = 'col'; head.append(cell);
  }
  const body = table.createTBody();
  for (const day of [...days].reverse()) {
    const row = body.insertRow(), date = el('th', '', showDate(day.day));
    date.scope = 'row'; row.append(date);
    for (const key of keys) {
      const metric = measures[key], value = metric.value(day);
      row.insertCell().textContent = value === null ? '—' : display(value) + (metric.suffix || '');
    }
  }
  scroll.append(table); details.append(summary, scroll);
  return details;
}

/** Render only real Eastern reporting dates and discard the data with this DOM on sign-out. */
export function displayAdminStats({days}) {
  const report = document.getElementById('admin-report');
  const old = key => report.querySelector('[data-choice="' + key + '"]')?.value;
  const range = selector('Reporting period', [['7','Last 7 days'],['14','Last 14 days'],['28','Last 28 days']], old('period') || '28');
  const volume = selector('Workload measure', [['calls','Total calls'],['perAgent','Per active agent']], old('volume') || 'calls');
  const metric = selector('Technical chart measure', [['requests','API requests'],['latency','Mean handling time'],['errors','Server errors']], old('technical') || 'requests');
  range.dataset.choice = 'period'; volume.dataset.choice = 'volume'; metric.dataset.choice = 'technical';
  const dateRange = el('p', 'perf-period'), toolbar = el('div', 'perf-toolbar');
  toolbar.append(dateRange, range);
  const activity = el('div', 'perf-pair');
  const workload = chartPanel('Call volume', volume), adoption = chartPanel('Active agents');
  activity.append(workload.panel, adoption.panel);
  const usageTable = el('div');
  const tech = chartPanel('Technical performance', metric);
  tech.panel.classList.add('perf-technical');
  report.replaceChildren(toolbar, activity, usageTable, tech.panel);

  function render() {
    const period = days.slice(-Number(range.value));
    if (!period.length) { dateRange.textContent = 'No dates available.'; return; }
    dateRange.textContent = showDate(period[0].day) + ' – ' + showDate(period.at(-1).day) + ' · Eastern time';
    const calls = sum(period, 'calls'), requests = sum(period, 'requests');
    for (const [body, key] of [[workload.body, volume.value], [adoption.body, 'agents']]) {
      const measure = measures[key], total = el('div', 'perf-headline');
      total.append(el('strong', '', display(measure.summary(period))), el('span', '', measure.caption));
      body.replaceChildren(total, dailyChart(period, key, !calls && 'No calls logged in this period.'));
    }
    usageTable.replaceChildren(dailyTable(period, ['calls', 'agents', 'perAgent']));
    const errors = sum(period, 'errors'), average = ratio(sum(period, 'totalMs'), requests);
    const cards = el('div', 'admin-cards technical-cards');
    cards.append(summaryCard('Authenticated API requests', display(requests), 'Recorded in this period'),
      summaryCard('Server errors', display(errors), 'HTTP 5xx responses'),
      summaryCard('Mean handling time', average === null ? '—' : display(average) + ' ms', 'Measured on the server'));
    tech.body.replaceChildren(cards, dailyChart(period, metric.value, !requests && 'No API requests measured in this period.'),
      dailyTable(period, ['requests', 'errors', 'latency']));
  }
  for (const control of [range, volume, metric]) control.addEventListener('change', render);
  render();
}
