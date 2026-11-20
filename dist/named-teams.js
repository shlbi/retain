const $ = id => document.getElementById(id);
const make = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Bind each edit to the team and membership snapshot the admin actually reviewed. */
export function createNamedTeams(request, actorId) {
  const picker = $('managed-team'), nameForm = $('team-name-form'), memberForm = $('team-member-form');
  const status = $('teams-status'), search = $('team-members-search');
  const checked = new Set();
  const batchSize = 50;
  let directory, teamId = '', editingName = null, version = 0, busy = false, visibleLimit = batchSize;
  const current = () => directory?.teams.find(team => team.supervisorId === teamId);
  const username = id => directory?.accounts.find(person => person.id === id)?.username ?? '';
  const freeSupervisors = () => directory.accounts.filter(person =>
    person.role === 'supervisor' && !directory.teams.some(team => team.supervisorId === person.id));
  const candidates = () => directory.accounts.filter(person => person.role !== 'supervisor' && person.supervisorId !== teamId);

  function setBusy(value) {
    busy = value;
    $('teams-refresh').disabled = value;
    $('teams-create').disabled = value || !directory || !freeSupervisors().length;
    picker.disabled = value;
    $('teams-rename').disabled = $('teams-add').disabled = value;
    nameForm.querySelector('fieldset').disabled = memberForm.querySelector('fieldset').disabled = value;
  }

  function closeForms() {
    editingName = null;
    nameForm.hidden = memberForm.hidden = true;
    nameForm.reset(); search.value = ''; checked.clear(); visibleLimit = batchSize;
    $('available-members').replaceChildren();
    $('team-name-error').textContent = $('team-member-error').textContent = '';
    nameForm.elements.teamName.removeAttribute('aria-invalid');
    $('teams-add').setAttribute('aria-expanded','false');
  }

  function render() {
    closeForms();
    const teams = directory.teams;
    if (!current()) teamId = teams[0]?.supervisorId || '';
    const team = current();
    $('teams-count').hidden = false;
    $('teams-count').textContent = teams.length;
    const canCreate = freeSupervisors().length > 0;
    $('teams-empty').hidden = !!team && canCreate;
    $('teams-empty').textContent = canCreate ? 'Choose a name and supervisor to create a team. Then select the agents to assign.'
      : 'To create another team, assign the Supervisor role to an available account.';
    if (!team && !canCreate) $('teams-empty').textContent = 'Assign the Supervisor role to an account, then create your first team.';
    $('teams-go-accounts').hidden = canCreate;
    $('team-detail').hidden = !team;
    picker.replaceChildren(...teams.map(t => new Option(t.name,t.supervisorId)));
    if (!team) return;
    picker.value = teamId;
    $('managed-team-title').textContent = team.name;
    $('managed-team-supervisor').textContent = 'Supervisor · ' + username(teamId);
    const members = directory.accounts.filter(person => person.supervisorId === teamId);
    $('members-count').textContent = members.length;
    $('team-no-members').hidden = members.length > 0;
    $('managed-roster').replaceChildren(...members.map(person => {
      const item = make('li'), role = make('span',person.role === 'admin' ? 'Admin' : 'Agent');
      item.append(make('strong',person.username),role);
      return item;
    }));
  }

  function reset() {
    version++; directory = null; teamId = '';
    closeForms(); status.textContent = ''; $('teams-error').textContent = '';
    for (const id of ['managed-team','managed-team-title','managed-team-supervisor','managed-roster','members-count','teams-count']) $(id).replaceChildren();
    nameForm.elements.supervisorId.replaceChildren();
    for (const id of ['teams-count','teams-empty','teams-go-accounts','team-detail']) $(id).hidden = true;
    setBusy(false);
  }

  async function load(epoch) {
    const result = await request('adminAccounts');
    if (version !== epoch) return;
    if (!Array.isArray(result?.teams)) {
      const error = new Error('Team management needs the named teams database update. Apply the update in Supabase, then refresh Teams.');
      error.code = 'TEAM_SETUP';
      throw error;
    }
    directory = result;
    render();
  }

  async function refresh() {
    if (busy || !actorId()) return;
    const epoch = version;
    status.textContent = 'Loading teams…';
    $('teams-error').textContent = '';
    setBusy(true);
    try {
      await load(epoch);
      if (version === epoch) status.textContent = '';
    } catch (error) {
      if (version !== epoch) return;
      if (error.code === 'FORBIDDEN' || error.code === 'TEAM_SETUP') reset();
      status.textContent = '';
      $('teams-error').textContent = error.message || 'Could not load teams. Refresh to try again.';
    } finally { if (version === epoch) setBusy(false); }
  }

  async function save(action, payload, message, nextId) {
    if (busy || !directory || !actorId()) return;
    const epoch = version;
    const membership = action === 'adminAddTeamMembers';
    const creating = !membership && payload.expectedName === null;
    const errorBox = $(membership ? 'team-member-error' : 'team-name-error');
    let confirmed = false, focusId = membership ? 'team-assign' : 'team-name-save';
    errorBox.textContent = $('teams-error').textContent = '';
    setBusy(true);
    status.textContent = 'Saving…';
    try {
      await request(action,payload);
      if (version !== epoch) return;
      confirmed = true;
      teamId = nextId;
      await load(epoch);
      if (version !== epoch) return;
      status.textContent = message;
      focusId = membership ? 'teams-add' : 'managed-team';
      if (creating && current()?.supervisorId === nextId) {
        openMembers();
        focusId = 'team-members-search';
      }
    } catch (error) {
      if (version !== epoch) return;
      status.textContent = '';
      if (error.code === 'FORBIDDEN' || confirmed) {
        reset();
        $('teams-error').textContent = error.code === 'FORBIDDEN' || error.code === 'TEAM_SETUP' ? error.message : message+' Refresh Teams to load the updated roster.';
        $('teams-refresh').focus();
      } else {
        errorBox.textContent = error.message || 'Could not confirm this change. Refresh Teams to check the roster.';
      }
    } finally {
      if (version === epoch) {
        setBusy(false);
        $(focusId).focus();
      }
    }
  }

  function editName(rename) {
    if (!directory || busy) return;
    closeForms();
    const team = current();
    const choices = rename ? [{id:teamId,username:username(teamId)}] : freeSupervisors();
    if (!choices.length) return;
    editingName = rename ? team.name : null;
    const fields = nameForm.elements;
    fields.supervisorId.replaceChildren(...choices.map(person => new Option(person.username,person.id)));
    if (!rename && choices.length > 1) fields.supervisorId.add(new Option('Choose a supervisor','',false,true),0);
    fields.teamName.value = editingName ?? '';
    $('team-supervisor-label').hidden = rename;
    $('team-name-title').textContent = rename ? 'Rename team' : 'Create team';
    $('team-name-save').textContent = rename ? 'Save name' : 'Create team';
    nameForm.hidden = false;
    status.textContent = '';
    $('teams-error').textContent = '';
    fields.teamName.focus();
  }

  nameForm.addEventListener('submit',event => {
    event.preventDefault();
    const name = nameForm.elements.teamName.value.trim(), supervisorId = nameForm.elements.supervisorId.value;
    if (!name || Array.from(name).length > 60 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
      $('team-name-error').textContent = 'Enter a team name of 1–60 characters without control characters.';
      nameForm.elements.teamName.setAttribute('aria-invalid','true');
      nameForm.elements.teamName.focus();
      return;
    }
    const rename = editingName !== null;
    save('adminSaveTeam',{supervisorId,name,expectedName:editingName},name+(rename ? ' renamed.' : ' created.'),supervisorId);
  });
  nameForm.addEventListener('input',() => {
    $('team-name-error').textContent = '';
    nameForm.elements.teamName.removeAttribute('aria-invalid');
  });

  function selectionSummary() {
    const count = checked.size;
    const transfers = candidates().filter(person => checked.has(person.id) && person.supervisorId).length;
    $('team-move-note').textContent = transfers ? transfers+' selected '+(transfers === 1 ? 'member will move' : 'members will move')+' from another team.' : '';
    $('team-assign').textContent = count ? 'Assign '+count+' '+(count === 1 ? 'member' : 'members') : 'Assign to team';
    $('team-assign').disabled = !count;
  }

  function renderCandidates() {
    const available = candidates(), query = search.value.toLowerCase().trim();
    const visible = available.filter(person => person.username.toLowerCase().includes(query));
    const names = new Map(directory.teams.map(team => [team.supervisorId,team.name]));
    const labels = visible.slice(0,visibleLimit).map(person => {
      const label = make('label'), input = make('input');
      input.type = 'checkbox'; input.value = person.id; input.checked = checked.has(person.id);
      const detail = person.supervisorId ? (names.get(person.supervisorId) || username(person.supervisorId)+'’s team') : 'Unassigned';
      const info = make('span');
      info.append(make('strong',person.username),make('small',detail));
      label.append(input,info);
      return label;
    });
    $('available-members').replaceChildren(...(labels.length ? labels : [make('p',query ? 'No matching agents.' : 'No available agents.')]));
    $('team-members-more').hidden = visible.length <= visibleLimit;
    selectionSummary();
  }

  $('teams-refresh').addEventListener('click',refresh);
  $('teams-create').addEventListener('click',() => editName(false));
  $('teams-rename').addEventListener('click',() => editName(true));
  $('teams-go-accounts').addEventListener('click',() => $('admin-open-accounts').click());
  $('team-member-accounts').addEventListener('click',() => $('admin-open-accounts').click());
  $('team-name-cancel').addEventListener('click',() => {
    const button = editingName === null ? $('teams-create') : $('teams-rename');
    closeForms(); button.focus();
  });
  picker.addEventListener('change',() => {teamId=picker.value;status.textContent='';render();});
  function openMembers() {
    memberForm.hidden = false;
    $('teams-add').setAttribute('aria-expanded','true');
    $('members-form-title').textContent = 'Add agents to '+current().name;
    renderCandidates();
  }
  $('teams-add').addEventListener('click',() => {
    const open = memberForm.hidden;
    closeForms();
    if (!open) return;
    status.textContent = ''; $('teams-error').textContent = '';
    openMembers();
    search.focus();
  });
  $('team-members-cancel').addEventListener('click',() => {closeForms();$('teams-add').focus();});
  search.addEventListener('input',() => {visibleLimit=batchSize;renderCandidates();});
  $('team-members-more').addEventListener('click',() => {
    const previous = visibleLimit;
    visibleLimit += batchSize;
    renderCandidates();
    $('available-members').querySelectorAll('input')[previous]?.focus();
  });
  $('available-members').addEventListener('change',event => {
    $('team-member-error').textContent = '';
    if (event.target.checked) checked.add(event.target.value);
    else checked.delete(event.target.value);
    selectionSummary();
  });
  memberForm.addEventListener('submit',event => {
    event.preventDefault();
    const members = candidates().filter(person => checked.has(person.id)).map(person => ({id:person.id,expectedSupervisorId:person.supervisorId}));
    if (!members.length) return;
    save('adminAddTeamMembers',{supervisorId:teamId,members},members.length+(members.length===1 ? ' member' : ' members')+' assigned to '+current().name+'.',teamId);
  });
  return {refresh,reset};
}
