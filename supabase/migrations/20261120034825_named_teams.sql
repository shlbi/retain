-- A supervisor already identifies a team for membership, games, scores and
-- Realtime. Store its name once and keep those existing identities intact.
create table workspace_private.teams (
  supervisor_id uuid primary key references workspace_private.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60 and name = btrim(name) and name !~ '[[:cntrl:]]')
);
create unique index team_names on workspace_private.teams (lower(name));
alter table workspace_private.teams enable row level security;
revoke all on workspace_private.teams from public,anon,authenticated,service_role;

-- Older clients can still assign an agent directly to a supervisor. An initial
-- assignment provisions a readable name; name collisions get a numeric suffix.
create function workspace_private.ensure_roster_team(p_supervisor_id uuid) returns void
language plpgsql set search_path = '' as $$
declare
  v_base text;
  v_name text;
  v_number integer := 1;
begin
  if exists(select 1 from workspace_private.teams where supervisor_id=p_supervisor_id) then return; end if;
  select left(regexp_replace(btrim(username),'[[:cntrl:]]',' ','g'),44) || '’s team' into v_base
    from workspace_private.users where id=p_supervisor_id and (role='supervisor' or exists(
      select 1 from workspace_private.bingo_games g where g.supervisor_id=p_supervisor_id));
  if not found then raise exception 'INVALID_TEAM: Choose an active supervisor.'; end if;
  loop
    v_name := case when v_number=1 then v_base else v_base || ' ' || v_number::text end;
    insert into workspace_private.teams(supervisor_id,name) values(p_supervisor_id,v_name) on conflict do nothing;
    if found or exists(select 1 from workspace_private.teams where supervisor_id=p_supervisor_id) then return; end if;
    v_number := v_number+1;
  end loop;
end;
$$;
do $$
declare leader uuid;
begin
  for leader in select u.id from workspace_private.users u
    where exists(select 1 from workspace_private.users m where m.supervisor_id=u.id)
      or exists(select 1 from workspace_private.bingo_games g where g.supervisor_id=u.id)
    order by u.id
  loop
    perform workspace_private.ensure_roster_team(leader);
  end loop;
end;
$$;

-- Each historical game keeps its original team, including when a former
-- supervisor was already demoted before this migration. A dormant team's
-- name remains reserved. Defer this FK to allow a user deletion to cascade
-- through the existing user-to-games and user-to-teams relationships together.
alter table workspace_private.bingo_games add constraint bingo_named_team_fk
  foreign key (supervisor_id) references workspace_private.teams(supervisor_id) deferrable initially deferred;

create function workspace_private.sync_named_team() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op='UPDATE' and old.role='supervisor' and new.role<>'supervisor' then
    -- Empty teams with game history become dormant until this same supervisor
    -- returns. The existing membership FK prevents demotion while members remain.
    delete from workspace_private.teams where supervisor_id=old.id and not exists(
      select 1 from workspace_private.bingo_games g where g.supervisor_id=old.id);
  end if;
  if new.supervisor_id is not null then
    perform workspace_private.ensure_roster_team(new.supervisor_id);
  end if;
  return new;
end;
$$;
create trigger sync_named_team before insert or update of supervisor_id,role on workspace_private.users
for each row execute function workspace_private.sync_named_team();

-- New games require a named team. The existing launch function derives
-- supervisor_id from the authenticated actor; a client cannot supply a target.
create function workspace_private.require_bingo_team() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not exists(select 1 from workspace_private.teams t join workspace_private.users u on u.id=t.supervisor_id
    where t.supervisor_id=new.supervisor_id and u.role='supervisor') then
    raise exception 'TEAM_REQUIRED: Create a team before scheduling a game.';
  end if;
  return new;
end;
$$;
create trigger require_bingo_team before insert on workspace_private.bingo_games
for each row execute function workspace_private.require_bingo_team();

