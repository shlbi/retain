-- One pending request and one approved code may coexist. Requesting another
-- review never replaces an approved code; approving the new request replaces it.
create table workspace_private.password_change_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references workspace_private.users(id) on delete cascade,
  requested_at timestamptz not null default clock_timestamp()
);
create table workspace_private.password_change_codes (
  user_id uuid primary key references workspace_private.users(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null
);
alter table workspace_private.password_change_requests enable row level security;
alter table workspace_private.password_change_codes enable row level security;
revoke all on workspace_private.password_change_requests,workspace_private.password_change_codes
  from public,anon,authenticated,service_role;

create function public.auth_request_password_change(p_username text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid;
begin
  -- Public API requests use an identical response for every username. Only an
  -- active identity can receive a request; a signup still awaiting approval cannot.
  select id into v_user_id from workspace_private.users where username_key=lower(btrim(p_username)) for update;
  if found then
    delete from workspace_private.password_change_codes where user_id=v_user_id and expires_at<=clock_timestamp();
    insert into workspace_private.password_change_requests(user_id) values(v_user_id)
      on conflict(user_id) do nothing;
  end if;
  return jsonb_build_object('ok',true);
end;
$$;

create or replace function public.workspace_admin_accounts(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform workspace_private.require_admin(p_user_id,false);
  return jsonb_build_object(
    'pending',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'username',r.username,
      'requestedRole',r.requested_role,'requestedAt',r.requested_at) order by r.requested_at,r.id),'[]'::jsonb)
      from workspace_private.signup_requests r),
    'passwordChanges',(select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'username',u.username,
      'requestedAt',r.requested_at) order by r.requested_at,r.id),'[]'::jsonb)
      from workspace_private.password_change_requests r join workspace_private.users u on u.id=r.user_id),
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

create function public.workspace_admin_review_password_change(p_user_id uuid,p_request_id uuid,p_decision text,p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_target uuid;
begin
  perform workspace_private.require_admin(p_user_id,true);
  if p_decision is null or p_decision not in ('approve','deny')
    or (p_decision='approve' and (p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'))
    or (p_decision='deny' and p_token_hash is not null) then
    raise exception 'VALIDATION: Invalid password change decision.';
  end if;
  -- Every reset action locks the target user before changing a request or code,
  -- including a resubmission from a different browser during an approval.
  select user_id into v_target from workspace_private.password_change_requests where id=p_request_id;
  perform 1 from workspace_private.users where id=v_target for update;
  delete from workspace_private.password_change_requests where id=p_request_id and user_id=v_target;
  if not found then raise exception 'CONFLICT: This password change request has already been handled.'; end if;
  if p_decision='approve' then
    -- The server shows the fresh code to the reviewing admin once for private
    -- delivery after identity verification. The database receives only its digest.
    insert into workspace_private.password_change_codes(user_id,token_hash,expires_at)
      values(v_target,p_token_hash,clock_timestamp()+interval '30 minutes')
      on conflict(user_id) do update set token_hash=excluded.token_hash,expires_at=excluded.expires_at;
  end if;
  return jsonb_build_object('ok',true);
end;
$$;

create function public.auth_complete_password_change(p_username text,p_token_hash text,p_password_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_target uuid;
begin
  if p_password_hash is null or p_password_hash !~ '^scrypt[$]32768[$]8[$]3[$][0-9a-f]{32}[$][0-9a-f]{128}$' then
    raise exception 'VALIDATION: Unsupported credential format.';
  end if;
  select id into v_target from workspace_private.users where username_key=lower(btrim(p_username)) for update;
  delete from workspace_private.password_change_codes where user_id=v_target and token_hash=p_token_hash and expires_at>clock_timestamp();
  if not found then raise exception 'INVALID_RESET: Invalid or expired reset code.'; end if;
  update workspace_private.users set password_hash=p_password_hash where id=v_target;
  delete from workspace_private.sessions where user_id=v_target;
  delete from workspace_private.password_change_requests where user_id=v_target;
  return jsonb_build_object('ok',true);
end;
$$;

-- A login may verify the previous hash just before a reset. Checking that hash
-- under a row lock makes issuing a session and revoking all sessions serialize.
alter function public.auth_create_session(uuid,text,timestamptz) set schema workspace_private;
revoke all on function workspace_private.auth_create_session(uuid,text,timestamptz) from public,anon,authenticated,service_role;

create function public.auth_create_verified_session(p_user_id uuid,p_expected_hash text,p_token_hash text,p_expires_at timestamptz)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from workspace_private.users where id=p_user_id and password_hash=p_expected_hash for share;
  if not found then return false; end if;
  perform workspace_private.auth_create_session(p_user_id,p_token_hash,p_expires_at);
  return true;
end;
$$;

revoke all on function public.auth_request_password_change(text),public.auth_complete_password_change(text,text,text),
  public.workspace_admin_review_password_change(uuid,uuid,text,text),public.auth_create_verified_session(uuid,text,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.auth_request_password_change(text),public.auth_complete_password_change(text,text,text),
  public.workspace_admin_review_password_change(uuid,uuid,text,text),public.auth_create_verified_session(uuid,text,text,timestamptz)
  to service_role;
notify pgrst,'reload schema';
