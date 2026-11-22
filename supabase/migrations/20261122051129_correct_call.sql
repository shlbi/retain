-- Atomically correct one agent's grouped totals across up to two reporting dates.
-- The retry receipt contains only salted digests. Original call selections are never persisted.
create function workspace_private.correct_call(p_user_id uuid, p_changes jsonb, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  item jsonb; previous jsonb; revised jsonb; report_day date; retry bytea; signature bytea;
  seen bytea; result jsonb := '[]';
begin
  perform workspace_private.lock_user(p_user_id);
  if not exists (select 1 from workspace_private.users where id=p_user_id and role in ('agent','admin')) then
    raise exception 'FORBIDDEN: Sign in to your own agent workspace.';
  end if;
  if p_request_id is null or jsonb_typeof(p_changes) is distinct from 'array'
    or jsonb_array_length(p_changes) not between 1 and 2
    or (select count(distinct value->>'day') from jsonb_array_elements(p_changes)) <> jsonb_array_length(p_changes) then
    raise exception 'VALIDATION: Choose the affected report dates.';
  end if;
  retry := sha256(uuid_send(p_request_id));
  signature := sha256(uuid_send(p_request_id) || convert_to('correct-call:' || p_changes::text,'UTF8'));
  select retry_signature into seen from workspace_private.tally_receipts where user_id=p_user_id and retry_key=retry;
  if seen is not null and seen <> signature then raise exception 'CONFLICT: Correction token already used.'; end if;
  for item in select value from jsonb_array_elements(p_changes) loop
    if jsonb_typeof(item) <> 'object' or not (item ?& array['day','expected','replacement'])
      or item - array['day','expected','replacement'] <> '{}' or (item->>'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'VALIDATION: Invalid report date.';
    end if;
    report_day := (item->>'day')::date;
    previous := nullif(item->'expected','null'::jsonb);
    revised := nullif(item->'replacement','null'::jsonb);
    if seen is null then
      if previous is not null then
        perform workspace_private.validate_edited_day(previous);
        previous := jsonb_set(previous,'{groups}',(select jsonb_agg(g order by g-'count')
          from jsonb_array_elements(previous->'groups') g));
      end if;
      if (previous is not null and previous->>'day' <> item->>'day')
        or (revised is not null and revised->>'day' <> item->>'day')
        or (previous is null and revised is null) then raise exception 'VALIDATION: Dates disagree.'; end if;
      if workspace_private.tally_day(p_user_id,report_day) is distinct from previous then
        raise exception 'CONFLICT: A reporting date changed. Reopen the correction.';
      end if;
      if revised is null then
        delete from workspace_private.tally_days where user_id=p_user_id and day=report_day;
      else
        perform workspace_private.validate_edited_day(revised);
        insert into workspace_private.tally_days(user_id,day,calls,eligible_calls,saved_calls,sale_calls,mobile_orders,mobile_lines)
          values(p_user_id,report_day,(revised->>'calls')::bigint,(revised->>'eligibleCalls')::bigint,
            (revised->>'savedCalls')::bigint,(revised->>'saleCalls')::bigint,(revised->>'mobileOrders')::bigint,
            (revised->>'mobileLines')::bigint)
          on conflict(user_id,day) do update set calls=excluded.calls,eligible_calls=excluded.eligible_calls,
            saved_calls=excluded.saved_calls,sale_calls=excluded.sale_calls,mobile_orders=excluded.mobile_orders,mobile_lines=excluded.mobile_lines;
        delete from workspace_private.tally_groups where user_id=p_user_id and day=report_day;
        insert into workspace_private.tally_groups(user_id,day,tags,accounts)
          select p_user_id, report_day, g-'count',(g->>'count')::bigint from jsonb_array_elements(revised->'groups') g;
      end if;
    end if;
    result := result || jsonb_build_array(jsonb_build_object('day',report_day,'summary',workspace_private.tally_day(p_user_id,report_day)));
  end loop;
  if seen is null then
    insert into workspace_private.tally_receipts(user_id,retry_key,retry_signature) values(p_user_id,retry,signature);
  end if;
  return result;
end;
$$;

create function public.workspace_correct_call(p_user_id uuid,p_changes jsonb,p_request_id uuid)
returns jsonb language sql security invoker set search_path = ''
return workspace_private.correct_call(p_user_id,p_changes,p_request_id);

revoke all on function workspace_private.correct_call(uuid,jsonb,uuid),public.workspace_correct_call(uuid,jsonb,uuid)
  from public,anon,authenticated;
grant execute on function workspace_private.correct_call(uuid,jsonb,uuid),public.workspace_correct_call(uuid,jsonb,uuid) to service_role;
notify pgrst,'reload schema';
