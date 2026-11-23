create or replace function workspace_private.default_goals() returns jsonb
language sql immutable set search_path = '' as $$
  select '{"overall":85,"internet":85,"tv":75,"sp":80,"dp":80,"tp":80,"phone":80,"mobile":75,"orders":20,"sales":20,"bundle":80,"lineSave":75,"spInternet":85,"exactTp":80,"subscriber":85}'::jsonb;
$$;

-- Preserve previously assigned targets as initial values for the replacement rates.
update workspace_private.users set goals=goals || jsonb_strip_nulls(jsonb_build_object(
 'lineSave',goals->'mobile','subscriber',goals->'overall','exactTp',goals->'tp','spInternet',goals->'internet'));
-- Optional balances keep unmeasured historical groups distinct. Call identifiers are never stored.
create function workspace_private.line_tags(g jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare n integer; e integer;
begin
  if not g ?| array['lineStart','lineEnd'] then return '{}'::jsonb; end if;
  n := workspace_private.tally_int(g->'lineStart',1,999);
  e := workspace_private.tally_int(g->'lineEnd',0,999);
  if not g ?& array['lineStart','lineEnd'] or not ((g->'before') ? 'mobile')
    or (((g->'kept') ? 'mobile') <> (e > 0)) then
    raise exception 'VALIDATION: Check starting and ending mobile lines.';
  end if;
  return jsonb_build_object('lineStart',n,'lineEnd',e);
end;
$$;
revoke all on function workspace_private.line_tags(jsonb) from public,anon,authenticated,service_role;

create or replace function workspace_private.workspace_tally(p_user_id uuid, p_day date, p_delta jsonb, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_retry_key bytea; v_signature bytea;
  v_group jsonb; v_tags jsonb; v_groups jsonb := '[]'; v_count integer;
  v_eligible integer := 0; v_saved integer := 0; v_orders integer; v_lines integer;
begin
  if p_request_id is null or p_request_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_day is null or p_day not between date '0001-01-01' and date '9999-12-31'
    or jsonb_typeof(p_delta) is distinct from 'object'
    or p_delta - array['calls','eligibleCalls','savedCalls','saleCalls','mobileOrders','mobileLines','groups'] <> '{}'
    or p_delta->'calls' is distinct from '1'::jsonb
    or jsonb_typeof(p_delta->'groups') is distinct from 'array' or p_delta->'groups'='[]' then
    raise exception 'VALIDATION: Expected daily counters and grouped service outcomes.';
  end if;
  v_orders := workspace_private.tally_int(p_delta->'mobileOrders',0,20);
  v_lines := workspace_private.tally_int(p_delta->'mobileLines',v_orders,v_orders*12);
  if p_delta->'saleCalls' is distinct from to_jsonb((v_orders>0)::int) then
    raise exception 'VALIDATION: Mobile order counts disagree.';
  end if;
  for v_group in select value from jsonb_array_elements(p_delta->'groups') loop
    if jsonb_typeof(v_group) is distinct from 'object'
      or v_group - array['before','kept','added','washed','count','lineStart','lineEnd'] <> '{}'
      or not (v_group ?& array['before','kept','added','washed','count'])
      or jsonb_typeof(v_group->'washed') is distinct from 'boolean' then
      raise exception 'VALIDATION: Unexpected outcome fields.';
    end if;
    v_count := workspace_private.tally_int(v_group->'count',1,2147483647);
    v_tags := (workspace_private.normalize_account(v_group - 'washed' - 'count' - 'lineStart' - 'lineEnd') - 'account') || workspace_private.line_tags(v_group);
    v_tags := v_tags || jsonb_build_object('washed',v_group->'washed');
    if (v_tags->>'washed')::boolean then
      if v_tags->'kept' <> '[]' and v_tags->'kept' <> v_tags->'before' then
        raise exception 'VALIDATION: A partial save cannot be washed.';
      end if;
    else
      v_eligible := 1;
      if v_tags->'kept' <> '[]' then v_saved := 1; end if;
    end if;
    v_groups := v_groups || jsonb_build_array(v_tags || jsonb_build_object('count',v_count));
  end loop;
  if p_delta->'eligibleCalls' is distinct from to_jsonb(v_eligible) or p_delta->'savedCalls' is distinct from to_jsonb(v_saved) then
    raise exception 'VALIDATION: Overall counts disagree with grouped outcomes.';
  end if;
  if exists(select 1 from jsonb_array_elements(v_groups) g group by (g-'count') having count(*)>1) then
    raise exception 'VALIDATION: Duplicate outcome groups.';
  end if;
  -- All possible full saves and losses of a matching original mix must pair, and both sides balance.
  if exists(select 1 from jsonb_array_elements(v_groups) g group by (g->'before')
    having sum(case when g->'washed'='true' then (g->>'count')::bigint *
      (case when g->'kept'='[]' then -1 else 1 end) else 0 end) <> 0
    or (bool_or(g->'washed'='false' and g->'kept'='[]') and
        bool_or(g->'washed'='false' and g->'kept'=g->'before'))) then
    raise exception 'VALIDATION: Wash pairs do not match.';
  end if;
  perform workspace_private.lock_user(p_user_id);
  -- Hash the random retry token. The receipt stores neither its date, tags, nor its original token.
  v_retry_key := sha256(uuid_send(p_request_id));
  v_signature := sha256(uuid_send(p_request_id) || date_send(p_day) || convert_to(p_delta::text,'UTF8'));
  insert into workspace_private.tally_receipts values(p_user_id,v_retry_key,v_signature) on conflict do nothing;
  if found then
    insert into workspace_private.tally_days as d values(p_user_id,p_day,1,v_eligible,v_saved,(v_orders>0)::int,v_orders,v_lines)
      on conflict(user_id,day) do update set calls=d.calls+1, eligible_calls=d.eligible_calls+excluded.eligible_calls,
        saved_calls=d.saved_calls+excluded.saved_calls,sale_calls=d.sale_calls+excluded.sale_calls,
        mobile_orders=d.mobile_orders+excluded.mobile_orders,mobile_lines=d.mobile_lines+excluded.mobile_lines;
    insert into workspace_private.tally_groups as g
      select p_user_id,p_day,item-'count',(item->>'count')::bigint from jsonb_array_elements(v_groups) item
      on conflict(user_id,day,tags) do update set accounts=g.accounts+excluded.accounts;
  elsif not exists(select 1 from workspace_private.tally_receipts
         where user_id=p_user_id and retry_key=v_retry_key and retry_signature=v_signature) then
    raise exception 'CONFLICT: The save token was already used for a different tally.';
  end if;
  return workspace_private.tally_day(p_user_id,p_day);
end;
$$;

create or replace function workspace_private.validate_edited_day(p_day jsonb) returns void
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
      or v_group - array['before','kept','added','washed','count','lineStart','lineEnd'] <> '{}'
      or jsonb_typeof(v_group->'count') is distinct from 'number'
      or (v_group->>'count')::numeric not between 1 and 9007199254740991
      or trunc((v_group->>'count')::numeric) <> (v_group->>'count')::numeric
      or jsonb_typeof(v_group->'washed') is distinct from 'boolean' then
      raise exception 'VALIDATION: Check outcome groups and account counts.';
    end if;
    v_tags := (workspace_private.normalize_account(v_group-'count'-'washed'-'lineStart'-'lineEnd')-'account') || workspace_private.line_tags(v_group);
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

notify pgrst,'reload schema';

create or replace function workspace_private.bingo_delta(p_delta jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  with successes as (
    select credit.metric, sum((g->>'count')::bigint * (case when credit.metric='lineSave' then least((g->>'lineStart')::integer,(g->>'lineEnd')::integer) else 1 end)) as amount
    from jsonb_array_elements(p_delta->'groups') g
    cross join lateral (
      select jsonb_array_elements_text(g->'added') as metric
      union all select 'lineSave' where g->'washed'='false' and g ? 'lineStart'
      union all select 'subscriber' where g->'washed'='false' and g->'kept'<>'[]'
      union all select 'spInternet' where g->'washed'='false' and g->'before'=jsonb_build_array('internet'::text) and g->'kept'=g->'before'
      union all
      select k from jsonb_array_elements_text(g->'kept') k where g->'washed'='false'
      union all
      select case jsonb_array_length(g->'before') when 1 then 'sp' when 2 then 'dp' else 'tp' end
        where g->'washed'='false' and g->'kept' = g->'before' and jsonb_array_length(g->'before')<=3
    ) credit group by credit.metric
  )
  select jsonb_build_object('calls',1,'savedCalls',p_delta->'savedCalls',
    'mobileOrders',p_delta->'mobileOrders','mobileLines',p_delta->'mobileLines')
    || coalesce((select jsonb_object_agg(metric,amount) from successes),'{}');
$$;
