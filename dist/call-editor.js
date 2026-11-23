import { SERVICES, classifyAccount, dayKey } from './model.js';
import { originalTally, revisedTally, correctionChanges } from './call-correction.js';

const blankAccount = () => ({before:[], kept:[], added:[], count:1});
const plural = (n, unit) => n+' '+unit+(n === 1 ? '' : 's');
const buttons = (action, label, style = 'secondary') =>
  '<button type="button" class="button '+style+'" data-step="'+action+'">'+label+'</button>';
const toggle = (list, key) => list.includes(key) ? list.filter(k => k !== key) : [...list,key];
const numberField = (key,label,value,min,max) => '<label>'+label+'<input required type="number" step="1" min="'+min+
  '" max="'+max+'" name="'+key+'" value="'+value+'"></label>';

function description(group) {
  const outcome = classifyAccount(group);
  if (!outcome) return 'Choose starting services';
  return [group.washed && 'Wash', outcome.code,group.lineStart!==undefined && ('Mobile lines '+group.lineStart+' → '+group.lineEnd), ...SERVICES.flatMap(s =>
    outcome.kept.includes(s.key) ? [s.short+' kept'] : outcome.disconnected.includes(s.key) ? [s.short+' disconnected']
    : outcome.added.includes(s.key) ? [s.short+' added'] : [])].filter(Boolean).join(' · ');
}

function serviceButtons(keys, selected, action) {
  return keys.map(s => '<button type="button" data-service-action="'+action+'" value="'+s.key+
    '" aria-pressed="'+selected.includes(s.key)+'">'+s.short+'</button>').join('');
}

function balanceInputs(a,i) {
  return ['lineStart','lineEnd'].map((key,j) => '<label>'+['Starting lines','Ending lines'][j]+'<input type="number" min="'+(j ? 0 : 1)+'" max="999" name="'+key+i+'" value="'+(a[key] ?? '')+'" placeholder="Unknown"></label>').join('');
}
function accountCard(account, i, length) {
  const kept = SERVICES.filter(s => account.before.includes(s.key));
  const available = SERVICES.filter(s => !account.before.includes(s.key) && s.key !== 'mobile');
  return '<fieldset class="correction-account" data-account="'+i+'"><legend>Account '+(i+1)+'</legend>'+
    (length > 1 ? buttons('remove-account','Remove','text-button') : '')+
    '<span>Starting services</span><div class="correction-options">'+serviceButtons(SERVICES,account.before,'before')+'</div>'+
    kept.map(s => '<div class="correction-keep"><span>'+s.short+'</span><div class="correction-options">'+
      ['Kept','Disconnected'].map((label,j) => '<button type="button" data-service-action="'+(j ? 'lose' : 'keep')+
        '" value="'+s.key+'" aria-pressed="'+(account.kept.includes(s.key) === !j)+'">'+label+'</button>').join('')+
      '</div></div>').join('')+
    (available.length && kept.length ? '<span>Services added</span><div class="correction-options">'+serviceButtons(available,account.added,'added')+'</div>' : '')+
    (account.before.includes('mobile') ? balanceInputs(account,i) : '')+
    (account.count > 1 ? numberField('quantity-'+i,'Matching accounts',account.count,1,2147483647) : '')+
    '</fieldset>';
}

