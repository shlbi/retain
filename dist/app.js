import { outcomeName, serviceName, matchesFilter, orderLabel, callsToCsv } from './reporting.js';
import { SERVICES, METRICS, DEFAULT_GOALS, accountsFor, outcomesForCall, calculateMetrics, dayKey, soldLinesFor, soldOrdersFor, ordersFor } from './model.js';
import { openStore, apiRequest, parseBackup, MAX_BACKUP_BYTES, MAX_BACKUP_CALLS, validDay } from './storage.js';

import { formatCallbackTime, renderCallbackReminders } from './callbacks.js';

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
let state = { version:3, calls:[], goals:{...DEFAULT_GOALS} };
let repo, ready=false, busy=false, view='today', filter='all', page=0, allHistory=false;
let selectedDay=dayKey(), previousDay=dayKey(), editing=null, draft=newDraft(), lastFocus=null, toastTimer;
let pendingImport=null, sessionUser=null, authMode='login', authBusy=false, sessionEpoch=0, sessionRequest=0, authenticating=false;
let pendingRead=null;
const PAGE_SIZE=50;
const channel=typeof BroadcastChannel==='function' ? new BroadcastChannel('call-workspace-v3') : null;

/** Escape all user-supplied identifiers before rendering HTML. */
function esc(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
/** Render locally defined outline icons. */
function icon(name){return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.info}</svg>`;}
/** Require starting services to be explicitly selected for every new call. */
function emptyAccount(){return {account:'',before:[],kept:[],added:[]};}
function newDraft(){return {id:typeof crypto.randomUUID==='function'?crypto.randomUUID():'call-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),accounts:[emptyAccount()],activeIndex:0,mobileOrders:[],callbackEnabled:false,originalCallback:null};}
function activeAccount(){return draft.accounts[draft.activeIndex];}
function editValues(){
 return JSON.stringify([$('ucid').value,draft.accounts,draft.mobileOrders,draft.callbackEnabled&&[$('callback-at').value,$('callback-note').value,draft.originalCallback?.dueAt]]);
}
function hasEntryDraft(){
 if(editing)return editValues()!==draft.originalValues;
 return Boolean($('ucid').value||$('account').value||draft.mobileOrders.length||draft.callbackEnabled||draft.accounts.length>1||draft.accounts.some(a=>a.account||a.before.length||a.added.length));
}
/** Select a day while keeping old records available. */
function todayCalls(){return state.calls.filter(c=>c.day===selectedDay).sort((a,b)=>b.order-a.order);}
/** Select the call-log scope independently from the daily dashboard. */
function scopedCalls(){return allHistory ? [...state.calls].sort((a,b)=>b.day.localeCompare(a.day)||b.order-a.order) : todayCalls();}
/** Format fractional rates without hiding zero-opportunity states. */
function percent(value){return value===null?'—':Number(value.toFixed(1)).toLocaleString('en-US');}
/** Describe the fixed six outcome codes, including the stated three-plus grouping. */
function accountBadge(outcome, detailed = false) {
  const name = outcomeName(outcome);
  const color = { save: 'save', disconnect: 'disconnect', downgrade: 'downgrade' }[outcome.kind];
  if (outcome.washed) return `<span class="badge neutral">Wash</span> <span class="wash-result">${esc(name)}</span>`;
  return `<span class="badge ${color}" title="${esc(name)}">${esc(outcome.code)}${detailed ? ' · ' + esc(name) : ''}</span>`;
}

function serviceTags(outcome) {
  const tags = [];
  for (const [keys, label, color] of [[outcome.kept, 'kept', 'save'], [outcome.disconnected, 'disconnected', 'disconnect'], [outcome.added, 'added', 'added']]) {
    for (const key of keys) tags.push(`<span class="badge ${color}">${serviceName(key)} ${label}</span>`);
  }
  return tags.join('');
}

function outcomeGroup(outcome, multiple, content) {
  return `<span class="outcome-group">${multiple ? `<span class="account-caption">Account ${outcome.index + 1}</span>` : ''}<span class="outcome-tags">${content}</span></span>`;
}

function outcomeTags(call, detailed = false) {
  const outcomes = outcomesForCall(call), multiple = accountsFor(call).length > 1;
  return outcomes.map(outcome => outcomeGroup(outcome, multiple, accountBadge(outcome, detailed) + serviceTags(outcome))).join('');
}

/** Label progress without promising a finite run can erase a loss at a 100% target. */
function neededLabel(m){if(m.reached)return icon('check')+'Goal reached';if(m.needed===null)return ['sales','orders'].includes(m.key)?'See goal details':'See goal details';return `${m.needed} ${m.unit}${m.needed===1?'':'s'} to goal`;}
/** Show the underlying counts beside each rate. */
function countLabel(m) {
  const unit = m.opportunityUnit, total = `${m.total} ${unit}${m.total === 1 ? '' : 's'}`;
  if (!m.total) return `No eligible ${unit}s yet`;
  const result = ['sales','orders'].includes(m.key) ? m.unit + (m.successes === 1 ? '' : 's') : 'saved';
  return `${m.successes} ${result} / ${total}`;
}
/** Keep all write controls locked until storage is ready or a transaction finishes. */
function setBusy(value){busy=value;document.querySelectorAll('#call-form input,#call-form button,#call-form select,#call-form textarea,[data-action="complete-callback"],[data-goal],[data-goal-slider],[data-action="import"],[data-action="backup"]').forEach(el=>el.disabled=busy||!ready);$('submit-label').textContent=busy?'Saving…':editing?'Update call':'Save call';document.querySelectorAll('[data-action="order-up"],[data-action="order-down"]').forEach(el=>{const n=draft.mobileOrders[Number(el.dataset.orderIndex)];el.disabled=busy||!ready||(el.dataset.action==='order-up'?n>=12:n<=1);});const add=document.querySelector('[data-action="add-order"]');if(add)add.disabled=busy||!ready||draft.mobileOrders.length>=20;$('goal-save-status').textContent=busy?'Saving…':ready?'Saved to your account':'Storage not ready';}
/** Display a lasting storage error rather than falsely claiming a save succeeded. */
function storageError(message){$('storage-banner').textContent=message;$('storage-banner').hidden=false;$('storage-status').textContent='Storage needs attention';}
/** Commit first, then update UI; preserve user input when a transaction fails. */
async function mutate(action,message){
  if(!ready||busy)return false;
  // A background read started before this write can arrive after the write finishes.
  pendingRead=null;
  $('dialog-error')?.remove();setBusy(true);let committed=false;const epoch=sessionEpoch,source=repo;
  try{
    await action();committed=true;
    if(epoch!==sessionEpoch)return false;
    const fresh=await source.read();
    if(epoch!==sessionEpoch)return false;
    state=fresh;renderDashboard();renderGoals();$('storage-banner').hidden=true;$('storage-status').textContent='Saved to your account';channel?.postMessage({changed:true,userId:sessionUser?.id});if(message)showToast(message);return true;
  }
  catch(error){if(epoch!==sessionEpoch||error?.code==='AUTH')return false;const message=committed?'The change was committed, but saved records could not be reloaded. Reload this page before continuing.':error?.message||'The change could not be saved. Your entry is still here.';if(committed||error?.code==='STORAGE')ready=false;formError(message);storageError(message);if($('detail-dialog').open){const alert=document.createElement('p');alert.id='dialog-error';alert.className='form-error';alert.setAttribute('role','alert');$('dialog-content').querySelector('.dialog-body').prepend(alert);alert.textContent=message;}return false;}
  finally{if(epoch===sessionEpoch)setBusy(false);}
}
/** Render today's dashboard and rates from committed records only. */
function renderDashboard(){
  const calls=todayCalls(),metrics=calculateMetrics(calls,state.goals);
  const saved=metrics.find(m=>m.key==='overall').successes,sold=calls.reduce((n,c)=>n+soldLinesFor(c),0),orders=calls.reduce((n,c)=>n+soldOrdersFor(c),0);
  $('summary-strip').innerHTML=[['calls',calls.length,'Calls logged'],['leaf',saved,'Calls saved'],['mobile',orders,'Mobile orders'],['sparkles',sold,'Mobiles sold']].map(([name,n,label])=>`<div class="summary-item"><span class="summary-icon">${icon(name)}</span><div class="summary-content"><strong>${n}</strong><span>${label}</span></div></div>`).join('');
  const circumference=2*Math.PI*56;
  $('rings-grid').innerHTML=metrics.map(m=>`<button class="ring-card" data-metric="${m.key}" style="--ring-color:${m.color}" aria-label="${m.label}: ${m.rate===null?'no eligible '+m.opportunityUnit+'s':percent(m.rate)+' percent'}, goal ${m.goal} percent. ${m.reached?'Goal reached':m.needed===null?'See goal details':m.needed+' more '+m.unit+(m.needed===1?'':'s')+' needed'}"><div class="ring-visual"><svg class="ring-svg" viewBox="0 0 132 132" aria-hidden="true"><circle class="ring-track" cx="66" cy="66" r="56"/><circle class="ring-progress" cx="66" cy="66" r="56" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference*(1-m.progress)}"/></svg><span class="ring-center"><span class="ring-value">${percent(m.rate)}${m.rate===null?'':'<span>%</span>'}</span><span class="ring-goal">Goal ${m.goal}%</span><span class="ring-needed">${neededLabel(m)}</span></span></div><span class="ring-title">${m.label}</span><span class="ring-count">${countLabel(m)}</span></button>`).join('');
  $('goals-reached').innerHTML=icon('check')+`${metrics.filter(m=>m.reached).length} of ${metrics.length} goals reached`;
  $('nav-count').textContent=state.calls.length;$('recent-count').textContent=calls.length;
  $('recent-calls').innerHTML=callTable(calls.slice(0,4));
  const m=metrics.find(m=>m.key==='orders');
  $('next-win').innerHTML=icon('sparkles')+`<div><strong>${!calls.length?'A fresh start.':m.reached?'Mobile goal reached.':'Your next win.'}</strong><br>${!calls.length?'Log your first call to start filling the circles.':m.needed===null?'Additional mobile orders can help close the gap.':m.reached?'Every additional order adds to your total.':`${m.needed} more mobile order${m.needed===1?'':'s'}, one per next call, would reach your ${m.goal}% goal.`}</div>`;
  renderCallbackReminders(state.calls);
  renderDate();renderCallLog();
}
/** Render escaped identifiers, outcome badges, and separate service losses. */
function callTable(calls) {
  if (!calls.length) return `<div class="empty-state"><span>${icon('calls')}</span><h3>${view==='calls' && filter!=='all'?'No matching calls.':'No calls recorded.'}</h3><p>Choose another date or log a call.</p><button class="button secondary" data-action="new-call">${icon('plus')}Log a call</button></div>`;
  const rows = calls.map(call => {
    const outcomes = outcomesForCall(call), multiple = outcomes.length > 1, order = orderLabel(call);
    const account = multiple ? `${outcomes.length} accounts` : outcomes[0]?.account || 'No account number';
    const badges = outcomes.map(outcome => outcomeGroup(outcome, multiple, accountBadge(outcome))).join('');
    const changes = outcomes.map(outcome => outcomeGroup(outcome, multiple, serviceTags(outcome))).join('');
    const callback = call.callback ? `<span class="history-callback">${call.callback.status === 'done' ? 'Callback completed' : 'Callback · ' + formatCallbackTime(call.callback.dueAt)}</span>` : '';
    return `<tr data-call="${esc(call.id)}">
      <td>${esc(call.time)}</td><td><span class="record-id">${esc(account)}</span><span class="record-subtitle">${esc(call.ucid || 'No UCID')}</span>${allHistory ? `<span class="record-subtitle">${esc(call.day)}</span>` : ''}${callback}</td>
      <td>${badges}</td><td>${changes}${order ? `<span class="badge mobile history-order">${order}</span>` : ''}</td>
      <td><button class="icon-button" aria-label="View call ${esc(call.ucid || call.day+' at '+call.time)}">${icon('chevron')}</button></td></tr>`;
  });
  return `<table class="call-table"><thead><tr><th scope="col">Time</th><th scope="col">Account / UCID</th><th scope="col">Outcome</th><th scope="col">Services</th><th scope="col"><span class="sr-only">Details</span></th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
/** Limit large histories to fifty rows at a time without affecting totals or exports. */
function renderCallLog(){
  const calls=scopedCalls(),filtered=calls.filter(c=>matchesFilter(c,filter));
  const pages=Math.max(1,Math.ceil(filtered.length/PAGE_SIZE));page=Math.min(page,pages-1);
  $('all-calls').innerHTML=callTable(filtered.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE));
  $('table-footer').textContent=`${filtered.length} of ${calls.length} calls · ${allHistory?'All dates':selectedDay} · Saved to your account`;
  $('pagination').innerHTML=pages>1?`<button class="button secondary" data-action="previous-page" ${page===0?'disabled':''}>Previous</button><span>Page ${page+1} of ${pages}</span><button class="button secondary" data-action="next-page" ${page===pages-1?'disabled':''}>Next</button>`:'';
  document.querySelectorAll('[data-filter]').forEach(el=>{el.classList.toggle('active',el.dataset.filter===filter);el.setAttribute('aria-pressed',String(el.dataset.filter===filter));});
  document.querySelector('[data-action="all-history"]').setAttribute('aria-pressed',String(allHistory));
}
/** Preserve focus when replacing service buttons in the entry form. */
function renderEntry(){
  const active=document.activeElement;let focusSelector=null;
  if(active?.dataset.service)focusSelector=`[data-service="${active.dataset.service}"]`;
  if(active?.dataset.orderIndex!==undefined)focusSelector=`[data-action="${active.dataset.action}"][data-order-index="${active.dataset.orderIndex}"]`;
  if(active?.dataset.end)focusSelector=`[data-end="${active.dataset.end}"][data-kept="${active.dataset.kept}"]`;
  if(active?.dataset.addedService)focusSelector=`[data-added-service="${active.dataset.addedService}"]`;
  const account=activeAccount();
  $('account-switcher').hidden=draft.accounts.length===1;
  $('account-select').replaceChildren(...draft.accounts.map((a,index)=>new Option(`Account ${index+1} of ${draft.accounts.length}${a.account?' · '+a.account:''}`,String(index),false,index===draft.activeIndex)));
  if($('account').value!==account.account)$('account').value=account.account;
  $('start-services').innerHTML=SERVICES.map(s=>`<button type="button" class="service-button" data-service="${s.key}" aria-pressed="${account.before.includes(s.key)}">${icon(s.icon)}${s.short}</button>`).join('');
  $('end-services').innerHTML=SERVICES.filter(s=>account.before.includes(s.key)).map(s=>`<div class="end-row"><span class="end-name">${icon(s.icon)}${s.label}</span><div class="outcome-toggle" role="group" aria-label="${s.label} outcome"><button type="button" data-end="${s.key}" data-kept="true" aria-pressed="${account.kept.includes(s.key)}" aria-label="Keep ${s.label}">Kept</button><button type="button" data-end="${s.key}" data-kept="false" aria-pressed="${!account.kept.includes(s.key)}" aria-label="Disconnect ${s.label}">Disconnected</button></div></div>`).join('')||'<p class="text-muted">Select the services the customer had.</p>';
  const available=SERVICES.filter(s=>!account.before.includes(s.key));
  $('added-services-section').hidden=!available.length||!account.before.length;
  $('added-count').textContent=account.added.length?`(${account.added.length})`:'';
  $('added-services').innerHTML=available.map(s=>`<button type="button" class="service-button" data-added-service="${s.key}" aria-pressed="${account.added.includes(s.key)}">${icon(account.added.includes(s.key)?'check':'plus')}${s.short}</button>`).join('');
  $('callback-fields').hidden=!draft.callbackEnabled;
  $('callback-toggle-label').textContent=draft.callbackEnabled?'Remove callback reminder':'Add callback reminder';
  $('callback-toggle-icon').innerHTML=icon(draft.callbackEnabled?'minus':'plus');
  document.querySelector('[data-action="toggle-callback"]').setAttribute('aria-expanded',String(draft.callbackEnabled));
  $('callback-zone').textContent=`Your local time · ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
  $('mobile-orders').innerHTML=draft.mobileOrders.map((n,i)=>`<div class="mobile-order-row"><span>Order ${i+1}</span><div class="mobile-lines-stepper"><button type="button" data-action="order-down" data-order-index="${i}" aria-label="One fewer mobile in order ${i+1}" ${n===1?'disabled':''}>${icon('minus')}</button><output aria-live="polite">${n}</output><button type="button" data-action="order-up" data-order-index="${i}" aria-label="One more mobile in order ${i+1}" ${n===12?'disabled':''}>${icon('plus')}</button></div><button type="button" class="remove-order icon-button" data-action="remove-order" data-order-index="${i}" aria-label="Remove order ${i+1}">${icon('close')}</button></div>`).join('')+`<p class="orders-summary">${draft.mobileOrders.length?`${draft.mobileOrders.length} order${draft.mobileOrders.length===1?'':'s'} · ${soldLinesFor(draft)} mobile${soldLinesFor(draft)===1?'':'s'}`:'No mobile orders on this call'}</p>`;
  const hasOutcome=draft.accounts.some(a=>a.before.length);
  $('outcome-preview').innerHTML=hasOutcome?`${outcomeTags(draft,true)}${draft.mobileOrders.length?`<span class="badge mobile">${draft.mobileOrders.length} order${draft.mobileOrders.length===1?'':'s'} · ${soldLinesFor(draft)} mobile${soldLinesFor(draft)===1?'':'s'}</span>`:''}`:'The outcome appears here automatically';
  $('entry-title').textContent=editing?'Edit call':'Log a call';
  document.querySelector('.entry-subtitle').textContent=editing?`Recorded ${editing.day} · ${editing.time}`:'Add IDs if you have them. Tap the rest.';
  document.querySelector('.cancel-edit').hidden=!editing;
  setBusy(busy);
  if(focusSelector)$('entry-panel').querySelector(focusSelector)?.focus({preventScroll:true});
}
/** Render tap-based goal controls; persist only settled range changes. */
function renderGoals(){
  $('goal-settings').innerHTML=METRICS.map(m=>`<div class="goal-setting" data-goal-row="${m.key}" style="--ring-color:${m.color}"><span class="goal-setting-icon">${icon(m.icon)}</span><div class="goal-setting-info"><strong>${m.label}</strong><small>${m.description}</small></div><input class="goal-slider" type="range" min="5" max="100" step="1" value="${state.goals[m.key]}" data-goal-slider="${m.key}" aria-label="${m.label} goal percentage"><div class="goal-stepper"><button data-goal="${m.key}" data-delta="-5" aria-label="Lower ${m.label} goal by 5 percent">${icon('minus')}</button><strong>${state.goals[m.key]}%</strong><button data-goal="${m.key}" data-delta="5" aria-label="Raise ${m.label} goal by 5 percent">${icon('plus')}</button></div></div>`).join('');
}
/** Save one goal atomically, restoring committed values after errors and keyboard focus after rendering. */
async function setGoal(key,value){const active=document.activeElement,restoreFocus=active?.dataset.goalSlider===key;const saved=await mutate(()=>repo.setGoal(key,Math.max(5,Math.min(100,Number(value)))));if(!saved){renderGoals();setBusy(busy);$('goal-save-status').textContent=ready?'Change not saved':'Storage needs attention';}if(restoreFocus&&view==='goals'&&(document.activeElement===document.body||document.activeElement===active))document.querySelector(`[data-goal-slider="${key}"]`)?.focus({preventScroll:true});}
/** Change application sections while preserving the unfinished call. */
function setView(next,scroll=true){view=['today','calls','goals'].includes(next)?next:'today';for(const name of ['today','calls','goals'])$('view-'+name).hidden=view!==name;
 document.querySelectorAll('.desktop-nav [data-view],.mobile-nav [data-view]').forEach(el=>{el.classList.toggle('active',el.dataset.view===view);if(el.dataset.view===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
 const titles={today:['Overview','Your day, at a glance.','Every conversation counts. See how yours add up.'],calls:['Call log','Your call history.','Every outcome, saved and easy to find.'],goals:['Daily goals','Daily goals.','Set the targets for your daily report.']};
 $('breadcrumb-label').textContent=titles[view][0];$('page-title').textContent=titles[view][1];$('page-description').textContent=titles[view][2];document.querySelector('.date-control').hidden=view==='goals';history.replaceState(null,'','#'+view);if(scroll)window.scrollTo({top:0,behavior:'instant'});
}
/** Make everything behind the phone entry sheet unavailable to keyboard and assistive navigation. */
function setBackgroundInert(value){document.querySelectorAll('.sidebar,.topbar,.page-heading,.date-control,.summary-strip,.goals-panel,.recent-panel,.page-footer,.mobile-nav,#next-win,#callback-due-alert,#callback-reminder-panel').forEach(el=>el.inert=value);}
/** Focus call entry and use a modal sheet on phone screens. */
function openEntry(){
 if(!ready)return showToast('Storage is not ready. Check the message above.');
 selectedDay=editing?.day||dayKey();allHistory=false;page=0;renderDashboard();if(view!=='today')setView('today');lastFocus=document.activeElement;
 if(window.matchMedia('(max-width: 760px)').matches){document.body.classList.add('entry-open');$('entry-backdrop').hidden=false;$('entry-panel').setAttribute('role','dialog');$('entry-panel').setAttribute('aria-modal','true');setBackgroundInert(true);}else $('entry-panel').scrollIntoView({block:'nearest',behavior:'smooth'});
 requestAnimationFrame(()=>$('ucid').focus({preventScroll:true}));
}
/** Close the sheet while retaining a draft for the next opening. */
function closeEntry(){document.body.classList.remove('entry-open');$('entry-backdrop').hidden=true;$('entry-panel').removeAttribute('role');$('entry-panel').removeAttribute('aria-modal');setBackgroundInert(false);if(lastFocus?.isConnected&&!lastFocus.closest('[hidden]'))lastFocus.focus({preventScroll:true});}
/** Clear only after a confirmed write or an explicit discard. */
function clearEntry(){
 editing=null;draft=newDraft();$('call-form').reset();$('added-services-section').open=false;$('form-error').hidden=true;
 for(const id of ['ucid','account','callback-at'])$(id).removeAttribute('aria-invalid');
 renderEntry();
}
/** Keep validation errors beside the unsaved input. */
function formError(message,id){$('form-error').textContent=message;$('form-error').hidden=false;if(id){$(id).setAttribute('aria-invalid','true');$(id).focus();}}
/** Native date-time controls are in the agent's local timezone, independent of reporting days. */
function localMinute(date){
 const two=n=>String(n).padStart(2,'0');
 return `${String(date.getFullYear()).padStart(4,'0')}-${two(date.getMonth()+1)}-${two(date.getDate())}T${two(date.getHours())}:${two(date.getMinutes())}`;
}
function callbackFromForm(){
 const value=$('callback-at').value, note=$('callback-note').value, original=draft.originalCallback;
 if(original&&value===localMinute(new Date(original.dueAt)))return {...original,note};
 const date=new Date(value);
 if(!value||!Number.isFinite(date.getTime())||!/^\d{4}-/.test(value)||localMinute(date)!==value)throw new Error('Choose a valid callback date and time in your local timezone.');
 if(date.getTime()<=Date.now())throw new Error('Choose a future time for the callback.');
 return {dueAt:date.toISOString(),note,status:'scheduled',approved:true};
}
function confirmCallback(callback){
 const dialog=$('detail-dialog');
 dialog.returnValue='';
 const when=new Date(callback.dueAt).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'});
 showDialog('Has your supervisor approved this callback?',`<p>Schedule the reminder for ${esc(when)} (your local time).</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">Cancel</button><button class="button primary" data-action="confirm-callback">Yes</button></div>`);
 return new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='callback-approved'),{once:true}));
}
/** Validate every account and commit the callback and call in a single write. */
async function saveCall(event){
 event.preventDefault();if(!ready||busy||$('detail-dialog').open)return;
 const ucid=$('ucid').value.trim();activeAccount().account=$('account').value;
 for(const id of ['ucid','account','callback-at'])$(id).removeAttribute('aria-invalid');
 $('form-error').hidden=true;
 const incomplete=draft.accounts.findIndex(a=>!a.before.length);
 if(incomplete!==-1){
   switchAccount(incomplete);
   formError(`Select at least one starting service${draft.accounts.length===1?'':` for account ${incomplete+1}`}.`);
   $('start-services').querySelector('button').focus();return;
 }
 const duplicate=ucid&&state.calls.find(c=>c.id!==editing?.id&&c.ucid.toLowerCase()===ucid.toLowerCase());
 if(duplicate){formError(`This UCID is already recorded on ${duplicate.day}. Use Call log → All dates to find it.`,'ucid');return;}
 let callback=null;
 if(draft.callbackEnabled){
   try{callback=callbackFromForm();}catch(error){formError(error.message,'callback-at');return;}
   if(callback.dueAt!==draft.originalCallback?.dueAt){
     const pendingDraft=draft;
     if(!await confirmCallback(callback)||draft!==pendingDraft||!ready||busy)return;
   }
 }
 const accounts=draft.accounts.map(a=>({account:a.account.trim(),before:[...a.before],kept:[...a.kept],added:[...a.added]}));
 const now=new Date(),time=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false}).format(now);
 const {account,before,kept}=accounts[0];
 const call={id:draft.id,day:editing?.day||dayKey(now),time:editing?.time||time,order:editing?.order??now.getTime(),ucid,account,before,kept,accounts,callback,mobileOrders:[...draft.mobileOrders],sold:draft.mobileOrders.length>0,soldLines:soldLinesFor(draft)};
 const wasEditing=!!editing,revision=editing?.revision??null;
 if(await mutate(()=>repo.saveCall(call,revision))){selectedDay=call.day;clearEntry();renderDashboard();closeEntry();showToast(wasEditing?'Call updated':'Call saved');}
}
/** Report completed actions; Undo itself is an awaited storage transaction. */
function showToast(message,undo){clearTimeout(toastTimer);const toast=$('toast');toast.textContent=message;if(undo){const button=document.createElement('button');button.textContent='Undo';button.onclick=async()=>{button.disabled=true;toast.hidden=true;await undo();};toast.append(button);}toast.hidden=false;toastTimer=setTimeout(()=>toast.hidden=true,undo?15000:5000);}
/** Open a native modal for details and reviewable restore operations. */
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
    <div class="help-rule"><strong>Callbacks</strong><p>Choose a time and an optional note, confirm supervisor approval, and save the call. Scheduled reminders appear in Overview. Due reminders appear while the tracker is open or when you return.</p></div>
    <div class="dialog-actions"><button class="button secondary" data-action="backup">Download backup</button><button class="button secondary" data-action="import">Restore backup</button><button class="button primary" data-action="close-dialog">Done</button></div>`);
}
/** Show the numerator, denominator, and assumptions behind a circle. */
function showMetric(key){const m=calculateMetrics(todayCalls(),state.goals).find(m=>m.key===key);if(!m)return;
 let advice=m.reached?'You have reached this goal.':m.needed===null?(['sales','orders'].includes(key)?'Additional orders or lines on future calls can close this gap. One on each new call alone cannot reach an exact 100% target after a missed call.':'After a loss, an exact 100% save rate cannot be reached with a finite number of new eligible opportunities on this date.'):`${m.needed} more ${m.unit}${m.needed===1?'':'s'} on consecutive eligible ${m.opportunityUnit}s would reach your ${m.goal}% goal. Each enters the denominator.`;
 const converted=todayCalls().filter(c=>soldLinesFor(c)>0).length;
 showDialog(m.label,`<div style="--ring-color:${m.color}" class="metric-detail-value">${percent(m.rate)}${m.rate===null?'':'%'}<small>Goal ${m.goal}%</small></div><div class="metric-facts"><div><strong>${m.successes}</strong><span>${key==='sales'?'Mobiles sold':key==='orders'?'Mobile orders':'Saves'}</span></div><div><strong>${m.total}</strong><span>Eligible ${m.opportunityUnit}s</span></div></div><div class="help-rule"><strong>How it's calculated</strong><p>${m.description}</p>${key==='sales'?`<p>Calls with a sale: ${converted} / ${m.total} (${m.total?percent(converted/m.total*100):'—'}%). This is separate from the line-based rate above.</p>`:''}</div><div class="rule-example">${advice}</div><div class="dialog-actions"><button class="button secondary" data-action="metric-goals">Edit goals</button><button class="button primary" data-action="close-dialog">Done</button></div>`);
}
/** Show a record's exact saved values before an edit or removal. */
function showCall(id) {
  const call = state.calls.find(record => record.id === id);
  if (!call) return;
  const accountDetails = outcomesForCall(call).map(outcome => `
    <section class="detail-account"><h3>Account ${outcome.index + 1}</h3>
      <p class="detail-account-number">${esc(outcome.account || 'No account number')}</p>
      <div class="outcome-tags">${accountBadge(outcome, true)}</div>
      <div class="service-results">${serviceTags(outcome)}</div></section>`).join('');
  const order = orderLabel(call), callback = call.callback;
  showDialog('Call details', `<p>${esc(call.time)} · ${esc(call.day)} · Eastern time</p>
    <div class="detail-ids"><div><small>CALL UCID</small><strong>${esc(call.ucid || 'Not provided')}</strong></div></div>
    ${accountDetails}
    ${order ? `<div class="help-rule"><strong>Mobile sales</strong><p>${order}</p></div>` : ''}
    ${callback ? `<div class="help-rule"><strong>Callback${callback.status === 'done' ? ' · Completed' : ''}</strong><p>${formatCallbackTime(callback.dueAt)}</p>${callback.note ? `<p class="callback-note-text">${esc(callback.note)}</p>` : ''}</div>` : ''}
    <div class="dialog-actions"><button class="text-button danger-text" data-delete="${esc(id)}" data-revision="${call.revision}">Remove call</button><button class="button primary" data-edit="${esc(id)}">Edit call ${icon('arrow-right')}</button></div>`);
}
function requestEditCall(id){
 if(editing?.id===id){$('detail-dialog').close();openEntry();return;}
 if(!hasEntryDraft()){editCall(id);return;}
 showDialog('Discard your unfinished changes?',`<p>Opening the selected call will replace the entry you are working on.</p><div class="dialog-actions"><button class="button secondary" data-action="keep-draft">Keep editing</button><button class="button primary" data-discard-for-edit="${esc(id)}">Discard draft</button></div>`);
}
/** Capture the revision now so a later edit cannot overwrite a concurrent change. */
function editCall(id){
 const call=state.calls.find(c=>c.id===id);if(!call)return;
 editing={...call};draft=newDraft();draft.id=call.id;
 draft.accounts=accountsFor(call).map(a=>({account:a.account,before:[...a.before],kept:[...a.kept],added:[...a.added]}));
 draft.mobileOrders=[...ordersFor(call)];draft.callbackEnabled=Boolean(call.callback);draft.originalCallback=call.callback||null;
 $('detail-dialog').close();$('ucid').value=call.ucid;
 $('callback-at').value=call.callback?localMinute(new Date(call.callback.dueAt)):'';
 $('callback-note').value=call.callback?.note||'';
 $('added-services-section').open=Boolean(activeAccount().added.length);
 $('form-error').hidden=true;for(const id of ['ucid','account','callback-at'])$(id).removeAttribute('aria-invalid');
 renderEntry();draft.originalValues=editValues();openEntry();
}
function switchAccount(index){
 draft.activeIndex=index;
 $('added-services-section').open=Boolean(activeAccount().added.length);
 renderEntry();
}
/** Remove atomically and offer a validated, conflict-aware undo. */
async function removeCall(id,revision){let removed;if(await mutate(async()=>{removed=await repo.removeCall(id,revision);})){if(editing?.id===id)clearEntry();$('detail-dialog').close();showToast('Call removed',async()=>{await mutate(()=>repo.restoreCall(removed),'Call restored');});}}

