import { METRICS, DEFAULT_GOALS, dayKey } from './model.js';
import { tallyForCall, metricsForDay } from './tally.js';
import { createTallyEntry } from './entry-tally.js';
import { groupedRows, groupedTable, groupedCsv } from './tally-history.js';
import { openStore, apiRequest, validDay } from './storage.js';

const paths = {
  overview:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  calls:'<path d="M8 3H5a2 2 0 0 0-2 2c0 8.8 7.2 16 16 16a2 2 0 0 0 2-2v-3l-5-2-2 2a14 14 0 0 1-6-6l2-2-2-5Z"/>',
  target:'<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".7"/>',
  internet:'<path d="M3 8a15.5 15.5 0 0 1 18 0M6 12a10 10 0 0 1 12 0m-9 4a4.5 4.5 0 0 1 6 0"/><circle cx="12" cy="20" r=".6"/>',
  tv:'<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  phone:'<path d="M7 3H5a2 2 0 0 0-2 2c0 8.8 7.2 16 16 16a2 2 0 0 0 2-2v-2l-5-2-2 2a15 15 0 0 1-7-7l2-2-2-5Z"/>',
  mobile:'<rect x="6" y="2" width="12" height="20" rx="2.5"/><path d="M10 5h4m-3 14h2"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',minus:'<path d="M5 12h14"/>',check:'<path d="m5 12 4 4L19 6"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.6 9a2.5 2.5 0 0 1 4.8.8c0 1.8-2.4 1.9-2.4 3.7m0 3h.01"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/>',
  'arrow-right':'<path d="M4 12h15m-5-5 5 5-5 5"/>',
  'arrow-up-right':'<path d="M6 18 18 6M6 6h12v12"/>',
  chevron:'<path d="m9 6 6 6-6 6"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4"/>',
  lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>',
  layers:'<path d="m12 3 10 5-10 5L2 8l10-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  sparkles:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm8-1v4m-2-2h4"/>',
  leaf:'<path d="M19 4C6 2 2 10 7 16s15 2 12-12Z"/><path d="M5 21 16 10"/>',
  disconnect:'<path d="M4 13a13 13 0 0 1 16 0v5h-5v-4a12 12 0 0 0-6 0v4H4v-5Zm4-9 8 5M16 4 8 9"/>'
};
/** Resolve a stable DOM id. */
const $ = id => document.getElementById(id);
function emptyState() { return {version:4, days:[], goals:{...DEFAULT_GOALS}}; }
let state = emptyState();
let repo, ready=false, busy=false, view='today', filter='all', page=0, allHistory=false;
let selectedDay=dayKey(), previousDay=selectedDay, lastFocus=null, toastTimer;
let sessionUser=null, authMode='login', authBusy=false, sessionEpoch=0, sessionRequest=0, authenticating=false;
let pendingRead=null;
const entry = createTallyEntry({submit:submitTally, onClose:closeEntry, icon});

const PAGE_SIZE=50;
const channel=typeof BroadcastChannel==='function' ? new BroadcastChannel('call-workspace-v4') : null;

