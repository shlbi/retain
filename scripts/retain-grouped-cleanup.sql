-- Retain production cutover and legacy call cleanup.
-- Stop call entry and coordinate the grouped-tallies app release before running.
-- This transaction permanently removes the old call log and callback reminders.
-- It retains grouped daily counts, mobile sales, agent sign-ins and goals.
-- The result shows only pass/fail indicators. Run the whole file as one query.
begin;
set local lock_timeout = '10s';
set local search_path = pg_catalog, pg_temp;
lock table supabase_migrations.schema_migrations in share row exclusive mode;

do $cutover$
declare
  migration_sql constant text := $grouped_migration$
-- The live application stores daily counters, independent grouped account outcomes,
-- and opaque idempotency receipts. No table links a new entry to an individual call.
create table workspace_private.tally_days (
  user_id uuid not null references workspace_private.users(id) on delete cascade,
  day date not null,
  calls bigint not null, eligible_calls bigint not null, saved_calls bigint not null,
  sale_calls bigint not null, mobile_orders bigint not null, mobile_lines bigint not null,
  primary key (user_id, day)
);
create table workspace_private.tally_groups (
  user_id uuid not null, day date not null, tags jsonb not null, accounts bigint not null,
  primary key (user_id, day, tags),
  foreign key (user_id, day) references workspace_private.tally_days on delete cascade
);
create table workspace_private.tally_receipts (
  user_id uuid not null references workspace_private.users(id) on delete cascade,
  retry_key bytea not null,
  retry_signature bytea not null,
  primary key (user_id, retry_key)
);
alter table workspace_private.tally_days enable row level security;
alter table workspace_private.tally_groups enable row level security;
alter table workspace_private.tally_receipts enable row level security;
revoke all on workspace_private.tally_days, workspace_private.tally_groups, workspace_private.tally_receipts
  from public, anon, authenticated, service_role;

create function workspace_private.tally_day(p_user_id uuid, p_day date) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('day',d.day,'calls',d.calls,'eligibleCalls',d.eligible_calls,
    'savedCalls',d.saved_calls,'saleCalls',d.sale_calls,'mobileOrders',d.mobile_orders,'mobileLines',d.mobile_lines,
    'groups', coalesce((select jsonb_agg(g.tags || jsonb_build_object('count',g.accounts) order by g.tags)
       from workspace_private.tally_groups g where g.user_id=d.user_id and g.day=d.day),'[]'::jsonb))
  from workspace_private.tally_days d where d.user_id=p_user_id and d.day=p_day;
$$;

create function public.workspace_tally_state(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('version',4,'goals',workspace_private.default_goals() || u.goals,
    'days', coalesce((select jsonb_agg(workspace_private.tally_day(d.user_id,d.day) order by d.day desc)
       from workspace_private.tally_days d where d.user_id=u.id),'[]'::jsonb))
  from workspace_private.users u where u.id=p_user_id;
$$;

create function workspace_private.tally_int(p_number jsonb, p_min integer, p_max integer) returns integer
language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p_number) is distinct from 'number' then
    raise exception 'VALIDATION: Expected a tally count.';
  end if;
  if p_number::numeric <> trunc(p_number::numeric) or p_number::numeric not between p_min and p_max then
    raise exception 'VALIDATION: Tally count outside its allowed range.';
  end if;
  return p_number::integer;
end;
$$;

create function public.workspace_tally(p_user_id uuid, p_day date, p_delta jsonb, p_request_id uuid)
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
      or v_group - array['before','kept','added','washed','count'] <> '{}'
      or not (v_group ?& array['before','kept','added','washed','count'])
      or jsonb_typeof(v_group->'washed') is distinct from 'boolean' then
      raise exception 'VALIDATION: Unexpected outcome fields.';
    end if;
    v_count := workspace_private.tally_int(v_group->'count',1,2147483647);
    v_tags := workspace_private.normalize_account(v_group - 'washed' - 'count') - 'account';
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

-- Quiesce the legacy entry points before taking the migration snapshot. Dropping
-- the RPCs also prevents previously authorized, queued requests from writing after cutover.
drop function public.workspace_save(uuid,jsonb,bigint), public.workspace_remove(uuid,text,bigint),
  public.workspace_restore(uuid,jsonb), public.workspace_import(uuid,jsonb), public.workspace_state(uuid);
