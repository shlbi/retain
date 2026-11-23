import { defaultConfig, gameById, results } from '../dist/arcade-catalog.js';

const symbols = ['Sun', 'Wave', 'Leaf', 'Bolt', 'Moon', 'Star'];
const stamps = ['Rocket', 'Comet', 'Planet', 'Radio', 'Orbit', 'Moon'];
const captions = [
  'I booked the copier for lunch.',
  'That meeting could have been a squeak.',
  'My résumé said night shift.',
  'It printed 40 copies of my paw.',
  'Tell payroll I work for snacks.',
  'The moon has better parking.',
];
const fantasyKeys = ['internet', 'tv', 'phone', 'sp', 'dp', 'mobileOrders', 'mobileLines'];
const sum = (items, get) => items.reduce((n, item) => n + get(item), 0);
const val = (stats, k) => stats?.[k] ?? 0;
const hash = (text) => [...text].reduce((n, c) => Math.imul(n ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261);
const cycle = (n, size) => ((n % size) + size) % size;
function neighbors(i, riverside) {
  return [i - 4, i + 4, ...(i % 4 ? [i - 1] : []), ...(i % 4 < 3 ? [i + 1] : [])].filter(
    (k) =>
      k >= 0 &&
      k < 12 &&
      (!riverside || Math.abs(k - i) !== 4 || Math.min(i, k) >= 4 || [0, 3].includes(i % 4)),
  );
}
function region(land, crew, riverside) {
  const seen = new Set();
  let best = 0;
  for (let i = 0; i < 12; i++) {
    if (land[i] !== crew || seen.has(i)) continue;
    const queue = [i];
    seen.add(i);
    for (let j = 0; j < queue.length; j++) {
      const n = queue[j];
      for (const k of neighbors(n, riverside)) {
        if (k >= 0 && k < 12 && !seen.has(k) && land[k] === crew) {
          seen.add(k);
          queue.push(k);
        }
      }
    }
    best = Math.max(best, queue.length);
  }
  return best;
}

// Each choice is constructed alongside its eligibility check. Only the server executes it.
// Secrets, other players' drafts and move handlers never cross the API boundary.
function turn(s, player) {
  const kind = s.kind,
    c = s.config,
    w = s.world,
    team = s.players,
    t = c.target;
  const id = player?.id,
    mine = id ? (w[id] ?? {}) : {};
  const stat = (k, p = player) => val(p?.stats, k),
    primary = stat(c.metric),
    bonus = stat(c.bonus);
  const total = (k) => sum(team, (p) => stat(k, p)),
    group = total(c.metric);
  const crew = (p) => (p?.seat ?? hash(p?.id ?? 'visitor')) % 2;
  const side = crew(player),
    other = 1 - side;
  const rand = (name, n) => hash(s.secret + ':' + name) % n;
  const second = c.mode !== s.firstMode,
    live = !!player && s.game.status === 'live';
  const view = { points: 0, won: false, headline: '', cells: [], actions: [], moves: new Map() };
  const cell = (label, value, done = false) =>
    view.cells.push({ label: String(label), value: String(value), done: Boolean(done) });
  const action = (key, label, enabled, perform) => {
    if (!live || !enabled) return;
    view.actions.push({ key, label });
    view.moves.set(key, perform);
  };
  const personal = () => (w[id] ??= {});
  const mark = (points, goal) => {
    view.points = points;
    view.won = points >= goal;
  };
  const tallyVotes = (key, n) =>
    Array.from({ length: n }, (_, i) => team.filter((p) => w[p.id]?.[key] === i).length);
  const cast = (key, choices, enabled = true) =>
    choices.forEach((v, i) =>
      action(key + i, v, enabled && mine[key] !== i, () => {
        personal()[key] = i;
      }),
    );
  const options = (prefix, items, enabled, perform) =>
    items.forEach((label, i) => action(prefix + i, label, enabled(i), () => perform(i)));
  switch (kind) {
    case 'vault': {
      const locks = [c.metric, 'internet', c.bonus];
      const goals = [t, second ? t * 2 : t, Math.max(1, Math.ceil(t / 2))];
      locks.forEach((k, i) =>
        cell(
          ['Dial', 'Keyway', 'Deadbolt'][i] + ' · ' + results[k],
          total(k) + ' / ' + goals[i],
          total(k) >= goals[i],
        ),
      );
      view.won = view.cells.every((x) => x.done);
      view.points = sum(locks, (k) => stat(k));
      view.headline = view.won ? 'Vault open' : 'Crack all three team locks';
      break;
    }
    case 'belt': {
      const d = w.duel ?? { champ: team[0]?.id, opponent: team[1]?.id, scores: {} };
      for (const [label, fighter] of [
        ['Champion', d.champ],
        ['Challenger', d.opponent],
      ]) {
        const p = team.find((p) => p.id === fighter),
          round = d.scores[fighter];
        cell(label, p?.username ?? 'Waiting');
        if (p) cell(label + ' score', (round?.points ?? 0) + ' pts · ' + (round?.calls ?? 0) + ' / ' + t);
      }
      view.won = !!w.duel && !d.opponent && d.champ === id;
      view.points = mine.defenses ?? 0;
      view.headline = view.won
        ? 'The belt is yours'
        : 'Only calls during your duel score. Ties go to the champion.';
      break;
    }
    case 'rally':
    case 'ghost': {
      const metric = kind === 'ghost' && second ? 'mobileOrders' : c.metric;
      const score = (p) =>
        val(p?.finish ?? p?.stats, metric) +
        (kind === 'ghost' ? 0 : val(p?.finish ?? p?.stats, c.bonus) * (second ? 3 : 2));
      const finish = (p) => !!p.finish;
      view.points = score(player);
      if (kind === 'ghost') {
        const previous = player?.ghost ? val(player.ghost, metric) : null;
        cell('Your car', view.points);
        cell('Ghost', previous ?? 'First race');
        cell('Calls', Math.min(t, stat('calls')) + ' / ' + t);
        view.won = !!player?.finish && (previous === null || view.points > previous);
        view.headline = previous === null ? 'Set your personal benchmark' : 'Beat your previous finish';
        break;
      }
      if (kind === 'rally') {
        const drivers = [team.filter((p) => crew(p) === 0), team.filter((p) => crew(p) === 1)];
        const distances = drivers.map((d) => (d.length ? sum(d, score) / d.length : 0));
        distances.forEach((d, i) => cell(['Blue crew', 'Coral crew'][i], d.toFixed(1) + ' km'));
        view.won = drivers.every((d) => d.length && d.every(finish)) && distances[side] >= distances[other];
        view.headline = 'Crew distance per driver · ' + t + ' calls each';
        break;
      }
    }
    case 'mission': {
      const keys = [...new Set([c.metric, c.bonus, 'internet', 'tv', 'dp'])].slice(0, 3);
      const stamped = mine.stamps ?? [],
        active = mine.contract;
      keys.forEach((k, i) => {
        const need = t + (second ? i : 0),
          earned = active?.key === k ? stat(k) - active.base : 0;
        cell(
          results[k],
          stamped.includes(k) ? 'Stamped' : active?.key === k ? earned + ' / ' + need : 'Available',
          stamped.includes(k),
        );
        action('take' + i, 'Draft ' + results[k], !active && !stamped.includes(k), () => {
          personal().contract = { key: k, base: stat(k) };
        });
        action('stamp' + i, 'Stamp contract', active?.key === k && earned >= need, () => {
          personal().stamps = [...stamped, k];
          delete personal().contract;
        });
      });
      mark(stamped.length, 3);
      view.headline = 'Fill your three-stamp passport';
      break;
    }
    case 'heist': {
      const lockers = ['A', 'B', 'C', 'D', 'E', 'F'],
        rival = w['rock' + other],
        secret = w['rock' + side],
        scans = mine.scans ?? [];
      const tries = 1 + Math.floor(primary / t) + bonus,
        won = w.heistWinner,
        decoy = w['decoy' + other];
      view.headline =
        won !== undefined
          ? 'Crew ' + (won + 1) + ' recovered the rock'
          : 'Hide your rock and read rival signals';
      options(
        'hide',
        lockers.map((x) => 'Hide in ' + x),
        () => secret === undefined && won === undefined,
        (i) => {
          w['rock' + side] = i;
        },
      );
      options(
        'decoy',
        lockers.map((x) => 'Place decoy ' + x),
        (i) => secret !== undefined && i !== secret && w['decoy' + side] === undefined && won === undefined,
        (i) => {
          w['decoy' + side] = i;
        },
      );
      action(
        'doublecross',
        'Swap rock and decoy',
        bonus > 0 && w['decoy' + side] !== undefined && !w['swapped' + side] && won === undefined,
        () => {
          w['rock' + side] = w['decoy' + side];
          w['decoy' + side] = secret;
          w['swapped' + side] = true;
        },
      );
      lockers.forEach((x, i) => {
        const scanned = scans.includes(i),
          near = rival !== undefined && Math.abs(i - rival) <= 1;
        cell(
          'Locker ' + x,
          scanned
            ? i === rival || i === decoy
              ? 'Strong signal'
              : near && !second
                ? 'Nearby'
                : 'Cold'
            : 'Sealed',
          scanned,
        );
        action(
          'scan' + i,
          'Scan ' + x,
          rival !== undefined &&
            !scanned &&
            scans.length < Math.floor(primary / t) + bonus &&
            won === undefined,
          () => {
            personal().scans = [...scans, i];
          },
        );
        const guesses = mine.guesses ?? [];
        action(
          'guess' + i,
          'Recover ' + x,
          rival !== undefined &&
            secret !== undefined &&
            !guesses.includes(i) &&
            guesses.length < tries &&
            won === undefined,
          () => {
            personal().guesses = [...guesses, i];
            if (i === rival) w.heistWinner = side;
          },
        );
      });
      view.won = won === side;
      view.points = scans.length + (view.won ? 6 : 0);
      break;
    }
    case 'switchboard': {
      const n = second ? 6 : 4,
        switches = w.switches ?? Array(n).fill(0);
      let lit = 0,
        open = true;
      switches.forEach((a, i) => {
        const required = 1 + rand('tile' + i, 3);
        open = open && a === required;
        if (open) lit++;
        cell('Relay ' + (i + 1), ['↑', '→', '↓', '←'][a] + ' to ' + ['↑', '→', '↓', '←'][required], open);
        action(
          'bridge' + i,
          'Bridge relay ' + (i + 1),
          !w.powered && a !== required && (mine.bridges ?? 0) < bonus,
          () => {
            switches[i] = required;
            w.switches = switches;
            personal().bridges = (mine.bridges ?? 0) + 1;
            if (switches.every((v, j) => v === 1 + rand('tile' + j, 3))) w.powered = true;
          },
        );
        action(
          'rotate' + i,
          'Rotate relay ' + (i + 1),
          !w.powered && (mine.turns ?? 0) < Math.floor(primary / t),
          () => {
            switches[i] = (a + 1) % 4;
            w.switches = switches;
            personal().turns = (mine.turns ?? 0) + 1;
            if (switches.every((v, j) => v === 1 + rand('tile' + j, 3))) w.powered = true;
          },
        );
      });
      view.points = mine.turns ?? 0;
      view.won = !!w.powered;
      view.headline = lit + ' of ' + n + ' city blocks powered';
      break;
    }
    case 'fm': {
      const layers = ['Drums', 'Bass', 'Keys'],
        presets = ['Pulse', 'Swing', 'Glide'];
      view.track = [];
      layers.forEach((label, i) => {
        const enabled = group >= t * (i + 1),
          votes = tallyVotes('layer' + i, 3),
          mix = votes.indexOf(Math.max(...votes));
        cell(label, enabled ? presets[mix] : 'Locked', enabled);
        view.track.push(enabled ? mix : -1);
        cast(
          'layer' + i,
          presets.map((n) => label + ' · ' + n),
          enabled,
        );
      });
      cell('Chorus', total(c.bonus) > 0 ? 'On air' : 'Waiting', total(c.bonus) > 0);
      view.points = primary + bonus;
      view.won = view.track.every((x) => x >= 0) && total(c.bonus) > 0;
      view.headline = 'The team mixing desk';
      break;
    }
    case 'swap': {
      const n = second ? 6 : 4,
        album = mine.album ?? Array(n).fill(0),
        packs = mine.packs ?? 0;
      album.forEach((v, i) => cell(stamps[i], v ? '×' + v : 'Missing', v));
      action('pack', 'Open earned pack', packs < Math.floor(primary / t), () => {
        album[rand(id + packs, n)]++;
        personal().album = album;
        personal().packs = packs + 1;
      });
      options(
        'wild',
        stamps.slice(0, n).map((x) => 'Wild · ' + x),
        (i) => !album[i] && (mine.wild ?? 0) < bonus,
        (i) => {
          album[i]++;
          personal().album = album;
          personal().wild = (mine.wild ?? 0) + 1;
        },
      );
      // A trade exchanges only duplicates on both sides, so neither album loses a collected design.
      for (const p of team) {
        const theirs = w[p.id]?.album;
        if (!theirs || p.id === id) continue;
        const give = album.findIndex((v, i) => v > 1 && !theirs[i]),
          take = theirs.findIndex((v, i) => v > 1 && !album[i]);
        action('trade' + p.id, 'Swap doubles with ' + p.username, give >= 0 && take >= 0, () => {
          album[give]--;
          album[take]++;
          theirs[give]++;
          theirs[take]--;
          personal().album = album;
        });
      }
      mark(album.filter(Boolean).length, n);
      view.headline = 'Complete your stamp album';
      break;
    }
    case 'macro': {
      const objects = second
        ? ['Whisk', 'Grater', 'Corkscrew', 'Colander']
        : ['Zipper', 'Padlock', 'Gear', 'Spring'];
      const clues = second
        ? ['Wire loops', 'Rows of sharp holes', 'A pointed spiral', 'A perforated bowl']
        : ['Interlocking teeth', 'A metal shackle', 'A toothed wheel', 'A coil of wire'];
      const answer = rand('object', 4),
        level = Math.min(4, Math.floor(group / t));
      view.puzzle = { shape: answer, theme: second ? 'kitchen' : 'workshop', level };
      cell('Focus', level + ' / 4');
      if (bonus) cell('Private clue', clues[answer]);
      options(
        'guess',
        objects,
        () => mine.guess === undefined && level > 0,
        (i) => {
          personal().guess = i;
          personal().points = i === answer ? 5 - level : 0;
        },
      );
      if (mine.guess !== undefined) cell('Your guess', objects[mine.guess], mine.guess === answer);
      view.points = mine.points ?? 0;
      view.won = view.points > 0;
      view.headline = 'One guess per player';
      break;
    }
    case 'caption': {
      const lines = second
        ? [
            'One small step for payroll.',
            'We left the agenda on Earth.',
            'Mute your space helmet.',
            ...captions.slice(3),
          ]
        : captions;
      const entries = team.filter((p) => w[p.id]?.entry !== undefined);
      options(
        'enter',
        lines,
        (i) => primary >= t && mine.entry === undefined && (!i || i < 4 || bonus > 0),
        (i) => {
          personal().entry = i;
        },
      );
      entries.forEach((p) => {
        const votes = team.filter((v) => w[v.id]?.vote === p.id).length;
        cell(lines[w[p.id].entry], votes + ' votes');
        action('vote' + p.id, 'Vote · ' + lines[w[p.id].entry], p.id !== id && mine.vote !== p.id, () => {
          personal().vote = p.id;
        });
      });
      view.points = team.filter((p) => w[p.id]?.vote === id).length;
      view.won =
        s.game.status === 'finished' &&
        view.points > 0 &&
        entries.every((p) => team.filter((v) => w[v.id]?.vote === p.id).length <= view.points);
      view.headline = second ? 'The moon meeting ran over' : 'A raccoon walks into the copy room';
      break;
    }
    case 'territory': {
      const land = w.land ?? Array(12).fill(null),
        owns = land.includes(side),
        moves = mine.flags ?? 0;
      land.forEach((v, i) => {
        const adjacent = neighbors(i, second).some((k) => land[k] === side);
        cell('Block ' + (i + 1), v === null ? 'Open' : v ? 'Coral' : 'Blue', v === side);
        action(
          'flag' + i,
          'Flag ' + (i + 1),
          w.cityWinner === undefined && v === null && (!owns || adjacent) && moves < primary + bonus * 2,
          () => {
            land[i] = side;
            w.land = land;
            personal().flags = moves + 1;
            if (region(land, side, second) >= t) w.cityWinner = side;
          },
        );
      });
      view.won = w.cityWinner === side;
      view.points = moves;
      view.headline = c.mode + ' · connect ' + t + ' blocks';
      break;
    }
    case 'wavelength': {
      const setter = team[0]?.id,
        hints = second ? ['Ice', 'Coffee', 'Sunshine'] : ['Library', 'Rainfall', 'Stadium'];
      if (id === setter && w.dial === undefined)
        options(
          'dial',
          Array.from({ length: 9 }, (_, i) => 'Set dial ' + (i + 1)),
          () => true,
          (i) => {
            w.dial = i;
          },
        );
      if (id === setter && w.dial !== undefined && w.hint === undefined)
        options(
          'hint',
          hints,
          () => true,
          (i) => {
            w.hint = i;
          },
        );
      if (w.hint !== undefined) cell('Clue', hints[w.hint]);
      options(
        'tune',
        Array.from({ length: 9 }, (_, i) => 'Tune ' + (i + 1)),
        () => id !== setter && w.hint !== undefined && mine.tune === undefined && primary >= t,
        (i) => {
          personal().tune = i;
        },
      );
      const others = team.filter((p) => p.id !== setter);
      const reveal =
        others.length > 0 && (others.every((p) => w[p.id]?.tune !== undefined) || s.game.status === 'finished');
      if (id === setter || reveal) cell('Secret dial', w.dial === undefined ? 'Choose' : w.dial + 1);
      if (mine.tune !== undefined) cell('Your dial', mine.tune + 1);
      const distance = (p) => Math.abs((w[p.id]?.tune ?? 99) - w.dial);
      view.points = reveal && mine.tune !== undefined ? 9 - distance(player) : 0;
      view.won = reveal && mine.tune !== undefined && others.every((p) => distance(p) >= distance(player));
      view.headline = c.mode;
      break;
    }
    case 'plot': {
      const path = w.path ?? [],
        stage = path.length,
        scenes = second
          ? ['A radio calls your name', 'The signal splits', 'The last transmission']
          : ['The midnight train stops', 'The sleeper car is empty', 'A lantern at the crossing'];
      const branches = second
        ? [
            ['Trace the call', 'Send a reply'],
            ['Open the relay', 'Follow the echo'],
            ['Broadcast', 'Listen'],
          ]
        : [
            ['Take the envelope', 'Follow the porter'],
            ['Search the carriage', 'Ask the conductor'],
            ['Open the gate', 'Signal the train'],
          ];
      path.forEach((v, i) => cell('Chapter ' + (i + 1), branches[i][v], true));
      if (stage < 3 && group >= t * (stage + 1)) {
        cast('chapter' + stage, branches[stage]);
        const votes = tallyVotes('chapter' + stage, 2),
          needed = Math.max(1, Math.ceil(team.length / 2));
        action('turnPage', 'Reveal next chapter', Math.max(...votes) >= needed, () => {
          w.path = [...path, votes[1] > votes[0] ? 1 : 0];
        });
      }
      view.won = stage === 3;
      view.points = Object.keys(mine).filter((k) => k.startsWith('chapter')).length;
      const endings = second
        ? ['A voice answers from tomorrow', 'Your reply reaches home']
        : ['The porter delivers the lost letter', 'The train rolls into dawn'];
      view.headline = view.won
        ? endings[path.reduce((a, b) => a + b, 0) % 2]
        : scenes[stage] + (stage ? ' · ' + branches[stage - 1][path[stage - 1]] : '');
      break;
    }
    case 'elevator': {
      const ride = mine.ride,
        floor = mine.floor ?? 0,
        bank = mine.bank ?? 0;
      cell('Banked', bank);
      cell('Cabin', floor);
      cell('Checkpoint', ride ? Math.min(stat('calls') - ride.calls, t) + ' / ' + t : 'At rest');
      action('ride', 'Ride one more floor', !ride && bank < 5, () => {
        personal().ride = { calls: stat('calls'), primary, bonus };
      });
      // The tally transaction settles the ride on its final call, even when the drawer is closed.
      action('bank', 'Bank this floor', !ride && floor > 0, () => {
        personal().bank = bank + floor;
        personal().floor = 0;
      });
      mark(bank, 5);
      view.headline = 'Bank five floors to win';
      break;
    }
    case 'manual': {
      const n = second ? 6 : 4,
        stage = w.solved ?? 0,
        cue = rand('beacon' + stage, n),
        offset = 1 + rand('offset' + stage, n - 1);
      const operator = team[stage % Math.max(1, team.length)]?.id;
      cell('Signals', stage + ' / 3');
      if (stage < 3 && id && team.length > 1) {
        if (id === operator) cell('Your panel', symbols[cue]);
        else for (let i = 0; i < n; i++) cell(symbols[i], symbols[(i + offset) % n]);
        options(
          'wire',
          symbols.slice(0, n).map((x) => 'Press ' + x),
          () => id === operator && group >= (stage + 1) * t && (mine.failedAt ?? -1) !== group,
          (i) => {
            if (i === (cue + offset) % n) {
              w.solved = stage + 1;
              personal().solves = (mine.solves ?? 0) + 1;
            } else personal().failedAt = group;
          },
        );
      }
      view.points = mine.solves ?? 0;
      view.won = stage === 3;
      view.headline =
        team.length < 2
          ? 'Waiting for a second player'
          : id === operator
            ? 'Read your beacon to a teammate'
            : 'Tell the operator which symbol to press';
      break;
    }
    case 'fantasy': {
      const picks = mine.picks ?? [];
      options(
        'draft',
        fantasyKeys.map((k) => 'Draft ' + results[k]),
        (i) => picks.length < 3 && !picks.includes(fantasyKeys[i]),
        (i) => {
          personal().picks = [...picks, fantasyKeys[i]];
        },
      );
      picks.forEach((k, i) => {
        const earned = mine.baseline ? Math.max(0, total(k) - mine.baseline[k]) : 0;
        cell(results[k], earned + (mine.captain === k ? ' · Captain' : ''), mine.captain === k);
        action('captain' + i, 'Captain · ' + results[k], picks.length === 3 && !mine.baseline, () => {
          personal().captain = k;
          personal().baseline = Object.fromEntries(picks.map((key) => [key, total(key)]));
        });
        view.points += earned * (mine.captain === k ? (second ? 3 : 2) : 1);
      });
      view.won = view.points >= t;
      view.headline = 'Draft three, then choose your captain';
      break;
    }
    case 'domino': {
      const tiles = Math.min(t, group),
        votes = tallyVotes('route', 2),
        spiral = votes[0] === votes[1] ? second : votes[1] > votes[0];
      cell('Chain', tiles + ' / ' + t, tiles === t);
      cell('Route', spiral ? 'Spiral' : 'Bridge');
      view.chain = { tiles, target: t, spiral };
      cast('route', ['Build a bridge', 'Build a spiral'], bonus > 0 && tiles < t);
      view.points = primary;
      view.won = tiles === t;
      view.headline = view.won ? 'The chain is falling!' : 'Leave a tile for the next teammate';
      break;
    }
  }
  return view;
}
import { modes } from '../dist/arcade-catalog.js';
function context(raw) {
  return { ...raw, config: { ...defaultConfig(raw.kind), ...raw.rules }, firstMode: modes[raw.kind][0] };
}
export function projectGame(raw, actor) {
  if (!raw?.game)
    return {
      game: null,
      me: null,
      leaders: [],
      members: [],
      hasLibrary: !!raw?.hasLibrary,
      channel: raw?.channel,
    };
  const { game, channel } = raw,
    kind = raw.kind ?? 'bingo';
  if (kind === 'bingo')
    return {
      hasLibrary: !!raw.hasLibrary,
      game: { ...game, kind },
      channel,
      me: raw.me,
      leaders: raw.leaders,
      members: raw.members,
      winners: raw.bingoWinners ?? raw.leaders.filter((p) => p.won).map((p) => p.username),
    };
  const s = context(raw),
    player = s.players.find((p) => p.id === actor);
  const summaries = s.players
    .map((p) => {
      const v = turn(s, p);
      return { id: p.id, username: p.username, points: v.points, won: v.won };
    })
    .sort(
      (a, b) => Number(b.won) - Number(a.won) || b.points - a.points || a.username.localeCompare(b.username),
    );
  let rank = 0;
  const entries = summaries.map((p, i) => {
    if (!i || summaries[i - 1].points !== p.points || summaries[i - 1].won !== p.won) rank = i + 1;
    return { username: p.username, points: p.points, won: p.won, rank };
  });
  const { moves, ...scene } = turn(s, player);
  const winners = entries.filter((p) => p.won).map((p) => p.username);
  return {
    hasLibrary: !!raw.hasLibrary,
    game: { ...game, kind, rules: s.config },
    channel,
    revision: s.revision,
    scene,
    winners,
    leaders: entries.slice(0, 3),
    members:
      actor === s.host
        ? entries.map((e, i) => ({ ...e, stats: s.players.find((p) => p.id === summaries[i].id).stats }))
        : [],
    me: entries[summaries.findIndex((p) => p.id === actor)] ?? null,
  };
}
export function playMove(raw, actor, key) {
  if (!raw?.game || raw.game.status !== 'live' || !Object.hasOwn(gameById, raw.kind) || raw.kind === 'bingo')
    return null;
  const s = context(raw),
    p = s.players.find((item) => item.id === actor);
  if (!p) return null;
  const perform = turn(s, p).moves.get(key);
  if (!perform) return null;
  perform();
  return s.world;
}
