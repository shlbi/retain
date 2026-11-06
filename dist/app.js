import { SERVICES, METRICS, DEFAULT_GOALS, classifyCall, calculateMetrics, dayKey, soldLinesFor, soldOrdersFor, ordersFor } from './model.js';
import { openStore, apiRequest, parseBackup, MAX_BACKUP_BYTES, MAX_BACKUP_CALLS, validDay } from './storage.js';

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
let pendingImport=null, sessionUser=null, authMode='login', authBusy=false, syncing=false, sessionEpoch=0, sessionRequest=0, authenticating=false;
const PAGE_SIZE=50;
const channel=typeof BroadcastChannel==='function' ? new BroadcastChannel('call-workspace-v3') : null;

/** Escape all user-supplied identifiers before rendering HTML. */
function esc(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
/** Render locally defined outline icons. */
function icon(name){return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name]||paths.info}</svg>`;}
/** Require starting services to be explicitly selected for every new call. */
function newDraft(){return {id:typeof crypto.randomUUID==='function'?crypto.randomUUID():'call-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2),before:[],kept:[],mobileOrders:[]};}
/** Select a day while keeping old records available. */
function todayCalls(){return state.calls.filter(c=>c.day===selectedDay).sort((a,b)=>b.order-a.order);}
/** Select the call-log scope independently from the daily dashboard. */
function scopedCalls(){return allHistory ? [...state.calls].sort((a,b)=>b.day.localeCompare(a.day)||b.order-a.order) : todayCalls();}
/** Format fractional rates without hiding zero-opportunity states. */
function percent(value){return value===null?'—':Number(value.toFixed(1)).toLocaleString('en-US');}
/** Describe the fixed six outcome codes, including the stated three-plus grouping. */
function outcomeName(code){return ({SPS:'Single-play save',SPD:'Single-play disconnect',DPS:'Double-play save',DPD:'Double-play disconnect',TPS:'Triple-play (3+) save',TPD:'Triple-play (3+) disconnect'})[code]||'Choose services';}
/** Keep the save classification and every lost service visible together. */
function outcomeTags(call,detailed=false){
  const outcome=classifyCall(call.before,call.kept);
  if(!outcome)return '';
  const losses=SERVICES.filter(service=>outcome.disconnected.includes(service.key));
  return `<span class="outcome-tags"><span class="badge ${outcome.saved?'save':'disconnect'}" title="${outcomeName(outcome.code)}">${outcome.code}${detailed?' · '+outcomeName(outcome.code):''}</span>${losses.map(service=>`<span class="badge disconnect service-disconnect">${esc(service.label)} disconnected</span>`).join('')}</span>`;
}
/** Label progress without promising a finite run can erase a loss at a 100% target. */
function neededLabel(m){if(m.reached)return icon('check')+'Goal reached';if(m.needed===null)return ['sales','orders'].includes(m.key)?'See goal details':'Keep every next call';return `${m.needed} ${m.unit}${m.needed===1?'':'s'} to goal`;}
/** Show the underlying counts beside each rate. */
function countLabel(m){const calls=`${m.total} call${m.total===1?'':'s'}`;return !m.total?'No eligible calls yet':['sales','orders'].includes(m.key)?`${m.successes} ${m.unit}${m.successes===1?'':'s'} / ${calls}`:`${m.successes} saved / ${calls}`;}
/** Keep all write controls locked until storage is ready or a transaction finishes. */
function setBusy(value){busy=value;document.querySelectorAll('#call-form input,#call-form button,[data-goal],[data-goal-slider],[data-action="import"],[data-action="backup"]').forEach(el=>el.disabled=busy||!ready);$('submit-label').textContent=busy?'Saving…':editing?'Update call':'Save call';document.querySelectorAll('[data-action="order-up"],[data-action="order-down"]').forEach(el=>{const n=draft.mobileOrders[Number(el.dataset.orderIndex)];el.disabled=busy||!ready||(el.dataset.action==='order-up'?n>=12:n<=1);});const add=document.querySelector('[data-action="add-order"]');if(add)add.disabled=busy||!ready||draft.mobileOrders.length>=20;$('goal-save-status').textContent=busy?'Saving…':ready?'Saved to your account':'Storage not ready';}
/** Display a lasting storage error rather than falsely claiming a save succeeded. */
function storageError(message){$('storage-banner').textContent=message;$('storage-banner').hidden=false;$('storage-status').textContent='Storage needs attention';}
/** Reload committed state; never replace an in-progress draft with another tab's changes. */
async function refreshState(){if(!repo)return;state=await repo.read();renderDashboard();renderGoals();setBusy(busy);}
/** Commit first, then update UI; preserve user input when a transaction fails. */
async function mutate(action,message){
  if(!ready||busy)return false;
  $('dialog-error')?.remove();setBusy(true);let committed=false;const epoch=sessionEpoch;
  try{await action();committed=true;const fresh=await repo.read();if(epoch!==sessionEpoch)return false;state=fresh;renderDashboard();renderGoals();$('storage-banner').hidden=true;$('storage-status').textContent='Saved to your account';channel?.postMessage({changed:true,userId:sessionUser?.id});if(message)showToast(message);return true;}
  catch(error){if(epoch!==sessionEpoch||error?.code==='AUTH')return false;const message=committed?'The change was committed, but saved records could not be reloaded. Reload this page before continuing.':error?.message||'The change could not be saved. Your entry is still here.';if(committed||error?.code==='STORAGE')ready=false;formError(message);storageError(message);if($('detail-dialog').open){const alert=document.createElement('p');alert.id='dialog-error';alert.className='form-error';alert.setAttribute('role','alert');$('dialog-content').querySelector('.dialog-body').prepend(alert);alert.textContent=message;}return false;}
  finally{if(epoch===sessionEpoch)setBusy(false);}
}
/** Render today's dashboard and rates from committed records only. */
function renderDashboard(){
  const calls=todayCalls(),metrics=calculateMetrics(calls,state.goals);
  const saved=calls.filter(c=>classifyCall(c.before,c.kept).saved).length,sold=calls.reduce((n,c)=>n+soldLinesFor(c),0),orders=calls.reduce((n,c)=>n+soldOrdersFor(c),0);
  $('summary-strip').innerHTML=[['calls',calls.length,'Calls logged'],['leaf',saved,'Customers kept'],['mobile',orders,'Mobile orders'],['sparkles',sold,'Mobiles sold']].map(([name,n,label])=>`<div class="summary-item"><span class="summary-icon">${icon(name)}</span><div class="summary-content"><strong>${n}</strong><span>${label}</span></div></div>`).join('');
  const circumference=2*Math.PI*56;
  $('rings-grid').innerHTML=metrics.map(m=>`<button class="ring-card" data-metric="${m.key}" style="--ring-color:${m.color}" aria-label="${m.label}: ${m.rate===null?'no eligible calls':percent(m.rate)+' percent'}, goal ${m.goal} percent. ${m.reached?'Goal reached':m.needed===null?'See goal details':m.needed+' more '+m.unit+(m.needed===1?'':'s')+' needed'}"><div class="ring-visual"><svg class="ring-svg" viewBox="0 0 132 132" aria-hidden="true"><circle class="ring-track" cx="66" cy="66" r="56"/><circle class="ring-progress" cx="66" cy="66" r="56" stroke-dasharray="${circumference}" stroke-dashoffset="${circumference*(1-m.progress)}"/></svg><span class="ring-center"><span class="ring-value">${percent(m.rate)}${m.rate===null?'':'<span>%</span>'}</span><span class="ring-goal">Goal ${m.goal}%</span><span class="ring-needed">${neededLabel(m)}</span></span></div><span class="ring-title">${m.label}</span><span class="ring-count">${countLabel(m)}</span></button>`).join('');
  $('goals-reached').innerHTML=icon('check')+`${metrics.filter(m=>m.reached).length} of ${metrics.length} goals reached`;
  $('nav-count').textContent=state.calls.length;$('recent-count').textContent=calls.length;
  $('recent-calls').innerHTML=callTable(calls.slice(0,4));
  const m=metrics.find(m=>m.key==='orders');
  $('next-win').innerHTML=icon('sparkles')+`<div><strong>${!calls.length?'A fresh start.':m.reached?'Mobile goal reached.':'Your next win.'}</strong><br>${!calls.length?'Log your first call to start filling the circles.':m.needed===null?'Additional mobile orders can help close the gap.':m.reached?'Every additional order adds to your total.':`${m.needed} more mobile order${m.needed===1?'':'s'}, one per next call, would reach your ${m.goal}% goal.`}</div>`;
  renderDate();renderCallLog();
}
/** Render escaped identifiers, outcome badges, and separate service losses. */
function callTable(calls){
  if(!calls.length)return `<div class="empty-state"><span>${icon('calls')}</span><h3>${filter==='all'?'No calls recorded.':'No matching calls.'}</h3><p>${allHistory?'Your saved history will appear here.':'Choose another date or log your next call.'}</p><button class="button secondary" data-action="new-call">${icon('plus')}Log a call</button></div>`;
  return `<table class="call-table"><thead><tr><th scope="col">Time</th><th scope="col">Account / UCID</th><th scope="col">Outcome</th><th scope="col">Service changes</th><th scope="col"><span class="sr-only">Details</span></th></tr></thead><tbody>${calls.map(c=>{const o=classifyCall(c.before,c.kept),losses=o.disconnected.map(s=>SERVICES.find(x=>x.key===s).label).join(', '),lines=soldLinesFor(c),orders=soldOrdersFor(c);return `<tr data-call="${esc(c.id)}"><td>${esc(c.time)}</td><td><span class="record-id">${esc(c.account||'No account number')}</span><span class="record-subtitle">${esc(c.ucid||'No UCID')}</span>${allHistory?`<span class="record-subtitle">${esc(c.day)}</span>`:''}</td><td>${outcomeTags(c)}<span class="record-subtitle">${outcomeName(o.code)}</span></td><td>${losses?`<span class="disconnect-note">− ${esc(losses)}</span>`:'<span class="record-subtitle">All services kept</span>'}${lines?`<span class="badge mobile" style="margin-top:5px">${orders} order${orders===1?'':'s'} · ${lines} mobile${lines===1?'':'s'}</span>`:''}</td><td><button class="icon-button" aria-label="View call ${esc(c.ucid||c.day+' at '+c.time)}">${icon('chevron')}</button></td></tr>`;}).join('')}</tbody></table>`;
}
/** Limit large histories to fifty rows at a time without affecting totals or exports. */
function renderCallLog(){
  const calls=scopedCalls(),filtered=calls.filter(c=>filter==='all'||(filter==='mobile'?soldLinesFor(c)>0:filter==='saved'?classifyCall(c.before,c.kept).saved:classifyCall(c.before,c.kept).disconnected.length>0));
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
  $('start-services').innerHTML=SERVICES.map(s=>`<button type="button" class="service-button" data-service="${s.key}" aria-pressed="${draft.before.includes(s.key)}">${icon(s.icon)}${s.short}</button>`).join('');
  $('end-services').innerHTML=SERVICES.filter(s=>draft.before.includes(s.key)).map(s=>`<div class="end-row"><span class="end-name">${icon(s.icon)}${s.label}</span><div class="outcome-toggle" role="group" aria-label="${s.label} outcome"><button type="button" data-end="${s.key}" data-kept="true" aria-pressed="${draft.kept.includes(s.key)}" aria-label="Keep ${s.label}">Kept</button><button type="button" data-end="${s.key}" data-kept="false" aria-pressed="${!draft.kept.includes(s.key)}" aria-label="Disconnect ${s.label}">Disconnected</button></div></div>`).join('')||'<p class="text-muted">Select the services the customer had.</p>';
  $('mobile-orders').innerHTML=draft.mobileOrders.map((n,i)=>`<div class="mobile-order-row"><span>Order ${i+1}</span><div class="mobile-lines-stepper"><button type="button" data-action="order-down" data-order-index="${i}" aria-label="One fewer mobile in order ${i+1}" ${n===1?'disabled':''}>${icon('minus')}</button><output aria-live="polite">${n}</output><button type="button" data-action="order-up" data-order-index="${i}" aria-label="One more mobile in order ${i+1}" ${n===12?'disabled':''}>${icon('plus')}</button></div><button type="button" class="remove-order icon-button" data-action="remove-order" data-order-index="${i}" aria-label="Remove order ${i+1}">${icon('close')}</button></div>`).join('')+`<p class="orders-summary">${draft.mobileOrders.length?`${draft.mobileOrders.length} order${draft.mobileOrders.length===1?'':'s'} · ${soldLinesFor(draft)} mobile${soldLinesFor(draft)===1?'':'s'}`:'No mobile orders on this call'}</p>`;
  const outcome=classifyCall(draft.before,draft.kept);
  $('outcome-preview').innerHTML=outcome?`${outcomeTags(draft,true)}${draft.mobileOrders.length?`<span class="badge mobile">${draft.mobileOrders.length} order${draft.mobileOrders.length===1?'':'s'} · ${soldLinesFor(draft)} mobile${soldLinesFor(draft)===1?'':'s'}</span>`:''}`:'The outcome appears here automatically';
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
 const titles={today:['Overview','Your day, at a glance.','Every conversation counts. See how yours add up.'],calls:['Call log','Your call history.','Every outcome, saved and easy to find.'],goals:['Goals & backups','A goal for every win.','Set your targets and manage your saved records.']};
 $('breadcrumb-label').textContent=titles[view][0];$('page-title').textContent=titles[view][1];$('page-description').textContent=titles[view][2];document.querySelector('.date-control').hidden=view==='goals';history.replaceState(null,'','#'+view);if(scroll)window.scrollTo({top:0,behavior:'instant'});
}
/** Make everything behind the phone entry sheet unavailable to keyboard and assistive navigation. */
function setBackgroundInert(value){document.querySelectorAll('.sidebar,.topbar,.page-heading,.date-control,.summary-strip,.goals-panel,.recent-panel,.page-footer,.mobile-nav,#next-win').forEach(el=>el.inert=value);}
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
function clearEntry(){editing=null;draft=newDraft();$('call-form').reset();$('form-error').hidden=true;for(const id of ['ucid','account'])$(id).removeAttribute('aria-invalid');renderEntry();}
/** Keep validation errors beside the unsaved input. */
function formError(message,id){$('form-error').textContent=message;$('form-error').hidden=false;if(id){$(id).setAttribute('aria-invalid','true');$(id).focus();}}
/** Validate and commit a call, retaining the original revision through edits. */
async function saveCall(event){
 event.preventDefault();if(!ready||busy)return;
 const ucid=$('ucid').value.trim(),account=$('account').value.trim();for(const id of ['ucid','account'])$(id).removeAttribute('aria-invalid');
 if(!draft.before.length)return formError('Tap at least one starting service.');
 const duplicate=ucid&&state.calls.find(c=>c.id!==editing?.id&&c.ucid.toLowerCase()===ucid.toLowerCase());
 if(duplicate){formError(`This UCID is already recorded on ${duplicate.day}. Use Call log → All dates to find it.`,'ucid');return;}
 const now=new Date(),time=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false}).format(now);
 const id=editing?.id||draft.id;
 const call={id,day:editing?.day||dayKey(),time:editing?.time||time,order:editing?.order??Date.now(),ucid,account,before:[...draft.before],kept:[...draft.kept],mobileOrders:[...draft.mobileOrders],sold:draft.mobileOrders.length>0,soldLines:soldLinesFor(draft)};
 const wasEditing=!!editing;
 if(await mutate(()=>repo.saveCall(call,editing?.revision??null))){selectedDay=call.day;clearEntry();renderDashboard();closeEntry();showToast(`${wasEditing?'Call updated':'Call saved'} · ${classifyCall(call.before,call.kept).code}`);}
}
/** Report completed actions; Undo itself is an awaited storage transaction. */
function showToast(message,undo){clearTimeout(toastTimer);const toast=$('toast');toast.textContent=message;if(undo){const button=document.createElement('button');button.textContent='Undo';button.onclick=async()=>{button.disabled=true;toast.hidden=true;await undo();};toast.append(button);}toast.hidden=false;toastTimer=setTimeout(()=>toast.hidden=true,undo?15000:5000);}
/** Open a native modal for details and reviewable restore operations. */
function showDialog(title,content){$('dialog-content').innerHTML=`<div class="dialog-heading"><h2 id="dialog-title">${title}</h2><button class="icon-button" data-action="close-dialog" aria-label="Close dialog">${icon('close')}</button></div><div class="dialog-body">${content}</div>`;if(!$('detail-dialog').open)$('detail-dialog').showModal();}
/** Explain the exact implemented reporting rules without claiming official company definitions. */
function showHelp(){showDialog('How your numbers work',`<p>UCID and account number are optional. Select the starting services, tap what stayed, and add any mobile orders with 1–12 mobiles each.</p><div class="rule-example"><strong>Three services → two kept</strong><br>TV + Internet + Home phone → TV + Home phone<br><span class="badge save">DPS</span> Double-play save <span class="badge disconnect">− Internet</span><br>The internet loss is included in the internet save-rate denominator. Mixed calls show both tags and appear under both Saves and Disconnects in the call log.</div><div class="help-rule"><strong>Rates</strong><p>Overall: calls with an original service kept ÷ all calls.<br>Service: service kept ÷ calls that started with it.<br>Play: SPS ÷ (SPS + SPD), and similarly for DP and TP.<br>Mobile orders: number of orders ÷ all calls.<br>Mobiles sold: number of new lines ÷ all calls. An order with 3 mobiles counts as 1 order and 3 mobiles. Each order supports 1–12 mobiles; more than one order can be logged on a call.</p></div><div class="help-rule"><strong>Six outcomes</strong><p>Saves use the number of services kept. Full disconnects use the starting services. Mobile counts as a service. TP groups three or four services, shown as 3+. These are this tracker's reporting definitions; match them to your team's reporting before using the figures for official performance reporting.</p></div><div class="help-rule"><strong>Goals and remaining wins</strong><p>Rings close when the actual rate reaches the target. Remaining wins include new eligible calls in the denominator and assume each next eligible call is successful. Mobile order estimates assume one order per next call; mobile line estimates assume one line per next call. Targets apply to every report date.</p></div><div class="help-rule"><strong>Your records</strong><p>Records are saved to your account. Sign in with the same username and password on your phone or computer to access them. Changes refresh when you return to the page. Backups contain any identifiers you entered. Daily reports use Eastern time; past days remain in Call log.</p></div><div class="dialog-actions"><button class="button primary" data-action="close-dialog">Got it ${icon('check')}</button></div>`);}
/** Show the numerator, denominator, and assumptions behind a circle. */
function showMetric(key){const m=calculateMetrics(todayCalls(),state.goals).find(m=>m.key===key);if(!m)return;
 let advice=m.reached?'You have reached this goal.':m.needed===null?(['sales','orders'].includes(key)?'Additional orders or lines on future calls can close this gap. One on each new call alone cannot reach an exact 100% target after a missed call.':'After a loss, an exact 100% save rate cannot be reached with a finite number of new calls on this date.'):`${m.needed} more ${m.unit}${m.needed===1?'':'s'} on consecutive eligible calls would reach your ${m.goal}% goal. These new calls also enter the denominator.`;
 const converted=todayCalls().filter(c=>soldLinesFor(c)>0).length;
 showDialog(m.label,`<div style="--ring-color:${m.color}" class="metric-detail-value">${percent(m.rate)}${m.rate===null?'':'%'}<small>Goal ${m.goal}%</small></div><div class="metric-facts"><div><strong>${m.successes}</strong><span>${key==='sales'?'Mobiles sold':key==='orders'?'Mobile orders':'Saves'}</span></div><div><strong>${m.total}</strong><span>Eligible calls</span></div></div><div class="help-rule"><strong>How it's calculated</strong><p>${m.description}</p>${key==='sales'?`<p>Calls with a sale: ${converted} / ${m.total} (${m.total?percent(converted/m.total*100):'—'}%). This is separate from the line-based rate above.</p>`:''}</div><div class="rule-example">${advice}</div><div class="dialog-actions"><button class="button secondary" data-action="metric-goals">Edit goals</button><button class="button primary" data-action="close-dialog">Done</button></div>`);
}
/** Show a record's exact saved values before an edit or removal. */
function showCall(id){const c=state.calls.find(c=>c.id===id);if(!c)return;showDialog('Call details',`<div class="detail-results">${outcomeTags(c,true)}${soldLinesFor(c)?`<span class="badge mobile">${soldOrdersFor(c)} order${soldOrdersFor(c)===1?'':'s'} · ${soldLinesFor(c)} mobile${soldLinesFor(c)===1?'':'s'} sold</span>`:''}</div><p>${esc(c.time)} · ${esc(c.day)} · Eastern time</p><div class="detail-ids"><div><small>CALL UCID</small><strong>${esc(c.ucid||'Not provided')}</strong></div><div><small>ACCOUNT NUMBER</small><strong>${esc(c.account||'Not provided')}</strong></div></div>${SERVICES.filter(s=>c.before.includes(s.key)).map(s=>`<div class="detail-service"><span>${icon(s.icon)}${s.label}</span><span class="badge ${c.kept.includes(s.key)?'save':'disconnect'}">${c.kept.includes(s.key)?'Kept':'Disconnected'}</span></div>`).join('')}<div class="dialog-actions"><button class="text-button danger-text" data-delete="${esc(id)}" data-revision="${c.revision}">Remove call</button><button class="button primary" data-edit="${esc(id)}">Edit call ${icon('arrow-right')}</button></div>`);}
/** Capture the revision now so a later edit cannot overwrite a concurrent change. */
function editCall(id){const c=state.calls.find(c=>c.id===id);if(!c)return;editing={...c};draft={id:c.id,before:[...c.before],kept:[...c.kept],mobileOrders:ordersFor(c)};$('detail-dialog').close();$('ucid').value=c.ucid;$('account').value=c.account;$('form-error').hidden=true;renderEntry();openEntry();}
/** Remove atomically and offer a validated, conflict-aware undo. */
async function removeCall(id,revision){let removed;if(await mutate(async()=>{removed=await repo.removeCall(id,revision);})){if(editing?.id===id)clearEntry();$('detail-dialog').close();showToast('Call removed',async()=>{await mutate(()=>repo.restoreCall(removed),'Call restored');});}}
/** Prevent spreadsheet formula execution while preserving identifiers in quoted cells. */
function csvCell(value){const text=String(value??'');return '"'+(/^[\s]*[=+@-]/.test(text)?"'":'')+text.replace(/"/g,'""')+'"';}
/** Download a local file without sending records over the network. */
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);}
/** Export the selected date or all-date history, including mobile line quantities. */
function exportCalls(){const calls=scopedCalls(),rows=[['Date','Time (Eastern)','UCID','Account number','Outcome','Starting services','Kept services','Disconnected services','Mobile orders','Mobiles sold','Mobiles per order']];calls.forEach(c=>rows.push([c.day,c.time,c.ucid,c.account,classifyCall(c.before,c.kept).code,c.before.join('; '),c.kept.join('; '),c.before.filter(s=>!c.kept.includes(s)).join('; '),soldOrdersFor(c),soldLinesFor(c),ordersFor(c).join('; ')]));download(new Blob(['\uFEFF'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8;'}),`call-log-${allHistory?'all-dates':selectedDay}.csv`);showToast(`${calls.length} call${calls.length===1?'':'s'} exported`);}
/** Export a freshly read snapshot so another tab's committed calls are included. */
async function backup(){if(!ready)return;const epoch=sessionEpoch,source=repo;try{const fresh=await source.read();if(epoch!==sessionEpoch)return;const blob=new Blob([JSON.stringify({...fresh,exportedAt:new Date().toISOString()},null,2)],{type:'application/json'});if(fresh.calls.length>MAX_BACKUP_CALLS||blob.size>MAX_BACKUP_BYTES)throw new Error('This backup exceeds the restore limit. Export records as CSV and contact support before clearing data.');download(blob,`call-backup-${dayKey()}.json`);$('backup-status').textContent=`Backup downloaded: ${fresh.calls.length} call${fresh.calls.length===1?'':'s'}, ${new Date().toLocaleTimeString()}. Keep it somewhere private.`;showToast('Full backup downloaded');}catch(e){if(epoch===sessionEpoch)storageError(e.message||'Could not create backup.');}}
/** Validate an entire backup before presenting a merge action. */
async function reviewImport(file){if(!file||!sessionUser)return;const epoch=sessionEpoch;try{if(file.size>MAX_BACKUP_BYTES)throw new Error('Backup is larger than 3 MiB.');const text=await file.text();if(epoch!==sessionEpoch)return;pendingImport=parseBackup(text);showDialog('Restore saved records?',`<p>This backup contains <strong>${pendingImport.calls.length} call${pendingImport.calls.length===1?'':'s'}</strong>. Existing records stay in place. Identical entries are skipped; conflicting records stop the whole restore.</p><p>Existing saved targets are kept. Targets from the backup fill any unset targets.</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">Cancel</button><button class="button primary" data-action="confirm-import">Merge backup</button></div>`);}catch(e){if(epoch!==sessionEpoch)return;pendingImport=null;storageError(e.message||'This backup is invalid. No records were changed.');}finally{$('backup-input').value='';}}
/** Route dynamic buttons without duplicate listeners or accidental form submission. */
async function onClick(event){const button=event.target.closest('button,[data-call]');if(!button||button.disabled)return;if(busy&&(button.closest('[data-call]')||button.dataset.edit||button.dataset.action==='new-call'))return;
 if(button.dataset.view){setView(button.dataset.view);return;}
 if(button.dataset.metric){showMetric(button.dataset.metric);return;}
 if(button.closest('[data-call]')){showCall(button.closest('[data-call]').dataset.call);return;}
 if(button.dataset.edit){editCall(button.dataset.edit);return;}
 if(button.dataset.delete){await removeCall(button.dataset.delete,Number(button.dataset.revision));return;}
 if(button.dataset.filter){filter=button.dataset.filter;page=0;renderCallLog();return;}
 if(button.dataset.service){const key=button.dataset.service;if(draft.before.includes(key)){draft.before=draft.before.filter(s=>s!==key);draft.kept=draft.kept.filter(s=>s!==key);}else{draft.before.push(key);draft.kept.push(key);}renderEntry();return;}
 if(button.dataset.end){const key=button.dataset.end;draft.kept=draft.kept.filter(s=>s!==key);if(button.dataset.kept==='true')draft.kept.push(key);renderEntry();return;}
 if(button.dataset.goal){const key=button.dataset.goal,delta=button.dataset.delta;await setGoal(key,state.goals[key]+Number(delta));document.querySelector(`[data-goal="${key}"][data-delta="${delta}"]`)?.focus({preventScroll:true});return;}
 switch(button.dataset.action){
  case 'new-call':openEntry();break;
  case 'close-entry':closeEntry();break;
  case 'cancel-edit':clearEntry();break;
  case 'add-order':if(draft.mobileOrders.length<20)draft.mobileOrders.push(1);renderEntry();break;
  case 'order-up':{const i=Number(button.dataset.orderIndex);draft.mobileOrders[i]=Math.min(12,draft.mobileOrders[i]+1);renderEntry();break;}
  case 'order-down':{const i=Number(button.dataset.orderIndex);draft.mobileOrders[i]=Math.max(1,draft.mobileOrders[i]-1);renderEntry();break;}
  case 'remove-order':draft.mobileOrders.splice(Number(button.dataset.orderIndex),1);renderEntry();document.querySelector('[data-action="add-order"]')?.focus();break;
  case 'sign-out':await signOut();break;
  case 'confirm-sign-out':await finishSignOut();break;
  case 'toggle-password':$('password').type=$('password').type==='password'?'text':'password';button.setAttribute('aria-pressed',String($('password').type==='text'));button.setAttribute('aria-label',$('password').type==='text'?'Hide password':'Show password');button.textContent=$('password').type==='password'?'Show':'Hide';break;
  case 'help':showHelp();break;
  case 'close-dialog':pendingImport=null;$('detail-dialog').close();break;
  case 'metric-goals':$('detail-dialog').close();setView('goals');break;
  case 'export':exportCalls();break;
  case 'backup':await backup();break;
  case 'import':$('backup-input').click();break;
  case 'confirm-import':{if(!pendingImport)return;let result;if(await mutate(async()=>{result=await repo.importBackup(pendingImport);})){pendingImport=null;$('detail-dialog').close();showToast(`${result.imported} call${result.imported===1?'':'s'} restored · ${result.skipped} unchanged`);}break;}
  case 'all-history':allHistory=!allHistory;page=0;renderCallLog();break;
  case 'today':selectedDay=dayKey();allHistory=false;page=0;renderDashboard();break;
  case 'previous-page':page=Math.max(0,page-1);renderCallLog();break;
  case 'next-page':page++;renderCallLog();break;
 }
}
/** Keep keyboard navigation inside the mobile sheet and provide the N shortcut. */
function onKeydown(event){if(!sessionUser)return;if(document.body.classList.contains('entry-open')&&!$('detail-dialog').open){if(event.key==='Escape'){event.preventDefault();closeEntry();return;}if(event.key==='Tab'){const nodes=[...$('entry-panel').querySelectorAll('button,input')].filter(e=>!e.disabled&&e.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&(document.activeElement===first||!$('entry-panel').contains(document.activeElement))){event.preventDefault();last?.focus();}else if(!event.shiftKey&&(document.activeElement===last||!$('entry-panel').contains(document.activeElement))){event.preventDefault();first?.focus();}}}
 if(event.key.toLowerCase()==='n'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!$('detail-dialog').open&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)){event.preventDefault();openEntry();}}
/** Advance today's view at Eastern midnight, retaining explicitly selected historical days. */
function refreshDay(){const day=dayKey();if(previousDay!==day){if(selectedDay===previousDay)selectedDay=day;previousDay=day;renderDashboard();}}
/** Render dates from the report's day string without browser timezone shifts. */
function renderDate(){$('report-date').value=selectedDay;$('report-date').max=dayKey();$('today-date').textContent=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(new Date(selectedDay+'T12:00:00Z'));$('goals-day-label').textContent=selectedDay===dayKey()?'Today’s goals':'Daily goals';}
/** Refresh cloud data without replacing a call being edited. */
async function syncFromStorage(){
 if(!sessionUser||busy||syncing)return;syncing=true;const epoch=sessionEpoch;
 try{const fresh=await repo.read();if(epoch!==sessionEpoch||busy)return;state=fresh;ready=true;renderDashboard();if(view!=='goals'||!document.activeElement?.closest('#goal-settings'))renderGoals();setBusy(false);$('storage-banner').hidden=true;$('storage-status').textContent='Saved to your account';}
 catch(e){if(epoch===sessionEpoch&&!busy&&e.code!=='AUTH')storageError(e.message||'Could not refresh your records.');}finally{syncing=false;}
}
function authMessage(message){$('auth-error').textContent=message;$('auth-error').hidden=!message;}
function setAuthBusy(value){authBusy=value;$('auth-form').querySelectorAll('input,button').forEach(el=>el.disabled=value);$('auth-mode-toggle').disabled=value;$('auth-submit').textContent=value?'Please wait…':authMode==='signup'?'Create account':'Sign in';}
function renderAuth(){const signup=authMode==='signup';$('auth-title').textContent=signup?'Create your account':'Welcome back';$('auth-description').textContent=signup?'Choose a username and password. That’s it.':'Your calls and goals, across devices.';$('auth-submit').textContent=signup?'Create account':'Sign in';$('auth-mode-toggle').textContent=signup?'Already have an account? Sign in':'Create an account';$('password').autocomplete=signup?'new-password':'current-password';authMessage('');}
/** Clear one account's data before displaying another account or the sign-in form. */
function showSignIn(message=''){
 sessionEpoch++;sessionRequest++;sessionUser=null;authMode='login';ready=false;repo?.close();repo=null;busy=false;pendingImport=null;state={version:3,calls:[],goals:{...DEFAULT_GOALS}};editing=null;closeEntry();$('detail-dialog').close();clearEntry();renderDashboard();renderGoals();$('workspace-view').hidden=true;$('auth-view').hidden=false;$('toast').hidden=true;clearTimeout(toastTimer);$('password').value='';$('password').type='password';const visibility=document.querySelector('[data-action="toggle-password"]');visibility.textContent='Show';visibility.setAttribute('aria-pressed','false');visibility.setAttribute('aria-label','Show password');$('auth-status').textContent='';renderAuth();setAuthBusy(false);authMessage(message);
}
async function enterWorkspace(user){
 sessionEpoch++;const epoch=sessionEpoch;sessionUser=user;repo=await openStore(user.id);$('session-username').textContent=user.username;$('auth-view').hidden=true;$('workspace-view').hidden=false;$('auth-status').textContent='';ready=false;$('storage-status').textContent='Loading your records…';
 try{const fresh=await repo.read();if(epoch!==sessionEpoch)return;state=fresh;ready=true;$('storage-banner').hidden=true;$('storage-status').textContent='Saved to your account';renderDashboard();renderGoals();renderEntry();setBusy(false);}
 catch(e){if(epoch===sessionEpoch&&e.code!=='AUTH'){storageError(e.message||'Could not load your records.');setBusy(false);}}
}
async function submitAuth(event){event.preventDefault();if(authBusy)return;authenticating=true;sessionRequest++;authMessage('');setAuthBusy(true);try{const result=await apiRequest(authMode,{username:$('username').value,password:$('password').value});$('password').value='';await enterWorkspace(result.user);channel?.postMessage({sessionChanged:true});}catch(e){authMessage(e.message||'Could not sign in. Please try again.');}finally{authenticating=false;setAuthBusy(false);}}
async function signOut(){if(busy)return;if(draft.before.length||draft.mobileOrders.length||$('ucid').value||$('account').value){showDialog('Sign out?',`<p>You have an unfinished call. Signing out discards this entry.</p><div class="dialog-actions"><button class="button secondary" data-action="close-dialog">Keep editing</button><button class="button primary" data-action="confirm-sign-out">Sign out</button></div>`);return;}await finishSignOut();}
async function finishSignOut(){authenticating=true;sessionRequest++;try{await apiRequest('logout',{});showSignIn();channel?.postMessage({sessionChanged:true});}catch(e){storageError(e.message||'Could not sign out. Try again.');}finally{authenticating=false;}}
async function checkSession(){if(authenticating)return;const epoch=sessionEpoch,request=++sessionRequest;try{const {user}=await apiRequest();if(epoch!==sessionEpoch||request!==sessionRequest)return;if(user){if(!sessionUser||user.id!==sessionUser.id){showSignIn();await enterWorkspace(user);}else await syncFromStorage();}else if(sessionUser)showSignIn('Your session ended. Sign in again.');else{$('auth-status').textContent='';setAuthBusy(false);}}catch(e){if(epoch!==sessionEpoch||request!==sessionRequest)return;if(!sessionUser){$('auth-status').textContent='';authMessage(e.message);setAuthBusy(false);}else storageError(e.message);}}
async function initialize(){renderDashboard();renderEntry();renderGoals();setView(location.hash.slice(1),false);renderAuth();setAuthBusy(true);await checkSession();}

document.querySelectorAll('[data-icon]').forEach(el=>el.innerHTML=icon(el.dataset.icon));
document.addEventListener('click',event=>{onClick(event).catch(e=>storageError(e.message||'The action could not be completed.'));});
document.addEventListener('keydown',onKeydown);
$('call-form').addEventListener('submit',saveCall);
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
window.addEventListener('beforeunload',event=>{if(sessionUser&&(draft.before.length||draft.mobileOrders.length||$('ucid').value||$('account').value)){event.preventDefault();event.returnValue='';}});
setInterval(()=>{refreshDay();if(document.visibilityState==='visible')syncFromStorage();},30000);
initialize();
