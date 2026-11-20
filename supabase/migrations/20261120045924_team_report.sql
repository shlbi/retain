-- The session identifies the supervisor. Use the same current roster for all
-- dates, matching the individual reports a supervisor can open. No team copy
-- of a person's history is stored, so transfers and corrections apply at read time.
create function public.workspace_team_report(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare v_report jsonb;
begin
  with members as (
    select u.id, workspace_private.default_goals() || u.goals as goals
    from workspace_private.users u where u.supervisor_id=p_user_id
  ), daily_totals as (
    select d.day, sum(d.calls) as calls, sum(d.eligible_calls) as eligible_calls,
      sum(d.saved_calls) as saved_calls, sum(d.sale_calls) as sale_calls,
      sum(d.mobile_orders) as mobile_orders, sum(d.mobile_lines) as mobile_lines
    from workspace_private.tally_days d join members m on m.id=d.user_id
    group by d.day
  ), outcome_counts as (
    select g.day, g.tags, sum(g.accounts) as accounts
    from workspace_private.tally_groups g join members m on m.id=g.user_id
    group by g.day,g.tags
  ), daily_groups as (
    select day, jsonb_agg(tags || jsonb_build_object('count',accounts) order by tags) as groups
    from outcome_counts group by day
  ), shared_goals as (
    select keys.metric, case when min((m.goals->>keys.metric)::int)=max((m.goals->>keys.metric)::int)
      then min((m.goals->>keys.metric)::int) end as target
    from jsonb_object_keys(workspace_private.default_goals()) as keys(metric)
    left join members m on true group by keys.metric
  )
  -- Daily totals and outcome counts are aggregated separately because one call
  -- can contain several account outcomes. Joining them earlier would inflate calls.
  select jsonb_build_object('version',4,'memberCount',(select count(*) from members),
    'goals',(select jsonb_object_agg(metric,target) from shared_goals),
    'days',coalesce((select jsonb_agg(jsonb_build_object(
      'day',d.day,'calls',d.calls,'eligibleCalls',d.eligible_calls,'savedCalls',d.saved_calls,
      'saleCalls',d.sale_calls,'mobileOrders',d.mobile_orders,'mobileLines',d.mobile_lines,
      'groups',coalesce(g.groups,'[]'::jsonb)) order by d.day desc)
      from daily_totals d left join daily_groups g using(day)),'[]'::jsonb))
  into v_report
  from workspace_private.users leader join workspace_private.teams t on t.supervisor_id=leader.id
  where leader.id=p_user_id and leader.role='supervisor';
  if not found then
    raise exception 'FORBIDDEN: Only the assigned supervisor may open a team report.';
  end if;
  return v_report;
end;
$$;

revoke all on function public.workspace_team_report(uuid) from public,anon,authenticated;
grant execute on function public.workspace_team_report(uuid) to service_role;
notify pgrst,'reload schema';
