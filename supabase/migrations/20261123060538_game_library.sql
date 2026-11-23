-- The schedule and tally award transaction are shared with the original Bingo implementation.
alter table workspace_private.bingo_games
  add column kind text not null default 'bingo',
  add column rules jsonb not null default '{}',
  add column world jsonb not null default '{}',
  add column revision bigint not null default 0,
  add column secret uuid not null default gen_random_uuid();
alter table workspace_private.bingo_scores add column seat bigint generated always as identity,
  add column finish_stats jsonb;
create table workspace_private.game_access(
  supervisor_id uuid references workspace_private.users(id) on delete cascade,
  kind text not null, primary key(supervisor_id,kind)
);
alter table workspace_private.game_access enable row level security;
revoke all on workspace_private.game_access from public,anon,authenticated,service_role;

create function workspace_private.known_game(k text) returns boolean language sql immutable set search_path='' as $$
 select k=any(array['bingo','vault','rally','mission','heist','switchboard','fm','belt','swap','macro','caption','territory','wavelength','ghost','plot','elevator','manual','fantasy','domino']);
$$;
alter table workspace_private.game_access add constraint game_type check(workspace_private.known_game(kind));
-- Every future launch, including Bingo, starts with explicit supervisor access.

create function public.workspace_game_library(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare r text;
begin
 select role into r from workspace_private.users where id=p_user_id;
 if r='admin' then
  return jsonb_build_object('supervisors',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'name',u.username,'team',t.name,
    'games',coalesce((select jsonb_agg(kind order by kind) from workspace_private.game_access where supervisor_id=u.id),'[]')) order by u.username_key)
    from workspace_private.users u left join workspace_private.teams t on t.supervisor_id=u.id where u.role='supervisor'),'[]'));
 elsif r='supervisor' then
  return jsonb_build_object('games',coalesce((select jsonb_agg(kind order by kind) from workspace_private.game_access where supervisor_id=p_user_id),'[]'));
 end if;
 raise exception 'FORBIDDEN: Only admins and supervisors can open game setup.';
end; $$;
create function public.workspace_game_access(p_user_id uuid,p_supervisor uuid,p_kind text,p_enabled boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from workspace_private.users where id=p_user_id and role='admin' for share) then raise exception 'FORBIDDEN: Admin access required.'; end if;
 if not workspace_private.known_game(p_kind) or p_enabled is null or not exists(select 1 from workspace_private.users where id=p_supervisor and role='supervisor' for update) then raise exception 'VALIDATION: Choose an existing supervisor and game.'; end if;
 if p_enabled then insert into workspace_private.game_access values(p_supervisor,p_kind) on conflict do nothing;
 else delete from workspace_private.game_access where supervisor_id=p_supervisor and kind=p_kind; end if;
 return jsonb_build_object('ok',true);
end; $$;

alter function public.workspace_launch_game(uuid,jsonb) set schema workspace_private;
revoke all on function workspace_private.workspace_launch_game(uuid,jsonb) from public,anon,authenticated,service_role;
create or replace function workspace_private.workspace_launch_game(p_user_id uuid,p_game jsonb) returns jsonb
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
      or coalesce(v_square->>'metric','') not in ('calls','savedCalls','mobileOrders','mobileLines','internet','tv','phone','mobile','sp','dp','tp','lineSave','spInternet','subscriber') then
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

