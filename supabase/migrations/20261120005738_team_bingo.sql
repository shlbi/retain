-- Team games retain one counter set per player and game. The ordinary call log still
-- contains only grouped daily totals. Only the server can invoke the public functions.
create table workspace_private.bingo_games (
  id uuid primary key default gen_random_uuid(),
  supervisor_id uuid not null references workspace_private.users(id) on delete cascade,
  title text not null,
  incentive text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null check (ends_at > starts_at),
  pattern text not null check (pattern in ('line', 'blackout')),
  squares jsonb not null check (jsonb_typeof(squares) = 'array' and jsonb_array_length(squares) = 9)
);
create index bingo_team_schedule on workspace_private.bingo_games (supervisor_id, starts_at, ends_at);
create table workspace_private.bingo_scores (
  game_id uuid not null references workspace_private.bingo_games(id) on delete cascade,
  user_id uuid not null references workspace_private.users(id) on delete cascade,
  stats jsonb not null default '{}',
  primary key (game_id,user_id)
);
alter table workspace_private.bingo_games enable row level security;
alter table workspace_private.bingo_scores enable row level security;
revoke all on workspace_private.bingo_games,workspace_private.bingo_scores from public,anon,authenticated,service_role;

-- Original services score on unwashed saves, added services always earn service
-- credit, and a play save requires keeping every original service.
create function workspace_private.bingo_delta(p_delta jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  with successes as (
    select credit.metric, sum((g->>'count')::bigint) as amount
    from jsonb_array_elements(p_delta->'groups') g
    cross join lateral (
      select jsonb_array_elements_text(g->'added') as metric
      union all
      select k from jsonb_array_elements_text(g->'kept') k where g->'washed'='false'
      union all
      select case jsonb_array_length(g->'before') when 1 then 'sp' when 2 then 'dp' else 'tp' end
        where g->'washed'='false' and g->'kept' = g->'before'
    ) credit group by credit.metric
  )
  select jsonb_build_object('calls',1,'savedCalls',p_delta->'savedCalls',
    'mobileOrders',p_delta->'mobileOrders','mobileLines',p_delta->'mobileLines')
    || coalesce((select jsonb_object_agg(metric,amount) from successes),'{}');
$$;

-- Keep existing tally validation, receipt semantics and response shape intact. The same
-- per-user transaction lock serializes the receipt check, ordinary tally and game award.
alter function public.workspace_tally(uuid,date,jsonb,uuid) set schema workspace_private;
revoke all on function workspace_private.workspace_tally(uuid,date,jsonb,uuid) from public,anon,authenticated,service_role;

create function public.workspace_tally(p_user_id uuid,p_day date,p_delta jsonb,p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_at timestamptz;
  v_game uuid;
  v_retry boolean;
  v_result jsonb;
begin
  perform workspace_private.lock_user(p_user_id);
  v_at := clock_timestamp();
  if p_day = (v_at at time zone 'America/New_York')::date then
    select g.id into v_game from workspace_private.users u
    join workspace_private.bingo_games g on g.supervisor_id=u.supervisor_id
    where u.id=p_user_id and u.role in ('agent','admin') and g.starts_at<=v_at and v_at<g.ends_at;
  end if;
  if v_game is not null then
    select exists(select 1 from workspace_private.tally_receipts where user_id=p_user_id
      and retry_key=sha256(uuid_send(p_request_id))) into v_retry;
  end if;

  v_result := workspace_private.workspace_tally(p_user_id,p_day,p_delta,p_request_id);
  if v_game is not null and not v_retry then
    insert into workspace_private.bingo_scores as player(game_id,user_id,stats)
    values(v_game,p_user_id,workspace_private.bingo_delta(p_delta))
    on conflict(game_id,user_id) do update set stats=(
      select jsonb_object_agg(key,total) from (
        select key,sum(value::bigint) as total from (
          select * from jsonb_each_text(player.stats)
          union all select * from jsonb_each_text(excluded.stats)
        ) entries group by key
      ) sums
    );
  end if;
  return v_result;
end;
$$;

-- A line is any row, column, or diagonal, read left-to-right in row-major order.
create function workspace_private.bingo_won(p_marks boolean[],p_pattern text) returns boolean
language sql immutable set search_path = '' as $$
  select case when p_pattern='blackout' then true=all(p_marks) else exists(
    select 1 from (values (1,2,3),(4,5,6),(7,8,9),(1,4,7),(2,5,8),(3,6,9),(1,5,9),(3,5,7)) line(a,b,c)
    where p_marks[a] and p_marks[b] and p_marks[c]
  ) end;
$$;

create function public.workspace_game_state(p_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_role text;
  v_team uuid;
  v_game workspace_private.bingo_games%rowtype;
  v_at timestamptz := statement_timestamp();
  v_status text;
  v_board jsonb;
  v_empty constant jsonb := '{"game":null,"leaders":[],"me":null,"members":[]}';
begin
  select role,case when role='supervisor' then id else supervisor_id end into v_role,v_team
    from workspace_private.users where id=p_user_id;
  if not found then raise exception 'FORBIDDEN: Unknown workspace account.'; end if;
  if v_team is null then return v_empty; end if;

  -- Show a running game first, otherwise the next scheduled game or the last result.
  select * into v_game from workspace_private.bingo_games
    where supervisor_id=v_team
    order by case when starts_at<=v_at and ends_at>v_at then 0 when starts_at>v_at then 1 else 2 end,
      case when starts_at>v_at then starts_at end asc, ends_at desc limit 1;
  if not found then return v_empty; end if;
  v_status := case when v_at<v_game.starts_at then 'scheduled' when v_at<v_game.ends_at then 'live' else 'finished' end;

  with players as (
    select u.id,u.username,coalesce(s.stats,'{}') as stats
    from workspace_private.users u left join workspace_private.bingo_scores s
      on s.game_id=v_game.id and s.user_id=u.id
    where u.supervisor_id=v_team and u.role in ('agent','admin')
      and (v_status <> 'finished' or s.user_id is not null)
  ), marks as (
    select p.*, board.completed,workspace_private.bingo_won(board.marks,v_game.pattern) as won
    from players p cross join lateral (
      select count(*) filter(where hit) as completed,array_agg(hit order by ord) as marks from (
        select ord,coalesce((p.stats->>(square->>'metric'))::bigint,0)>=(square->>'target')::int as hit
        from jsonb_array_elements(v_game.squares) with ordinality cell(square,ord)
      ) cells
    ) board
  ), ranked as (
    select *, rank() over(order by won desc, completed desc) as rank,
      row_number() over(order by won desc, completed desc,lower(username),id) as slot from marks
  ), entries as (
    select id,slot,stats,jsonb_build_object('username',username,'rank',rank,'completed',completed,'won',won) as summary from ranked
  )
  select jsonb_build_object(
    'leaders',coalesce(jsonb_agg(summary order by slot) filter(where slot<=3),'[]'),
    'me',(select summary || jsonb_build_object('stats',stats) from entries where id=p_user_id),
    'members',case when v_role='supervisor' then coalesce(jsonb_agg(summary || jsonb_build_object('stats',stats) order by slot),'[]') else '[]' end
  ) into v_board from entries;
  return v_board || jsonb_build_object('game',jsonb_build_object('id',v_game.id,'title',v_game.title,
    'incentive',v_game.incentive,'startsAt',v_game.starts_at,'endsAt',v_game.ends_at,
    'pattern',v_game.pattern,'squares',v_game.squares,'status',v_status));
end;
$$;

create function public.workspace_launch_game(p_user_id uuid,p_game jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_square jsonb;
  v_id uuid;
begin
  -- The supervisor row locks concurrent launches, preventing races on overlapping windows.
  perform 1 from workspace_private.users where id=p_user_id and role='supervisor' for update;
  if not found then raise exception 'FORBIDDEN: Only supervisors may schedule team games.'; end if;
  if jsonb_typeof(p_game) is distinct from 'object'
    or not (p_game ?& array['title','incentive','startsAt','endsAt','pattern','squares'])
    or p_game-array['title','incentive','startsAt','endsAt','pattern','squares'] <> '{}'
    or jsonb_typeof(p_game->'title') is distinct from 'string' or length(trim(p_game->>'title')) not between 1 and 80
    or jsonb_typeof(p_game->'incentive') is distinct from 'string' or length(p_game->>'incentive')>240
    or coalesce(p_game->>'pattern','') not in ('line','blackout')
    or jsonb_typeof(p_game->'squares') is distinct from 'array' or jsonb_array_length(p_game->'squares')<>9 then
    raise exception 'VALIDATION: Choose nine bingo squares, a title and a winning pattern.';
  end if;
  if coalesce(p_game->>'startsAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+(Z|[+-][0-9]{2}:[0-9]{2})$'
    or coalesce(p_game->>'endsAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T.+(Z|[+-][0-9]{2}:[0-9]{2})$' then
    raise exception 'VALIDATION: Choose a start and end time with a timezone.';
  end if;
  begin
    v_start := (p_game->>'startsAt')::timestamptz;
    v_end := (p_game->>'endsAt')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception 'VALIDATION: Choose valid start and end times.';
  end;
  if v_end<=v_start then raise exception 'VALIDATION: End the game after it starts.'; end if;
  for v_square in select value from jsonb_array_elements(p_game->'squares') loop
    if jsonb_typeof(v_square) is distinct from 'object'
      or v_square - array['metric','target'] <> '{}'
      or coalesce(v_square->>'metric','') not in ('calls','savedCalls','mobileOrders','mobileLines','internet','tv','phone','mobile','sp','dp','tp') then
      raise exception 'VALIDATION: Choose a supported bingo metric.';
    end if;
    perform workspace_private.tally_int(v_square->'target',1,9999);
  end loop;
  if exists(select 1 from workspace_private.bingo_games where supervisor_id=p_user_id
    and starts_at=v_start and ends_at=v_end and title=trim(p_game->>'title') and incentive=trim(p_game->>'incentive')
    and pattern=p_game->>'pattern' and squares=p_game->'squares') then
    return public.workspace_game_state(p_user_id);
  end if;
  if v_end<=clock_timestamp() then raise exception 'VALIDATION: Choose an end time in the future.'; end if;
  if exists(select 1 from workspace_private.bingo_games where supervisor_id=p_user_id and starts_at<v_end and ends_at>v_start) then
    raise exception 'CONFLICT: This team already has a game scheduled during that time.';
  end if;
  insert into workspace_private.bingo_games(supervisor_id,title,incentive,starts_at,ends_at,pattern,squares)
    values(p_user_id,trim(p_game->>'title'),trim(p_game->>'incentive'),v_start,v_end,p_game->>'pattern',p_game->'squares')
    returning id into v_id;
  insert into workspace_private.bingo_scores(game_id,user_id)
    select v_id,id from workspace_private.users where supervisor_id=p_user_id and role in ('agent','admin');
  return public.workspace_game_state(p_user_id);
end;
$$;
revoke all on function workspace_private.bingo_delta(jsonb),workspace_private.bingo_won(boolean[],text)
  from public,anon,authenticated,service_role;
revoke all on function public.workspace_tally(uuid,date,jsonb,uuid),public.workspace_game_state(uuid),
  public.workspace_launch_game(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.workspace_tally(uuid,date,jsonb,uuid),public.workspace_game_state(uuid),
  public.workspace_launch_game(uuid,jsonb) to service_role;
notify pgrst,'reload schema';