/** Render locally defined outline icons. */
function icon(name){return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.info}</svg>`;}
function currentDay() {
  return state.days.find(summary => summary.day === selectedDay);
}
function historyRows() {
  const day = currentDay();
  if (allHistory) return groupedRows(state.days, filter);
  return groupedRows(day ? [day] : [], filter);
}
function percent(value){return value===null?'—':Number(value.toFixed(1)).toLocaleString('en-US');}

function neededLabel(m){if(m.reached)return icon('check')+'Goal reached';if(m.needed===null)return 'See goal details';return `${m.needed} ${m.unit}${m.needed===1?'':'s'} to goal`;}
/** Show the underlying counts beside each rate. */
function countLabel(m) {
  const unit = m.opportunityUnit, total = `${m.total} ${unit}${m.total === 1 ? '' : 's'}`;
  if (!m.total) return `No eligible ${unit}s yet`;
  const result = ['sales','orders'].includes(m.key) ? m.unit + (m.successes === 1 ? '' : 's') : 'saved';
  return `${m.successes} ${result} / ${total}`;
}
/** Keep all write controls locked until storage is ready or a transaction finishes. */
function setBusy(value) {
  busy = value;
  entry.busy(value || !ready);
  document.querySelectorAll('[data-goal],[data-goal-slider]').forEach(node => node.disabled = value || !ready);
  $('goal-save-status').textContent = value ? 'Saving…' : ready ? 'Saved to your account' : 'Storage not ready';
}
/** Display a lasting storage error rather than falsely claiming a save succeeded. */
function storageError(message){$('storage-banner').textContent=message;$('storage-banner').hidden=false;$('storage-status').textContent='Storage needs attention';}
async function writeToStore(operation) {
  if (!ready || busy || !repo) throw new Error('Cloud storage is unavailable. Try again when connected.');
  const epoch = sessionEpoch;
  pendingRead = null;
  setBusy(true);
  try {
    const result = await operation(repo);
    if (sessionEpoch !== epoch) throw new Error('Your sign-in changed. Reload your saved totals.');
    $('storage-banner').hidden = true;
    $('storage-status').textContent = 'Saved to your account';
    channel?.postMessage({userId:sessionUser.id});
    return result;
  } finally {
    if (sessionEpoch === epoch) setBusy(false);
  }
}

async function submitTally(draft, token, day) {
  const delta = tallyForCall(draft);
  const updated = await writeToStore(source => source.tally(day, delta, token));
  state.days = [...state.days.filter(item => item.day !== updated.day), updated];
  selectedDay = updated.day;
  renderDashboard();
  showToast('Daily tally saved');
}

/** Render today's dashboard and rates from committed records only. */
function renderDashboard(){
  const day = currentDay(), metrics = metricsForDay(day, state.goals);
  const stats = [['calls',day?.calls,'Calls logged'],['leaf',day?.savedCalls,'Calls saved'],['mobile',day?.mobileOrders,'Mobile orders'],['sparkles',day?.mobileLines,'Mobiles sold']];
  $('summary-strip').innerHTML=stats.map(([name,n,label])=>`<div class="summary-item"><span class="summary-icon">${icon(name)}</span><div class="summary-content"><strong>${n ?? 0}</strong><span>${label}</span></div></div>`).join('');
  const circumference=2*Math.PI*56;
  $('rings-grid').innerHTML=metrics.map(m=>`<button class="ring-card" data-metric="${m.key}" style="--ring-color:${m.color}" aria-label="${m.label}: ${m.rate===null?'no eligible '+m.opportunityUnit+'s':percent(m.rate)+' percent'}, goal ${m.goal} percent. ${m.reached?'Goal reached':m.needed===null?'See goal details':m.needed+' more '+m.unit+(m.needed===1?'':'s')+' needed'}"><div class="ring-visual"><svg class="ring-svg" viewBox="0 0 132 132" aria-hidden="true"><circle class="ring-track" cx="66" cy="66" r="56"/><circle class="ring-progress" cx="66" cy="66" r="56" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference*(1-m.progress)}"/></svg><span class="ring-center"><span class="ring-value">${percent(m.rate)}${m.rate===null?'':'<span>%</span>'}</span><span class="ring-goal">Goal ${m.goal}%</span><span class="ring-needed">${neededLabel(m)}</span></span></div><span class="ring-title">${m.label}</span><span class="ring-count">${countLabel(m)}</span></button>`).join('');
  $('goals-reached').innerHTML=icon('check')+`${metrics.filter(m=>m.reached).length} of ${metrics.length} goals reached`;
  $('nav-count').textContent = state.days.reduce((n, item) => n + item.calls, 0);
  const rows = groupedRows(day ? [day] : []);
  $('recent-count').textContent = rows.length;
  $('recent-calls').innerHTML = groupedTable(rows.slice(0, 5));

  renderDate();renderCallLog();
}
function renderCallLog() {
  const filtered = historyRows();

  const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));page=Math.min(page,pages-1);
  $('all-calls').innerHTML=groupedTable(filtered.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE), {showDate:allHistory});
  $('table-footer').textContent=`${filtered.length} outcome group${filtered.length===1?'':'s'} · ${allHistory?'All dates':selectedDay}`;
  $('pagination').innerHTML=pages>1?`<button class="button secondary" data-action="previous-page" ${page===0?'disabled':''}>Previous</button><span>Page ${page+1} of ${pages}</span><button class="button secondary" data-action="next-page" ${page===pages-1?'disabled':''}>Next</button>`:'';
  document.querySelectorAll('[data-filter]').forEach(el=>{el.classList.toggle('active',el.dataset.filter===filter);el.setAttribute('aria-pressed',String(el.dataset.filter===filter));});
  document.querySelector('[data-action="all-history"]').setAttribute('aria-pressed',String(allHistory));
}

