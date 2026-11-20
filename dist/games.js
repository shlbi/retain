import { createGameUpdates } from './games-realtime.js';

// Team game scores come from confirmed server tallies. The drawer always reads the signed-in
// player's game, including while a supervisor is viewing someone else's call log.
const metrics = {
  calls: 'Calls logged', savedCalls: 'Calls saved', internet: 'Internet saves', tv: 'Video saves',
  phone: 'Voice saves', mobile: 'Mobile saves', sp: 'Single-play saves', dp: 'Double-play saves',
  tp: 'Triple-play saves', mobileOrders: 'Mobile orders', mobileLines: 'Mobiles sold'
};
const defaultSquares = [
  ['savedCalls', 3], ['internet', 2], ['mobileOrders', 1], ['sp', 1], ['tv', 1],
  ['mobileLines', 2], ['dp', 1], ['phone', 1], ['calls', 8]
];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[c]);
const iconPaths = {
  bingo: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 3v18m6-18v18M3 9h18M3 15h18"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>'
};
const icon = key => '<svg aria-hidden="true" viewBox="0 0 24 24">' + iconPaths[key] + '</svg>';
const displayTime = new Intl.DateTimeFormat(undefined, {dateStyle:'medium', timeStyle:'short'});
const localTime = date => new Date(date.getTime() - date.getTimezoneOffset()*60000).toISOString().slice(0,16);
const dateText = value => escape(displayTime.format(new Date(value)));
const patternLabel = pattern => pattern === 'blackout' ? 'Cover all nine squares' : 'Three in a row, column or diagonal';
const phaseNames = {live:'Live', scheduled:'Scheduled', finished:'Finished'};
const labels = member => member.won ? 'Bingo' : member.completed + '/9';

function board(game, player) {
  return '<ol class="bingo-board" aria-label="Bingo card">' + game.squares.map(({metric,target}) => {
    const progress = player?.stats?.[metric] || 0;
    const complete = progress >= target;
    return '<li class="' + (complete ? 'square-complete' : '') + '">' +
      '<span class="square-target">' + escape(target) + '</span><span class="square-label">' + escape(metrics[metric]) + '</span>' +
      (player ? '<span class="square-progress">' + (complete ? icon('check') + ' Complete' : escape(progress) + ' of ' + escape(target)) + '</span>' : '') + '</li>';
  }).join('') + '</ol>';
}

function standings(data, supervisor) {
  const list = supervisor ? data.members : data.leaders;
  if (!list.length) return '<p class="games-muted">No players on this board yet.</p>';
  return '<div class="games-standings">' + list.map(player => {
    const score = '<span class="games-place">#' + escape(player.rank) + '</span><strong>' + escape(player.username) +
      '</strong><span class="games-score">' + escape(labels(player)) + '</span>';
    if (!supervisor) return '<div class="games-standing">' + score + '</div>';
    return '<details data-player="' + escape(player.username) + '"><summary class="games-standing">' + score + '</summary>' +
      '<dl class="games-player-stats">' + [...new Set(data.game.squares.map(square => square.metric))].map(metric =>
        '<div><dt>' + escape(metrics[metric]) + '</dt><dd>' + escape(player.stats?.[metric] || 0) + '</dd></div>').join('') + '</dl></details>';
  }).join('') + '</div>';
}

function gameView(data, supervisor) {
  const {game,me} = data;
  if (!game) return '<section class="games-empty">' + icon('bingo') + '<h3>No game scheduled</h3><p>' +
    (supervisor ? 'Set up a bingo game for your team.' : 'Your team’s next game will appear here.') + '</p></section>';
  return '<article class="games-current"><div class="games-phase ' + escape(game.status) + '">' + escape(phaseNames[game.status]) +
    '</div><h3>' + escape(game.title) + '</h3><p class="games-time">' + dateText(game.startsAt) + ' – ' + dateText(game.endsAt) + '</p>' +
    '<dl class="games-facts"><div><dt>Incentive</dt><dd>' + escape(game.incentive || 'No incentive set') + '</dd></div><div><dt>To win</dt><dd>' +
    escape(patternLabel(game.pattern)) + '</dd></div></dl>' +
    '<div class="games-section-heading"><h4>' + (supervisor ? 'Team card' : 'Your card') + '</h4>' +
    (me ? '<span>' + (me.won ? 'Bingo!' : escape(me.completed) + ' of 9 complete') + '</span>' : '') + '</div>' +
    board(game,me) +
    '<div class="games-section-heading"><h4>' + (supervisor ? 'Team standings' : 'Leaderboard') + '</h4>' +
    (me ? '<span>Your rank · #' + escape(me.rank) + '</span>' : '') + '</div>' + standings(data,supervisor) +
    '<p class="games-muted">Winners rank first, followed by completed squares. Tied players share a rank.</p></article>';
}

