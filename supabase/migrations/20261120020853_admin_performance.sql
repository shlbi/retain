-- Keep the last 28 Eastern report dates even when nobody logs a call. Historical
-- activity stays on its original date when an agent later changes role or team.
-- The existing version of admin_stats remains available for previously loaded clients.
create function public.workspace_admin_performance(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'America/New_York')::date;
begin
  if not exists (select 1 from workspace_private.users where id=p_user_id and role='admin') then
    raise exception 'FORBIDDEN: Administrator access required.';
  end if;
  return (
    with activity as (
      select day, count(*) as active_agents, sum(calls) as calls
      from workspace_private.tally_days
      where day between v_today-27 and v_today and calls>0
      group by day
    ), dates as (
      select v_today-i as day from generate_series(0,27) as i
    )
    select jsonb_build_object('days',jsonb_agg(jsonb_build_object(
      'day',d.day,'activeAgents',coalesce(a.active_agents,0),'calls',coalesce(a.calls,0),
      'requests',coalesce(r.requests,0),'errors',coalesce(r.errors,0),'totalMs',coalesce(r.total_ms,0)
    ) order by d.day))
    from dates d left join activity a using(day) left join workspace_private.request_days r using(day)
  );
end;
$$;
revoke all on function public.workspace_admin_performance(uuid) from public,anon,authenticated;
grant execute on function public.workspace_admin_performance(uuid) to service_role;
notify pgrst, 'reload schema';
