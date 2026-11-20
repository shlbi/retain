-- All existing users and public signups start as agents. Only a database operator
-- can change role or supervisor_id. The compound FK also prevents demoting a
-- supervisor with assigned members until those members have been reassigned.
alter table workspace_private.users
  add column role text not null default 'agent' check (role in ('agent','supervisor','admin')),
  add column supervisor_id uuid,
  add column supervisor_role text not null default 'supervisor' check (supervisor_role='supervisor'),
  add unique (id,role),
  add check (supervisor_id is null or (supervisor_id <> id and role <> 'supervisor')),
  add foreign key (supervisor_id,supervisor_role) references workspace_private.users (id,role)
    on delete set null (supervisor_id);

create index users_supervisor_members on workspace_private.users(supervisor_id)
  where supervisor_id is not null;
create index tally_days_report_date on workspace_private.tally_days(day);

-- Each server response contributes only its elapsed time and error flag to daily
-- counters. No URLs, user identifiers, IP addresses, request bodies or traces.
create table workspace_private.request_days (
  day date primary key,
  requests bigint not null,
  errors bigint not null,
  total_ms bigint not null
);
alter table workspace_private.request_days enable row level security;
revoke all on workspace_private.request_days from public, anon, authenticated, service_role;

create function public.workspace_record_request(p_failed boolean, p_elapsed_ms integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_failed is null or p_elapsed_ms is null or p_elapsed_ms < 0 then
    raise exception 'VALIDATION: Invalid request measurement.';
  end if;
  insert into workspace_private.request_days as bucket (day, requests, errors, total_ms)
    values ((now() at time zone 'America/New_York')::date, 1, p_failed::int, p_elapsed_ms)
    on conflict(day) do update set requests=bucket.requests+1,
      errors=bucket.errors+excluded.errors, total_ms=bucket.total_ms+excluded.total_ms;
end;
$$;

-- Role and roster come from the session's user ID passed by the trusted server.
create function public.workspace_team_context(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('role',actor.role,'supervisorId',actor.supervisor_id,
    'agents',case when actor.role='supervisor' then coalesce((
      select jsonb_agg(jsonb_build_object('id',m.id,'username',m.username,
        'goals',workspace_private.default_goals() || m.goals) order by m.username_key,m.id)
      from workspace_private.users m where m.supervisor_id=actor.id
    ),'[]'::jsonb) else '[]'::jsonb end)
  from workspace_private.users actor where actor.id=p_user_id;
$$;

create function public.workspace_agent_state(p_user_id uuid,p_agent_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from workspace_private.users s
    join workspace_private.users m on m.supervisor_id=s.id
    where s.id=p_user_id and s.role='supervisor' and m.id=p_agent_id) then
    raise exception 'FORBIDDEN: Only a supervisor may open an assigned agent.';
  end if;
  return public.workspace_tally_state(p_agent_id);
end;
$$;

-- Older clients cannot bypass the supervisor workflow by calling the old RPC.
drop function public.workspace_goal(uuid,text,integer);

create function public.workspace_team_goals(p_user_id uuid,p_agent_ids uuid[],p_goals jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_goal record;
  v_updated integer;
begin
  perform 1 from workspace_private.users where id=p_user_id and role='supervisor' for share;
  if not found then raise exception 'FORBIDDEN: Only supervisors may set team goals.'; end if;

  if jsonb_typeof(p_goals) is distinct from 'object' or p_goals='{}'::jsonb then
    raise exception 'VALIDATION: Supply one or more goal percentages.';
  end if;
  for v_goal in select * from jsonb_each(p_goals) loop
    if not (workspace_private.default_goals() ? v_goal.key)
       or jsonb_typeof(v_goal.value) <> 'number' then
      raise exception 'VALIDATION: Unknown goal or invalid percentage.';
    end if;
    if v_goal.value::numeric <> trunc(v_goal.value::numeric)
       or v_goal.value::numeric not between 5 and 100 then
      raise exception 'VALIDATION: Goals must be whole percentages from 5 to 100.';
    end if;
  end loop;
  if p_agent_ids is not null and cardinality(p_agent_ids)=0 then
    raise exception 'VALIDATION: Select at least one team member.';
  end if;
  -- Check row count after the scoped update; one unauthorized/duplicate target
  -- rolls back the full operation, including every otherwise valid target.
  update workspace_private.users set goals=goals || p_goals
    where supervisor_id=p_user_id and (p_agent_ids is null or id=any(p_agent_ids));
  get diagnostics v_updated = row_count;
  if p_agent_ids is not null and v_updated <> cardinality(p_agent_ids) then
    raise exception 'FORBIDDEN: One or more selections are outside this team or duplicated.';
  end if;
  return jsonb_build_object('updated',v_updated);
end;
$$;

-- Reporting uses the last 28 Eastern calendar dates and the current roster.
-- Rates can be recomputed from summed numerators and denominators. Days with
-- zero activity are included so trends do not hide gaps in tracker use.
create function public.workspace_admin_stats(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'America/New_York')::date;
  v_report jsonb;
begin
  if not exists (select 1 from workspace_private.users where id=p_user_id and role='admin') then
    raise exception 'FORBIDDEN: Administrator access required.';
  end if;
  with members as (
    select id,supervisor_id from workspace_private.users where role in ('agent','admin')
  ), activity as (
    select d.* from workspace_private.tally_days d join members m on m.id=d.user_id
    where d.day between v_today-27 and v_today
  ), dates as (
    select v_today-i as day from generate_series(0,27) i
  ), daily as (
    select dt.day,count(a.user_id) as "activeAgents",coalesce(sum(a.calls),0) as calls,
      coalesce(sum(a.eligible_calls),0) as "eligibleCalls",coalesce(sum(a.saved_calls),0) as "savedCalls",
      coalesce(sum(a.mobile_orders),0) as "mobileOrders",coalesce(sum(a.mobile_lines),0) as "mobileLines"
    from dates dt left join activity a using(day) group by dt.day
  ), teams as (
    select id,username from workspace_private.users where role='supervisor'
    union all select null::uuid,'Unassigned' where exists(select 1 from members where supervisor_id is null)
  ), team_summary as (
    select t.id,t.username,count(distinct m.id) as members,count(distinct a.user_id) as "activeAgents",
      coalesce(sum(a.calls),0) as calls,coalesce(sum(a.eligible_calls),0) as "eligibleCalls",
      coalesce(sum(a.saved_calls),0) as "savedCalls",coalesce(sum(a.mobile_orders),0) as "mobileOrders",
      coalesce(sum(a.mobile_lines),0) as "mobileLines"
    from teams t left join members m on m.supervisor_id is not distinct from t.id
    left join activity a on a.user_id=m.id group by t.id,t.username
  ), telemetry as (
    select coalesce(sum(requests),0) as requests,coalesce(sum(errors),0) as errors,
      round(sum(total_ms)::numeric/nullif(sum(requests),0)) as "meanMs"
    from workspace_private.request_days where day between v_today-27 and v_today
  )
  select jsonb_build_object('registered',(select count(*) from workspace_private.users),
    'activeAgents',count(distinct a.user_id),'calls',coalesce(sum(a.calls),0),
    'eligibleCalls',coalesce(sum(a.eligible_calls),0),'savedCalls',coalesce(sum(a.saved_calls),0),
    'mobileOrders',coalesce(sum(a.mobile_orders),0),'mobileLines',coalesce(sum(a.mobile_lines),0),
    'days',(select jsonb_agg(to_jsonb(d) order by d.day) from daily d),
    'teams',(select coalesce(jsonb_agg(to_jsonb(t) order by t.username,t.id),'[]'::jsonb) from team_summary t),
    'technical',(select to_jsonb(telemetry) from telemetry))
  into v_report from activity a;
  return v_report;
end;
$$;

revoke all on function public.workspace_team_context(uuid),public.workspace_agent_state(uuid,uuid),
  public.workspace_team_goals(uuid,uuid[],jsonb),public.workspace_admin_stats(uuid),
  public.workspace_record_request(boolean,integer) from public,anon,authenticated;
grant execute on function public.workspace_team_context(uuid),public.workspace_agent_state(uuid,uuid),
  public.workspace_team_goals(uuid,uuid[],jsonb),public.workspace_admin_stats(uuid),
  public.workspace_record_request(boolean,integer) to service_role;
notify pgrst, 'reload schema';
