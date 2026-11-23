import { ruleText } from './game-rules.js';
import { games, gameById, modes, results, defaultConfig, bingoBlocks } from './arcade-catalog.js';
export const html = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const art = (g) => '--x:' + (g.index % 5) * 25 + '%;--y:' + (Math.floor(g.index / 5) * 100) / 3 + '%';
const localTime = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const opts = (items, selected) =>
  Object.entries(items)
    .map(
      ([k, v]) =>
        '<option value="' + html(k) + '"' + (selected === k ? ' selected' : '') + '>' + html(v) + '</option>',
    )
    .join('');
const primaryKinds = [
  'vault',
  'rally',
  'mission',
  'heist',
  'switchboard',
  'fm',
  'belt',
  'swap',
  'macro',
  'caption',
  'territory',
  'wavelength',
  'ghost',
  'plot',
  'elevator',
  'manual',
  'domino',
];
const bonusKinds = [
  'vault',
  'rally',
  'mission',
  'heist',
  'switchboard',
  'fm',
  'belt',
  'swap',
  'macro',
  'caption',
  'territory',
  'elevator',
  'domino',
];
export function gameCover(g) {
  return '<div class="arc-cover" style="' + art(g) + '" aria-hidden="true"></div>';
}
export function gameLibraryView(ids) {
  return (
    '<div class="arc-catalog">' +
    ids
      .map((id) => gameById[id])
      .filter(Boolean)
      .map(
        (g) =>
          '<button type="button" class="arc-card" data-arc-open="' +
          g.id +
          '">' +
          gameCover(g) +
          '<span><small>' +
          g.genre +
          '</small><strong>' +
          g.name +
          '</strong><span>' +
          g.description +
          '</span></span></button>',
      )
      .join('') +
    '</div>'
  );
}
function builder(g, sup, admin) {
  const rules = defaultConfig(g.id),
    start = new Date(),
    end = new Date(start.getTime() + 3600000);
  const metricSelect = (key, label) =>
    '<label>' + label + '<select name="' + key + '">' + opts(results, rules[key]) + '</select></label>';
  return (
    '<form class="arc-builder"><fieldset><legend>Round setup</legend>' +
    (admin
      ? '<label>Play on team<select required name="supervisor">' +
        opts(Object.fromEntries(sup.filter((s) => s.team).map((s) => [s.id, s.team + ' · ' + s.name]))) +
        '</select></label>'
      : '') +
    '<label>Round name<input required maxlength="80" name="title" value="' +
    g.name +
    '"></label><label>Incentive <small>(optional)</small><input maxlength="240" name="incentive" placeholder="Choose the team playlist"></label>' +
    '<div class="arc-fields"><label>Starts<input required type="datetime-local" name="startsAt" value="' +
    localTime(start) +
    '"></label><label>Ends<input required type="datetime-local" name="endsAt" value="' +
    localTime(end) +
    '"></label></div><small>Times shown in ' +
    html(Intl.DateTimeFormat().resolvedOptions().timeZone) +
    '.</small></fieldset>' +
    '<fieldset><legend>Game rules</legend><label>' +
    (g.id === 'bingo' ? 'Winning pattern' : 'Variation') +
    '<select name="mode">' +
    opts(Object.fromEntries(modes[g.id].map((v) => [v, v])), rules.mode) +
    '</select></label>' +
    (g.id === 'bingo'
      ? '<div class="arc-squares">' +
        bingoBlocks
          .map(
            ([k, n], i) =>
              '<div><strong>Square ' +
              (i + 1) +
              '</strong><select name="m' +
              i +
              '" aria-label="Result for square ' +
              (i + 1) +
              '">' +
              opts(results, k) +
              '</select><label>Target<input name="n' +
              i +
              '" type="number" min="1" max="9999" required value="' +
              n +
              '"></label></div>',
          )
          .join('') +
        '</div>'
      : '<div class="arc-fields"><label>' +
        g.targetLabel +
        '<input required name="target" type="number" min="1" max="' +
        (g.id === 'territory' ? 12 : 99) +
        '" value="' +
        g.target +
        '"></label>' +
        (primaryKinds.includes(g.id) ? metricSelect('metric', 'Earn progress with') : '') +
        (bonusKinds.includes(g.id) ? metricSelect('bonus', 'Bonus result') : '') +
        '</div>') +
    '<p class="arc-preview" data-rule-preview>' +
    html(ruleText(g.id, rules)) +
    '</p></fieldset><p class="arc-error" role="alert"></p><button class="button primary" type="submit">Schedule game</button></form>'
  );
}
export function createGameLibrary({ root, request, actor, admin = false, launched, back }) {
  let catalog = null,
    selected = null,
    epoch = 0,
    busy = false;
  function draw() {
    if (!catalog) return;
    const g = gameById[selected],
      sup = catalog.supervisors ?? [],
      ids = admin ? games.map((g) => g.id) : (catalog.games ?? []);
    if (!g) {
      root.innerHTML =
        '<div class="arc-library-heading"><div><h3>Game library</h3><p>' +
        (admin
          ? 'Choose a game to manage access or set up a team round.'
          : 'Choose a game to customize for your team.') +
        '</p></div>' +
        (back ? '<button class="text-button" data-close-library>Back to game</button>' : '') +
        '</div>' +
        (ids.length
          ? gameLibraryView(ids)
          : '<p class="games-muted">Your admin can enable games for your team here.</p>');
      return;
    }
    root.innerHTML =
      '<button type="button" class="text-button arc-back" data-arc-back>← Game library</button><article class="arc-detail"><header>' +
      gameCover(g) +
      '<div><small>' +
      g.genre +
      '</small><h3>' +
      g.name +
      '</h3><p>' +
      g.description +
      '</p></div></header>' +
      (admin
        ? '<fieldset class="arc-access"><legend>Supervisor access</legend>' +
          (sup.length
            ? sup
                .map(
                  (s) =>
                    '<label><input type="checkbox" data-grant="' +
                    html(s.id) +
                    '"' +
                    (s.games.includes(g.id) ? ' checked' : '') +
                    '><span>' +
                    html(s.name) +
                    '</span><small>' +
                    html(s.team ?? 'No team assigned') +
                    '</small></label>',
                )
                .join('')
            : '<p>No supervisor accounts yet.</p>') +
          '<p class="arc-error" data-access-error role="alert"></p></fieldset>'
        : '') +
      (admin && !sup.some((s) => s.team)
        ? '<p>Create a team to schedule this game.</p>'
        : builder(g, sup, admin)) +
      '</article>';
  }
  async function open() {
    const id = actor(),
      stamp = ++epoch;
    if (!id) return;
    catalog = null;
    selected = null;
    busy = false;
    root.textContent = 'Loading game library…';
    try {
      const fresh = await request('gameLibrary', undefined, id);
      if (epoch !== stamp || actor() !== id) return;
      catalog = fresh;
      draw();
    } catch (e) {
      if (epoch === stamp) {
        root.innerHTML =
          '<p role="alert" class="arc-error">' +
          html(e.message) +
          '</p><button class="button secondary" data-retry-library>Retry</button>';
      }
    }
  }
  root.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b || busy) return;
    if (b.hasAttribute('data-retry-library')) return open();
    if (b.hasAttribute('data-close-library')) return back?.();
    if (b.hasAttribute('data-arc-back')) selected = null;
    else if (b.dataset.arcOpen) selected = b.dataset.arcOpen;
    else return;
    draw();
    (root.querySelector('.arc-back') ?? root.querySelector('[data-arc-open]'))?.focus();
  });
  root.addEventListener('input', (ev) => {
    const form = ev.target.closest('.arc-builder');
    if (!form || !selected) return;
    const f = new FormData(form),
      c = defaultConfig(selected);
    for (const k of ['metric', 'bonus', 'mode']) if (f.has(k)) c[k] = f.get(k);
    if (f.has('target') && !Number.isNaN(Number(f.get('target')))) c.target = Number(f.get('target'));
    form.querySelector('[data-rule-preview]').textContent = ruleText(selected, c);
  });
  root.addEventListener('change', async (ev) => {
    const field = ev.target;
    if (!admin || !field.dataset.grant) return;
    const enabled = field.checked,
      g = selected,
      id = actor(),
      sup = catalog.supervisors.find((s) => s.id === field.dataset.grant);
    const err = root.querySelector('[data-access-error]');
    err.textContent = '';
    field.disabled = true;
    try {
      await request('arcadeAccess', { supervisorId: sup.id, kind: g, enabled }, id);
      sup.games = sup.games.filter((k) => k !== g);
      if (enabled) sup.games.push(g);
    } catch (e) {
      field.checked = !enabled;
      err.textContent = e.message;
    } finally {
      field.disabled = false;
    }
  });
  root.addEventListener('submit', async (ev) => {
    if (!ev.target.matches('.arc-builder')) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (busy) return;
    const id = actor(),
      stamp = epoch,
      g = gameById[selected],
      form = ev.target,
      f = new FormData(form),
      rules = defaultConfig(g.id);
    rules.mode = f.get('mode');
    for (const k of ['metric', 'bonus']) if (f.has(k)) rules[k] = f.get(k);
    if (f.has('target')) rules.target = Number(f.get('target'));
    const game = {
      title: f.get('title').trim(),
      incentive: f.get('incentive').trim(),
      startsAt: new Date(f.get('startsAt')).toISOString(),
      endsAt: new Date(f.get('endsAt')).toISOString(),
      pattern: rules.mode === 'Blackout' ? 'blackout' : 'line',
      squares: bingoBlocks.map(([metric, target], i) => ({
        metric: f.get('m' + i) ?? metric,
        target: f.has('n' + i) ? Number(f.get('n' + i)) : target,
      })),
    };
    const err = form.querySelector('[role=alert]');
    err.textContent = '';
    if (!game.title || game.endsAt <= game.startsAt) {
      err.textContent = 'Enter a name and choose an end time after the start.';
      return;
    }
    const button = form.querySelector('[type=submit]');
    button.disabled = busy = true;
    try {
      await request(
        'arcadeLaunch',
        { supervisorId: admin ? f.get('supervisor') : id, kind: g.id, rules, game },
        id,
      );
      if (epoch !== stamp || actor() !== id) return;
      selected = null;
      draw();
      root.insertAdjacentHTML(
        'afterbegin',
        '<p class="arc-confirm" role="status">' + html(game.title) + ' scheduled.</p>',
      );
      launched?.();
    } catch (e) {
      err.textContent = e.message;
    } finally {
      button.disabled = busy = false;
    }
  });
  return {
    open,
    clear() {
      ++epoch;
      catalog = null;
      selected = null;
      busy = false;
      root.replaceChildren();
    },
  };
}
const objectPaths = [
  'M15 4v56m9-56v56M15 6h9m-9 9h9m-9 9h9m-9 9h9m-9 9h9m-9 9h9m-12-5 4 11h8l4-11z',
  'M12 28V17a12 12 0 0 1 24 0v11M8 28h32v27H8zM24 37v8',
  'M23 5l5 6 7-2 2 8 7 4-4 7 3 7-8 3-3 8-8-3-7 4-4-8-8-2 2-8-4-7 8-4 2-8 7 1z M29 25a6 6 0 1 1-12 0 6 6 0 0 1 12 0',
  'M10 9c40-12 40 12 7 12-18 0-4-16 13-10s10 20-13 19c-15-1-4-15 13-9s10 19-13 18c-15-1-4-15 13-9s10 20-13 20',
  'M24 55V31C0-3 46-4 24 31c-10-28 9-28 0 0',
  'M12 7h24l6 46H6z M15 20h3m8 0h3m-15 9h3m10 0h3m-17 9h4m10 0h3',
  'M6 10h37M24 10v8c18 4 10 12-2 14s-2 10 7 8l-8 11',
  'M3 22h44c-2 32-39 32-44 0z M4 20H0m47 0h3M12 29h1m7 4h1m7-4h1m7 3h1',
];
function stageSet(g, s) {
  if (g.id === 'rally' || g.id === 'ghost') {
    const lanes = s.cells.slice(0, 2),
      scores = lanes.map((v) => Number.parseFloat(v.value) || 0),
      max = Math.max(1, ...scores);
    return (
      '<div class="arc-track" aria-hidden="true">' +
      lanes
        .map((c, i) => '<div><i style="--distance:' + Math.min(92, (92 * scores[i]) / max) + '%">◆</i></div>')
        .join('') +
      '</div>'
    );
  }
  if (g.id === 'fm')
    return (
      '<div class="arc-mixer" aria-hidden="true">' +
      Array.from(
        { length: 24 },
        (_, i) =>
          '<i style="--i:' +
          i +
          ';--h:' +
          (s.track[Math.floor(i / 8)] >= 0 ? 20 + ((i * 37) % 70) : 8) +
          '%"></i>',
      ).join('') +
      '</div>'
    );
  if (g.id === 'elevator')
    return (
      '<div class="arc-tower" aria-hidden="true">' +
      Array.from(
        { length: 5 },
        (_, i) =>
          '<i class="' + (i < Number(s.cells[0].value) + Number(s.cells[1].value) ? 'on' : '') + '"></i>',
      ).join('') +
      '</div>'
    );
  if (g.id === 'wavelength')
    return (
      '<div class="arc-dial" aria-hidden="true"><i style="--angle:' +
      (Number(s.cells.find((x) => x.label === 'Your dial')?.value ?? 5) - 5) * 17 +
      'deg"></i></div>'
    );
  return '';
}
export function sceneView(data, supervisor) {
  const g = gameById[data.game.kind],
    s = data.scene;
  let extra = stageSet(g, s);
  if (s.chain)
    extra =
      '<div class="domino-track ' +
      (s.chain.spiral ? 'spiral' : '') +
      ' ' +
      (s.won ? 'fallen' : '') +
      '" aria-hidden="true">' +
      Array.from(
        { length: Math.min(28, s.chain.target) },
        (_, i) =>
          '<i style="--i:' +
          i +
          ';opacity:' +
          (i / Math.min(28, s.chain.target) < s.chain.tiles / s.chain.target ? 1 : 0.18) +
          '"></i>',
      ).join('') +
      '</div>';
  if (s.puzzle) {
    const p = s.puzzle;
    extra =
      '<div class="macro-lens"><svg viewBox="0 0 48 60" style="filter:blur(' +
      (4 - p.level) * 1.2 +
      'px);transform:scale(' +
      (2.5 - p.level * 0.35) +
      ')" aria-label="Mystery detail"><path d="' +
      objectPaths[p.shape + (p.theme === 'kitchen' ? 4 : 0)] +
      '"/></svg></div>';
  }
  return (
    '<article class="arc-stage kind-' +
    g.id +
    '">' +
    gameCover(g) +
    '<div class="arc-stage-body"><small>' +
    html(data.game.status) +
    ' · ' +
    g.genre +
    '</small><h3>' +
    html(data.game.title) +
    '</h3><p>' +
    html(ruleText(g.id, data.game.rules)) +
    '</p><h4>' +
    html(s.headline) +
    '</h4>' +
    extra +
    '<div class="arc-tiles">' +
    s.cells
      .map(
        (x) =>
          '<div class="' +
          (x.done ? 'lit' : '') +
          '"><strong>' +
          html(x.value) +
          '</strong><span>' +
          html(x.label) +
          '</span></div>',
      )
      .join('') +
    '</div>' +
    (s.track ? '<button type="button" class="arc-action" data-listen>▶ Play team mix</button>' : '') +
    (s.actions.length
      ? '<div class="arc-moves">' +
        s.actions
          .map(
            (a) =>
              '<button class="arc-action" data-arc-move="' + html(a.key) + '">' + html(a.label) + '</button>',
          )
          .join('') +
        '</div>'
      : '') +
    '<p class="arc-round-meta">Ends ' +
    html(new Date(data.game.endsAt).toLocaleString()) +
    (data.game.incentive ? ' · ' + html(data.game.incentive) : '') +
    '</p></div></article>' +
    '<h4>Team standings</h4>' +
    (data.me
      ? '<p class="games-muted">Your rank · #' + data.me.rank + ' · ' + data.me.points + ' pts</p>'
      : '') +
    '<div class="games-standings">' +
    (supervisor ? data.members : data.leaders)
      .map((p) => {
        const score =
          '<span>#' +
          p.rank +
          '</span><strong>' +
          html(p.username) +
          '</strong><span>' +
          p.points +
          ' pts' +
          (p.won ? ' · Winner' : '') +
          '</span>';
        if (!supervisor) return '<div class="games-standing">' + score + '</div>';
        return (
          '<details data-player="' +
          html(p.username) +
          '"><summary class="games-standing">' +
          score +
          '</summary><dl class="games-player-stats">' +
          Object.entries(results)
            .filter(([k]) => k === 'calls' || p.stats[k])
            .map(([k, label]) => '<div><dt>' + html(label) + '</dt><dd>' + (p.stats[k] ?? 0) + '</dd></div>')
            .join('') +
          '</dl></details>'
        );
      })
      .join('') +
    '</div>'
  );
}
export function playMix(track, daybreak = false) {
  const C = window.AudioContext ?? window.webkitAudioContext;
  if (!C) return;
  const ctx = new C();
  ctx.resume().catch(() => ctx.close());
  track.forEach((mix, i) => {
    if (mix < 0) return;
    for (let beat = 0; beat < 8; beat++) {
      const o = ctx.createOscillator(),
        gain = ctx.createGain(),
        at = ctx.currentTime + beat * 0.2 + i * 0.03;
      o.type = ['triangle', 'sine', 'square'][i];
      o.frequency.value =
        [84, 147, 294][i] * (1 + mix * 0.25) * (daybreak ? 1.25 : 1) * (beat % 3 === 0 ? 1.25 : 1);
      gain.gain.setValueAtTime(0.035, at);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.15);
      o.connect(gain).connect(ctx.destination);
      o.start(at);
      o.stop(at + 0.16);
    }
  });
  setTimeout(() => ctx.close(), 2200);
}