/** Edit one contribution to an agent's grouped log. A source snapshot never changes while the dialog is open. */
export function openCallEditor({source, days, groupIndex, showDialog, close, save, editDay}) {
  const singleAccounts = source.groups.reduce((sum,g) => sum + g.count,0) === source.calls;
  const singleMobileGroup = groupIndex === -1 && singleAccounts && source.groups.length === 1;
  const counts = source.groups.map((g,i) => source.calls === 1 ? g.count : Number(i === groupIndex || singleMobileGroup));
  const known = source.calls === 1 || (singleAccounts && groupIndex >= 0 && !source.mobileOrders) ||
    (singleMobileGroup && source.saleCalls === 1);
  let sale = source.mobileOrders === 0 ? 'no' : source.calls === 1 || groupIndex === -1 ||
    source.saleCalls === source.calls ? 'yes' : '';
  let orders = sale === 'yes' && source.saleCalls === 1 ? source.mobileOrders : '';
  let lines = sale === 'yes' && source.saleCalls === 1 ? source.mobileLines : '';
  let original, accounts, newOrders, newLines, destinationDay = source.day;
  let step = 'original', pending = null, writing = false;
  const token = crypto.randomUUID();
  showDialog('Edit call','<form id="correction-form"></form>');
  const form = document.getElementById('correction-form');

  function readOriginal() {
    const groups = source.groups.map((g,i) => ({...g,count:counts[i]})).filter(g => g.count);
    if (!groups.length) throw new Error('Select at least one original account outcome.');
    if (!sale) throw new Error('Choose whether this call included a mobile sale.');
    if (sale === 'yes' && !(orders > 0 && lines >= orders && lines <= orders * 12 && orders <= 20)) {
      throw new Error('Enter the original orders and lines. Each order contains 1–12 lines.');
    }
    const delta = originalTally(groups,sale === 'yes' ? Number(orders) : 0,sale === 'yes' ? Number(lines) : 0);
    try {
      correctionChanges({source,destination:null,destinationDay:source.day,original:delta,revised:null,requestId:token});
    } catch (error) {
      if (error.message.startsWith('Invalid grouped tally')) throw new Error('Check the original outcomes, including both sides of any wash, and the sales for this call.');
      throw error;
    }
    return delta;
  }

  function startRevision() {
    original = readOriginal();
    // Original wash partners get first priority when several matching accounts have different additions.
    accounts = [...original.groups].sort((a,b) => Number(b.washed)-Number(a.washed)).map(g => structuredClone(g));
    newOrders = original.mobileOrders;
    newLines = original.mobileLines;
    step = 'revise';
  }

  function originalForm() {
    return '<p>Choose the accounts and sales that belonged to one call on '+source.day+
      '. The log groups matching outcomes for the day.</p><fieldset class="correction-source"><legend>Original accounts</legend>'+
      source.groups.map((g,i) => numberField('original-'+i,description(g)+' <small>('+g.count+' logged)</small>',counts[i],0,g.count)).join('')+
      '</fieldset>'+(source.mobileOrders ? '<fieldset><legend>Did this call include mobile sales?</legend><div class="correction-options">'+
        ['no','yes'].map(value => '<button type="button" data-sale="'+value+'" aria-pressed="'+(sale === value)+'">'+(value === 'yes' ? 'Yes' : 'No')+'</button>').join('')+
        '</div>'+(sale === 'yes' ? '<div class="correction-numbers">'+numberField('orders','Original orders',orders,1,Math.min(20,source.mobileOrders))+
          numberField('lines','Original lines',lines,1,Math.min(240,source.mobileLines))+'</div>' : '')+'</fieldset>' : '')+
      '<div class="dialog-actions">'+buttons('day','Edit day totals','text-button')+
      '<button class="button primary" type="submit">Continue</button></div>';
  }

  function revisedForm() {
    const mobileAccounts = accounts.map((a,i) => a.before.length && !a.before.includes('mobile') ?
      '<label class="mobile-credit"><input type="checkbox" data-mobile-account="'+i+'" '+(a.added.includes('mobile') ? 'checked' : '')+
      '> Added Mobile service on account '+(i+1)+'</label>' : '').filter(Boolean);
    return '<p>Update one call. Its tags and save rates recalculate when you save.</p>'+
      '<label>Report date<input type="date" name="day" required max="'+dayKey()+'" value="'+destinationDay+'"></label>'+
      accounts.map((a,i) => accountCard(a,i,accounts.length)).join('')+buttons('add-account','Add another account')+
      '<fieldset><legend>Mobile sales</legend><div class="correction-numbers">'+numberField('orders','Orders',newOrders,0,20)+
      numberField('lines','Lines sold',newLines,0,240)+'</div>'+mobileAccounts.join('')+'</fieldset>'+
      '<div class="correction-links">'+(known ? '' : buttons('back','Original call','text-button'))+buttons('day','Edit day totals','text-button')+
      buttons('delete','Remove call','text-button danger')+'</div><div class="dialog-actions">'+buttons('close','Cancel')+
      '<button type="submit" class="button primary">Save changes</button></div>';
  }

  function render() {
    let body;
    if (step === 'original') body = originalForm();
    else if (step === 'delete') body = '<p>Remove one call from '+source.day+'?</p><ul>'+
      original.groups.map(g => '<li>'+plural(g.count,'account')+' · '+description(g)+'</li>').join('')+
      '</ul><p>'+plural(original.mobileOrders,'mobile order')+' · '+plural(original.mobileLines,'line')+
      '</p><div class="dialog-actions">'+buttons('revise','Keep call')+
      '<button type="submit" class="button danger-primary">Remove call</button></div>';
    else body = revisedForm();
    form.innerHTML = body+'<p class="form-error" role="alert" hidden></p>';
  }

  function message(text) {
    const error = form.querySelector('[role="alert"]');
    error.textContent = text; error.hidden = false;
  }

  function collect() {
    const data = new FormData(form);
    if (step === 'original') {
      counts.forEach((_,i) => { counts[i] = Number(data.get('original-'+i)); });
      if (data.has('orders')) { orders = data.get('orders'); lines = data.get('lines'); }
    } else if (step === 'revise') {
      destinationDay = data.get('day');
      newOrders = Number(data.get('orders'));
      newLines = Number(data.get('lines'));
      accounts.forEach((a,i) => { if (a.before.includes('mobile') && data.get('lineStart'+i) !== '' && data.get('lineStart'+i) !== null) {
        a.lineStart = Number(data.get('lineStart'+i)); a.lineEnd = data.get('lineEnd'+i) === '' ? a.lineStart : Number(data.get('lineEnd'+i));
        a.kept = a.kept.filter(k => k !== 'mobile'); if (a.lineEnd) a.kept.push('mobile');
      } else { delete a.lineStart; delete a.lineEnd; }
      if (data.has('quantity-'+i)) a.count = Number(data.get('quantity-'+i)); });
    }
  }

  form.addEventListener('click',event => {
    const button = event.target.closest('button');
    if (!button || button.type === 'submit' || writing || pending) return;
    collect();
    const action = button.dataset.step;
    const service = button.dataset.serviceAction, key = button.value;
    const index = Number(button.closest('[data-account]')?.dataset.account);
    if (action === 'close') return close();
    if (action === 'day') return editDay();
    if (service) {
      const account = accounts[index];
      if (service === 'before') {
        account.before = toggle(account.before,key);
        if (key === 'mobile') { delete account.lineStart; delete account.lineEnd; }
        account.kept = account.kept.filter(s => s !== key);
        if (account.before.includes(key)) account.kept.push(key);
        account.added = account.added.filter(s => s !== key);
      } else if (service === 'added') account.added = toggle(account.added,key);
      else {
        account.kept = account.kept.filter(s => s !== key);
        if (service === 'keep') account.kept.push(key);
        if (key === 'mobile' && account.lineStart) account.lineEnd = service === 'keep' ? account.lineStart : 0;
      }
    } else if (button.dataset.sale) {
      sale = button.dataset.sale;
      if (sale === 'yes' && source.saleCalls === 1) { orders = source.mobileOrders; lines = source.mobileLines; }
    } else if (action === 'back') step = 'original';
    else if (action === 'delete' || action === 'revise') step = action;
    else if (action === 'add-account') accounts.push(blankAccount());
    else if (action === 'remove-account') accounts.splice(index,1);
    else return;
    render();
    if (service) form.querySelector('[data-account="'+index+'"] [data-service-action="'+service+'"][value="'+key+'"]')?.focus();
    else if (action === 'add-account') form.querySelector('[data-account="'+(accounts.length-1)+'"] button[data-service-action]')?.focus();
    else if (button.dataset.sale) form.querySelector('[data-sale="'+sale+'"]')?.focus();
    else form.querySelector('button,input')?.focus();
  });

  form.addEventListener('change',event => {
    if (event.target.matches('[data-mobile-account]')) {
      const account = accounts[Number(event.target.dataset.mobileAccount)];
      account.added = account.added.filter(key => key !== 'mobile');
      if (event.target.checked) account.added.push('mobile');
    }
    if (step === 'revise' && event.target.name === 'orders') {
      const previous = newOrders;
      newOrders = Number(event.target.value);
      const lineField = form.elements.namedItem('lines');
      if (newOrders === 0) {
        lineField.value = 0;
        for (const checkbox of form.querySelectorAll('[data-mobile-account]')) {
          checkbox.checked = false;
          const account = accounts[Number(checkbox.dataset.mobileAccount)];
          account.added = account.added.filter(key => key !== 'mobile');
        }
      } else {
        const checkbox = form.querySelector('[data-mobile-account]');
        if (previous === 0 && accounts.length === 1 && checkbox) {
          checkbox.checked = true;
          if (!accounts[0].added.includes('mobile')) accounts[0].added.push('mobile');
        }
      }
    }
  });

  form.addEventListener('submit',async event => {
    event.preventDefault();
    if (writing) return;
    try {
      if (!pending) {
        collect();
        if (step === 'original') { startRevision(); render(); form.querySelector('[name="day"]').focus(); return; }
        const removing = step === 'delete';
        if (!removing && (newLines < newOrders || newLines > newOrders*12)) throw new Error('Enter 1–12 lines per mobile order, or zero lines for zero orders.');
        const day = removing ? source.day : destinationDay;
        const request = {source, original, revised:removing ? null : revisedTally(accounts,newOrders,newLines),
          requestId:token,destinationDay:day,destination:day === source.day ? null : days.find(d => d.day === day) ?? null};
        correctionChanges(request);
        pending = request;
      }
      writing = true;
      for (const control of form.elements) control.disabled = true;
      await save(pending);
    } catch(error) {
      if (!form.isConnected) return;
      if (pending && ['NETWORK','STORAGE'].includes(error.code)) {
        const retry = form.querySelector('[type="submit"]');
        retry.disabled = false;
        retry.textContent = 'Retry correction';
      } else if (pending && error.code === 'CONFLICT') {
        form.innerHTML = '<p>Another change affected this date. Close the editor and reopen the call from the updated log.</p>'+buttons('close','Close');
        pending = null;
        return;
      } else {
        pending = null;
        for (const control of form.elements) control.disabled = false;
      }
      message(error.message || 'Could not confirm the correction.');
    } finally { writing = false; }
  });
  if (known) { try { startRevision(); } catch { /* Inconsistent legacy totals can still be corrected with Edit day totals. */ } }
  render();
}
