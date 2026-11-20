import { signupRules } from './signup-rules.js';
import { confirmDelete, closeDeleteConfirmation } from './confirm-delete.js';

const $ = id => document.getElementById(id);
const roles = {agent:'Agent', supervisor:'Supervisor', admin:'Admin'};
const pageSize = 12;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function actionButton(label, className, onClick, name) {
  const button = element('button',label,className);
  button.type = 'button';
  if (name) button.setAttribute('aria-label',label+' '+name);
  button.addEventListener('click',onClick);
  return button;
}

function identity(username, detail) {
  const wrapper = element('div',undefined,'account-identity');
  const avatar = element('span',Array.from(username)[0]?.toUpperCase(),'account-avatar');
  avatar.setAttribute('aria-hidden','true');
  const labels = element('span',undefined,'account-name');
  labels.append(element('strong',username));
  if (detail) labels.append(element('small',detail));
  wrapper.append(avatar, labels);
  return wrapper;
}

function formError(form, message = '') {
  const output = form.querySelector('.account-form-error');
  output.textContent = message;
  output.hidden = !message;
}

function teamOptions(select, supervisors, selected) {
  select.replaceChildren(new Option('Unassigned',''),...supervisors.map(person => new Option(person.teamName ? person.teamName+' · '+person.username : person.username,person.id)));
  select.value = selected || '';
  if (select.selectedIndex === -1) select.value = '';
}

function teamVisibility(form) {
  form.querySelector('.team-assignment').hidden = form.elements.role.value === 'supervisor';
}

function assignment(form) {
  return {
    role:form.elements.role.value,
    supervisorId:form.elements.role.value === 'supervisor' ? null : form.elements.supervisorId.value || null
  };
}