lock table workspace_private.calls in access exclusive mode;
-- Fence a legacy mutation that entered its RPC before the cutover and waited for the lock.
create function workspace_private.deny_legacy_write() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'CONFLICT: Refresh the tracker to use grouped tallies.';
end;
$$;
create trigger archive_legacy_calls before insert or update or delete on workspace_private.calls
  for each statement execute function workspace_private.deny_legacy_write();

-- Derive the same one-to-one wash pairing as the scoring model. The only temporary
-- join key is the old call id. Neither it nor account identifiers enter the new tables.
create temporary table tally_backfill on commit drop as
with expanded as (
  select c.user_id, c.id, (c.record->>'day')::date as day, a.position,
    a.data->'before' as original,a.data->'kept' as kept,coalesce(a.data->'added','[]') as added,
    jsonb_array_length(c.record->'mobileOrders') as orders,(c.record->>'soldLines')::int as lines
  from workspace_private.calls c cross join lateral jsonb_array_elements(
    coalesce(c.record->'accounts',jsonb_build_array(c.record))) with ordinality a(data,position)
), ranked as (
  select *, row_number() over(partition by user_id,id,original,kept order by position) as ordinal,
    count(*) filter(where kept=original) over(partition by user_id,id,original) as full_saves,
    count(*) filter(where kept='[]') over(partition by user_id,id,original) as full_losses
  from expanded
)
select *, (kept=original or kept='[]') and ordinal<=least(full_saves,full_losses) as washed from ranked;

insert into workspace_private.tally_days
select user_id,day,count(*),count(*) filter(where eligible),count(*) filter(where saved),
  count(*) filter(where orders>0),sum(orders),sum(lines)
from (select user_id,day,id,bool_or(not washed) as eligible,bool_or(not washed and kept<>'[]') as saved,
      max(orders) as orders,max(lines) as lines from tally_backfill group by user_id,day,id) as per_call
group by user_id,day;

insert into workspace_private.tally_groups
select user_id,day,jsonb_build_object('before',original,'kept',kept,'added',added,'washed',washed),count(*)
from tally_backfill group by user_id,day,original,kept,added,washed;

-- A goal edit no longer has to read the archived calls to check backup size.
create or replace function public.workspace_goal(p_user_id uuid, p_key text, p_value integer) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if p_key is null or not (workspace_private.default_goals() ? p_key) or p_value is null or p_value not between 5 and 100 then
    raise exception 'VALIDATION: Choose a known goal and a whole percentage from 5 to 100.';
  end if;
  perform workspace_private.lock_user(p_user_id);
  update workspace_private.users set goals=goals || jsonb_build_object(p_key,p_value) where id=p_user_id;
  return p_value;
end;
$$;

revoke all on function workspace_private.tally_day(uuid,date),workspace_private.tally_int(jsonb,integer,integer),workspace_private.deny_legacy_write()
  from public, anon, authenticated, service_role;
revoke all on function public.workspace_tally_state(uuid),public.workspace_tally(uuid,date,jsonb,uuid)
  from public, anon, authenticated;
grant execute on function public.workspace_tally_state(uuid),public.workspace_tally(uuid,date,jsonb,uuid) to service_role;
$grouped_migration$;
  installed boolean;
  has_raw boolean;
  has_revisions boolean;