create function public.workspace_arcade_launch(p_user_id uuid,p_supervisor uuid,p_kind text,p_rules jsonb,p_game jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r text; prior workspace_private.bingo_games%rowtype;
begin
 select role into r from workspace_private.users where id=p_user_id for update;
 if not workspace_private.known_game(p_kind) or r is null or not (r='admin' or (r='supervisor' and p_user_id=p_supervisor
   and exists(select 1 from workspace_private.game_access where supervisor_id=p_user_id and kind=p_kind for share))) then
  raise exception 'FORBIDDEN: This game is not enabled for your account.'; end if;
 perform 1 from workspace_private.users where id=p_supervisor and role='supervisor' for update;
 if not found then raise exception 'VALIDATION: Choose a team supervisor.'; end if;
 if coalesce(p_game->>'startsAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then raise exception 'VALIDATION: Choose a start time.'; end if;
 select * into prior from workspace_private.bingo_games where supervisor_id=p_supervisor and starts_at=(p_game->>'startsAt')::timestamptz and ends_at=(p_game->>'endsAt')::timestamptz;
 if found and (prior.kind<>p_kind or prior.rules<>p_rules) then raise exception 'CONFLICT: This team already has a game in this window.'; end if;
 perform workspace_private.workspace_launch_game(p_supervisor,p_game);
 update workspace_private.bingo_games set kind=p_kind,rules=p_rules where supervisor_id=p_supervisor and starts_at=(p_game->>'startsAt')::timestamptz and ends_at=(p_game->>'endsAt')::timestamptz;
 return jsonb_build_object('ok',true);
end; $$;
create function public.workspace_launch_game(p_user_id uuid,p_game jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from workspace_private.users where id=p_user_id and role='supervisor') then raise exception 'FORBIDDEN: Only supervisors can launch their team game.'; end if;
 perform public.workspace_arcade_launch(p_user_id,p_user_id,'bingo','{}',p_game);
 return public.workspace_game_state(p_user_id);
end; $$;

-- A snapshot is server-only. The API returns only each player's permitted view and legal moves.
create function public.workspace_arcade_snapshot(p_user_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare board jsonb; g workspace_private.bingo_games%rowtype; players jsonb;
begin
 board:=public.workspace_game_state(p_user_id) || jsonb_build_object('hasLibrary',exists(select 1 from workspace_private.game_access a join workspace_private.users u on u.id=a.supervisor_id where u.role='supervisor' and a.supervisor_id=p_user_id));
 if board->>'game' is null then return board; end if;
 select * into g from workspace_private.bingo_games where id=(board->'game'->>'id')::uuid;
 select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'username',u.username,'seat',s.seat,'stats',coalesce(s.stats,'{}'),
 'finish',s.finish_stats,'ghost',(select prev.finish_stats from workspace_private.bingo_scores prev join workspace_private.bingo_games prevgame on prevgame.id=prev.game_id
 where g.kind='ghost' and prev.user_id=u.id and prevgame.supervisor_id=g.supervisor_id and prevgame.kind='ghost' and prevgame.ends_at<=g.starts_at and prevgame.rules=g.rules and prev.finish_stats is not null order by prevgame.ends_at desc limit 1))
 order by s.seat nulls last,u.id),'[]') into players from workspace_private.users u left join workspace_private.bingo_scores s on s.user_id=u.id and s.game_id=g.id
 where u.supervisor_id=g.supervisor_id and u.role in ('agent','admin');
 return board || jsonb_build_object('kind',g.kind,'rules',g.rules,'world',g.world,'revision',g.revision,'players',players,'secret',g.secret,'host',g.supervisor_id,'bingoWinners',case when g.kind='bingo' then (select coalesce(jsonb_agg(v->'username'),'[]') from jsonb_array_elements(workspace_private.workspace_game_state(g.supervisor_id)->'members') v where v->'won'='true') else '[]'::jsonb end);
