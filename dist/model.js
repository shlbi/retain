/** Service keys are shared by call entry, outcome calculation, and reporting. */
export const SERVICES = [
  { key: 'internet', label: 'Internet', short: 'Internet', icon: 'internet', color: '#337faa' },
  { key: 'tv', label: 'Video (TV)', short: 'Video', icon: 'tv', color: '#537db2' },
  { key: 'phone', label: 'Voice (home phone)', short: 'Voice', icon: 'phone', color: '#637f9b' },
  { key: 'mobile', label: 'Mobile', short: 'Mobile', icon: 'mobile', color: '#7579ad' }
];

export const METRICS = [
  { key: 'overall', label: 'Overall save', color: '#2563a6', icon: 'target', goal: 85, unit: 'save', description: 'Eligible calls keeping at least one original service ÷ calls with at least one unpaired account. Matched wash accounts are excluded.' },
  { key: 'internet', label: 'Internet save', color: '#337faa', icon: 'internet', goal: 85, unit: 'save', description: 'Internet kept or added ÷ accounts that started with or added internet. Paired wash accounts are excluded for their original services.' },
  { key: 'tv', label: 'Video save', color: '#537db2', icon: 'tv', goal: 75, unit: 'save', description: 'Video kept or added ÷ accounts that started with or added video. Downgrades count for each original service.' },
  { key: 'phone', label: 'Voice save', color: '#637f9b', icon: 'phone', goal: 80, unit: 'save', description: 'Voice kept or added ÷ accounts that started with or added home phone service.' },
  { key: 'mobile', label: 'Mobile save', color: '#7579ad', icon: 'mobile', goal: 75, unit: 'save', description: 'Mobile service kept or added ÷ accounts that started with or added mobile. An order can include several lines while the service counts once per account.' },
  { key: 'sp', label: 'Single-play save', color: '#4c80b4', icon: 'layers', goal: 80, unit: 'save', description: 'SPS ÷ (SPS + SPD) for unpaired accounts that started with exactly one service.' },
  { key: 'dp', label: 'Double-play save', color: '#3c739f', icon: 'layers', goal: 80, unit: 'save', description: 'DPS ÷ (DPS + DPD) for unpaired accounts that started with two services. Only full saves and full disconnects qualify.' },
  { key: 'tp', label: 'Triple-play (3+)', color: '#426787', icon: 'layers', goal: 80, unit: 'save', description: 'TPS ÷ (TPS + TPD) for unpaired accounts that started with three or four services. Only full saves and full disconnects qualify.' },
  { key: 'bundle', label: 'Bundle save', color: '#39618e', icon: 'layers', goal: 80, unit: 'save', description: 'Bundles keeping every original service ÷ bundles keeping all or disconnecting all original services. A bundle starts with at least two services. Wash pairs and downgrades are excluded.' },
  { key: 'orders', label: 'Mobile orders', color: '#6275b2', icon: 'sparkles', goal: 20, unit: 'order', description: 'Mobile orders placed ÷ all logged calls. Each order counts once regardless of its line count; multiple orders on one call count separately.' },
  { key: 'sales', label: 'Mobile lines', color: '#467ba8', icon: 'mobile', goal: 20, unit: 'line', description: 'New mobile lines sold ÷ all logged calls. Each order contains 1–12 lines; lines across multiple orders are added together, so the rate can exceed 100%.' }
];

export const DEFAULT_GOALS = Object.fromEntries(METRICS.map(metric => [metric.key, metric.goal]));

const SERVICE_KEYS = SERVICES.map(service => service.key);
const PLAY_NAMES = ['', 'SP', 'DP', 'TP'];

/** Read new and historical records through the same per-account scoring rules. */
export function accountsFor(call) {
  if (call?.accounts !== undefined) return Array.isArray(call.accounts) ? call.accounts : [];
  if (!Array.isArray(call?.before) || !Array.isArray(call?.kept)) return [];
  return [{ account: call.account ?? '', before: call.before, kept: call.kept, added: call.added ?? [] }];
}

/** Determine the outcome for the original services. Additions earn separate service credit. */
export function classifyAccount(account) {
  if (!Array.isArray(account?.before) || !Array.isArray(account?.kept)) return null;
  const before = SERVICE_KEYS.filter(key => account.before.includes(key));
  if (!before.length) return null;
  const kept = before.filter(key => account.kept.includes(key));
  const disconnected = before.filter(key => !kept.includes(key));
  const additions = Array.isArray(account.added) ? account.added : [];
  const added = SERVICE_KEYS.filter(key => !before.includes(key) && additions.includes(key));
  const tier = Math.min(before.length, 3);
  const saved = kept.length > 0;
  let kind = saved ? 'save' : 'disconnect';
  let code = PLAY_NAMES[tier] + (saved ? 'S' : 'D');
  if (saved && disconnected.length > 0) {
    kind = 'downgrade';
    code = kept.length === 3 ? 'TP (4 → 3)' : PLAY_NAMES[tier] + ' → ' + PLAY_NAMES[kept.length];
  }
  return { code, kind, saved, tier, before, kept, added, disconnected };
}