/** Download a local file without sending records over the network. */
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
/** Export the selected date or all-date history, including mobile line quantities. */
function exportCalls() {
  const calls = scopedCalls().filter(call => matchesFilter(call, filter));
  download(new Blob([callsToCsv(calls)], {type:'text/csv;charset=utf-8;'}), `call-log-${allHistory?'all-dates':selectedDay}.csv`);
  showToast(`${calls.length} call${calls.length === 1 ? '' : 's'} exported`);
}
/** Export a freshly read snapshot so another tab's committed calls are included. */
async function backup(){if(!ready)return;const epoch=sessionEpoch,source=repo;try{const fresh=await source.read();if(epoch!==sessionEpoch)return;const blob=new Blob([JSON.stringify({...fresh,exportedAt:new Date().toISOString()},null,2)],{type:'application/json'});if(fresh.calls.length>MAX_BACKUP_CALLS||blob.size>MAX_BACKUP_BYTES)throw new Error('This backup exceeds the restore limit. Export records as CSV and contact support before clearing data.');download(blob,`call-backup-${dayKey()}.json`);showToast('Full backup downloaded');}catch(e){if(epoch===sessionEpoch)storageError(e.message||'Could not create backup.');}}
/** Validate an entire backup before presenting a merge action. */
async function reviewImport(file){if(!file||!sessionUser)return;const epoch=sessionEpoch;try{if(file.size>MAX_BACKUP_BYTES)throw new Error('Backup is larger than 3 MiB.');const text=await file.text();if(epoch!==sessionEpoch)return;pendingImport=parseBackup(text);showDialog('Restore saved records?',`<p>This backup contains <strong>${pendingImport.calls.length} call${pendingImport.calls.length===1?'':'s'}</strong>. Existing records stay in place. Identical entries are skipped; conflicting records stop the whole restore.</p><p>Existing saved targets are kept. Targets from the backup fill any unset targets.</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">Cancel</button><button class="button primary" data-action="confirm-import">Merge backup</button></div>`);}catch(e){if(epoch!==sessionEpoch)return;pendingImport=null;storageError(e.message||'This backup is invalid. No records were changed.');}finally{$('backup-input').value='';}}
/** Route dynamic buttons without duplicate listeners or accidental form submission. */
async function onClick(event){const button=event.target.closest('button,[data-call]');if(!button||button.disabled)return;if(busy&&(button.closest('[data-call]')||button.dataset.edit||button.dataset.action==='new-call'))return;
 if(button.dataset.view){setView(button.dataset.view);return;}
 if(button.dataset.metric){showMetric(button.dataset.metric);return;}
 if(button.closest('[data-call]')){showCall(button.closest('[data-call]').dataset.call);return;}
 if(button.dataset.edit){requestEditCall(button.dataset.edit);return;}
 if(button.dataset.discardForEdit){editCall(button.dataset.discardForEdit);return;}
 if(button.dataset.delete){await removeCall(button.dataset.delete,Number(button.dataset.revision));return;}
 if(button.dataset.filter){filter=button.dataset.filter;page=0;renderCallLog();return;}
 if(button.dataset.service){
   const key=button.dataset.service,a=activeAccount();
   if(a.before.includes(key)){a.before=a.before.filter(s=>s!==key);a.kept=a.kept.filter(s=>s!==key);}
   else{a.before.push(key);a.kept.push(key);a.added=a.added.filter(s=>s!==key);}
   renderEntry();return;
 }
 if(button.dataset.end){
   const key=button.dataset.end,a=activeAccount();a.kept=a.kept.filter(s=>s!==key);
   if(button.dataset.kept==='true')a.kept.push(key);
   renderEntry();return;
 }
 if(button.dataset.addedService){
   const key=button.dataset.addedService,a=activeAccount();
   if(a.before.includes(key))return;
   a.added=a.added.includes(key)?a.added.filter(s=>s!==key):[...a.added,key];
   renderEntry();return;
 }
 if(button.dataset.goal){const key=button.dataset.goal,delta=button.dataset.delta;await setGoal(key,state.goals[key]+Number(delta));document.querySelector(`[data-goal="${key}"][data-delta="${delta}"]`)?.focus({preventScroll:true});return;}
 switch(button.dataset.action){
  case 'review-callbacks':
    setView('today',false);
    $('callback-reminder-panel').scrollIntoView({block:'start'});
    $('callback-reminder-title').focus({preventScroll:true});
    break;
  case 'complete-callback':{
    const call=state.calls.find(item=>item.id===button.dataset.callbackId);
    if(!ready||busy||call?.callback?.status!=='scheduled')break;
    const revision=Number(button.dataset.revision), repository=repo;
    let completed;
    if(await mutate(async()=>{
      completed=await repository.saveCall({...call,callback:{...call.callback,status:'done'}},revision);
    })){
      showToast('Callback marked done',()=>mutate(()=>repository.saveCall({...completed,callback:{...completed.callback,status:'scheduled'}},completed.revision),'Callback restored'));
      if(document.activeElement===document.body){
        const target=$('callback-reminder-panel').hidden ? document.querySelector('.add-call') : $('callback-reminder-title');
        target.focus({preventScroll:true});
      }
    }
    break;
  }
  case 'new-call':openEntry();break;
  case 'close-entry':closeEntry();break;
  case 'cancel-edit':clearEntry();break;
  case 'keep-draft':$('detail-dialog').close();openEntry();break;
  case 'add-account':
    activeAccount().account=$('account').value;draft.accounts.push(emptyAccount());switchAccount(draft.accounts.length-1);
    $('account').focus();break;
  case 'remove-account':
    if(draft.accounts.length>1){draft.accounts.splice(draft.activeIndex,1);switchAccount(Math.min(draft.activeIndex,draft.accounts.length-1));$('account').focus();}
    break;
  case 'toggle-callback':
    draft.callbackEnabled=!draft.callbackEnabled;
    if(!draft.callbackEnabled){draft.originalCallback=null;$('callback-at').value='';$('callback-note').value='';$('callback-at').removeAttribute('aria-invalid');}
    renderEntry();if(draft.callbackEnabled)$('callback-at').focus();break;
  case 'confirm-callback':$('detail-dialog').close('callback-approved');break;
  case 'add-order':if(draft.mobileOrders.length<20)draft.mobileOrders.push(1);renderEntry();break;
  case 'order-up':{const i=Number(button.dataset.orderIndex);draft.mobileOrders[i]=Math.min(12,draft.mobileOrders[i]+1);renderEntry();break;}
  case 'order-down':{const i=Number(button.dataset.orderIndex);draft.mobileOrders[i]=Math.max(1,draft.mobileOrders[i]-1);renderEntry();break;}
  case 'remove-order':draft.mobileOrders.splice(Number(button.dataset.orderIndex),1);renderEntry();document.querySelector('[data-action="add-order"]')?.focus();break;
  case 'sign-out':await signOut();break;
  case 'confirm-sign-out':await finishSignOut();break;
  case 'toggle-password':setPasswordVisible($('password').type==='password');break;
  case 'help':showHelp();break;
  case 'close-dialog':pendingImport=null;$('detail-dialog').close();break;
  case 'metric-goals':$('detail-dialog').close();setView('goals');break;
  case 'export':exportCalls();break;
  case 'backup':await backup();break;
  case 'import':$('detail-dialog').close();$('backup-input').click();break;
  case 'confirm-import':{if(!pendingImport)return;let result;if(await mutate(async()=>{result=await repo.importBackup(pendingImport);})){pendingImport=null;$('detail-dialog').close();showToast(`${result.imported} call${result.imported===1?'':'s'} restored · ${result.skipped} unchanged`);}break;}
  case 'all-history':allHistory=!allHistory;page=0;renderCallLog();break;
  case 'today':selectedDay=dayKey();allHistory=false;page=0;renderDashboard();break;
  case 'previous-page':page=Math.max(0,page-1);renderCallLog();break;
  case 'next-page':page++;renderCallLog();break;
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
 sessionEpoch++;sessionRequest++;sessionUser=null;authMode='login';ready=false;repo?.close();repo=null;busy=false;pendingImport=null;state={version:3,calls:[],goals:{...DEFAULT_GOALS}};editing=null;closeEntry();$('detail-dialog').close();clearEntry();renderDashboard();renderGoals();$('workspace-view').hidden=true;$('auth-view').hidden=false;$('toast').hidden=true;clearTimeout(toastTimer);$('password').value='';$('auth-status').textContent='';renderAuth();setAuthBusy(false);authMessage(message);
}
async function enterWorkspace(user){
 const epoch=++sessionEpoch;
 sessionUser=user;ready=false;
 const source=await openStore(user.id);
 if(epoch!==sessionEpoch){source.close();return;}
 repo=source;
 $('session-username').textContent=user.username;$('auth-view').hidden=true;$('workspace-view').hidden=false;$('auth-status').textContent='';$('storage-status').textContent='Loading your records…';
 renderEntry();
 await syncFromStorage();
}
async function submitAuth(event){event.preventDefault();if(authBusy)return;authenticating=true;sessionRequest++;authMessage('');setAuthBusy(true);try{const result=await apiRequest(authMode,{username:$('username').value,password:$('password').value});$('password').value='';await enterWorkspace(result.user);channel?.postMessage({sessionChanged:true});}catch(e){authMessage(e.message||'Could not sign in. Please try again.');}finally{authenticating=false;setAuthBusy(false);}}
async function signOut(){if(busy)return;if(hasEntryDraft()){showDialog('Sign out?',`<p>You have an unfinished call. Signing out discards this entry.</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">Keep editing</button><button class="button primary" data-action="confirm-sign-out">Sign out</button></div>`);return;}await finishSignOut();}
async function finishSignOut(){authenticating=true;sessionRequest++;try{await apiRequest('logout',{});showSignIn();channel?.postMessage({sessionChanged:true});}catch(e){storageError(e.message||'Could not sign out. Try again.');}finally{authenticating=false;}}
async function checkSession(){if(authenticating)return;const epoch=sessionEpoch,request=++sessionRequest;try{const {user}=await apiRequest();if(epoch!==sessionEpoch||request!==sessionRequest)return;if(user){if(!sessionUser||user.id!==sessionUser.id){showSignIn();await enterWorkspace(user);}else await syncFromStorage();}else if(sessionUser)showSignIn('Your session ended. Sign in again.');else{$('auth-status').textContent='';setAuthBusy(false);}}catch(e){if(epoch!==sessionEpoch||request!==sessionRequest)return;if(!sessionUser){$('auth-status').textContent='';authMessage(e.message);setAuthBusy(false);}else storageError(e.message);}}
async function initialize(){renderDashboard();renderEntry();renderGoals();setView(location.hash.slice(1),false);renderAuth();setAuthBusy(true);await checkSession();}

document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
document.addEventListener('click',event=>{onClick(event).catch(e=>storageError(e.message||'The action could not be completed.'));});
document.addEventListener('keydown',onKeydown);
$('call-form').addEventListener('submit',saveCall);
$('account').addEventListener('input',()=>{activeAccount().account=$('account').value;});
$('account-select').addEventListener('change',event=>{
 activeAccount().account=$('account').value;switchAccount(Number(event.target.value));
});
$('auth-form').addEventListener('submit',submitAuth);
$('auth-mode-toggle').addEventListener('click',()=>{authMode=authMode==='login'?'signup':'login';renderAuth();});
window.addEventListener('session-expired',event=>{if(event.detail?.userId===sessionUser?.id)showSignIn('Your session changed or expired. Sign in again.');});
$('report-date').addEventListener('change',event=>{const value=event.target.value;if(validDay(value)&&value<=dayKey()){selectedDay=value;allHistory=false;page=0;renderDashboard();}});
document.addEventListener('input',event=>{if(event.target.dataset.goalSlider)event.target.closest('.goal-setting').querySelector('.goal-stepper strong').textContent=event.target.value+'%';});
document.addEventListener('change',event=>{if(event.target.dataset.goalSlider)setGoal(event.target.dataset.goalSlider,event.target.value);});
$('backup-input').addEventListener('change',event=>reviewImport(event.target.files[0]));
$('entry-backdrop').addEventListener('click',closeEntry);
window.matchMedia('(max-width: 760px)').addEventListener('change',closeEntry);
channel?.addEventListener('message',event=>{if(event.data?.sessionChanged)checkSession();else if(event.data?.userId===sessionUser?.id)syncFromStorage();});
window.addEventListener('focus',()=>{refreshDay();checkSession();});
window.addEventListener('hashchange',()=>setView(location.hash.slice(1),false));
window.addEventListener('beforeunload',event=>{if(sessionUser&&(hasEntryDraft())){event.preventDefault();event.returnValue='';}});
setInterval(()=>{refreshDay();if(document.visibilityState==='visible')syncFromStorage();},30000);
initialize();
