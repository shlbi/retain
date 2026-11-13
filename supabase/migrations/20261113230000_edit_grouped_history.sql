-- Corrections replace a complete day atomically. The original snapshot prevents lost updates.
create function workspace_private.validate_edited_day(p_day jsonb) returns void
language plpgsql set search_path = '' as $$
declare
  v_key text; v_group jsonb; v_tags jsonb; v_accounts numeric := 0;
  v_unwashed numeric := 0; v_saved numeric := 0;
begin
  if jsonb_typeof(p_day) is distinct from 'object'
    or not (p_day ?& array['day','calls','eligibleCalls','savedCalls','saleCalls','mobileOrders','mobileLines','groups'])
    or p_day - array['day','calls','eligibleCalls','savedCalls','saleCalls','mobileOrders','mobileLines','groups'] <> '{}'
    or jsonb_typeof(p_day->'day') is distinct from 'string'
    or (p_day->>'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or jsonb_typeof(p_day->'groups') is distinct from 'array'
    or jsonb_array_length(p_day->'groups') = 0 then
    raise exception 'VALIDATION: Check the report date, outcomes and daily totals.';
  end if;
  perform (p_day->>'day')::date;
  foreach v_key in array array['calls','eligibleCalls','savedCalls','saleCalls','mobileOrders','mobileLines'] loop
    if jsonb_typeof(p_day->v_key) is distinct from 'number'
      or (p_day->>v_key)::numeric not between 0 and 9007199254740991
      or trunc((p_day->>v_key)::numeric) <> (p_day->>v_key)::numeric then
      raise exception 'VALIDATION: Totals must be nonnegative whole numbers.';
    end if;
  end loop;
  for v_group in select value from jsonb_array_elements(p_day->'groups') loop
    if jsonb_typeof(v_group) is distinct from 'object'
      or not (v_group ?& array['before','kept','added','washed','count'])
      or v_group - array['before','kept','added','washed','count'] <> '{}'
      or jsonb_typeof(v_group->'count') is distinct from 'number'
      or (v_group->>'count')::numeric not between 1 and 9007199254740991
      or trunc((v_group->>'count')::numeric) <> (v_group->>'count')::numeric
      or jsonb_typeof(v_group->'washed') is distinct from 'boolean' then
      raise exception 'VALIDATION: Check outcome groups and account counts.';
    end if;
    v_tags := workspace_private.normalize_account(v_group-'count'-'washed')-'account';
    if v_tags <> v_group-'count'-'washed' then
      raise exception 'VALIDATION: Check the selected services.';
    end if;
    v_accounts := v_accounts+(v_group->>'count')::numeric;
    if v_group->'washed' = 'true' then
      if v_group->'kept' <> '[]' and v_group->'kept' <> v_group->'before' then
        raise exception 'VALIDATION: Wash outcomes must be full saves or full disconnects.';
      end if;
    else
      v_unwashed := v_unwashed+(v_group->>'count')::numeric;
      if v_group->'kept' <> '[]' then v_saved := v_saved+(v_group->>'count')::numeric; end if;
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(p_day->'groups') g group by (g-'count') having count(*)>1)
    or exists(select 1 from jsonb_array_elements(p_day->'groups') g where g->'washed'='true'
      group by g->'before' having sum((g->>'count')::numeric * (case when g->'kept'='[]' then -1 else 1 end))<>0)
    or v_accounts>9007199254740991 or v_accounts<(p_day->>'calls')::numeric
    or (p_day->>'calls')::numeric<1
    or (p_day->>'savedCalls')::numeric>(p_day->>'eligibleCalls')::numeric
    or (p_day->>'eligibleCalls')::numeric>(p_day->>'calls')::numeric
    or (p_day->>'eligibleCalls')::numeric>v_unwashed
    or (v_unwashed=0) <> ((p_day->>'eligibleCalls')::numeric=0)
    or (p_day->>'savedCalls')::numeric>v_saved
    or (v_saved=0) <> ((p_day->>'savedCalls')::numeric=0)
    or (p_day->>'saleCalls')::numeric>(p_day->>'calls')::numeric
    or (p_day->>'mobileOrders')::numeric not between (p_day->>'saleCalls')::numeric and 20*(p_day->>'saleCalls')::numeric
    or (p_day->>'mobileLines')::numeric not between (p_day->>'mobileOrders')::numeric and 12*(p_day->>'mobileOrders')::numeric then
    raise exception 'VALIDATION: Call totals, account outcomes, wash pairs or mobile totals disagree.';
  end if;
end;
$$;

create function public.workspace_edit_day(p_user_id uuid,p_expected jsonb,p_replacement jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_current jsonb; v_day date;
begin
  perform workspace_private.validate_edited_day(p_expected);
  perform workspace_private.validate_edited_day(p_replacement);
  if p_expected->'day' <> p_replacement->'day' then
    raise exception 'VALIDATION: Choose the same report date.';
  end if;
  v_day := (p_expected->>'day')::date;
  perform workspace_private.lock_user(p_user_id);
  v_current := workspace_private.tally_day(p_user_id,v_day);
  -- Canonicalize array ordering for comparison. Repeating a confirmed edit is harmless.
  p_expected := jsonb_set(p_expected,'{groups}',(select jsonb_agg(g order by g-'count') from jsonb_array_elements(p_expected->'groups') g));
  p_replacement := jsonb_set(p_replacement,'{groups}',(select jsonb_agg(g order by g-'count') from jsonb_array_elements(p_replacement->'groups') g));
  if v_current = p_replacement then return v_current; end if;
  if v_current is distinct from p_expected then
    raise exception 'CONFLICT: This day changed after you opened it. Close the editor and reopen it to review the latest totals.';
  end if;
  update workspace_private.tally_days set
    calls=(p_replacement->>'calls')::bigint,eligible_calls=(p_replacement->>'eligibleCalls')::bigint,
    saved_calls=(p_replacement->>'savedCalls')::bigint,sale_calls=(p_replacement->>'saleCalls')::bigint,
    mobile_orders=(p_replacement->>'mobileOrders')::bigint,mobile_lines=(p_replacement->>'mobileLines')::bigint
    where user_id=p_user_id and day=v_day;
  delete from workspace_private.tally_groups where user_id=p_user_id and day=v_day;
  insert into workspace_private.tally_groups(user_id,day,tags,accounts)
    select p_user_id,v_day,g-'count',(g->>'count')::bigint from jsonb_array_elements(p_replacement->'groups') g;
  return workspace_private.tally_day(p_user_id,v_day);
end;
$$;
revoke all on function workspace_private.validate_edited_day(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.workspace_edit_day(uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.workspace_edit_day(uuid,jsonb,jsonb) to service_role;
notify pgrst, 'reload schema';
