-- A request reserves a username, but is separate from the users table until approved.
-- Existing agents, supervisors, admins, sessions, and tallies remain active.
create table workspace_private.signup_requests (
  id uuid primary key default gen_random_uuid(),
  username text not null check (char_length(username) between 1 and 8),
  username_key text generated always as (lower(username)) stored unique,
  password_hash text not null check (char_length(password_hash) between 1 and 2048),
  requested_role text not null check (requested_role in ('agent','supervisor')),
  requested_at timestamptz not null default clock_timestamp()
);
alter table workspace_private.signup_requests enable row level security;
revoke all on workspace_private.signup_requests from public, anon, authenticated, service_role;

create function workspace_private.reserve_username(p_username text,p_password_hash text) returns void
language plpgsql set search_path = '' as $$
begin
  if p_username is null or char_length(p_username) not between 1 and 8
    or p_username ~ '^[pP[:digit:]]' or p_password_hash is null
    or char_length(p_password_hash) not between 1 and 2048 then
    raise exception 'VALIDATION: Invalid signup credentials.';
  end if;
  -- Active and requested names share a namespace. Only operations claiming this
  -- particular username wait for one another. The service hashes passwords first.
  perform pg_advisory_xact_lock(hashtextextended('workspace-signup:' || lower(p_username),0));
  if exists(select 1 from workspace_private.users where username_key=lower(p_username))
    or exists(select 1 from workspace_private.signup_requests where username_key=lower(p_username)) then
    raise exception 'DUPLICATE: This username is already reserved.';
  end if;
end;
$$;

create function public.auth_request_signup(p_username text,p_password_hash text,p_requested_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text := btrim(p_username);
begin
  if p_requested_role is null or p_requested_role not in ('agent','supervisor') then
    raise exception 'VALIDATION: Request agent or supervisor access.';
  end if;
  perform workspace_private.reserve_username(v_name,p_password_hash);
  insert into workspace_private.signup_requests(username,password_hash,requested_role)
    values(v_name,p_password_hash,p_requested_role);
  return jsonb_build_object('status','pending');
end;
$$;

-- Earlier deployments submit no requested role. Preserve the entry point during
-- rollout while routing every such signup through the same approval queue.
create or replace function public.auth_register(p_username text,p_password_hash text) returns jsonb
language sql security definer set search_path = '' as $$
  select public.auth_request_signup(p_username,p_password_hash,'agent');
$$;

-- Both records use identical server-side password verification. Only an active
-- identity exists in the table referenced by sessions and workspace records.
create or replace function public.auth_get_user(p_username_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',matched.id,'username',matched.username,
    'password_hash',matched.password_hash,'status',matched.status)
  from (
    select id,username,password_hash,'active' as status from workspace_private.users
      where username_key=lower(btrim(p_username_key))
    union all
    select id,username,password_hash,'pending' as status from workspace_private.signup_requests
      where username_key=lower(btrim(p_username_key))
  ) matched;
$$;

-- Hold the actor's role for the duration of a privileged read or write. Admin
-- mutations also serialize with each other, so two concurrent role changes
-- cannot demote both administrators or attach a member to a demoted supervisor.
create function workspace_private.require_admin(p_user_id uuid,p_mutation boolean) returns void
language plpgsql set search_path = '' as $$
begin
  if p_mutation then
    perform pg_advisory_xact_lock(hashtextextended('workspace-admin:assignments',0));
  end if;
  perform 1 from workspace_private.users where id=p_user_id and role='admin' for share;
  if not found then raise exception 'FORBIDDEN: Administrator access required.'; end if;
end;
$$;

create function workspace_private.validate_assignment(p_role text,p_supervisor_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if p_role is null or p_role not in ('agent','supervisor','admin') then
    raise exception 'VALIDATION: Choose a valid role.';
  end if;
  if p_supervisor_id is not null then
    if p_role='supervisor' then raise exception 'INVALID_TEAM: A supervisor cannot report to another supervisor.'; end if;
    perform 1 from workspace_private.users where id=p_supervisor_id and role='supervisor' for share;
    if not found then raise exception 'INVALID_TEAM: Choose an active supervisor.'; end if;
  end if;
end;
$$;

create function public.workspace_admin_accounts(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform workspace_private.require_admin(p_user_id,false);
  return jsonb_build_object(
    'pending',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'username',r.username,
      'requestedRole',r.requested_role,'requestedAt',r.requested_at) order by r.requested_at,r.id),'[]'::jsonb)
      from workspace_private.signup_requests r),
    'accounts',(select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'username',u.username,
      'role',u.role,'supervisorId',u.supervisor_id) order by u.username_key,u.id),'[]'::jsonb)
      from workspace_private.users u)
  );