/** Render tap-based goal controls; persist only settled range changes. */
function renderGoals(){
  $('goal-settings').innerHTML=METRICS.map(m=>`<div class="goal-setting" data-goal-row="${m.key}" style="--ring-color:${m.color}"><span class="goal-setting-icon">${icon(m.icon)}</span><div class="goal-setting-info"><strong>${m.label}</strong><small>${m.description}</small></div><input class="goal-slider" type="range" min="5" max="100" step="1" value="${state.goals[m.key]}" data-goal-slider="${m.key}" aria-label="${m.label} goal percentage"><div class="goal-stepper"><button data-goal="${m.key}" data-delta="-5" aria-label="Lower ${m.label} goal by 5 percent">${icon('minus')}</button><strong>${state.goals[m.key]}%</strong><button data-goal="${m.key}" data-delta="5" aria-label="Raise ${m.label} goal by 5 percent">${icon('plus')}</button></div></div>`).join('');
}
/** Save one goal atomically, restoring committed values after errors and keyboard focus after rendering. */
async function setGoal(key, value) {
  if (!ready || busy) return;
  const goal = Math.max(5, Math.min(100, Number(value)));
  try {
    await writeToStore(source => source.setGoal(key, goal));
    state.goals[key] = goal;
    renderDashboard();
    $('goal-save-status').textContent = 'Saved to your account';
  } catch (error) {
    storageError(error.message);
  }
  const focused = document.activeElement;
  renderGoals();
  if (focused?.dataset.goalSlider === key) document.querySelector(`[data-goal-slider="${key}"]`)?.focus({preventScroll:true});
}
/** Change application sections while preserving the unfinished call. */
function setView(next,scroll=true){view=['today','calls','goals'].includes(next)?next:'today';for(const name of ['today','calls','goals'])$('view-'+name).hidden=view!==name;
 document.querySelectorAll('.desktop-nav [data-view],.mobile-nav [data-view]').forEach(el=>{el.classList.toggle('active',el.dataset.view===view);if(el.dataset.view===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
 const titles={today:['Overview','Your day, at a glance.','Every conversation counts. See how yours add up.'],calls:['Call log','Your call log.','Daily counts by outcome and service.'],goals:['Daily goals','Daily goals.','Set the targets for your daily report.']};
 $('breadcrumb-label').textContent=titles[view][0];$('page-title').textContent=titles[view][1];$('page-description').textContent=titles[view][2];document.querySelector('.date-control').hidden=view==='goals';history.replaceState(null,'','#'+view);if(scroll)window.scrollTo({top:0,behavior:'instant'});
}
/** Make everything behind the phone entry sheet unavailable to keyboard and assistive navigation. */
function setBackgroundInert(value){document.querySelectorAll('.sidebar,.topbar,.page-heading,.date-control,.summary-strip,.goals-panel,.recent-panel,.page-footer,.mobile-nav').forEach(el=>el.inert=value);}
/** Focus call entry and use a modal sheet on phone screens. */
function openEntry(){
 if(!ready)return showToast('Storage is not ready. Check the message above.');
 selectedDay=dayKey();allHistory=false;page=0;renderDashboard();if(view!=='today')setView('today');lastFocus=document.activeElement;
 if(window.matchMedia('(max-width: 760px)').matches){document.body.classList.add('entry-open');$('entry-backdrop').hidden=false;$('entry-panel').setAttribute('role','dialog');$('entry-panel').setAttribute('aria-modal','true');setBackgroundInert(true);}else $('entry-panel').scrollIntoView({block:'nearest',behavior:'smooth'});
 requestAnimationFrame(() => entry.focus());
}
/** Close the sheet while retaining a draft for the next opening. */
function closeEntry(){document.body.classList.remove('entry-open');$('entry-backdrop').hidden=true;$('entry-panel').removeAttribute('role');$('entry-panel').removeAttribute('aria-modal');setBackgroundInert(false);if(lastFocus?.isConnected&&!lastFocus.closest('[hidden]'))lastFocus.focus({preventScroll:true});}
function showToast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => $('toast').hidden=true, 4500);
}

/** Open a native modal for metric details and calculation rules. */
function showDialog(title,content){$('dialog-content').innerHTML=`<div class="dialog-heading"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">${icon('close')}</button></div><div class="dialog-body">${content}</div>`;if(!$('detail-dialog').open)$('detail-dialog').showModal();}
/** Explain the exact implemented reporting rules without claiming official company definitions. */
function showHelp() {
  showDialog('How your numbers work', `
    <div class="rule-example"><strong>Three services, two kept</strong><p>A customer keeps video and voice and disconnects internet. The account gets <span class="badge downgrade">TP → DP</span>. Video and voice each earn a save. Internet records a loss. The play and bundle rates stay the same.</p></div>
    <div class="help-rule"><strong>Single, double and triple play</strong><p>Keeping every original service earns SPS, DPS or TPS. Disconnecting every original service earns SPD, DPD or TPD. The starting service count determines the play. A full save or disconnect on two or more services also enters the bundle rate.</p>
    <p>Partial saves show how the original service count changed (DP → SP, TP → DP or TP → SP). Four starting services count as triple play (3+), so four reduced to three displays as TP (4 → 3). Downgrades affect the individual services and are excluded from all play and bundle rates.</p></div>
    <div class="help-rule"><strong>Services kept, disconnected or added</strong><p>Each account contributes one opportunity per original service. Keeping it earns a save. Adding a new service also earns one save and one opportunity for that service. An addition leaves the original play result intact.</p></div>
    <div class="help-rule"><strong>Multiple accounts and washes</strong><p>Log every account handled on a call together. When two accounts start with the same service mix and one is fully saved while the other fully disconnects, they pair as a wash. Their original services and plays are excluded from save rates. Other accounts and added services still count.</p>
    <p>Overall save rate is the share of eligible calls that kept at least one original service on an unpaired account. Each call with an unpaired account enters the denominator once.</p></div>
    <div class="help-rule"><strong>Mobile orders and lines</strong><p>One order can contain 1–12 lines. Two orders with three lines each count as two orders and six lines. Both rates divide by all logged calls, including washes. Select Mobile under added services when the account also gains mobile service.</p></div>
    <div class="help-rule"><strong>Daily goals</strong><p>Reports use Eastern time. Each ring closes when its rate reaches your target. Remaining saves assume every next eligible account or call succeeds. Sales estimates assume one new order or line per next call.</p></div>
    <div class="help-rule"><strong>Saved history</strong><p>Each submission updates your daily totals in Supabase. Accounts with the same outcome and service tags share a row. Mobile orders and lines have their own daily total. Refresh or sign in on another device to see confirmed saves.</p></div>
    <div class="dialog-actions"><button class="button primary" data-action="close-dialog">Done</button></div>`);
}
/** Show the numerator, denominator, and assumptions behind a circle. */
function showMetric(key){const m=metricsForDay(currentDay(),state.goals).find(m=>m.key===key);if(!m)return;
 let advice=m.reached?'You have reached this goal.':m.needed===null?(['sales','orders'].includes(key)?'Additional orders or lines on future calls can close this gap. One on each new call alone cannot reach an exact 100% target after a missed call.':'After a loss, an exact 100% save rate cannot be reached with a finite number of new eligible opportunities on this date.'):`${m.needed} more ${m.unit}${m.needed===1?'':'s'} on consecutive eligible ${m.opportunityUnit}s would reach your ${m.goal}% goal. Each enters the denominator.`;
 const converted=currentDay()?.saleCalls ?? 0;
 showDialog(m.label,`<div style="--ring-color:${m.color}" class="metric-detail-value">${percent(m.rate)}${m.rate===null?'':'%'}<small>Goal ${m.goal}%</small></div><div class="metric-facts"><div><strong>${m.successes}</strong><span>${key==='sales'?'Mobiles sold':key==='orders'?'Mobile orders':'Saves'}</span></div><div><strong>${m.total}</strong><span>Eligible ${m.opportunityUnit}s</span></div></div><div class="help-rule"><strong>How it's calculated</strong><p>${m.description}</p>${key==='sales'?`<p>Calls with a sale: ${converted} / ${m.total} (${m.total?percent(converted/m.total*100):'—'}%). This is separate from the line-based rate above.</p>`:''}</div><div class="rule-example">${advice}</div><div class="dialog-actions"><button class="button secondary" data-action="metric-goals">Edit goals</button><button class="button primary" data-action="close-dialog">Done</button></div>`);
}

/** Download a local file without sending records over the network. */
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
/** Export the selected date or all-date history, including mobile line quantities. */
function exportCalls() {
  const rows = historyRows();
  download(new Blob([groupedCsv(rows)], {type:'text/csv;charset=utf-8;'}), `daily-tallies-${allHistory?'all-dates':selectedDay}.csv`);
  showToast('Grouped totals exported');
}

async function onClick(event) {
  const button = event.target.closest('button');
  if (!button || button.disabled || button.closest('#entry-panel')) return;
  if (button.dataset.view) return setView(button.dataset.view);
  if (button.dataset.metric) return showMetric(button.dataset.metric);
  if (button.dataset.filter) {
    filter = button.dataset.filter;
    page = 0;
    return renderCallLog();
  }
  if (button.dataset.goal) {
    const key = button.dataset.goal;
    await setGoal(key, state.goals[key] + Number(button.dataset.delta));
    document.querySelector(`[data-goal="${key}"][data-delta="${button.dataset.delta}"]`)?.focus({preventScroll:true});
    return;
  }
  switch(button.dataset.action) {
    case 'new-call': openEntry(); break;
    case 'sign-out': await signOut(); break;
    case 'confirm-sign-out': await finishSignOut(); break;
    case 'toggle-password': setPasswordVisible($('password').type==='password'); break;
    case 'help': showHelp(); break;
    case 'close-dialog': $('detail-dialog').close(); break;
    case 'metric-goals': $('detail-dialog').close(); setView('goals'); break;
    case 'export': exportCalls(); break;
    case 'all-history': allHistory=!allHistory; page=0; renderCallLog(); break;
    case 'today': selectedDay=dayKey(); allHistory=false; page=0; renderDashboard(); break;
    case 'previous-page': page=Math.max(0,page-1); renderCallLog(); break;
    case 'next-page': page++; renderCallLog(); break;
  }
}

/** Keep keyboard navigation inside the mobile sheet and provide the N shortcut. */
function onKeydown(event){if(!sessionUser)return;if(document.body.classList.contains('entry-open')&&!$('detail-dialog').open){if(event.key==='Escape'){event.preventDefault();closeEntry();return;}if(event.key==='Tab'){const nodes=[...$('entry-panel').querySelectorAll('button,input,select,textarea,summary')].filter(e=>!e.disabled&&e.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&(document.activeElement===first||!$('entry-panel').contains(document.activeElement))){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||!$('entry-panel').contains(document.activeElement))){event.preventDefault();first?.focus();}}}
 if(event.key.toLowerCase()==='n'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!$('detail-dialog').open&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){event.preventDefault();openEntry();}}
