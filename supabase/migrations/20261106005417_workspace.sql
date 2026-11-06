-- Applied once by the Supabase GitHub migration runner. The browser must never receive a
-- service/secret key. Only the server's service_role can execute the public RPCs.
-- No Supabase Auth users or anonymous policies are involved in this application.

create schema if not exists workspace_private;
revoke all on schema workspace_private from public, anon, authenticated, service_role;

create table workspace_private.users (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  username text not null check (pg_catalog.char_length(username) between 1 and 64),
  username_key text not null unique,
  password_hash text not null check (pg_catalog.char_length(password_hash) between 1 and 2048),
  goals jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(goals) = 'object'),
  created_at timestamptz not null default pg_catalog.clock_timestamp()
);

create table workspace_private.sessions (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references workspace_private.users(id) on delete cascade,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null check (expires_at > created_at)
);
create index sessions_expiry_idx on workspace_private.sessions(expires_at);
create index sessions_user_idx on workspace_private.sessions(user_id);

create table workspace_private.auth_limits (
  bucket_key text primary key,
  window_started timestamptz not null,
  attempts integer not null check (attempts > 0)
);
create index auth_limits_window_idx on workspace_private.auth_limits(window_started);

create table workspace_private.calls (
  user_id uuid not null references workspace_private.users(id) on delete cascade,
  id text not null check (pg_catalog.char_length(id) between 1 and 100),
  record jsonb not null check (pg_catalog.jsonb_typeof(record) = 'object'),
  revision bigint not null check (revision between 1 and 9007199254740991),
  ucid_key text generated always as (nullif(pg_catalog.lower(pg_catalog.btrim(record->>'ucid')), '')) stored,
  primary key (user_id, id),
  check (record->>'id' = id),
  check ((record->>'revision')::numeric = revision)
);
create unique index calls_user_ucid_idx on workspace_private.calls(user_id, ucid_key) where ucid_key is not null;

-- Revisions survive deletion so an old edit or Undo cannot resurrect newer data.
create table workspace_private.call_versions (
  user_id uuid not null references workspace_private.users(id) on delete cascade,
  id text not null,
  revision bigint not null check (revision between 1 and 9007199254740991),
  primary key (user_id, id)
);

alter table workspace_private.users enable row level security;
alter table workspace_private.sessions enable row level security;
alter table workspace_private.auth_limits enable row level security;
alter table workspace_private.calls enable row level security;
alter table workspace_private.call_versions enable row level security;
-- No RLS policies: anon/authenticated cannot access any row. Explicit revocation
-- also denies direct table access to service_role; it uses the RPCs below.
revoke all on all tables in schema workspace_private from public, anon, authenticated, service_role;

create function workspace_private.default_goals() returns jsonb
language sql immutable set search_path = '' as $$
  select '{"overall":85,"internet":85,"tv":75,"sp":80,"dp":80,"tp":80,"phone":80,"mobile":75,"orders":20,"sales":20}'::jsonb;
$$;

create function workspace_private.validate_goals(p_goals jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_key text; v_value jsonb;
begin
  if p_goals is null or pg_catalog.jsonb_typeof(p_goals) <> 'object'
    or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_goals)) <> 10 then
    raise exception 'VALIDATION: A backup must contain all ten goals.';
  end if;
  for v_key, v_value in select key, value from pg_catalog.jsonb_each(p_goals) loop
    if not (workspace_private.default_goals() ? v_key)
      or pg_catalog.jsonb_typeof(v_value) <> 'number'
      or (v_value::text)::numeric <> pg_catalog.trunc((v_value::text)::numeric)
      or (v_value::text)::numeric not between 5 and 100 then
      raise exception 'VALIDATION: Goals must be whole percentages from 5 to 100.';
    end if;
  end loop;
  return p_goals;
end;
$$;