create or replace function public.workspace_team_context(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('role',actor.role,'supervisorId',actor.supervisor_id,'teamName',t.name,
    'agents',case when actor.role='supervisor' then coalesce((
      select jsonb_agg(jsonb_build_object('id',m.id,'username',m.username,
        'goals',workspace_private.default_goals() || m.goals) order by m.username_key,m.id)
      from workspace_private.users m where m.supervisor_id=actor.id
    ),'[]'::jsonb) else '[]'::jsonb end)
  from workspace_private.users actor left join workspace_private.teams t on t.supervisor_id=
    case when actor.role='supervisor' then actor.id else actor.supervisor_id end
  where actor.id=p_user_id;
$$;

create or replace function public.workspace_admin_accounts(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform workspace_private.require_admin(p_user_id,false);
  return jsonb_build_object(
    'pending',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'username',r.username,
      'requestedRole',r.requested_role,'requestedAt',r.requested_at) order by r.requested_at,r.id),'[]'::jsonb)
      from workspace_private.signup_requests r),
    'accounts',(select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'username',u.username,
      'role',u.role,'supervisorId',u.supervisor_id) order by u.username_key,u.id),'[]'::jsonb)
      from workspace_private.users u),
    'teams',(select coalesce(jsonb_agg(jsonb_build_object('supervisorId',t.supervisor_id,'name',t.name)
      order by lower(t.name),t.supervisor_id),'[]'::jsonb) from workspace_private.teams t
      join workspace_private.users u on u.id=t.supervisor_id and u.role='supervisor')
  );
end;
$$;

-- A null expected name requests creation. Renames carry the exact name shown
-- in the directory, so a stale tab cannot overwrite another admin's changes.
create function public.workspace_admin_save_team(p_user_id uuid,p_supervisor_id uuid,p_name text,p_expected_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_name text := btrim(p_name);
begin
  perform workspace_private.require_admin(p_user_id,true);
  if v_name is null or char_length(v_name) not between 1 and 60 or p_name ~ '[[:cntrl:]]' then
    raise exception 'VALIDATION: Choose a team name with 1–60 characters.';
  end if;
  if p_supervisor_id is null then raise exception 'INVALID_TEAM: Choose an active supervisor.'; end if;
  perform workspace_private.validate_assignment('agent',p_supervisor_id);
  if p_expected_name is null then
    insert into workspace_private.teams(supervisor_id,name) values(p_supervisor_id,v_name);
  else
    update workspace_private.teams set name=v_name where supervisor_id=p_supervisor_id and name=p_expected_name;
    if not found then raise exception 'CONFLICT: The team changed. Refresh the directory.'; end if;
  end if;
  return jsonb_build_object('ok',true);
exception when unique_violation then
  raise exception 'CONFLICT: That team name or supervisor is already assigned.';
end;
$$;

-- Every selected member and expected prior assignment must match. If one
-- changed, raising an error rolls back the entire update and its channel rotations.
create function public.workspace_admin_add_team_members(p_user_id uuid,p_supervisor_id uuid,p_members jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  perform workspace_private.require_admin(p_user_id,true);
  perform 1 from workspace_private.teams t join workspace_private.users u on u.id=t.supervisor_id
    where t.supervisor_id=p_supervisor_id and u.role='supervisor' for share;
  if not found then raise exception 'INVALID_TEAM: Select a named team.'; end if;
  if jsonb_typeof(p_members) is distinct from 'array' then raise exception 'VALIDATION: Select team members.'; end if;
  if jsonb_array_length(p_members)=0 or exists(select 1 from jsonb_array_elements(p_members) e
    where jsonb_typeof(e)<>'object' or not (e ?& array['id','expectedSupervisorId'])
      or e-array['id','expectedSupervisorId']<>'{}'::jsonb or jsonb_typeof(e->'id')<>'string'
      or jsonb_typeof(e->'expectedSupervisorId') not in ('string','null')) then
    raise exception 'VALIDATION: Select members and their current assignments.';
  end if;
  update workspace_private.users u set supervisor_id=p_supervisor_id
    from jsonb_to_recordset(p_members) as m(id uuid,"expectedSupervisorId" uuid)
    where u.id=m.id and u.role in ('agent','admin')
      and u.supervisor_id is not distinct from m."expectedSupervisorId";
  get diagnostics v_count=row_count;
  if v_count<>jsonb_array_length(p_members) then
    raise exception 'CONFLICT: The selected members or their team assignments changed.';
  end if;
  return jsonb_build_object('ok',true);
exception when invalid_text_representation then
  raise exception 'VALIDATION: Invalid account identifier.';
end;
$$;
revoke all on function workspace_private.ensure_roster_team(uuid),workspace_private.sync_named_team(),
  workspace_private.require_bingo_team() from public,anon,authenticated,service_role;
revoke all on function public.workspace_admin_save_team(uuid,uuid,text,text),
  public.workspace_admin_add_team_members(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.workspace_admin_save_team(uuid,uuid,text,text),
  public.workspace_admin_add_team_members(uuid,uuid,jsonb) to service_role;
notify pgrst, 'reload schema';