begin
  if (select count(*) from supabase_migrations.schema_migrations
      where version in ('20261106005417', '20261113022327')) <> 2
      or to_regprocedure('workspace_private.normalize_account(jsonb)') is null then
    raise exception 'Expected the retain workspace and account-outcomes migrations. Check the project before proceeding.';
  end if;

  if exists (select 1 from supabase_migrations.schema_migrations where
      (name='grouped_tallies' and version<>'20261113033103')
      or (version='20261113033103' and name is not null and name<>'grouped_tallies')) then
    raise exception 'Unexpected grouped migration version or name. Review the migration history before cleanup.';
  end if;

  select exists (select 1 from supabase_migrations.schema_migrations where version='20261113033103') into installed;
  has_raw := to_regclass('workspace_private.calls') is not null;
  has_revisions := to_regclass('workspace_private.call_versions') is not null;
  if has_raw <> has_revisions then
    raise exception 'Only one legacy table exists. Review the prior cleanup before proceeding.';
  end if;

  if not installed and to_regclass('workspace_private.tally_days') is null then
    if not has_raw or to_regclass('workspace_private.tally_groups') is not null
       or to_regclass('workspace_private.tally_receipts') is not null then
      raise exception 'Unexpected partial migration. Cleanup cancelled.';
    end if;
    execute migration_sql;
  end if;

  if to_regclass('workspace_private.tally_days') is null
     or to_regclass('workspace_private.tally_groups') is null
     or to_regclass('workspace_private.tally_receipts') is null
     or to_regprocedure('public.workspace_tally_state(uuid)') is null
     or to_regprocedure('public.workspace_tally(uuid,date,jsonb,uuid)') is null
     or to_regprocedure('workspace_private.tally_day(uuid,date)') is null
     or to_regprocedure('workspace_private.tally_int(jsonb,integer,integer)') is null
     or to_regprocedure('public.workspace_goal(uuid,text,integer)') is null
     or to_regprocedure('public.workspace_save(uuid,jsonb,bigint)') is not null
     or to_regprocedure('public.workspace_remove(uuid,text,bigint)') is not null
     or to_regprocedure('public.workspace_import(uuid,jsonb)') is not null
     or to_regprocedure('public.workspace_restore(uuid,jsonb)') is not null
     or to_regprocedure('public.workspace_state(uuid)') is not null then
    raise exception 'The grouped read/write API is incomplete or a legacy endpoint is still active. Cleanup cancelled.';
  end if;

  if not installed then
    insert into supabase_migrations.schema_migrations(version,name,statements)
      values ('20261113033103','grouped_tallies',array[migration_sql]);
  end if;

  if has_raw then
    execute $legacy_cleanup$
-- Run the entire migration in one transaction after the grouped-tallies migration.
-- Freeze writes for a consistent comparison of archived records, new counts and retry receipts.
lock table workspace_private.calls, workspace_private.call_versions in access exclusive mode;
lock table workspace_private.tally_receipts, workspace_private.tally_days, workspace_private.tally_groups in share mode;

-- Only the temporary computation uses a call id for wash matching and per-call denominators.
create temporary view retain_cleanup_accounts as
with account_services as (
  select c.user_id,c.id,(c.record->>'day')::date as day,a.ord,
    a.rec->'before' as original,a.rec->'kept' as kept,coalesce(a.rec->'added','[]'::jsonb) as added,
    jsonb_array_length(c.record->'mobileOrders') as orders,(c.record->>'soldLines')::bigint as lines
  from workspace_private.calls c cross join lateral jsonb_array_elements(
    coalesce(c.record->'accounts',jsonb_build_array(c.record))) with ordinality as a(rec,ord)
), paired as (
  select *,row_number() over(partition by user_id,id,original,kept order by ord) as position,
    count(*) filter(where kept=original) over(partition by user_id,id,original) as saved,
    count(*) filter(where kept='[]') over(partition by user_id,id,original) as lost
  from account_services
)
select *, (kept=original or kept='[]') and position<=least(saved,lost) as washed from paired;

create temporary table retain_cleanup_days on commit drop as
select user_id,day,count(*) as calls,count(*) filter(where eligible) as eligible,
  count(*) filter(where retained) as retained,count(*) filter(where orders>0) as converted,
  sum(orders) as orders,sum(lines) as lines
from (select user_id,day,id,bool_or(not washed) as eligible,
      bool_or(not washed and kept<>'[]') as retained,max(orders) as orders,max(lines) as lines
      from pg_temp.retain_cleanup_accounts group by user_id,day,id) as per_call
group by user_id,day;

create temporary table retain_cleanup_groups on commit drop as
select user_id,day,jsonb_build_object('before',original,'kept',kept,'added',added,'washed',washed) as tags,count(*) as accounts
from pg_temp.retain_cleanup_accounts group by user_id,day,original,kept,added,washed;