export function createAccountManagement(request, actorId) {
  const createForm = $('admin-create-form'), dialog = $('account-dialog'), editForm = $('account-dialog-form');
  const status = $('accounts-status'), statusError = $('accounts-error'), finder = $('directory-query');
  const search = $('request-search'), typeFilter = $('request-type'), codeDialog = $('password-code-dialog');
  const codeValue = $('password-code-value'), codeFeedback = $('password-code-feedback');
  let roster = null, supervisors = [], page = 0, generation = 0, busy = false, editing = null;
  let handoffVersion = 0, expiryTimer;

  function setBusy(value) {
    busy = value;
    $('create-controls').disabled = value || !roster;
    $('accounts-refresh').disabled = value;
    editForm.querySelector('fieldset').disabled = value;
    $('account-dialog-close').disabled = value;
    document.querySelectorAll('#signup-requests fieldset, #account-directory button').forEach(control => control.disabled = value);
  }

  function clearCode() {
    window.clearTimeout(expiryTimer);
    codeValue.value = '';
    $('password-code-guide').textContent = codeFeedback.textContent = '';
    if (codeDialog.open) codeDialog.close();
  }

  function leave() {
    // Invalidate delayed approval responses even if the admin returns to this tab.
    handoffVersion++;
    clearCode();
    if (editing && dialog.open) {
      closeDeleteConfirmation();
      dialog.close();
    }
  }

  function dismissCode() {
    clearCode();
    if (!$('view-admin').hidden && !$('admin-accounts').hidden) search.focus();
  }

  function approvePassword(person) {
    const actor = actorId(), version = handoffVersion;
    mutate('adminReviewPasswordChange',{requestId:person.id,decision:'approve'},'Password change approved for '+person.username+'.',null,result => {
      if (actorId() !== actor || handoffVersion !== version || $('view-admin').hidden || $('admin-accounts').hidden) return;
      clearCode();
      if (result?.ok !== true || typeof result.code !== 'string' || !result.code.trim()) throw new Error('The approval did not return a code.');
      $('password-code-guide').textContent = 'Verify the identity of '+person.username+', then share this code with them privately. You can view it here once.';
      codeValue.value = result.code;
      codeDialog.showModal();
      $('password-code-copy').focus();
      expiryTimer = window.setTimeout(dismissCode,30 * 60 * 1000);
    });
  }

  function requestRow(type,person) {
    const signup = type === 'signup', typeName = signup ? 'Sign-up' : 'Password change';
    const form = element('form',undefined,'request-form');
    form.dataset.type = type;
    form.dataset.username = person.username.toLowerCase();
    const row = element('fieldset',undefined,'request-row');
    form.append(row);
    row.setAttribute('aria-label',typeName+' request from '+person.username);
    const who = identity(person.username,signup ? 'Requested '+roles[person.requestedRole] : null);
    who.querySelector('.account-name').append(element('span',typeName,'request-type-tag'));
    row.append(who);
    if (signup) {
      const roleLabel = element('label','Role'), role = document.createElement('select');
      role.name = 'role';
      for (const key of ['agent','supervisor']) role.add(new Option(roles[key],key));
      role.value = person.requestedRole;
      roleLabel.append(role);
      const teamLabel = element('label','Supervisor','team-assignment'), team = document.createElement('select');
      team.name = 'supervisorId';
      teamOptions(team,supervisors,null);
      teamLabel.append(team);
      const selections = element('div',undefined,'request-selects');
      selections.append(roleLabel,teamLabel);
      row.append(selections);
      role.addEventListener('change',() => teamVisibility(form));
      teamVisibility(form);
    }
    const actions = element('div',undefined,'request-actions'), approve = element('button','Approve','button primary');
    const target = signup ? person.username : 'password change for '+person.username;
    approve.type = 'submit';
    approve.setAttribute('aria-label','Approve '+target);
    actions.append(approve,actionButton('Deny','text-button',() => openEditor(signup ? 'deny' : 'deny-password',person),target));
    row.append(actions);
    form.addEventListener('submit',event => {
      event.preventDefault();
      if (signup) mutate('adminReviewSignup',{requestId:person.id,decision:'approve',...assignment(form)},person.username+' approved.');
      else approvePassword(person);
    });
    return form;
  }

  function filterRequests() {
    if (!roster) return;
    const query = search.value.trim().toLowerCase(), type = typeFilter.value;
    const rows = $('signup-requests').children;
    let visible = 0;
    for (const row of rows) {
      const matchesType = type === 'all' || row.dataset.type === type;
      row.hidden = !matchesType || !row.dataset.username.includes(query);
      if (!row.hidden) visible++;
    }
    $('request-count').textContent = visible === rows.length ? String(visible) : visible+' of '+rows.length;
    $('requests-empty').textContent = visible ? '' : rows.length ? 'No requests match these filters.' : 'No pending requests.';
  }

  function renderRequests() {
    const requests = [...roster.pending.map(person => ({type:'signup',person})),
      ...(roster.passwordChanges || []).map(person => ({type:'password',person}))];
    requests.sort((a,b) => (a.person.requestedAt || '').localeCompare(b.person.requestedAt || ''));
    $('signup-requests').replaceChildren(...requests.map(({type,person}) => requestRow(type,person)));
    $('request-count').hidden = false;
    filterRequests();
  }

  function renderDirectory() {
    if (!roster) return;
    const query = finder.value.trim().toLowerCase();
    const matching = roster.accounts.filter(({username}) => username.toLowerCase().includes(query));
    const pages = Math.ceil(matching.length/pageSize);
    page = Math.min(page,Math.max(0,pages-1));
    const items = matching.slice(page*pageSize,(page+1)*pageSize).map(person => {
      const row = element('div',undefined,'account-directory-row');
      const tag = element('span',roles[person.role],'account-role');
      const supervisor = supervisors.find(s => s.id === person.supervisorId);
      const team = person.role === 'supervisor' ? (supervisors.find(s => s.id === person.id)?.teamName || 'No named team')
        : supervisor ? (supervisor.teamName || supervisor.username+'’s team') : 'Unassigned';
      const button = actionButton('Edit','button secondary',() => openEditor('edit',person),person.username);
      button.disabled = busy;
      row.append(identity(person.username,person.id === actorId() ? 'Your account' : null),tag,element('span',team,'account-team'),button);
      return row;
    });
    $('directory-count').hidden = false;
    $('directory-count').textContent = roster.accounts.length;
    $('account-directory').replaceChildren(...(items.length ? items : [element('p','No matching accounts.','accounts-empty')]));
    $('directory-pages').hidden = pages < 2;
    $('directory-page').textContent = (page+1)+' of '+pages;
    $('directory-prev').disabled = page === 0;
    $('directory-next').disabled = page+1 >= pages;
  }

  async function fetchRoster(version) {
    const data = await request('adminAccounts');
    if (version !== generation) return;
    roster = data;
    const teamNames = new Map((data.teams || []).map(team => [team.supervisorId,team.name]));
    supervisors = data.accounts.filter(account => account.role === 'supervisor').map(account => ({...account,teamName:teamNames.get(account.id)}));
    teamOptions(createForm.elements.supervisorId,supervisors,createForm.elements.supervisorId.value);
    teamVisibility(createForm);
    renderRequests(); renderDirectory();
  }

  async function refresh() {
    if (busy || !actorId()) return;
    const version = generation;
    status.textContent = 'Loading accounts…';
    statusError.textContent = '';
    setBusy(true);
    try {
      await fetchRoster(version);
      if (version === generation) status.textContent = '';
    } catch (error) {
      if (version === generation) {
        if (error.code === 'FORBIDDEN') reset();
        status.textContent = '';
        statusError.textContent = error.message || 'Could not load accounts. Refresh to try again.';
      }
    } finally {
      if (version === generation) setBusy(false);
    }
  }

  async function mutate(action, payload, message, form, onSuccess) {
    if (busy || !roster || !actorId()) return;
    const version = generation;
    setBusy(true);
    if (form) formError(form);
    status.textContent = statusError.textContent = '';
    try {
      const result = await request(action,payload);
      if (version !== generation) return;
      onSuccess?.(result);
      status.textContent = message;
      try {
        await fetchRoster(version);
      } catch (error) {
        if (version === generation) {
          if (error.code === 'FORBIDDEN') reset();
          else resetDirectory();
          status.textContent = message;
          statusError.textContent = error.code === 'FORBIDDEN' ? error.message : 'The updated directory could not be loaded. Refresh Accounts to see the latest list.';
          if (!codeDialog.open) $('accounts-refresh').focus();
        }
      }
    } catch (error) {
      if (version !== generation) return;
      const message = error.message || 'Could not save this change. Refresh to see the current accounts.';
      if (error.code === 'FORBIDDEN') { reset(); statusError.textContent = message; }
      else if (action === 'adminReviewPasswordChange' && payload.decision === 'approve') {
        statusError.textContent = 'No code was received. Refresh Requests to check the outcome. If the request has left the list, ask the account holder to request a new password change.';
      }
      else if (form) formError(form,message);
      else statusError.textContent = message;
    } finally {
      if (version === generation) setBusy(false);
    }
  }

  function openEditor(mode, person) {
    if (busy || !roster || !actorId()) return;
    formError(editForm);
    const denyPassword = mode === 'deny-password', deny = mode === 'deny' || denyPassword, self = actorId() === person.id;
    const ownedTeam = person.ownedTeamName;
    const memberIds = deny ? [] : roster.accounts.filter(account => account.supervisorId === person.id).map(account => account.id);
    const deletable = !deny && !self && ['agent','supervisor'].includes(person.role);
    const activeTeam = !!ownedTeam && roster.teams?.some(team => team.supervisorId === person.id);
    editing = {mode,person,ownedTeam,memberIds,deletable};
    $('account-delete').hidden = !deletable;
    $('account-team-block').hidden = !deletable || !ownedTeam;
    $('account-manage-teams').hidden = !activeTeam;
    const teamHint = $('account-team-block-message');
    teamHint.textContent = '';
    if (deletable && ownedTeam) {
      teamHint.textContent = activeTeam
        ? 'To keep '+ownedTeam+', assign a different supervisor before deleting this account.'
        : 'This account owns the inactive team '+ownedTeam+'. To keep it, restore the Supervisor role and reassign the team in Teams.';
    }
    $('account-dialog-title').textContent = (denyPassword ? 'Deny password change for ' : deny ? 'Deny request from ' : 'Edit ')+person.username;
    $('account-edit-fields').hidden = deny;
    $('account-dialog-detail').textContent = denyPassword ? 'This closes the request. Their current password will keep working.' : deny
      ? 'This removes the sign-up request. They can submit a new request later.'
      : self ? 'Your own admin role is locked. You can still choose your supervisor.' : '';
    $('account-dialog-submit').textContent = deny ? 'Deny request' : 'Save changes';
    if (!deny) {
      const hasTeam = person.role === 'supervisor' && memberIds.length > 0;
      editForm.elements.role.value = person.role;
      editForm.elements.role.disabled = self || hasTeam;
      if (hasTeam) $('account-dialog-detail').textContent = 'Reassign this supervisor’s team members before changing their role.';
      teamOptions(editForm.elements.supervisorId,supervisors.filter(s => s.id !== person.id),person.supervisorId);
      teamVisibility(editForm);
    }
    dialog.showModal();
    (deny ? $('account-dialog-cancel') : editForm.elements.role.disabled ? editForm.elements.supervisorId : editForm.elements.role).focus();
  }

  function reset() {
    leave();
    resetDirectory();
  }

  function resetDirectory() {
    generation++;
    if (editing) closeDeleteConfirmation();
    roster = null; supervisors = []; editing = null; page = 0;
    dialog.close(); editForm.reset(); createForm.reset();
    finder.value = search.value = '';
    typeFilter.value = 'all';
    formError(createForm); formError(editForm);
    for (const id of ['signup-requests','requests-empty','account-directory','request-count','directory-count','directory-page','account-dialog-detail','account-dialog-title']) $(id).replaceChildren();
    $('request-count').hidden = $('directory-count').hidden = $('directory-pages').hidden = true;
    $('account-delete').hidden = $('account-team-block').hidden = true;
    $('account-team-block-message').textContent = '';
    teamOptions(createForm.elements.supervisorId,[],null);
    editForm.elements.supervisorId.replaceChildren();
    teamVisibility(createForm);
    status.textContent = statusError.textContent = '';
    setBusy(false);
  }

  $('accounts-refresh').addEventListener('click',refresh);
  search.addEventListener('input',filterRequests);
  typeFilter.addEventListener('change',filterRequests);
  $('password-code-dismiss').addEventListener('click',dismissCode);
  codeDialog.addEventListener('keydown',event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dismissCode();
  });
  codeDialog.addEventListener('cancel',event => { event.preventDefault(); dismissCode(); });
  codeDialog.addEventListener('close',() => { if (!codeDialog.open) clearCode(); });
  $('password-code-copy').addEventListener('click',async () => {
    if (!codeDialog.open || !codeValue.value) return;
    const code = codeValue.value;
    try {
      await navigator.clipboard.writeText(code);
      if (codeValue.value === code) codeFeedback.textContent = 'Code copied.';
    } catch {
      if (codeValue.value !== code) return;
      codeValue.focus();
      codeValue.select();
      codeFeedback.textContent = 'Code selected. Use your device’s Copy command.';
    }
  });
  window.addEventListener('pagehide',leave);
  $('directory-prev').addEventListener('click',() => {page--;renderDirectory();});
  $('directory-next').addEventListener('click',() => {page++;renderDirectory();});
  finder.addEventListener('input',() => {page=0;renderDirectory();});
  createForm.addEventListener('change',() => teamVisibility(createForm));
  createForm.addEventListener('input',() => formError(createForm));
  createForm.addEventListener('submit',event => {
    event.preventDefault();
    const {username,password} = createForm.elements;
    const errors = signupRules(username.value,password.value);
    if (errors.username || errors.password) {
      formError(createForm,errors.username || errors.password);
      (errors.username ? username : password).focus();
      return;
    }
    const payload = {username:username.value.trim(),password:password.value,...assignment(createForm)};
    mutate('adminCreateAccount',payload,payload.username+' created.',createForm,() => {createForm.reset();teamVisibility(createForm);});
  });
  editForm.elements.role.addEventListener('change',() => teamVisibility(editForm));
  $('account-manage-teams').addEventListener('click',() => {
    dialog.close();
    $('admin-open-teams').click();
  });
  $('account-delete').addEventListener('click',async () => {
    const snapshot = editing, actor = actorId(), directory = roster;
    if (!snapshot?.deletable || !actor || busy) return;
    const {person,ownedTeam,memberIds} = snapshot;
    const hasTeamSnapshot = (person.ownedTeamId === null && ownedTeam === null) ||
      (typeof person.ownedTeamId === 'string' && typeof ownedTeam === 'string');
    if (!hasTeamSnapshot) {
      formError(editForm,'Update the database and refresh Accounts before deleting an account.');
      return;
    }
    let description = 'This permanently deletes '+person.username+'’s account, sign-in credentials, active sessions, call tallies, goals and game scores.';
    if (ownedTeam) description += ' It also deletes the team '+ownedTeam+' and its games and scores. Team members keep their accounts and tallies and become unassigned.';
    const confirmed = await confirmDelete({title:'Delete '+person.username+'?',description,action:'Delete account'});
    if (!confirmed || !dialog.open || editing !== snapshot || actorId() !== actor || roster !== directory || busy) return;
    // Use the saved assignment shown when the editor opened, independent of any draft form changes.
    const payload = {accountId:person.id,expectedUsername:person.username,expectedRole:person.role,
      expectedSupervisorId:person.supervisorId,expectedTeamId:person.ownedTeamId,
      expectedTeamName:ownedTeam,expectedMemberIds:memberIds};
    await mutate('adminDeleteAccount',payload,person.username+' deleted.',editForm,() => {
      dialog.close();
      finder.focus();
    });
  });
  editForm.addEventListener('submit',event => {
    event.preventDefault();
    if (!editing) return;
    const {mode,person} = editing;
    if (mode === 'deny-password') {
      mutate('adminReviewPasswordChange',{requestId:person.id,decision:'deny'},person.username+'’s password change request denied.',editForm,() => {
        dialog.close();
        search.focus();
      });
    } else if (mode === 'deny') {
      mutate('adminReviewSignup',{requestId:person.id,decision:'deny'},person.username+'’s request denied.',editForm,() => dialog.close());
    } else {
      mutate('adminAssignAccount',{accountId:person.id,...assignment(editForm),expectedRole:person.role,expectedSupervisorId:person.supervisorId},person.username+' updated.',editForm,() => dialog.close());
    }
  });
  $('account-dialog-close').addEventListener('click',() => dialog.close());
  $('account-dialog-cancel').addEventListener('click',() => dialog.close());
  dialog.addEventListener('cancel',event => {if (busy) event.preventDefault();});
  dialog.addEventListener('close',() => {
    if (dialog.open) return;
    if (editing) closeDeleteConfirmation();
    editing = null;
  });
  return {refresh,reset,leave};
}
