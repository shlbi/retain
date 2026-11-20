-- One editor submission changes the name, supervisor and complete roster together.
-- The original team and member assignments are the snapshots shown to the admin.
create function public.workspace_admin_save_team_details(
  p_user_id uuid, p_original_supervisor_id uuid, p_supervisor_id uuid, p_name text,
  p_expected_name text, p_expected_member_ids uuid[], p_members jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name text := btrim(p_name);
  v_selected_ids uuid[];
  v_current_ids uuid[];
  v_member_id uuid;
begin
  -- All admin assignment RPCs use this same transaction lock, including older clients.
  perform workspace_private.require_admin(p_user_id,true);
  if v_name is null or char_length(v_name) not between 1 and 60 or p_name ~ '[[:cntrl:]]' then
    raise exception 'INVALID_TEAM: Choose a team name with 1–60 characters.';
  end if;
  if p_expected_member_ids is null or
     (select count(distinct id) from unnest(p_expected_member_ids) id) <> cardinality(p_expected_member_ids) or
     (p_original_supervisor_id is null and (p_expected_name is not null or cardinality(p_expected_member_ids) <> 0)) or
     (p_original_supervisor_id is not null and p_expected_name is null) then
    raise exception 'INVALID_TEAM: Supply the original team and roster.';
  end if;
  if jsonb_typeof(p_members) is distinct from 'array' then
    raise exception 'INVALID_TEAM: Supply the selected agents.';
  end if;
  if exists(select 1 from jsonb_array_elements(p_members) m where case when jsonb_typeof(m)='object' then
      not (m ?& array['id','expectedSupervisorId']) or m-array['id','expectedSupervisorId'] <> '{}'::jsonb
      or jsonb_typeof(m->'id') <> 'string' or jsonb_typeof(m->'expectedSupervisorId') not in ('string','null')
    else true end) then
    raise exception 'INVALID_TEAM: Supply agents and their current assignments.';
  end if;
  v_selected_ids := array(select distinct m.id from jsonb_to_recordset(p_members) m(id uuid));
  if cardinality(v_selected_ids) <> jsonb_array_length(p_members) then
    raise exception 'INVALID_TEAM: Select each agent once.';
  end if;

  -- Finish in-flight tallies before changing their membership or moving their game.
  -- Acquire these locks before the supervisor rows that score notifications read.
  for v_member_id in select id from workspace_private.users
    where id=any(v_selected_ids) or supervisor_id=p_original_supervisor_id order by id
  loop
    perform workspace_private.lock_user(v_member_id);
  end loop;

  -- Launches and goal changes lock the supervisor. Include the source teams of
  -- transfers so that their goal/roster updates finish before changing membership.
  perform 1 from workspace_private.users where role='supervisor' and (
    id in (p_original_supervisor_id,p_supervisor_id) or id in (
      select m."expectedSupervisorId" from jsonb_to_recordset(p_members) m("expectedSupervisorId" uuid)
    )) order by id for update;
  if not exists(select 1 from workspace_private.users where id=p_supervisor_id and role='supervisor') then
    raise exception 'INVALID_TEAM: Choose an active supervisor.';
  end if;
  if p_original_supervisor_id is not null then
    perform 1 from workspace_private.teams t join workspace_private.users u on u.id=t.supervisor_id
      where t.supervisor_id=p_original_supervisor_id and t.name=p_expected_name and u.role='supervisor'
      for update of t;
    if not found then raise exception 'CONFLICT: The team changed. Reopen the editor.'; end if;
    v_current_ids := array(select id from workspace_private.users where supervisor_id=p_original_supervisor_id order by id);
    if v_current_ids <> array(select id from unnest(p_expected_member_ids) id order by id) then
      raise exception 'CONFLICT: The roster changed. Reopen the editor.';
    end if;
  end if;
  if p_original_supervisor_id is distinct from p_supervisor_id and
    exists(select 1 from workspace_private.teams where supervisor_id=p_supervisor_id) then
    raise exception 'SUPERVISOR_TAKEN: That supervisor already leads a team.';
  end if;
  if exists(select 1 from workspace_private.teams where lower(name)=lower(v_name)
    and supervisor_id is distinct from p_original_supervisor_id) then
    raise exception 'TEAM_NAME_TAKEN: That team name is already in use.';
  end if;
  if exists(select 1 from jsonb_to_recordset(p_members) m(id uuid,"expectedSupervisorId" uuid)
    left join workspace_private.users u on u.id=m.id
    where u.id is null or u.role not in ('agent','admin') or u.supervisor_id is distinct from m."expectedSupervisorId") then
    raise exception 'CONFLICT: An agent or their assignment changed. Reopen the editor.';
  end if;

  if p_original_supervisor_id is null then
    insert into workspace_private.teams(supervisor_id,name) values(p_supervisor_id,v_name);
  else
    update workspace_private.teams set supervisor_id=p_supervisor_id,name=v_name
      where supervisor_id=p_original_supervisor_id;
    if p_original_supervisor_id <> p_supervisor_id then
      -- The deferred named-team FK lets every existing game keep its ID and scores.
      update workspace_private.bingo_games set supervisor_id=p_supervisor_id where supervisor_id=p_original_supervisor_id;
      update workspace_private.users set bingo_channel=gen_random_uuid() where id in (p_original_supervisor_id,p_supervisor_id);
    end if;
    update workspace_private.users set supervisor_id=null
      where supervisor_id=p_original_supervisor_id and not (id=any(v_selected_ids));
  end if;
  update workspace_private.users set supervisor_id=p_supervisor_id
    where id=any(v_selected_ids) and supervisor_id is distinct from p_supervisor_id;
  return jsonb_build_object('ok',true);
exception when invalid_text_representation then
  raise exception 'INVALID_TEAM: Invalid account identifier.';
end;
$$;

revoke all on function public.workspace_admin_save_team_details(uuid,uuid,uuid,text,text,uuid[],jsonb)
  from public,anon,authenticated;
grant execute on function public.workspace_admin_save_team_details(uuid,uuid,uuid,text,text,uuid[],jsonb)
  to service_role;
notify pgrst, 'reload schema';