function scheduleForm() {
  const start = new Date(Math.ceil((Date.now()+60000)/60000)*60000);
  const end = new Date(start.getTime()+60*60000);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return '<form id="game-schedule-form" class="games-form"><div class="games-section-heading"><h3>Schedule a game</h3></div>' +
    '<label>Game<select name="type"><option value="bingo">Bingo</option></select></label>' +
    '<label>Game name<input required name="title" value="Team bingo" maxlength="80"></label>' +
    '<label>Incentive<input name="incentive" placeholder="e.g. First choice of break" maxlength="240"></label>' +
    '<div class="games-dates"><label>Starts<input type="datetime-local" required name="startsAt" value="' + localTime(start) + '"></label>' +
    '<label>Ends<input type="datetime-local" required name="endsAt" value="' + localTime(end) + '"></label></div>' +
    '<small>Times shown in ' + escape(zone) + '.</small>' +
    '<label>Winning pattern<select name="pattern"><option value="line">Three in a row, column or diagonal</option>' +
    '<option value="blackout">All nine squares</option></select></label><fieldset class="game-blocks"><legend>Bingo squares</legend>' +
    '<p>Choose the result and how many an agent needs for each square.</p><div class="game-block-grid">' +
    defaultSquares.map(([key,target],i) => '<div class="game-block"><span>Square ' + (i+1) + '</span><select aria-label="Square ' +
      (i+1) + ' result" name="metric-' + i + '">' + Object.entries(metrics).map(([k,label]) => '<option value="' + k + '"' +
      (k===key ? ' selected' : '') + '>' + label + '</option>').join('') + '</select><label>Target<input type="number" required min="1" step="1" max="9999" name="target-' +
      i + '" value="' + target + '"></label></div>').join('') +
    '</div></fieldset><p class="game-error" data-schedule-error role="alert" hidden></p><div class="games-actions">' +
    '<button type="button" data-game-cancel class="button secondary">Cancel</button><button type="submit" class="button primary">Schedule bingo</button></div></form>';
}

function readSchedule(form) {
  const fields = new FormData(form);
  const title = fields.get('title').trim(), incentive = fields.get('incentive').trim();
  if (!title) throw new Error('Enter a game name.');
  const start = new Date(fields.get('startsAt')), end = new Date(fields.get('endsAt'));
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    throw new Error('Choose an end time after the start time.');
  }
  return {title, incentive, startsAt:start.toISOString(), endsAt:end.toISOString(), pattern:fields.get('pattern'),
    squares:defaultSquares.map((_,i) => ({metric:fields.get('metric-'+i),target:Number(fields.get('target-'+i))}))};
}

