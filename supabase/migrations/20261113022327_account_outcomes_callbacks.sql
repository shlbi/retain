-- Existing version 3 records keep their compact shape. Extended records keep
-- first-account aliases so that history and exports can still use them.
create or replace function workspace_private.default_goals() returns jsonb
language sql immutable set search_path = '' as $$
  select '{"overall":85,"internet":85,"tv":75,"sp":80,"dp":80,"tp":80,"phone":80,"mobile":75,"orders":20,"sales":20,"bundle":80}'::jsonb;
$$;

create or replace function workspace_private.validate_goals(p_goals jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_defaults jsonb := workspace_private.default_goals(); v_key text; v_value jsonb;
begin
  if pg_catalog.jsonb_typeof(p_goals) is distinct from 'object' then
    raise exception 'VALIDATION: Backup goals must be an object.';
  end if;
  -- The original version 3 backups predate the bundle goal.
  p_goals := pg_catalog.jsonb_build_object('bundle',v_defaults->'bundle') || p_goals;
  if not (p_goals ?& array(select pg_catalog.jsonb_object_keys(v_defaults)))
    or not (v_defaults ?& array(select pg_catalog.jsonb_object_keys(p_goals))) then
    raise exception 'VALIDATION: The backup must contain all recognized goals.';
  end if;
  for v_key, v_value in select key, value from pg_catalog.jsonb_each(p_goals) loop
    if pg_catalog.jsonb_typeof(v_value) <> 'number' then
      raise exception 'VALIDATION: Goals must be whole percentages from 5 to 100.';
    end if;
    if v_value::numeric <> pg_catalog.trunc(v_value::numeric) or v_value::numeric not between 5 and 100 then
      raise exception 'VALIDATION: Goals must be whole percentages from 5 to 100.';
    end if;
  end loop;
  return p_goals;
end;
$$;

-- The fixed service list also gives all arrays a stable ordering for imports.
create function workspace_private.normalize_services(p_services jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_sorted jsonb;
begin
  if pg_catalog.jsonb_typeof(p_services) is distinct from 'array' then
    raise exception 'VALIDATION: Choose services from the service list.';
  end if;
  select pg_catalog.to_jsonb(array(
    select service from pg_catalog.unnest(array['internet','tv','phone','mobile'])
      with ordinality as s(service,position) where p_services ? service order by position
  )) into v_sorted;
  if pg_catalog.jsonb_array_length(v_sorted) <> pg_catalog.jsonb_array_length(p_services) then
    raise exception 'VALIDATION: Services must be distinct and recognized.';
  end if;
  return v_sorted;
end;
$$;

create function workspace_private.normalize_account(p_account jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_number text; v_before jsonb; v_kept jsonb; v_added jsonb;
begin
  if pg_catalog.jsonb_typeof(p_account) is distinct from 'object'
    or p_account - array['account','before','kept','added'] <> '{}'::jsonb then
    raise exception 'VALIDATION: Each account must contain recognized account fields.';
  end if;
  if p_account ? 'account' and pg_catalog.jsonb_typeof(p_account->'account') <> 'string' then
    raise exception 'VALIDATION: Account numbers must be text.';
  end if;
  v_number := pg_catalog.btrim(coalesce(p_account->>'account',''));
  if pg_catalog.char_length(v_number) > 100 or v_number ~ '[[:cntrl:]]' then
    raise exception 'VALIDATION: Account number is invalid or too long.';
  end if;
  v_before := workspace_private.normalize_services(p_account->'before');
  v_kept := workspace_private.normalize_services(p_account->'kept');
  v_added := workspace_private.normalize_services(coalesce(p_account->'added','[]'::jsonb));
  if v_before = '[]'::jsonb or not (v_before @> v_kept) then
    raise exception 'VALIDATION: Choose starting services and keep only services the account started with.';
  end if;
  if v_before ?| array(select pg_catalog.jsonb_array_elements_text(v_added)) then
    raise exception 'VALIDATION: Added services must be new to this account.';
  end if;
  return pg_catalog.jsonb_build_object('account',v_number,'before',v_before,'kept',v_kept,'added',v_added);
end;
$$;

create function workspace_private.normalize_callback(p_callback jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_due text;
begin
  if p_callback = 'null'::jsonb then return p_callback; end if;
  if pg_catalog.jsonb_typeof(p_callback) is distinct from 'object'
    or p_callback - array['approved','dueAt','note','status'] <> '{}'::jsonb then
    raise exception 'VALIDATION: Invalid callback fields.';
  end if;
  if p_callback->'approved' is distinct from 'true'::jsonb then
    raise exception 'VALIDATION: Confirm supervisor approval before scheduling a callback.';
  end if;
  if pg_catalog.jsonb_typeof(p_callback->'note') is distinct from 'string'
    or pg_catalog.char_length(p_callback->>'note') > 2000 then
    raise exception 'VALIDATION: Callback notes must be text up to 2,000 characters.';
  end if;
  if pg_catalog.jsonb_typeof(p_callback->'status') is distinct from 'string'
    or p_callback->>'status' not in ('scheduled','done') then
    raise exception 'VALIDATION: Invalid callback status.';
  end if;
  v_due := p_callback->>'dueAt';
  if pg_catalog.jsonb_typeof(p_callback->'dueAt') is distinct from 'string'
    or v_due !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?Z$' then
    raise exception 'VALIDATION: Choose a valid UTC callback date and time.';
  end if;
  begin
    perform pg_catalog.make_date(pg_catalog.substr(v_due,1,4)::int,
      pg_catalog.substr(v_due,6,2)::int, pg_catalog.substr(v_due,9,2)::int);
  exception when datetime_field_overflow then
    raise exception 'VALIDATION: Choose a valid callback date.';
  end;
  v_due := pg_catalog.substr(v_due,1,19) || '.' ||
    pg_catalog.rpad(coalesce(substring(v_due from '[.]([0-9]+)Z$'),''),3,'0') || 'Z';
  return p_callback || pg_catalog.jsonb_build_object('dueAt',v_due);
end;
$$;

-- Reuse the original identifier, timestamp, sales and revision validation.
alter function workspace_private.normalize_call(jsonb) rename to normalize_call_core;
create function workspace_private.normalize_call(p_call jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare v_base jsonb; v_accounts jsonb; v_first jsonb;
begin
  if pg_catalog.jsonb_typeof(p_call) is distinct from 'object' then
    raise exception 'VALIDATION: A call must be an object.';
  end if;
  v_base := p_call - 'accounts' - 'callback';
  if p_call ? 'accounts' then
    if pg_catalog.jsonb_typeof(p_call->'accounts') <> 'array' then
      raise exception 'VALIDATION: Accounts must be an array.';
    end if;
    select pg_catalog.jsonb_agg(workspace_private.normalize_account(a.account) order by a.position)
      into v_accounts from pg_catalog.jsonb_array_elements(p_call->'accounts') with ordinality as a(account,position);
    if v_accounts is null then raise exception 'VALIDATION: A call must include at least one account.'; end if;
    v_first := (v_accounts->0) - 'added';
    -- Fill absent aliases, while allowing the core validator to check supplied ones.
    v_base := v_first || v_base;
  end if;
  v_base := workspace_private.normalize_call_core(v_base);
  if v_accounts is not null then
    if v_base->'account' <> v_first->'account' or v_base->'before' <> v_first->'before'
      or v_base->'kept' <> v_first->'kept' then
      raise exception 'VALIDATION: The account number and services must match the first account.';
    end if;
    v_base := v_base || pg_catalog.jsonb_build_object('accounts',v_accounts);
  end if;
  if p_call ? 'callback' then
    v_base := v_base || pg_catalog.jsonb_build_object('callback',workspace_private.normalize_callback(p_call->'callback'));
  end if;
  return v_base;
end;
$$;

-- Treat a compact legacy call and the same explicit single-account call as
-- identical on import. Meaningful account or callback differences still conflict.
create function workspace_private.comparable_call(p_call jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select (p_call - 'revision') || pg_catalog.jsonb_build_object(
    'ucid',pg_catalog.lower(p_call->>'ucid'),
    'accounts',coalesce(p_call->'accounts',pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'account',p_call->'account','before',p_call->'before','kept',p_call->'kept','added','[]'::jsonb))),
    'callback',p_call->'callback');
$$;

create or replace function public.workspace_save(p_user_id uuid, p_call jsonb, p_expected_revision bigint default null) returns jsonb
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
  -- Older clients can edit a single-account call, but cannot represent these fields.
  if (not (v_call ? 'accounts') and (pg_catalog.jsonb_array_length(v_current.record->'accounts') > 1
        or pg_catalog.jsonb_array_length(v_current.record#>'{accounts,0,added}') > 0))
    or (not (v_call ? 'callback') and pg_catalog.jsonb_typeof(v_current.record->'callback') = 'object') then
    raise exception 'CONFLICT: Refresh the app to edit all accounts and callbacks on this call.';
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

create or replace function public.workspace_import(p_user_id uuid, p_backup jsonb) returns jsonb
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
      if workspace_private.comparable_call(v_current.record) = workspace_private.comparable_call(v_call) then
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

-- Replaced public RPCs retain their original execute grants.
revoke all on all functions in schema workspace_private from public, anon, authenticated, service_role;