-- Defense in depth at the trusted-server boundary. The JavaScript validator
-- performs the same checks before the RPC and provides more detailed errors.
create function workspace_private.normalize_call(p_call jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_key text; v_id text; v_ucid text; v_account text; v_day date;
  v_before jsonb; v_kept jsonb; v_orders jsonb; v_item jsonb;
  v_count integer; v_distinct integer; v_lines integer := 0;
  v_revision numeric := 1; v_order numeric;
begin
  if p_call is null or pg_catalog.jsonb_typeof(p_call) <> 'object' then
    raise exception 'VALIDATION: A call must be an object.';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p_call) loop
    if v_key <> all(array['id','day','time','order','ucid','account','before','kept','mobileOrders','soldLines','sold','revision']) then
      raise exception 'VALIDATION: The call contains an unsupported field.';
    end if;
  end loop;
  if pg_catalog.jsonb_typeof(p_call->'id') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_call->'ucid') is distinct from 'string'
    or pg_catalog.jsonb_typeof(p_call->'account') is distinct from 'string' then
    raise exception 'VALIDATION: Call identifiers must be text.';
  end if;
  v_id := pg_catalog.btrim(p_call->>'id');
  v_ucid := pg_catalog.btrim(p_call->>'ucid');
  v_account := pg_catalog.btrim(p_call->>'account');
  if pg_catalog.char_length(v_id) not between 1 and 100
    or pg_catalog.char_length(v_ucid) > 100 or pg_catalog.char_length(v_account) > 100
    or v_id ~ '[[:cntrl:]]' or v_ucid ~ '[[:cntrl:]]' or v_account ~ '[[:cntrl:]]' then
    raise exception 'VALIDATION: Call identifiers are invalid or too long.';
  end if;
  if pg_catalog.jsonb_typeof(p_call->'day') is distinct from 'string'
    or (p_call->>'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or pg_catalog.jsonb_typeof(p_call->'time') is distinct from 'string'
    or (p_call->>'time') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'VALIDATION: Call date or time is invalid.';
  end if;
  begin
    v_day := pg_catalog.make_date(pg_catalog.substring(p_call->>'day',1,4)::integer,
      pg_catalog.substring(p_call->>'day',6,2)::integer, pg_catalog.substring(p_call->>'day',9,2)::integer);
  exception when datetime_field_overflow then
    raise exception 'VALIDATION: Call date is invalid.';
  end;
  if pg_catalog.jsonb_typeof(p_call->'order') is distinct from 'number' then
    raise exception 'VALIDATION: Call sorting time is invalid.';
  end if;
  v_order := (p_call->>'order')::numeric;
  if v_order < 0 or v_order > 1.7976931348623157e308 then
    raise exception 'VALIDATION: Call sorting time is invalid.';
  end if;
  if p_call ? 'revision' then
    if pg_catalog.jsonb_typeof(p_call->'revision') is distinct from 'number' then
      raise exception 'VALIDATION: Call revision is invalid.';
    end if;
    v_revision := (p_call->>'revision')::numeric;
    if v_revision <> pg_catalog.trunc(v_revision) or v_revision not between 1 and 9007199254740991 then
      raise exception 'VALIDATION: Call revision is invalid.';
    end if;
  end if;
  v_before := p_call->'before'; v_kept := p_call->'kept'; v_orders := p_call->'mobileOrders';
  if pg_catalog.jsonb_typeof(v_before) is distinct from 'array'
    or pg_catalog.jsonb_typeof(v_kept) is distinct from 'array'
    or pg_catalog.jsonb_typeof(v_orders) is distinct from 'array' then
    raise exception 'VALIDATION: Services and mobile orders must be arrays.';
  end if;
  if pg_catalog.jsonb_array_length(v_before) not between 1 and 4
    or pg_catalog.jsonb_array_length(v_kept) > 4 or pg_catalog.jsonb_array_length(v_orders) > 20 then
    raise exception 'VALIDATION: Choose 1–4 starting services and at most 20 mobile orders.';
  end if;
  select pg_catalog.count(*), pg_catalog.count(distinct value) into v_count, v_distinct
    from pg_catalog.jsonb_array_elements(v_before);
  if v_count <> v_distinct then raise exception 'VALIDATION: Starting services must be distinct.'; end if;
  select pg_catalog.count(*), pg_catalog.count(distinct value) into v_count, v_distinct
    from pg_catalog.jsonb_array_elements(v_kept);
  if v_count <> v_distinct then raise exception 'VALIDATION: Kept services must be distinct.'; end if;
  for v_item in select value from pg_catalog.jsonb_array_elements(v_before) loop
    if pg_catalog.jsonb_typeof(v_item) <> 'string'
      or (v_item #>> '{}') <> all(array['internet','tv','phone','mobile']) then
      raise exception 'VALIDATION: Unknown starting service.';
    end if;
  end loop;
  for v_item in select value from pg_catalog.jsonb_array_elements(v_kept) loop
    if not (v_before @> pg_catalog.jsonb_build_array(v_item)) then
      raise exception 'VALIDATION: Kept services must be starting services.';
    end if;
  end loop;
  for v_item in select value from pg_catalog.jsonb_array_elements(v_orders) loop
    if pg_catalog.jsonb_typeof(v_item) <> 'number' then
      raise exception 'VALIDATION: Each mobile order must contain 1–12 lines.';
    end if;
    if (v_item::text)::numeric <> pg_catalog.trunc((v_item::text)::numeric)
      or (v_item::text)::numeric not between 1 and 12 then
      raise exception 'VALIDATION: Each mobile order must contain 1–12 lines.';
    end if;
    v_lines := v_lines + (v_item::text)::integer;
  end loop;
  if p_call->'soldLines' is distinct from pg_catalog.to_jsonb(v_lines)
    or p_call->'sold' is distinct from pg_catalog.to_jsonb(v_lines > 0) then
    raise exception 'VALIDATION: Mobile line totals do not match the orders.';
  end if;
  select coalesce(pg_catalog.jsonb_agg(s.service order by s.position), '[]'::jsonb) into v_before
    from (values ('internet',1),('tv',2),('phone',3),('mobile',4)) as s(service,position)
    where v_before ? s.service;
  select coalesce(pg_catalog.jsonb_agg(s.service order by s.position), '[]'::jsonb) into v_kept
    from (values ('internet',1),('tv',2),('phone',3),('mobile',4)) as s(service,position)
    where v_kept ? s.service;
  return pg_catalog.jsonb_build_object('id',v_id,'day',p_call->>'day','time',p_call->>'time','order',v_order,
    'ucid',v_ucid,'account',v_account,'before',v_before,'kept',v_kept,'mobileOrders',v_orders,
    'soldLines',v_lines,'sold',v_lines > 0,'revision',v_revision);
end;
$$;

create function workspace_private.lock_user(p_user_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('call-workspace:' || p_user_id::text, 0));
  if not exists(select 1 from workspace_private.users where id = p_user_id) then
    raise exception 'VALIDATION: The workspace does not exist.';
  end if;
end;
$$;

create function workspace_private.state(p_user_id uuid) returns jsonb
language sql volatile set search_path = '' as $$
  select pg_catalog.jsonb_build_object('version',3,
    'calls',coalesce((select pg_catalog.jsonb_agg(c.record order by (c.record->>'order')::numeric, c.id)
      from workspace_private.calls as c where c.user_id = p_user_id),'[]'::jsonb),
    'goals',workspace_private.default_goals() || u.goals)
  from workspace_private.users as u where u.id = p_user_id;
$$;

create function workspace_private.check_capacity(p_user_id uuid) returns void
language plpgsql set search_path = '' as $$
begin
  if (select pg_catalog.count(*) from workspace_private.calls where user_id = p_user_id) > 10000 then
    raise exception 'LIMIT: This workspace has reached the 10,000-call limit.';
  end if;
  if pg_catalog.octet_length(workspace_private.state(p_user_id)::text) > 3145728 then
    raise exception 'LIMIT: This change would exceed the 3 MiB workspace limit. Download a backup before removing older records.';
  end if;
end;
$$;

-- Authentication RPCs return hashes only to the trusted server. Plain passwords
-- and raw session tokens are never accepted by or stored in this database.
create function public.auth_register(p_username text, p_password_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_user workspace_private.users%rowtype; v_username text := pg_catalog.btrim(p_username);
begin
  if v_username is null or pg_catalog.char_length(v_username) not between 1 and 64
    or p_password_hash is null or pg_catalog.char_length(p_password_hash) not between 1 and 2048 then
    raise exception 'VALIDATION: Enter a username and password.';
  end if;
  insert into workspace_private.users(username,username_key,password_hash)
    values(v_username,pg_catalog.lower(v_username),p_password_hash) returning * into v_user;
  return pg_catalog.jsonb_build_object('id',v_user.id,'username',v_user.username);
exception when unique_violation then
  raise exception 'DUPLICATE: That username is already in use.';
end;
$$;

create function public.auth_get_user(p_username_key text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('id',id,'username',username,'password_hash',password_hash)
    from workspace_private.users where username_key = pg_catalog.lower(pg_catalog.btrim(p_username_key));
$$;

create function public.auth_create_session(p_user_id uuid, p_token_hash text, p_expires_at timestamptz) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
    or p_expires_at is null or p_expires_at <= pg_catalog.clock_timestamp()
    or p_expires_at > pg_catalog.clock_timestamp() + interval '31 days' then
    raise exception 'VALIDATION: Session parameters are invalid.';
  end if;
  delete from workspace_private.sessions where expires_at <= pg_catalog.clock_timestamp();
  insert into workspace_private.sessions(user_id,token_hash,expires_at) values(p_user_id,p_token_hash,p_expires_at);
  return pg_catalog.jsonb_build_object('ok',true);
end;
$$;

create function public.auth_session(p_token_hash text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select pg_catalog.jsonb_build_object('id',u.id,'username',u.username)
    from workspace_private.sessions as s join workspace_private.users as u on u.id = s.user_id
    where s.token_hash = p_token_hash and s.expires_at > pg_catalog.statement_timestamp();
$$;

create function public.auth_logout(p_token_hash text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  delete from workspace_private.sessions where token_hash = p_token_hash;
  return pg_catalog.jsonb_build_object('ok',true);
end;
$$;

-- Fixed-window counters are atomic across all server instances. Call once for
-- both the hashed IP bucket and hashed username bucket before doing password work.
create function public.auth_rate_limit(p_key text, p_limit integer, p_window_seconds integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_now timestamptz := pg_catalog.clock_timestamp(); v_attempts integer;
begin
  if p_key is null or pg_catalog.char_length(p_key) not between 1 and 256
    or p_limit is null or p_limit not between 1 and 10000
    or p_window_seconds is null or p_window_seconds not between 1 and 86400 then
    raise exception 'VALIDATION: Rate-limit parameters are invalid.';
  end if;
  delete from workspace_private.auth_limits where window_started < v_now - interval '2 days';
  insert into workspace_private.auth_limits as existing(bucket_key,window_started,attempts)
    values(p_key,v_now,1)
    on conflict(bucket_key) do update set
      window_started = case when existing.window_started <= v_now - pg_catalog.make_interval(secs => p_window_seconds) then v_now else existing.window_started end,
      attempts = case when existing.window_started <= v_now - pg_catalog.make_interval(secs => p_window_seconds) then 1 else least(existing.attempts + 1,p_limit + 1) end
    returning attempts into v_attempts;
  return v_attempts <= p_limit;
end;
$$;

create function public.workspace_state(p_user_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare v_state jsonb;
begin
  v_state := workspace_private.state(p_user_id);
  if v_state is null then raise exception 'VALIDATION: The workspace does not exist.'; end if;
  return v_state;
end;
$$;

create function public.workspace_save(p_user_id uuid, p_call jsonb, p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_call jsonb; v_current workspace_private.calls%rowtype; v_last bigint; v_ucid text;
begin
  v_call := workspace_private.normalize_call(p_call);
  perform workspace_private.lock_user(p_user_id);
  select * into v_current from workspace_private.calls where user_id = p_user_id and id = v_call->>'id';
  if v_current.id is null and p_expected_revision is not null then
    raise exception 'CONFLICT: This call was removed. Refresh before editing again.';
  elsif v_current.id is not null and (p_expected_revision is null or v_current.revision <> p_expected_revision) then
    raise exception 'CONFLICT: This call changed. Refresh before editing again.';
  end if;
  v_ucid := nullif(pg_catalog.lower(v_call->>'ucid'),'');
  if v_ucid is not null and exists(select 1 from workspace_private.calls
    where user_id = p_user_id and ucid_key = v_ucid and id <> v_call->>'id') then
    raise exception 'DUPLICATE: That UCID is already logged in your workspace.';
  end if;
  select revision into v_last from workspace_private.call_versions where user_id = p_user_id and id = v_call->>'id';
  v_last := coalesce(v_last,v_current.revision,0);
  if v_last >= 9007199254740991 or v_last < coalesce(v_current.revision,0) then
    raise exception 'CONFLICT: The call revision cannot be advanced safely.';
  end if;
  v_call := v_call || pg_catalog.jsonb_build_object('revision',v_last + 1);
  insert into workspace_private.calls(user_id,id,record,revision) values(p_user_id,v_call->>'id',v_call,v_last + 1)
    on conflict(user_id,id) do update set record = excluded.record, revision = excluded.revision;
  insert into workspace_private.call_versions(user_id,id,revision) values(p_user_id,v_call->>'id',v_last + 1)
    on conflict(user_id,id) do update set revision = excluded.revision;
  perform workspace_private.check_capacity(p_user_id);
  return v_call;
end;
$$;

create function public.workspace_remove(p_user_id uuid, p_id text, p_expected_revision bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_current workspace_private.calls%rowtype;
begin
  perform workspace_private.lock_user(p_user_id);
  select * into v_current from workspace_private.calls where user_id = p_user_id and id = p_id;
  if v_current.id is null then raise exception 'CONFLICT: This call has already been removed.'; end if;
  if p_expected_revision is null or v_current.revision <> p_expected_revision then
    raise exception 'CONFLICT: This call changed. Refresh before removing it.';
  end if;
  if v_current.revision >= 9007199254740991 then raise exception 'CONFLICT: The call revision cannot be advanced safely.'; end if;
  delete from workspace_private.calls where user_id = p_user_id and id = p_id;
  insert into workspace_private.call_versions(user_id,id,revision) values(p_user_id,p_id,v_current.revision + 1)
    on conflict(user_id,id) do update set revision = excluded.revision;
  return v_current.record;
end;
$$;

create function public.workspace_restore(p_user_id uuid, p_call jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_call jsonb; v_last bigint; v_ucid text;
begin
  v_call := workspace_private.normalize_call(p_call);
  perform workspace_private.lock_user(p_user_id);
  if exists(select 1 from workspace_private.calls where user_id = p_user_id and id = v_call->>'id') then
    raise exception 'CONFLICT: This call has already been restored or changed.';
  end if;
  select revision into v_last from workspace_private.call_versions where user_id = p_user_id and id = v_call->>'id';
  if v_last is null or v_last <> (v_call->>'revision')::bigint + 1 or v_last >= 9007199254740991 then
    raise exception 'CONFLICT: A newer change prevents this Undo.';
  end if;
  v_ucid := nullif(pg_catalog.lower(v_call->>'ucid'),'');
  if v_ucid is not null and exists(select 1 from workspace_private.calls where user_id = p_user_id and ucid_key = v_ucid) then
    raise exception 'DUPLICATE: Another call now uses this UCID. Undo cannot restore it.';
  end if;
  v_call := v_call || pg_catalog.jsonb_build_object('revision',v_last + 1);
  insert into workspace_private.calls(user_id,id,record,revision) values(p_user_id,v_call->>'id',v_call,v_last + 1);
  update workspace_private.call_versions set revision = v_last + 1 where user_id = p_user_id and id = v_call->>'id';
  perform workspace_private.check_capacity(p_user_id);
  return v_call;
end;
$$;

create function public.workspace_goal(p_user_id uuid, p_key text, p_value integer) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if p_key is null or not (workspace_private.default_goals() ? p_key) or p_value is null or p_value not between 5 and 100 then
    raise exception 'VALIDATION: Choose a known goal and a whole percentage from 5 to 100.';
  end if;
  perform workspace_private.lock_user(p_user_id);
  update workspace_private.users set goals = goals || pg_catalog.jsonb_build_object(p_key,p_value) where id = p_user_id;
  perform workspace_private.check_capacity(p_user_id);
  return p_value;
end;
$$;

create function public.workspace_import(p_user_id uuid, p_backup jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_input jsonb; v_call jsonb; v_current workspace_private.calls%rowtype;
  v_goals jsonb; v_last bigint; v_ucid text; v_imported integer := 0; v_skipped integer := 0;
  v_key text;
begin
  if p_backup is null or pg_catalog.jsonb_typeof(p_backup) <> 'object'
    or p_backup->'version' is distinct from '3'::jsonb
    or pg_catalog.jsonb_typeof(p_backup->'calls') is distinct from 'array' then
    raise exception 'VALIDATION: Choose a valid version 3 backup.';
  end if;
  for v_key in select pg_catalog.jsonb_object_keys(p_backup) loop
    if v_key <> all(array['version','calls','goals','exportedAt']) then raise exception 'VALIDATION: The backup contains an unsupported field.'; end if;
  end loop;
  if pg_catalog.jsonb_array_length(p_backup->'calls') > 10000 then raise exception 'LIMIT: A backup may contain at most 10,000 calls.'; end if;
  if exists(select 1 from pg_catalog.jsonb_array_elements(p_backup->'calls') as incoming(call)
      group by pg_catalog.btrim(call->>'id') having pg_catalog.count(*) > 1)
    or exists(select 1 from pg_catalog.jsonb_array_elements(p_backup->'calls') as incoming(call)
      where nullif(pg_catalog.btrim(call->>'ucid'),'') is not null
      group by pg_catalog.lower(pg_catalog.btrim(call->>'ucid')) having pg_catalog.count(*) > 1) then
    raise exception 'VALIDATION: The backup contains duplicate call IDs or UCIDs. Nothing was imported.';
  end if;
  v_goals := workspace_private.validate_goals(p_backup->'goals');
  perform workspace_private.lock_user(p_user_id);
  for v_input in select value from pg_catalog.jsonb_array_elements(p_backup->'calls') loop
    v_call := workspace_private.normalize_call(v_input);
    v_ucid := nullif(pg_catalog.lower(v_call->>'ucid'),'');
    select * into v_current from workspace_private.calls where user_id = p_user_id and id = v_call->>'id';
    if v_current.id is not null then
      if pg_catalog.jsonb_set(v_current.record - 'revision','{ucid}',pg_catalog.to_jsonb(pg_catalog.lower(v_current.record->>'ucid')))
        = pg_catalog.jsonb_set(v_call - 'revision','{ucid}',pg_catalog.to_jsonb(pg_catalog.lower(v_call->>'ucid'))) then
        v_skipped := v_skipped + 1; continue;
      end if;
      raise exception 'CONFLICT: A backup record conflicts with an existing call. Nothing was imported.';
    end if;
    if v_ucid is not null and exists(select 1 from workspace_private.calls where user_id = p_user_id and ucid_key = v_ucid) then
      raise exception 'CONFLICT: A backup UCID conflicts with an existing call. Nothing was imported.';
    end if;
    select revision into v_last from workspace_private.call_versions where user_id = p_user_id and id = v_call->>'id';
    v_last := coalesce(v_last,0);
    if v_last >= 9007199254740991 then raise exception 'CONFLICT: A call revision cannot be advanced safely. Nothing was imported.'; end if;
    v_call := v_call || pg_catalog.jsonb_build_object('revision',v_last + 1);
    insert into workspace_private.calls(user_id,id,record,revision) values(p_user_id,v_call->>'id',v_call,v_last + 1);
    insert into workspace_private.call_versions(user_id,id,revision) values(p_user_id,v_call->>'id',v_last + 1)
      on conflict(user_id,id) do update set revision = excluded.revision;
    v_imported := v_imported + 1;
  end loop;
  -- Right-hand explicit goals win; imported values fill only unset goals.
  update workspace_private.users set goals = v_goals || goals where id = p_user_id;
  perform workspace_private.check_capacity(p_user_id);
  return pg_catalog.jsonb_build_object('imported',v_imported,'skipped',v_skipped);
end;
$$;

-- Explicit ACLs are required: PostgreSQL and Supabase may otherwise grant new
-- functions to PUBLIC/anon/authenticated through their default privileges.
revoke all on all functions in schema workspace_private from public, anon, authenticated, service_role;
revoke all on function public.auth_register(text,text) from public, anon, authenticated;
revoke all on function public.auth_get_user(text) from public, anon, authenticated;
revoke all on function public.auth_create_session(uuid,text,timestamptz) from public, anon, authenticated;
revoke all on function public.auth_session(text) from public, anon, authenticated;
revoke all on function public.auth_logout(text) from public, anon, authenticated;
revoke all on function public.auth_rate_limit(text,integer,integer) from public, anon, authenticated;
revoke all on function public.workspace_state(uuid) from public, anon, authenticated;
revoke all on function public.workspace_save(uuid,jsonb,bigint) from public, anon, authenticated;
revoke all on function public.workspace_remove(uuid,text,bigint) from public, anon, authenticated;
revoke all on function public.workspace_restore(uuid,jsonb) from public, anon, authenticated;
revoke all on function public.workspace_goal(uuid,text,integer) from public, anon, authenticated;
revoke all on function public.workspace_import(uuid,jsonb) from public, anon, authenticated;

grant execute on function public.auth_register(text,text) to service_role;
grant execute on function public.auth_get_user(text) to service_role;
grant execute on function public.auth_create_session(uuid,text,timestamptz) to service_role;
grant execute on function public.auth_session(text) to service_role;
grant execute on function public.auth_logout(text) to service_role;
grant execute on function public.auth_rate_limit(text,integer,integer) to service_role;
grant execute on function public.workspace_state(uuid) to service_role;
grant execute on function public.workspace_save(uuid,jsonb,bigint) to service_role;
grant execute on function public.workspace_remove(uuid,text,bigint) to service_role;
grant execute on function public.workspace_restore(uuid,jsonb) to service_role;
grant execute on function public.workspace_goal(uuid,text,integer) to service_role;
grant execute on function public.workspace_import(uuid,jsonb) to service_role;

