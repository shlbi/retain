const $ = id => document.getElementById(id);
const make = (tag, text) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
};
const pageSize = 50;

/** The editor submits the full roster together with the directory snapshot the admin reviewed. */
export function createNamedTeams(request, actorId) {
  const list = $('teams-list'), dialog = $('team-dialog'), form = $('team-editor');
  const {teamName, supervisorId} = form.elements;
  const search = $('team-members-search'), status = $('teams-status'), errorBox = $('team-save-error');
  const selected = new Set();
  let directory = null, original = null, expectedMemberIds = [];
  let epoch = 0, loading = false, saving = false, visibleLimit = pageSize;

  function renderList() {
    const teams = directory?.teams ?? [];
    const accounts = new Map(directory?.accounts.map(person => [person.id, person]));
    const counts = new Map();
    for (const person of accounts.values()) {
      if (person.supervisorId) counts.set(person.supervisorId,(counts.get(person.supervisorId) ?? 0) + 1);
    }
    $('teams-count').hidden = !directory;
    $('teams-count').textContent = directory ? teams.length : '';
    $('teams-empty').hidden = !directory || teams.length > 0;
    list.replaceChildren(...teams.map(team => {
      const row = make('li'), title = make('div'), details = make('p');
      const count = counts.get(team.supervisorId) || 0;
      title.append(make('h3',team.name));
      details.append(make('span','Supervisor · ' + (accounts.get(team.supervisorId)?.username || 'Unknown')),
        make('span',count + (count === 1 ? ' agent' : ' agents')));
      title.append(details);
      const edit = make('button','Edit');
      edit.type = 'button';
      edit.className = 'button secondary';
      edit.dataset.team = team.supervisorId;
      edit.setAttribute('aria-label','Edit ' + team.name);
      edit.setAttribute('aria-haspopup','dialog');
      row.append(title,edit);
      return row;
    }));
  }

  function selectionSummary() {
    const transfers = directory.accounts.filter(person => selected.has(person.id) && person.supervisorId && person.supervisorId !== original?.supervisorId).length;
    $('team-selection-count').textContent = selected.size + ' selected';
    $('team-move-note').textContent = transfers ? transfers + (transfers === 1 ? ' selected agent will move' : ' selected agents will move') + ' from another team.' : '';
  }

  function openAccounts() {
    closeEditor();
    $('admin-open-accounts').click();
    $('admin-open-accounts').focus();
  }

  function renderAgents() {
    const query = search.value.trim().toLowerCase();
    const matches = directory.accounts.filter(person => person.role !== 'supervisor' && person.username.toLowerCase().includes(query));
    const names = new Map(directory.teams.map(team => [team.supervisorId,team.name]));
    const labels = matches.slice(0,visibleLimit).map(person => {
      const label = make('label'), input = make('input'), detail = make('span');
      input.type = 'checkbox';
      input.value = person.id;
      input.checked = selected.has(person.id);
      const affiliation = names.get(person.supervisorId) || 'Unassigned';
      detail.append(make('strong',person.username),make('small',(person.role === 'admin' ? 'Admin · ' : '') + affiliation));
      label.append(input,detail);
      return label;
    });
    if (!labels.length) {
      const empty = make('p',query ? 'No matching agents. ' : 'No agent accounts yet. ');
      const manage = make('button','Manage accounts');
      manage.type = 'button';
      manage.className = 'text-button';
      manage.addEventListener('click',openAccounts);
      empty.append(manage);
      labels.push(empty);
    }
    $('available-members').replaceChildren(...labels);
    $('team-members-more').hidden = matches.length <= visibleLimit;
    selectionSummary();
  }

  function updateControls() {
    $('team-fields').disabled = !directory || loading || saving;
    $('team-save').disabled = !directory || loading || saving || !$('team-supervisor-help').hidden;
    $('team-cancel').disabled = $('team-close').disabled = saving;
  }

  function populateEditor() {
    const occupied = new Set(directory.teams.map(team => team.supervisorId));
    const choices = directory.accounts.filter(person => person.role === 'supervisor' && (!occupied.has(person.id) || person.id === original?.supervisorId));
    const prompt = choices.length ? 'Choose a supervisor' : 'No available supervisors';
    supervisorId.replaceChildren(new Option(prompt,''),...choices.map(person => new Option(person.username,person.id)));
    supervisorId.value = original?.supervisorId ?? (choices.length === 1 ? choices[0].id : '');
    $('team-supervisor-help').hidden = choices.length > 0;
    teamName.value = original?.name ?? '';
    expectedMemberIds = original ? directory.accounts.filter(person => person.supervisorId === original.supervisorId).map(person => person.id) : [];
    selected.clear();
    expectedMemberIds.forEach(id => selected.add(id));
    renderAgents();
    $('team-load-status').textContent = '';
    updateControls();
  }

  function closeEditor(focusTeamId) {
    dialog.close();
    form.reset();
    original = null;
    expectedMemberIds = [];
    selected.clear();
    visibleLimit = pageSize;
    supervisorId.replaceChildren();
    $('available-members').replaceChildren();
    for (const id of ['team-dialog-title','team-save-error','team-load-status','team-selection-count','team-move-note']) $(id).textContent = '';
    $('team-supervisor-help').hidden = $('team-reload').hidden = $('team-members-more').hidden = true;
    for (const field of [teamName,supervisorId]) field.removeAttribute('aria-invalid');
    if (focusTeamId !== undefined) {
      const target = [...list.querySelectorAll('button')].find(button => button.dataset.team === focusTeamId);
      (target || $('teams-create')).focus();
    }
  }

  function reset() {
    epoch++;
    loading = saving = false;
    directory = null;
    closeEditor();
    renderList();
    status.textContent = $('teams-error').textContent = '';
    $('teams-retry').hidden = true;
    updateControls();
  }

  async function readDirectory() {
    const result = await request('adminAccounts');
    if (!Array.isArray(result?.teams) || !Array.isArray(result.accounts)) {
      throw new Error('Apply the named teams database update in Supabase, then reload Teams.');
    }
    return result;
  }

  async function refresh() {
    if (loading || saving || !actorId() || (dialog.open && directory)) return;
    const version = epoch;
    loading = true;
    directory = null;
    renderList();
    $('teams-error').textContent = '';
    $('teams-retry').hidden = true;
    status.textContent = 'Loading teams…';
    try {
      const result = await readDirectory();
      if (version !== epoch) return;
      directory = result;
      renderList();
      if (dialog.open) populateEditor();
    } catch (error) {
      if (version !== epoch) return;
      if (error.code === 'FORBIDDEN') reset();
      directory = null;
      renderList();
      const message = error.message || 'Could not load teams. Try again.';
      $('teams-error').textContent = message;
      $('teams-retry').hidden = false;
      if (dialog.open) {
        $('team-load-status').textContent = '';
        errorBox.textContent = message;
        $('team-reload').hidden = false;
      }
    } finally {
      if (version === epoch) {
        loading = false;
        status.textContent = '';
        updateControls();
      }
    }
  }

  function openEditor(team = null) {
    if (dialog.open || saving || !actorId()) return;
    original = team;
    status.textContent = '';
    $('team-dialog-title').textContent = team ? 'Edit team' : 'Create team';
    $('team-save').textContent = team ? 'Save changes' : 'Create team';
    if (directory && !loading) populateEditor();
    else $('team-load-status').textContent = 'Loading team details…';
    updateControls();
    dialog.showModal();
    if (directory && !loading) teamName.focus();
    else refresh();
  }

  async function save(event) {
    event.preventDefault();
    if (saving || loading || !directory || !actorId() || $('team-save').disabled) return;
    const name = teamName.value.trim();
    let invalidField;
    if (!name || Array.from(name).length > 60 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
      errorBox.textContent = 'Enter a team name of 1–60 characters without control characters.';
      invalidField = teamName;
    } else if (!supervisorId.value) {
      errorBox.textContent = 'Choose a supervisor for this team.';
      invalidField = supervisorId;
    }
    if (invalidField) {
      invalidField.setAttribute('aria-invalid','true');
      invalidField.focus();
      return;
    }

    const targetId = supervisorId.value, version = epoch;
    const message = name + (original ? ' updated.' : ' created.');
    const members = directory.accounts.filter(person => selected.has(person.id))
      .map(person => ({id:person.id,expectedSupervisorId:person.supervisorId ?? null}));
    saving = true;
    updateControls();
    errorBox.textContent = '';
    $('team-reload').hidden = true;
    $('team-save').textContent = 'Saving…';
    let confirmed = false;
    try {
      await request('adminSaveTeamDetails', {
        originalSupervisorId:original?.supervisorId ?? null, supervisorId:targetId, name,
        expectedName:original?.name ?? null, expectedMemberIds, members
      });
      if (epoch !== version) return;
      confirmed = true;
      const result = await readDirectory();
      if (epoch !== version) return;
      directory = result;
      renderList();
      closeEditor(targetId);
      status.textContent = message;
    } catch (error) {
      if (epoch !== version) return;
      if (error.code === 'FORBIDDEN' || confirmed) {
        reset();
        $('teams-error').textContent = confirmed ? message + ' Reload Teams to see the updated list.' : error.message;
        $('teams-retry').hidden = false;
        $('teams-retry').focus();
      } else {
        errorBox.textContent = error.message || 'Could not confirm the change. Reload teams to check the roster.';
        $('team-reload').hidden = false;
      }
    } finally {
      if (epoch === version) {
        saving = false;
        updateControls();
        if (dialog.open) {
          $('team-save').textContent = original ? 'Save changes' : 'Create team';
          $('team-save').focus();
        }
      }
    }
  }

  $('teams-create').addEventListener('click',() => openEditor());
  list.addEventListener('click',event => {
    const edit = event.target.closest('button[data-team]');
    if (edit) openEditor(directory.teams.find(team => team.supervisorId === edit.dataset.team));
  });
  for (const id of ['team-close','team-cancel']) $(id).addEventListener('click',() => closeEditor(original?.supervisorId ?? null));
  dialog.addEventListener('cancel',event => {
    event.preventDefault();
    if (!saving) closeEditor(original?.supervisorId ?? null);
  });
  $('teams-retry').addEventListener('click',refresh);
  $('team-reload').addEventListener('click',() => { closeEditor(null); refresh(); });
  $('team-manage-accounts').addEventListener('click',openAccounts);
  search.addEventListener('input',() => { visibleLimit = pageSize; renderAgents(); });
  search.addEventListener('keydown',event => {
    if (event.key === 'Enter') event.preventDefault();
  });
  $('team-members-more').addEventListener('click',() => {
    const previous = visibleLimit;
    visibleLimit += pageSize;
    renderAgents();
    $('available-members').querySelectorAll('input')[previous]?.focus();
  });
  $('available-members').addEventListener('change',event => {
    if (event.target.checked) selected.add(event.target.value);
    else selected.delete(event.target.value);
    selectionSummary();
  });
  form.addEventListener('input',event => {
    if (event.target.hasAttribute('aria-invalid')) {
      event.target.removeAttribute('aria-invalid');
      errorBox.textContent = '';
    }
  });
  form.addEventListener('submit',save);
  return {refresh,reset};
}