/** Advance today's view at Eastern midnight, retaining explicitly selected historical days. */
function refreshDay(){const day=dayKey();if(previousDay!==day){if(selectedDay===previousDay)selectedDay=day;previousDay=day;renderDashboard();}}
/** Render dates from the report's day string without browser timezone shifts. */
function renderDate(){$('report-date').value=selectedDay;$('report-date').max=dayKey();$('today-date').textContent=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(new Date(selectedDay+'T12:00:00Z'));$('goals-day-label').textContent=selectedDay===dayKey()?'Today’s goals':'Daily goals';}
/** Refresh cloud data without replacing a call being edited. */
async function syncFromStorage(){
 if(!sessionUser||!repo||busy||pendingRead?.source===repo)return;
 const read={source:repo,epoch:sessionEpoch};
 pendingRead=read;
 try{
   const fresh=await read.source.read();
   if(pendingRead!==read||read.epoch!==sessionEpoch)return;
   state=fresh;ready=true;renderDashboard();
   if(view!=='goals'||!document.activeElement?.closest('#goal-settings'))renderGoals();
   setBusy(false);$('storage-banner').hidden=true;$('storage-status').textContent='Saved to your account';
 }catch(error){
   if(pendingRead===read&&read.epoch===sessionEpoch&&error.code!=='AUTH')storageError(error.message||'Could not refresh your records.');
 }finally{
   if(pendingRead===read)pendingRead=null;
 }
}
function authMessage(message){$('auth-error').textContent=message;$('auth-error').hidden=!message;}
function setAuthBusy(value){authBusy=value;$('auth-form').querySelectorAll('input,button').forEach(el=>el.disabled=value);$('auth-mode-toggle').disabled=value;$('auth-submit').textContent=value?'Please wait…':authMode==='signup'?'Create account':'Sign in';}
function setPasswordVisible(visible) {
  $('password').type = visible ? 'text' : 'password';
  const toggle = document.querySelector('[data-action="toggle-password"]');
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
}
function renderAuth() {
  const signup = authMode === 'signup';
  $('auth-title').textContent = signup ? 'Create account' : 'Welcome back';
  $('auth-submit').textContent = signup ? 'Create account' : 'Sign in';
  $('auth-mode-toggle').textContent = signup ? 'Back to sign in' : 'Create an account';
  $('password').autocomplete = signup ? 'new-password' : 'current-password';
  setPasswordVisible(false);
  authMessage('');
}
/** Clear one account's data before displaying another account or the sign-in form. */
function showSignIn(message=''){
 sessionEpoch++;sessionRequest++;sessionUser=null;authMode='login';ready=false;repo?.close();repo=null;busy=false;pendingRead=null;state=emptyState();closeEntry();$('detail-dialog').close();entry.reset();renderDashboard();renderGoals();$('workspace-view').hidden=true;$('auth-view').hidden=false;$('toast').hidden=true;clearTimeout(toastTimer);$('password').value='';$('auth-status').textContent='';renderAuth();setAuthBusy(false);authMessage(message);
}
async function enterWorkspace(user){
 const epoch=++sessionEpoch;
 sessionUser=user;ready=false;
 const source=await openStore(user.id);
 if(epoch!==sessionEpoch){source.close();return;}
 repo=source;
 $('session-username').textContent=user.username;$('auth-view').hidden=true;$('workspace-view').hidden=false;$('auth-status').textContent='';$('storage-status').textContent='Loading your records…';
 setBusy(false);
 await syncFromStorage();
}
async function submitAuth(event){event.preventDefault();if(authBusy)return;authenticating=true;sessionRequest++;authMessage('');setAuthBusy(true);try{const result=await apiRequest(authMode,{username:$('username').value,password:$('password').value});$('password').value='';await enterWorkspace(result.user);channel?.postMessage({sessionChanged:true});}catch(e){authMessage(e.message||'Could not sign in. Please try again.');}finally{authenticating=false;setAuthBusy(false);}}
async function signOut(){if(busy)return;if(entry.dirty()){showDialog('Sign out?',`<p>You have an unfinished call. Signing out discards this entry.</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">Keep editing</button><button class="button primary" data-action="confirm-sign-out">Sign out</button></div>`);return;}await finishSignOut();}
async function finishSignOut(){authenticating=true;sessionRequest++;try{await apiRequest('logout',{});showSignIn();channel?.postMessage({sessionChanged:true});}catch(e){storageError(e.message||'Could not sign out. Try again.');}finally{authenticating=false;}}
async function checkSession(){if(authenticating)return;const epoch=sessionEpoch,request=++sessionRequest;try{const {user}=await apiRequest();if(epoch!==sessionEpoch||request!==sessionRequest)return;if(user){if(!sessionUser||user.id!==sessionUser.id){showSignIn();await enterWorkspace(user);}else await syncFromStorage();}else if(sessionUser)showSignIn('Your session ended. Sign in again.');else{$('auth-status').textContent='';setAuthBusy(false);}}catch(e){if(epoch!==sessionEpoch||request!==sessionRequest)return;if(!sessionUser){$('auth-status').textContent='';authMessage(e.message);setAuthBusy(false);}else storageError(e.message);}}
async function initialize(){renderDashboard();setBusy(false);renderGoals();setView(location.hash.slice(1),false);renderAuth();setAuthBusy(true);await checkSession();}

