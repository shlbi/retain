-- Only an empty invalidation is public. Actual scores always come from the
-- authenticated game state RPC. An opaque topic rotates when a team loses a member.
alter table workspace_private.users add column bingo_channel uuid not null default gen_random_uuid();

create function workspace_private.rotate_bingo_channel() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op='UPDATE' then
    if old.role='supervisor' and new.role<>'supervisor' then
      new.bingo_channel := gen_random_uuid();
    end if;
    if old.supervisor_id is not distinct from new.supervisor_id then return new; end if;
  end if;
  if old.supervisor_id is not null then
    update workspace_private.users set bingo_channel=gen_random_uuid() where id=old.supervisor_id;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create trigger bingo_channel_membership before update of role,supervisor_id or delete on workspace_private.users
for each row execute function workspace_private.rotate_bingo_channel();

-- Reuse the core standings and attach the topic owned by the currently assigned
-- supervisor. Local Postgres installs without Supabase Realtime return a null topic.
alter function public.workspace_game_state(uuid) set schema workspace_private;
revoke all on function workspace_private.workspace_game_state(uuid) from public,anon,authenticated,service_role;
create function public.workspace_game_state(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select workspace_private.workspace_game_state(p_user_id) || jsonb_build_object('channel',(
    select 'bingo-' || team.bingo_channel::text from workspace_private.users actor
    join workspace_private.users team on team.id = case when actor.role='supervisor' then actor.id else actor.supervisor_id end
    where actor.id=p_user_id and team.role='supervisor'
      and to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null
  ));
$$;
revoke all on function public.workspace_game_state(uuid) from public,anon,authenticated;
grant execute on function public.workspace_game_state(uuid) to service_role;

create function workspace_private.notify_bingo_board() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_team uuid;
  v_topic text;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then return new; end if;
  if tg_table_name='bingo_games' then
    v_team := new.supervisor_id;
  else
    select supervisor_id into v_team from workspace_private.bingo_games where id=new.game_id;
  end if;
  -- Serializes the topic lookup with membership revocation. No new event after
  -- a revocation can be addressed to the old channel. In-flight older events
  -- carry no data and the API enforces current roster membership on every read.
  select 'bingo-' || bingo_channel::text into v_topic from workspace_private.users
    where id=v_team and role='supervisor' for share;
  if v_topic is not null then
    begin
      perform realtime.send('{}'::jsonb,'refresh',v_topic,false);
    exception when others then
      -- Realtime is an optimization. The tally transaction still commits if the
      -- notification service is unavailable; clients recover via the regular API.
      raise warning 'Bingo refresh delivery was unavailable.';
    end;
  end if;
  return new;
end;
$$;

-- Creating a game emits one event, independent of how many empty score rows
-- are seeded. A tally emits one event only when it updates an actual score.
create trigger bingo_game_refresh after insert on workspace_private.bingo_games
  for each row execute function workspace_private.notify_bingo_board();
create trigger bingo_score_refresh after insert or update on workspace_private.bingo_scores
  for each row when (new.stats <> '{}'::jsonb) execute function workspace_private.notify_bingo_board();
revoke all on function workspace_private.rotate_bingo_channel(),workspace_private.notify_bingo_board()
  from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
