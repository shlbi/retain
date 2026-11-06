/** Service keys are shared by call entry, outcome calculation, and reporting. */
export const SERVICES = [
  { key: 'internet', label: 'Internet', short: 'Internet', icon: 'internet', color: '#337faa' },
  { key: 'tv', label: 'TV', short: 'TV', icon: 'tv', color: '#537db2' },
  { key: 'phone', label: 'Home phone', short: 'Phone', icon: 'phone', color: '#637f9b' },
  { key: 'mobile', label: 'Mobile', short: 'Mobile', icon: 'mobile', color: '#7579ad' }
];

export const METRICS = [
  { key: 'overall', label: 'Overall save', color: '#2563a6', icon: 'target', goal: 85, unit: 'save', description: 'Calls with at least one original service kept ÷ all logged calls.' },
  { key: 'internet', label: 'Internet save', color: '#337faa', icon: 'internet', goal: 85, unit: 'save', description: 'Internet kept ÷ calls that started with internet.' },
  { key: 'tv', label: 'TV save', color: '#537db2', icon: 'tv', goal: 75, unit: 'save', description: 'TV kept ÷ calls that started with TV.' },
  { key: 'sp', label: 'Single-play save', color: '#4c80b4', icon: 'layers', goal: 80, unit: 'save', description: 'SPS ÷ (SPS + SPD). Downgrades to one service count as SPS.' },
  { key: 'dp', label: 'Double-play save', color: '#3c739f', icon: 'layers', goal: 80, unit: 'save', description: 'DPS ÷ (DPS + DPD). Downgrades to two services count as DPS.' },
  { key: 'tp', label: 'Triple-play (3+)', color: '#426787', icon: 'layers', goal: 80, unit: 'save', description: 'TPS ÷ (TPS + TPD). TP groups three and four services; saves use services kept and full disconnects use starting services.' },
  { key: 'phone', label: 'Home phone save', color: '#637f9b', icon: 'phone', goal: 80, unit: 'save', description: 'Home phone kept ÷ calls that started with home phone.' },
  { key: 'mobile', label: 'Mobile save', color: '#7579ad', icon: 'mobile', goal: 75, unit: 'save', description: 'Existing mobile service kept ÷ calls that started with mobile. New line sales are counted separately.' },
  { key: 'orders', label: 'Mobile orders', color: '#6275b2', icon: 'sparkles', goal: 20, unit: 'order', description: 'Mobile orders placed ÷ all logged calls. Each order counts once regardless of its line count; multiple orders on one call count separately.' },
  { key: 'sales', label: 'Mobile lines', color: '#467ba8', icon: 'mobile', goal: 20, unit: 'line', description: 'New mobile lines sold ÷ all logged calls. Each order contains 1–12 lines; lines across multiple orders are added together, so the rate can exceed 100%.' }
];

export const DEFAULT_GOALS = Object.fromEntries(METRICS.map(metric => [metric.key, metric.goal]));

/** Classify saves by remaining services and full disconnects by starting services. */
export function classifyCall(before, kept) {
  if (!Array.isArray(before) || !Array.isArray(kept)) return null;
  const validBefore = [...new Set(before)].filter(key => SERVICES.some(service => service.key === key));
  const validKept = [...new Set(kept)].filter(key => validBefore.includes(key));
  if (!validBefore.length) return null;
  const saved = validKept.length > 0;
  const tier = Math.min(saved ? validKept.length : validBefore.length, 3);
  const prefix = ['', 'SP', 'DP', 'TP'][tier];
  return { code: prefix + (saved ? 'S' : 'D'), saved, tier, disconnected: validBefore.filter(service => !validKept.includes(service)) };
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

/** Compute each denominator independently so a bundle save can still lose a service. */
export function calculateMetrics(calls, goals = DEFAULT_GOALS) {
  const validCalls = calls.map(call => ({ ...call, outcome: classifyCall(call?.before, call?.kept) })).filter(call => call.outcome);
  return METRICS.map(metric => {
    let eligible = validCalls;
    let successes = 0;
    if (metric.key === 'overall') successes = validCalls.filter(call => call.outcome.saved).length;
    else if (metric.key === 'orders') successes = validCalls.reduce((sum, call) => sum + soldOrdersFor(call), 0);
    else if (metric.key === 'sales') successes = validCalls.reduce((sum, call) => sum + soldLinesFor(call), 0);
    else if (['sp', 'dp', 'tp'].includes(metric.key)) {
      const prefix = metric.key.toUpperCase();
      eligible = validCalls.filter(call => call.outcome.code.startsWith(prefix));
      successes = eligible.filter(call => call.outcome.saved).length;
    } else {
      eligible = validCalls.filter(call => call.before.includes(metric.key));
      successes = eligible.filter(call => call.kept.includes(metric.key)).length;
    }
    const total = eligible.length;
    const rate = total ? successes / total * 100 : null;
    const candidate = goals?.[metric.key];
    const goal = Number.isFinite(candidate) && candidate >= 0 && candidate <= 100 ? candidate : metric.goal;
    const progress = rate === null ? 0 : goal === 0 ? 1 : Math.min(rate / goal, 1);
    return { ...metric, successes, total, rate, goal, progress, needed: successesNeeded(successes, total, goal), reached: total > 0 && rate >= goal - 1e-8 };
  });
}

/** Assign records and daily reporting to the agent's Eastern working day. */
export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