end; $$;
create function public.workspace_arcade_move(p_user_id uuid,p_id uuid,p_revision bigint,p_world jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 update workspace_private.bingo_games g set world=p_world,revision=revision+1 where id=p_id and revision=p_revision and starts_at<=clock_timestamp() and ends_at>clock_timestamp()
 and exists(select 1 from workspace_private.users u where u.id=p_user_id and u.supervisor_id=g.supervisor_id and u.role in ('agent','admin'));
 return found;
end; $$;
-- An after trigger sees the merged tally on UPSERT (including the very first tally).
create function workspace_private.record_arcade_score() returns trigger language plpgsql set search_path='' as $$
declare g workspace_private.bingo_games%rowtype; previous jsonb; duel jsonb; fighter jsonb; line jsonb; queue jsonb; ride jsonb; p text:=new.user_id::text; winner text; scored integer; floor integer;
begin
 update workspace_private.bingo_games set revision=revision+1 where id=new.game_id returning * into g;
 if g.kind='elevator' then
   line:=g.world->p;
   ride:=line->'ride';
   if ride is not null and (new.stats->>'calls')::int >= (ride->>'calls')::int + (g.rules->>'target')::int then
     floor:=case when coalesce((new.stats->>(g.rules->>'metric'))::int,0)>(ride->>'primary')::int
       or coalesce((new.stats->>(g.rules->>'bonus'))::int,0)>(ride->>'bonus')::int
       then coalesce((line->>'floor')::int,0)+(case when g.rules->>'mode'='Express' then 2 else 1 end) else 0 end;
     update workspace_private.bingo_games set world=jsonb_set(world,array[p],(line-'ride')||jsonb_build_object('floor',floor)) where id=g.id;
   end if;
 elsif g.kind='belt' then
   duel:=g.world->'duel';
   if duel is null then
     select jsonb_agg(u.id::text order by s.seat,u.id) into queue from workspace_private.users u
       left join workspace_private.bingo_scores s on s.user_id=u.id and s.game_id=g.id
       where u.supervisor_id=g.supervisor_id and u.role in ('agent','admin');
     if jsonb_array_length(queue)<2 then return new; end if;
     duel:=jsonb_build_object('champ',queue->0,'opponent',queue->1,'queue',(queue-0)-0,'scores','{}'::jsonb);
   end if;
   if p in (duel->>'champ',duel->>'opponent') and duel->>'opponent' is not null then
     fighter:=coalesce(duel->'scores'->p,'{"calls":0,"points":0}'::jsonb);
     if (fighter->>'calls')::int < (g.rules->>'target')::int then
       previous:=case when tg_op='UPDATE' then old.stats else '{}'::jsonb end;
       scored:=coalesce((new.stats->>(g.rules->>'metric'))::int,0)-coalesce((previous->>(g.rules->>'metric'))::int,0)
        +(case when g.rules->>'mode'='Sales boost' then 3 else 2 end)*(coalesce((new.stats->>(g.rules->>'bonus'))::int,0)-coalesce((previous->>(g.rules->>'bonus'))::int,0));
       duel:=jsonb_set(duel,array['scores',p],jsonb_build_object('calls',(fighter->>'calls')::int+1,'points',(fighter->>'points')::int+scored));
       if (duel->'scores'->(duel->>'champ')->>'calls')::int=(g.rules->>'target')::int and
         (duel->'scores'->(duel->>'opponent')->>'calls')::int=(g.rules->>'target')::int then
         winner:=case when (duel->'scores'->(duel->>'opponent')->>'points')::int>(duel->'scores'->(duel->>'champ')->>'points')::int then duel->>'opponent' else duel->>'champ' end;
         queue:=duel->'queue';
         duel:=jsonb_build_object('champ',winner,'opponent',queue->0,'queue',queue-0,'scores','{}'::jsonb);
         g.world:=jsonb_set(g.world,array[winner],jsonb_build_object('defenses',coalesce((g.world->winner->>'defenses')::int,0)+1));
       end if;
       update workspace_private.bingo_games set world=g.world||jsonb_build_object('duel',duel) where id=g.id;
     end if;
   end if;
 end if;
 if g.kind in ('rally','ghost') and new.finish_stats is null and (new.stats->>'calls')::int >= (g.rules->>'target')::int then
  update workspace_private.bingo_scores set finish_stats=new.stats where game_id=new.game_id and user_id=new.user_id;
 end if;
 return new;
end; $$;

create trigger arcade_score_revision after insert or update of stats on workspace_private.bingo_scores for each row when(new.stats<>'{}'::jsonb) execute function workspace_private.record_arcade_score();
create trigger arcade_move_refresh after update of world on workspace_private.bingo_games for each row execute function workspace_private.notify_bingo_board();
-- Account deletion also removes private game choices and votes which reference that player.
create function workspace_private.forget_game_player(doc jsonb, player text) returns jsonb
language plpgsql immutable set search_path='' as $$
begin
 case jsonb_typeof(doc)
 when 'object' then return coalesce((select jsonb_object_agg(key,workspace_private.forget_game_player(value,player))
   from jsonb_each(doc) where key<>player and value<>to_jsonb(player)),'{}');
 when 'array' then return coalesce((select jsonb_agg(workspace_private.forget_game_player(value,player) order by n)
   from jsonb_array_elements(doc) with ordinality e(value,n) where value<>to_jsonb(player)),'[]');
 else return doc;
 end case;
end; $$;
create function workspace_private.clear_game_player() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update workspace_private.bingo_games
 set world=workspace_private.forget_game_player(case when old.id::text in (world->'duel'->>'champ',world->'duel'->>'opponent')
    then world-'duel' else world end,old.id::text),revision=revision+1
 where position(old.id::text in world::text)>0;
 return old;
end; $$;
create trigger clear_game_player before delete on workspace_private.users for each row execute function workspace_private.clear_game_player();
revoke all on function workspace_private.clear_game_player(),workspace_private.forget_game_player(jsonb,text) from public,anon,authenticated,service_role;
revoke all on function workspace_private.record_arcade_score(),workspace_private.known_game(text) from public,anon,authenticated,service_role;
revoke all on function public.workspace_game_library(uuid),public.workspace_game_access(uuid,uuid,text,boolean),public.workspace_launch_game(uuid,jsonb),public.workspace_arcade_launch(uuid,uuid,text,jsonb,jsonb),public.workspace_arcade_snapshot(uuid),public.workspace_arcade_move(uuid,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.workspace_game_library(uuid),public.workspace_game_access(uuid,uuid,text,boolean),public.workspace_launch_game(uuid,jsonb),public.workspace_arcade_launch(uuid,uuid,text,jsonb,jsonb),public.workspace_arcade_snapshot(uuid),public.workspace_arcade_move(uuid,uuid,bigint,jsonb) to service_role;
notify pgrst,'reload schema';
