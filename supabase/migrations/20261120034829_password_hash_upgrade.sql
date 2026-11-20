-- The server supplies the previously verified digest and a fresh, salted digest
-- after a successful legacy password check. Approval can move a request to a new
-- active identity concurrently; a stale verification may never replace its hash.
create function public.auth_upgrade_password_hash(
  p_identity_id uuid, p_status text, p_expected_hash text, p_new_hash text
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if p_expected_hash is null or p_expected_hash !~ '^scrypt[$]32768[$]8[$]1[$][0-9a-f]{32}[$][0-9a-f]{128}$'
     or p_new_hash is null or p_new_hash !~ '^scrypt[$]32768[$]8[$]3[$][0-9a-f]{32}[$][0-9a-f]{128}$' then
    raise exception 'VALIDATION: Unsupported credential format.';
  end if;
  if p_status = 'active' then
    update workspace_private.users set password_hash=p_new_hash
      where id=p_identity_id and password_hash=p_expected_hash;
  elsif p_status = 'pending' then
    update workspace_private.signup_requests set password_hash=p_new_hash
      where id=p_identity_id and password_hash=p_expected_hash;
  else
    raise exception 'VALIDATION: Unknown account status.';
  end if;
  return found;
end;
$$;
revoke all on function public.auth_upgrade_password_hash(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.auth_upgrade_password_hash(uuid,text,text,text) to service_role;
notify pgrst,'reload schema';