export function createGames({apiRequest,onOpen}) {
  const workspace = document.getElementById('workspace-view');
  const sidebar = workspace.querySelector('.sidebar');
  const header = workspace.querySelector('.topbar');
  const narrow = matchMedia('(max-width: 1040px)');
  sidebar.id ||= 'workspace-sidebar';
  header.insertAdjacentHTML('afterbegin','<button type="button" class="menu-switch" aria-controls="' + sidebar.id + '" aria-label="Open navigation">' + icon('menu') + '</button>');
  sidebar.insertAdjacentHTML('afterbegin','<button type="button" class="menu-close" aria-label="Close navigation">' + icon('close') + '</button>');
  sidebar.insertAdjacentHTML('afterend','<button type="button" class="menu-shade" aria-label="Close navigation" hidden></button>');
  header.querySelector('.topbar-right').insertAdjacentHTML('afterbegin','<button type="button" class="game-open" aria-expanded="false" aria-controls="team-game-panel">' + icon('bingo') + ' Games</button>');
  header.insertAdjacentHTML('afterend','<div class="games-dock" hidden><button type="button" class="game-widget" aria-expanded="false" aria-controls="team-game-panel"></button></div>');
  workspace.insertAdjacentHTML('beforeend','<aside id="team-game-panel" class="game-panel" hidden aria-labelledby="team-game-title">' +
    '<header><h2 id="team-game-title">Games</h2><button type="button" class="game-close" aria-label="Close games">' + icon('close') +
    '</button></header><div class="game-panel-scroll" role="region" aria-label="Game details" tabindex="0"><div class="game-controls"></div><p class="game-scheduled" role="status" hidden></p><p class="game-error game-load-error" role="status" hidden></p>' +
    '<div class="game-view"></div><div class="game-setup"></div></div></aside>');
  const $ = selector => workspace.querySelector(selector);
  const menuSwitch = $('.menu-switch'), shade = $('.menu-shade'), panel = $('.game-panel'), dock = $('.games-dock');
  const setup = $('.game-setup'), view = $('.game-view'), controls = $('.game-controls'), widget = $('.game-widget');
  const gameButton = $('.game-open'), shell = $('.app-shell');
  let opener = gameButton;
  let user = null, role = null, session = 0, timer, pending = null, data = null, menuOpen, viewKey, loadError = '';
  let needsRefresh = false, scheduling = false;
  const updates = createGameUpdates(refresh);

  function toggleMenu(open) {
    menuOpen = open;
    workspace.classList.toggle('workspace-menu-open',open);
    workspace.classList.toggle('workspace-menu-closed',!open);
    menuSwitch.setAttribute('aria-expanded', String(open));
    menuSwitch.setAttribute('aria-label',open ? 'Close navigation' : 'Open navigation');
    shade.hidden = !(open && narrow.matches);
    if (open && narrow.matches) $('.menu-close').focus();
  }
  toggleMenu(!narrow.matches);
  menuSwitch.onclick = () => toggleMenu(!menuOpen);
  const closeNav = () => { toggleMenu(false); menuSwitch.focus(); };
  $('.menu-close').onclick = closeNav;
  shade.onclick = closeNav;
  sidebar.addEventListener('click',event => {
    if (narrow.matches && event.target.closest('[data-view],[data-action]')) toggleMenu(false);
  });
  sidebar.addEventListener('change',event => {
    if (narrow.matches && event.target.matches('select')) toggleMenu(false);
  });
  narrow.addEventListener('change',() => toggleMenu(!narrow.matches && panel.hidden));
  document.addEventListener('keydown',event => {
    if (!menuOpen || !narrow.matches || workspace.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); closeNav(); return; }
    if (event.key !== 'Tab') return;
    const items = [...sidebar.querySelectorAll('button,select,a[href]')].filter(el => !el.disabled && el.getClientRects().length);
    if (event.shiftKey && items[0]===document.activeElement) { event.preventDefault(); items.at(-1)?.focus(); }
    else if (!event.shiftKey && items.at(-1)===document.activeElement) { event.preventDefault(); items[0]?.focus(); }
  });
  function draw() {
    const err = $('.game-load-error');
    err.hidden = !loadError; err.textContent = loadError;
    const game = data?.game;
    dock.hidden = !game || game.status !== 'live';
    if (!dock.hidden) {
      const top = data.leaders.slice(0,3).map(member =>
        '<span><b>#' + escape(member.rank) + '</b> ' + escape(member.username) + '</span>').join('');
      widget.innerHTML = '<strong>' + icon('bingo') + ' Bingo</strong>' + (top || '<span>No players yet</span>') +
        (data.me ? '<strong class="widget-own">You #' + escape(data.me.rank) + '</strong>' : '') +
        (loadError ? '<span>Offline</span>' : '');
    }
    if (panel.hidden) return;
    if (role === 'supervisor' && !controls.children.length) {
      controls.innerHTML = '<button type="button" class="button secondary" data-game-new>Schedule a game</button>';
    }
    if (!setup.children.length) {
      const currentKey = JSON.stringify(data);
      if (currentKey !== viewKey) {
        const openPlayers = new Set([...view.querySelectorAll('details[open]')].map(el => el.dataset.player));
        const activePlayer = document.activeElement?.closest('details')?.dataset.player;
        view.innerHTML = data ? gameView(data,role==='supervisor') : '<p class="games-muted">Loading game…</p>';
        for (const details of view.querySelectorAll('details[data-player]')) {
          details.open = openPlayers.has(details.dataset.player);
          if (activePlayer === details.dataset.player) details.querySelector('summary').focus({preventScroll:true});
        }
        viewKey = currentKey;
      }
    }
  }
  function scheduleRefresh() {
    clearTimeout(timer);
    if (!user || document.hidden) return;
    const game = data?.game;
    let delay = game?.status === 'live' && !updates.connected() ? 5000 : 30000;
    const boundary = game?.status === 'live' ? game.endsAt : game?.status === 'scheduled' ? game.startsAt : null;
    if (boundary) delay = Math.min(delay, Math.max(1000, new Date(boundary).getTime()-Date.now()+250));
    timer = setTimeout(refresh,delay);
  }
  async function refresh() {
    if (!user || document.hidden) return;
    if (pending) { needsRefresh = true; return pending; }
    const epoch = session;
    pending = (async()=>{
      try {
        const fresh = await apiRequest('gameState',undefined,user.id);
        if (epoch !== session) return;
        data = fresh; loadError = '';
        if (!document.hidden) updates.sync(fresh.realtime);
      } catch (error) {
        if (epoch !== session) return;
        loadError = error.message || 'Could not update the leaderboard.';
      } finally {
        if (epoch === session) {
          pending = null; draw();
          if (needsRefresh) { needsRefresh=false; queueMicrotask(refresh); }
          else scheduleRefresh();
        }
      }
    })();
    return pending;
  }
  function closeSetup() {
    setup.replaceChildren(); view.hidden = false; controls.hidden = false;
    viewKey = undefined;
    draw();
  }
  // The workspace keeps its form and scroll position when its scroll container changes.
  function setPanel(open, restoreFocus = true) {
    if (open === !panel.hidden) return;
    const scrollTop = open ? window.scrollY : shell.scrollTop;
    if (open) toggleMenu(false);
    panel.hidden = !open;
    workspace.classList.toggle('games-split',open);
    for (const button of [gameButton,widget]) button.setAttribute('aria-expanded',String(open));
    if (open) {
      shell.scrollTop = scrollTop;
      onOpen?.();
      $('.game-close').focus({preventScroll:true});
      draw();
      refresh();
    } else {
      window.scrollTo({top:scrollTop,behavior:'instant'});
      if (restoreFocus) (opener.getClientRects().length ? opener : gameButton).focus({preventScroll:true});
    }
  }
  function togglePanel(event) {
    if (!user) return;
    if (panel.hidden) opener = event.currentTarget;
    setPanel(panel.hidden);
  }
  gameButton.onclick = togglePanel;
  widget.onclick = togglePanel;
  $('.game-close').onclick = () => setPanel(false);
  panel.addEventListener('keydown',event => {
    if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setPanel(false); }
  });
  panel.addEventListener('click',event => {
    if (event.target.closest('[data-game-new]') && role === 'supervisor') {
      $('.game-scheduled').hidden = true;
      setup.innerHTML = scheduleForm(); view.hidden = true; controls.hidden = true;
      setup.querySelector('[name="title"]').focus();
    }
    if (event.target.closest('[data-game-cancel]') && !scheduling) {
      closeSetup(); controls.querySelector('button')?.focus();
    }
  });
  panel.addEventListener('submit',async event => {
    event.preventDefault();
    if (scheduling || role !== 'supervisor' || !user) return;
    const form = event.target, errorBox = form.querySelector('[data-schedule-error]');
    const epoch = session;
    try {
      const config = readSchedule(form);
      scheduling=true; form.querySelector('[type="submit"]').disabled=true; errorBox.hidden=true;
      await apiRequest('gameSchedule',config,user.id);
      if (epoch !== session) return;
      closeSetup();
      const confirmation = $('.game-scheduled');
      confirmation.textContent = config.title + ' scheduled for ' + displayTime.format(new Date(config.startsAt)) + '.';
      confirmation.hidden = false;
      await refresh();
    } catch (error) {
      if (epoch === session) {
        errorBox.hidden=false; errorBox.textContent=error.message || 'Could not schedule the game.';
      }
    } finally {
      if (epoch === session) scheduling=false;
      form.querySelector('[type="submit"]').disabled=false;
    }
  });
  document.addEventListener('visibilitychange',()=> {
    clearTimeout(timer);
    if (document.hidden) updates.close();
    else refresh();
  });
  function closeSession() {
    session++; user=null; role=null; data=null; pending=null; needsRefresh=false; scheduling=false; loadError='';
    clearTimeout(timer); updates.close();
    setPanel(false,false);
    setup.replaceChildren(); controls.replaceChildren(); view.replaceChildren(); widget.replaceChildren();
    controls.hidden=false; view.hidden=false; viewKey=undefined; dock.hidden=true; $('.game-scheduled').hidden=true;
    toggleMenu(!narrow.matches);
  }
  function openSession(nextUser,nextRole) {
    if (!nextUser?.id || (user?.id===nextUser.id && role===nextRole)) return;
    closeSession(); user=nextUser; role=nextRole; refresh();
  }
  return {openSession,closeSession,refresh};
}