drop view pg_temp.retain_cleanup_accounts;

do $verify$
begin
  -- Every archived call must have contributed exactly once and every new save exactly once.
  if exists (
    select 1 from (select id as user_id from workspace_private.users) u
    left join (select user_id,count(*) as n from workspace_private.calls group by user_id) raw using(user_id)
    left join (select user_id,sum(calls) as n from pg_temp.retain_cleanup_days group by user_id) scored using(user_id)
    left join (select user_id,count(*) as n from workspace_private.tally_receipts group by user_id) receipts using(user_id)
    left join (select user_id,sum(calls) as n from workspace_private.tally_days group by user_id) tallies using(user_id)
    where coalesce(raw.n,0) <> coalesce(scored.n,0)
      or coalesce(raw.n,0)+coalesce(receipts.n,0) <> coalesce(tallies.n,0)
  ) then raise exception 'Legacy call totals could not be reconciled. Cleanup cancelled.'; end if;

  -- There may be new calls since backfill. Check what remains after subtracting the archive:
  -- it must be a valid set of new call counters, including the all-zero case.
  if exists (
    select 1 from (
      select d.calls-o.calls as calls,d.eligible_calls-o.eligible as eligible,d.saved_calls-o.retained as saved,
        d.sale_calls-o.converted as converted,d.mobile_orders-o.orders as orders,d.mobile_lines-o.lines as lines
      from pg_temp.retain_cleanup_days o left join workspace_private.tally_days d using(user_id,day)
    ) as remaining
    where calls is null or calls<0 or eligible not between 0 and calls or saved not between 0 and eligible
      or converted not between 0 and calls or orders not between converted and 20*converted
      or lines not between orders and 12*orders
  ) then raise exception 'Daily scoring counters could not be reconciled. Cleanup cancelled.'; end if;

  -- Every historic tag combination must still be represented. Days with no subsequent saves
  -- must match exactly in both directions; new saves may only increase grouped counts.
  if exists (
    select 1 from pg_temp.retain_cleanup_groups o
    full join workspace_private.tally_groups g using(user_id,day,tags)
    join workspace_private.tally_days d using(user_id,day)
    left join pg_temp.retain_cleanup_days od using(user_id,day)
    where coalesce(g.accounts,0)<coalesce(o.accounts,0)
      or (d.calls=od.calls and coalesce(g.accounts,0)<>coalesce(o.accounts,0))
  ) then raise exception 'Grouped service counts could not be reconciled. Cleanup cancelled.'; end if;
end;
$verify$;

-- Explicit, restricted drops: any unexpected dependent object aborts the transaction.
drop function workspace_private.check_capacity(uuid), workspace_private.state(uuid),
  workspace_private.comparable_call(jsonb), workspace_private.normalize_call(jsonb),
  workspace_private.normalize_call_core(jsonb), workspace_private.normalize_callback(jsonb),
  workspace_private.validate_goals(jsonb) restrict;
drop table workspace_private.call_versions, workspace_private.calls restrict;
drop function workspace_private.deny_legacy_write() restrict;
$legacy_cleanup$;
  end if;

  -- Check every persisted tag against the exact four service codes and allowed keys.
  -- normalize_account rejects unknown or duplicate services and invalid kept/added combinations.
  if exists (
    select 1 from workspace_private.tally_groups g
    where jsonb_typeof(g.tags->'washed') is distinct from 'boolean'
       or g.tags is distinct from ((workspace_private.normalize_account(g.tags-'washed')-'account')
                                      || jsonb_build_object('washed',g.tags->'washed'))
       or g.accounts < 1
  ) then raise exception 'Unexpected data in grouped outcome tags. Changes rolled back.'; end if;
end;
$cutover$;

notify pgrst, 'reload schema';
commit;

-- A successful run returns true in every column.
select to_regclass('workspace_private.calls') is null as raw_calls_removed,
       to_regclass('workspace_private.call_versions') is null as call_revisions_removed,
       to_regprocedure('public.workspace_tally_state(uuid)') is not null as grouped_log_ready,
       to_regprocedure('public.workspace_tally(uuid,date,jsonb,uuid)') is not null as grouped_saves_ready;