end;
$$;

create function public.workspace_admin_review_signup(p_user_id uuid,p_request_id uuid,p_decision text,
  p_role text,p_supervisor_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_request workspace_private.signup_requests%rowtype;
begin
  perform workspace_private.require_admin(p_user_id,true);
  select * into v_request from workspace_private.signup_requests where id=p_request_id for update;
  if not found then raise exception 'CONFLICT: This request has already been reviewed.'; end if;
  -- Serializing with new requests and direct creation keeps a username reserved
  -- throughout approval. Denial deletes only the unapproved request and its hash.
  perform pg_advisory_xact_lock(hashtextextended('workspace-signup:' || v_request.username_key,0));
  if p_decision='approve' then
    if p_role is null or p_role not in ('agent','supervisor') then
      raise exception 'VALIDATION: Approve an agent or supervisor role.';
    end if;
    perform workspace_private.validate_assignment(p_role,p_supervisor_id);
    insert into workspace_private.users(username,username_key,password_hash,role,supervisor_id)
      values(v_request.username,v_request.username_key,v_request.password_hash,p_role,p_supervisor_id);
  elsif p_decision is distinct from 'deny' or p_role is not null or p_supervisor_id is not null then
    raise exception 'VALIDATION: Invalid review decision.';
  end if;
  delete from workspace_private.signup_requests where id=p_request_id;
  return jsonb_build_object('ok',true);
end;
$$;

create function public.workspace_admin_create_account(p_user_id uuid,p_username text,p_password_hash text,
  p_role text,p_supervisor_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_name text := btrim(p_username);
begin
  perform workspace_private.require_admin(p_user_id,true);
  perform workspace_private.validate_assignment(p_role,p_supervisor_id);
  perform workspace_private.reserve_username(v_name,p_password_hash);
  insert into workspace_private.users(username,username_key,password_hash,role,supervisor_id)
    values(v_name,lower(v_name),p_password_hash,p_role,p_supervisor_id);
  return jsonb_build_object('ok',true);
end;
$$;

create function public.workspace_admin_assign_account(p_user_id uuid,p_account_id uuid,p_role text,
  p_supervisor_id uuid,p_expected_role text,p_expected_supervisor_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_account workspace_private.users%rowtype;
begin
  perform workspace_private.require_admin(p_user_id,true);
  select * into v_account from workspace_private.users where id=p_account_id for update;
  if not found or v_account.role is distinct from p_expected_role
    or v_account.supervisor_id is distinct from p_expected_supervisor_id then
    raise exception 'CONFLICT: This assignment has changed. Reload the directory.';
  end if;
  if p_account_id=p_user_id and p_role is distinct from 'admin' then
    raise exception 'SELF_ROLE: You cannot change your own administrator role.';
  end if;
  if p_account_id=p_supervisor_id then raise exception 'INVALID_TEAM: An account cannot supervise itself.'; end if;
  perform workspace_private.validate_assignment(p_role,p_supervisor_id);
  if v_account.role='supervisor' and p_role<>'supervisor' and exists(
    select 1 from workspace_private.users where supervisor_id=p_account_id) then
    raise exception 'TEAM_IN_USE: Reassign this supervisor''s team before changing their role.';
  end if;
  update workspace_private.users set role=p_role,supervisor_id=p_supervisor_id where id=p_account_id;
  return jsonb_build_object('ok',true);
end;
$$;

revoke all on function workspace_private.reserve_username(text,text),workspace_private.require_admin(uuid,boolean),
  workspace_private.validate_assignment(text,uuid) from public,anon,authenticated,service_role;
revoke all on function public.auth_request_signup(text,text,text),public.workspace_admin_accounts(uuid),
  public.workspace_admin_review_signup(uuid,uuid,text,text,uuid),public.workspace_admin_create_account(uuid,text,text,text,uuid),
  public.workspace_admin_assign_account(uuid,uuid,text,uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.auth_request_signup(text,text,text),public.workspace_admin_accounts(uuid),
  public.workspace_admin_review_signup(uuid,uuid,text,text,uuid),public.workspace_admin_create_account(uuid,text,text,text,uuid),
  public.workspace_admin_assign_account(uuid,uuid,text,uuid,text,uuid) to service_role;
notify pgrst,'reload schema';
