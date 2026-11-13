import { SERVICES } from './model.js';
import { validateDayTotals } from './tally-validation.js';

const fields = [
  ['calls', 'Total calls'], ['eligibleCalls', 'Calls eligible for overall save rate'],
  ['savedCalls', 'Calls with an overall save'], ['saleCalls', 'Calls with mobile sales'],
  ['mobileOrders', 'Mobile orders'], ['mobileLines', 'Mobiles sold']
];
const numberInput = (name, value, min = 0) => '<input type="number" required min="' + min + '" step="1" name="' + name + '" value="' + value + '">';
const serviceFields = (name, selected, index) => '<fieldset><legend>' + name + '</legend>' +
  SERVICES.map(service => '<label><input type="checkbox" data-services="' + name + '" data-group="' + index +
    '" value="' + service.key + '"' + (selected.includes(service.key) ? ' checked' : '') + '> ' + service.short + '</label>').join('') + '</fieldset>';

export function outcomeEditor(group,index) {
  return '<section class="history-edit-group" data-edit-group="' + index + '"><strong>Outcome group ' + (index + 1) + '</strong>' +
      serviceFields('Starting services',group.before,index) + serviceFields('Kept',group.kept,index) +
      serviceFields('Added',group.added,index) + '<label>Accounts ' + numberInput('count-' + index,group.count) +
      '</label><label><input type="checkbox" name="washed-' + index + '"' + (group.washed ? ' checked' : '') +
      '> Wash</label><small>Set accounts to 0 to remove this outcome group.</small></section>';
}

export function historyEditor(day) {
  return '<form id="history-edit-form"><p>Correct the grouped outcomes for ' + day.day +
    '. Review the call and sales totals before saving.</p><div class="history-edit-totals">' +
    fields.map(([key,label]) => '<label>' + label + numberInput(key, day[key], key === 'calls' ? 1 : 0) + '</label>').join('') +
    '</div><div id="history-edit-groups">' + day.groups.map(outcomeEditor).join('') +
    '</div><button type="button" class="button secondary" id="add-history-group">Add outcome group</button><p id="history-edit-error" role="alert" hidden></p><div class="dialog-actions">' +
    '<button type="button" class="button secondary" data-action="close-dialog">Cancel</button>' +
    '<button type="submit" class="button primary">Save changes</button></div></form>';
}

export function readHistoryEditor(form, day) {
  const data = new FormData(form);
  const groups = new Map();
  for (const section of form.querySelectorAll('[data-edit-group]')) {
    const index = section.dataset.editGroup;
    const count = Number(data.get('count-' + index));
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Account counts must be whole numbers.');
    if (!count) continue;
    const services = name => Array.from(section.querySelectorAll('[data-services="' + name + '"]:checked'), input => input.value);
    const group = {before:services('Starting services'),kept:services('Kept'),added:services('Added'),washed:data.has('washed-' + index)};
    const key = JSON.stringify(group);
    if (groups.has(key)) groups.get(key).count += count;
    else groups.set(key,{...group,count});
  }
  return validateDayTotals({day,...Object.fromEntries(fields.map(([key]) => [key,Number(data.get(key))])),groups:[...groups.values()]});
}