/** Retain the two-list API for callers displaying one account. */
export function classifyCall(before, kept) {
  const result = classifyAccount({ before, kept });
  if (!result) return null;
  const { code, saved, tier, disconnected } = result;
  return { code, saved, tier, disconnected };
}

/** Match one complete save with one complete loss of identical original services on this call. */
export function outcomesForCall(call) {
  const outcomes = [];
  const matchingAccounts = new Map();
  accountsFor(call).forEach((account, index) => {
    const result = classifyAccount(account);
    if (!result) return;
    const outcome = { ...result, index, account: account.account ?? '', washed: false };
    outcomes.push(outcome);
    if (outcome.kind === 'downgrade') return;
    // classifyAccount emits service keys in a stable order, including on legacy calls.
    const signature = outcome.before.join(',');
    if (!matchingAccounts.has(signature)) matchingAccounts.set(signature, { save: [], disconnect: [] });
    matchingAccounts.get(signature)[outcome.kind].push(outcome);
  });
  for (const { save, disconnect } of matchingAccounts.values()) {
    for (let index = 0; index < Math.min(save.length, disconnect.length); index++) {
      save[index].washed = true;
      disconnect[index].washed = true;
    }
  }
  return outcomes;
}

/** Read independent mobile orders, using legacy counts only when canonical orders are absent. */
export function ordersFor(call) {
  if (call?.mobileOrders !== undefined) {
    return Array.isArray(call.mobileOrders) && Array.from(call.mobileOrders).every(lines => Number.isInteger(lines) && lines >= 1 && lines <= 12)
      ? [...call.mobileOrders]
      : [];
  }
  if (call?.soldLines === undefined) return call?.sold === true ? [1] : [];
  return Number.isInteger(call.soldLines) && call.soldLines >= 1 && call.soldLines <= 12 ? [call.soldLines] : [];
}

/** Count every order once, independently of how many mobile lines it contains. */
export function soldOrdersFor(call) {
  return ordersFor(call).length;
}

/** Sum all lines across the call's mobile orders without merging their order identities. */
export function soldLinesFor(call) {
  return ordersFor(call).reduce((sum, lines) => sum + lines, 0);
}

/** Count consecutive eligible calls, assuming one successful save, order, or line per next call. */
export function successesNeeded(successes, opportunities, targetPercent) {
  if (!Number.isSafeInteger(successes) || successes < 0 || !Number.isSafeInteger(opportunities) || opportunities < 0 || !Number.isFinite(targetPercent) || targetPercent < 0 || targetPercent > 100) {
    throw new RangeError('Counts must be nonnegative integers and the target must be between 0 and 100.');
  }
  const target = targetPercent / 100;
  if (target === 0) return 0;
  if (opportunities > 0 && successes / opportunities >= target - 1e-10) return 0;
  if (target === 1 && opportunities > successes) return null;
  if (!opportunities) return 1;
  return Math.max(0, Math.ceil((target * opportunities - successes) / (1 - target) - 1e-9));
}

/** Count service and bundle results per account, and overall saves and sales per call. */
export function calculateMetrics(calls, goals = DEFAULT_GOALS) {
  const counts = Object.fromEntries(METRICS.map(metric => [metric.key, { successes: 0, total: 0 }]));
  function count(key, successes) {
    counts[key].total++;
    counts[key].successes += Number(successes);
  }
  for (const call of calls) {
    const outcomes = outcomesForCall(call);
    if (!outcomes.length) continue;
    count('orders', soldOrdersFor(call));
    count('sales', soldLinesFor(call));
    const unpaired = outcomes.filter(outcome => !outcome.washed);
    if (unpaired.length) count('overall', unpaired.some(outcome => outcome.saved));

    for (const outcome of outcomes) {
      for (const service of outcome.added) count(service, true);
    }
    for (const outcome of unpaired) {
      for (const service of outcome.kept) count(service, true);
      for (const service of outcome.disconnected) count(service, false);
      if (outcome.kind === 'downgrade') continue;
      count(PLAY_NAMES[outcome.tier].toLowerCase(), outcome.saved);
      if (outcome.tier >= 2) count('bundle', outcome.saved);
    }
  }
  return METRICS.map(metric => {
    const { successes, total } = counts[metric.key];
    const rate = total ? successes / total * 100 : null;
    const candidate = goals?.[metric.key];
    const goal = Number.isFinite(candidate) && candidate >= 0 && candidate <= 100 ? candidate : metric.goal;
    const progress = rate === null ? 0 : goal === 0 ? 1 : Math.min(rate / goal, 1);
    const opportunityUnit = ['overall', 'sales', 'orders'].includes(metric.key) ? 'call' : 'account';
    return { ...metric, successes, total, opportunityUnit, rate, goal, progress, needed: successesNeeded(successes, total, goal), reached: total > 0 && rate >= goal - 1e-8 };
  });
}

/** Assign records and daily reporting to the agent's Eastern working day. */
export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