document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
document.addEventListener('click',event=>{onClick(event).catch(e=>storageError(e.message||'The action could not be completed.'));});
document.addEventListener('keydown',onKeydown);

$('auth-form').addEventListener('submit',submitAuth);
$('auth-mode-toggle').addEventListener('click',()=>{authMode=authMode==='login'?'signup':'login';renderAuth();});
window.addEventListener('session-expired',event=>{if(event.detail?.userId===sessionUser?.id)showSignIn('Your session changed or expired. Sign in again.');});
$('report-date').addEventListener('change',event=>{const value=event.target.value;if(validDay(value)&&value<=dayKey()){selectedDay=value;allHistory=false;page=0;renderDashboard();}});
document.addEventListener('input',event=>{if(event.target.dataset.goalSlider)event.target.closest('.goal-setting').querySelector('.goal-stepper strong').textContent=event.target.value+'%';});
document.addEventListener('change',event=>{if(event.target.dataset.goalSlider)setGoal(event.target.dataset.goalSlider,event.target.value);});
$('entry-backdrop').addEventListener('click',closeEntry);
window.matchMedia('(max-width: 760px)').addEventListener('change',closeEntry);
channel?.addEventListener('message',event=>{if(event.data?.sessionChanged)checkSession();else if(event.data?.userId===sessionUser?.id)syncFromStorage();});
window.addEventListener('focus',()=>{refreshDay();checkSession();});
window.addEventListener('hashchange',()=>setView(location.hash.slice(1),false));
window.addEventListener('beforeunload',event=>{if(sessionUser && entry.dirty()){event.preventDefault();event.returnValue='';}});
setInterval(()=>{refreshDay();if(document.visibilityState==='visible')syncFromStorage();},30000);
initialize();
