-- Deleting and later recreating a team for the same supervisor creates a new
-- identity, even if its name and roster are identical. Handoffs keep this ID.
alter table workspace_private.teams add column id uuid not null default gen_random_uuid() unique;

create or replace function public.workspace_admin_accounts(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform workspace_private.require_admin(p_user_id,false);
  return jsonb_build_object(
    'pending',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'username',r.username,
      'requestedRole',r.requested_role,'requestedAt',r.requested_at) order by r.requested_at,r.id),'[]'::jsonb)
      from workspace_private.signup_requests r),
    'accounts',(select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'username',u.username,
      'role',u.role,'supervisorId',u.supervisor_id,'ownedTeamId',t.id,'ownedTeamName',t.name)
      order by u.username_key,u.id),'[]'::jsonb)
      from workspace_private.users u left join workspace_private.teams t on t.supervisor_id=u.id),
    'teams',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'supervisorId',t.supervisor_id,'name',t.name)
      order by lower(t.name),t.supervisor_id),'[]'::jsonb) from workspace_private.teams t
      join workspace_private.users u on u.id=t.supervisor_id and u.role='supervisor')
  );
end;
$$;

-- Some installations retain the frozen pre-tally archive. A statement trigger
-- on DELETE would reject the users FK's cascade even when the archive is empty.
-- Keep blocking direct edits and allow only cascades for an already deleted parent.
do $migration$
begin
  if to_regclass('workspace_private.calls') is not null then
    create or replace function workspace_private.deny_legacy_write() returns trigger
    language plpgsql set search_path = '' as $guard$
    begin
      if tg_op='DELETE' and tg_level='ROW' and pg_trigger_depth()>1 then
        if not exists(select 1 from workspace_private.users where id=old.user_id) then return old; end if;
      end if;
      raise exception 'CONFLICT: Refresh the tracker to use grouped tallies.';
    end;
    $guard$;
    drop trigger archive_legacy_calls on workspace_private.calls;
    create trigger archive_legacy_calls before insert or update on workspace_private.calls
      for each statement execute function workspace_private.deny_legacy_write();
    create trigger archive_legacy_deletes before delete on workspace_private.calls
      for each row execute function workspace_private.deny_legacy_write();
  end if;
end;
$migration$;

-- Called only inside the serialized admin deletion transactions below.
create function workspace_private.remove_confirmed_team(p_supervisor_id uuid,
  p_expected_team_id uuid,p_expected_name text,p_expected_member_ids uuid[])
returns void language plpgsql set search_path = '' as $$
declare
  v_team workspace_private.teams%rowtype;
  v_members uuid[];
  v_member_id uuid;
begin
  if p_expected_member_ids is null or (p_expected_team_id is null) <> (p_expected_name is null)
    or (p_expected_team_id is null and cardinality(p_expected_member_ids)>0)
    or cardinality(p_expected_member_ids) <> (select count(distinct id) from unnest(p_expected_member_ids) id) then
    raise exception 'VALIDATION: Supply the reviewed team and complete roster.';
  end if;
  v_members := array(select id from workspace_private.users where supervisor_id=p_supervisor_id order by id);
  if v_members <> array(select id from unnest(p_expected_member_ids) id order by id) then
    raise exception 'CONFLICT: The roster changed. Review it before deleting.';
  end if;
  -- Tallies lock the agent before looking up the game. Launches and team goals
  -- lock the supervisor. Use the same order before removing scores or memberships.
  foreach v_member_id in array v_members loop
    perform workspace_private.lock_user(v_member_id);
  end loop;
  perform 1 from workspace_private.users where id=p_supervisor_id or id=(
    select u.supervisor_id from workspace_private.users u where u.id=p_supervisor_id
  ) order by id for update;
  select * into v_team from workspace_private.teams where supervisor_id=p_supervisor_id for update;
  if v_team.id is distinct from p_expected_team_id or v_team.name is distinct from p_expected_name then
    raise exception 'CONFLICT: The team changed. Review it before deleting.';
  end if;
  if v_team.id is null then return; end if;

  update workspace_private.users set supervisor_id=null where supervisor_id=p_supervisor_id;
  update workspace_private.users set bingo_channel=gen_random_uuid() where id=p_supervisor_id;
  delete from workspace_private.bingo_games where supervisor_id=p_supervisor_id;
  delete from workspace_private.teams where id=v_team.id;
end;
$$;

create function public.workspace_admin_delete_team(p_user_id uuid,p_supervisor_id uuid,
  p_expected_team_id uuid,p_expected_name text,p_expected_member_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform workspace_private.require_admin(p_user_id,true);
  if p_supervisor_id is null or p_expected_team_id is null or p_expected_name is null then
    raise exception 'VALIDATION: Select the team to delete.';
  end if;
  perform workspace_private.remove_confirmed_team(p_supervisor_id,p_expected_team_id,p_expected_name,p_expected_member_ids);
  return jsonb_build_object('ok',true);
end;
$$;

create function public.workspace_admin_delete_account(p_user_id uuid,p_account_id uuid,
  p_expected_username text,p_expected_role text,p_expected_supervisor_id uuid,
  p_expected_team_id uuid,p_expected_team_name text,p_expected_member_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_account workspace_private.users%rowtype;
begin
  perform workspace_private.require_admin(p_user_id,true);
  select * into v_account from workspace_private.users where id=p_account_id;
  if not found then raise exception 'CONFLICT: This account is no longer in the directory.'; end if;
  if p_user_id=p_account_id or v_account.role='admin' then
    raise exception 'FORBIDDEN: Only agent and supervisor accounts can be deleted.';
  end if;
  if v_account.username is distinct from p_expected_username or v_account.role is distinct from p_expected_role
    or v_account.supervisor_id is distinct from p_expected_supervisor_id then
    raise exception 'CONFLICT: The account changed. Review it before deleting.';
  end if;
  -- Serialize releasing this username with registrations and this account's last
  -- tally with cascading removal of its score, daily totals and retry receipts.
  perform pg_advisory_xact_lock(hashtextextended('workspace-signup:' || v_account.username_key,0));
  perform workspace_private.lock_user(p_account_id);
  perform workspace_private.remove_confirmed_team(p_account_id,p_expected_team_id,p_expected_team_name,p_expected_member_ids);
  delete from workspace_private.users where id=p_account_id and username=p_expected_username and role=p_expected_role
    and role in ('agent','supervisor') and supervisor_id is not distinct from p_expected_supervisor_id;
  if not found then raise exception 'CONFLICT: The account changed. Review it before deleting.'; end if;
  return jsonb_build_object('ok',true);
end;
$$;

revoke all on function workspace_private.remove_confirmed_team(uuid,uuid,text,uuid[]) from public,anon,authenticated,service_role;
revoke all on function public.workspace_admin_delete_team(uuid,uuid,uuid,text,uuid[]),
  public.workspace_admin_delete_account(uuid,uuid,text,text,uuid,uuid,text,uuid[]) from public,anon,authenticated;
grant execute on function public.workspace_admin_delete_team(uuid,uuid,uuid,text,uuid[]),
  public.workspace_admin_delete_account(uuid,uuid,text,text,uuid,uuid,text,uuid[]) to service_role;
notify pgrst, 'reload schema';
