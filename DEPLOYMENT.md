# Vercel + Supabase setup

Vercel deploys this repository automatically after GitHub pushes. The app includes `vercel.json`, the static frontend in `dist/`, and the server endpoint in `api/workspace.js`. Keep the Vercel project root at the repository root; do not set its root to `dist/`.

## 1. Upgrade Supabase before enabling the new app

Apply the checked-in migrations from `supabase/migrations/` in filename order. The initial migration creates the workspace, the next introduces multi-account outcomes, and the grouped tally migration installs the new reporting functions and converts historical data. Existing projects should apply only versions missing from their migration history.

For the GitHub integration, use repository **shlbi/retain**, working directory **.**, production branch **main**, and enable **Deploy to production**. Check the production database's applied migration history. Supabase and Vercel run independently. A successful Vercel deployment establishes only that the website built. If it goes live first, complete the database migration before agents resume logging.

The cutover backfills daily tallies from existing calls and restricts the old raw-record functions. Agents with the old page open should refresh before continuing. Confirm that migration `20261113033103_grouped_tallies.sql` is recorded and both functions exist. This read-only SQL checks the production installation without reading user data.

```sql
select
  exists (
    select 1 from supabase_migrations.schema_migrations
    where version = '20261113033103'
  ) as migration_recorded,
  to_regprocedure('public.workspace_tally(uuid,date,jsonb,uuid)') is not null as tally_write_ready,
  to_regprocedure('public.workspace_tally_state(uuid)') is not null as tally_read_ready;
```

All three columns should be true. Complete the synthetic checks below before resuming use.

The grouped migration by itself leaves legacy calls in a private archive. To retire an existing archive, pause call entry, handle outstanding callbacks and run the complete [cleanup SQL](scripts/retain-grouped-cleanup.sql) in the Supabase SQL Editor. It checks daily totals and service groups before permanently removing the old call and revision tables. All four result columns should be true. Earlier database backups and downloaded exports have their own retention periods.

This app uses Supabase Postgres with its own username/password authentication. Supabase Auth email settings do not affect signup.

## 2. Set Vercel server environment variables

In the Vercel project's Environment Variables settings, add:

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | `https://byrqvlamuspcfiiirjhd.supabase.co` (the connected `retain` project) |
| `SUPABASE_SECRET_KEY` | A Supabase server secret key (`sb_secret_…`) |

Older projects may use `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`. Use only the intended project. Never put these values in GitHub files or variables prefixed `NEXT_PUBLIC_` or `VITE_`. The anonymous/publishable key is not sufficient for this server adapter.

The Supabase GitHub integration deploys the database schema; it does not supply these server environment variables to Vercel. Set them in Vercel if they are not already configured.

Optional `APP_ORIGIN` fixes the allowed origin to a canonical URL such as `https://your-domain.com`. If omitted, requests must match the host that served the app. If set, use the correct origin separately for each environment; a production-only value would intentionally reject mutations from preview URLs.

Use separate Supabase projects for production and previews if preview builds should not access production records. Vercel supplies `VERCEL` itself, enabling Secure cookies. Setting environment variables requires a new deployment to take effect; the next GitHub push can trigger it.

## 3. Verify the configured app

Use a test workspace and synthetic selections for these checks.

1. Submit a test agent sign-up. Confirm sign-in shows the pending status. In a separate admin session, approve the request in **Admin → Accounts**. Then sign in as the test agent and record a call that starts with Internet and Video and keeps Internet. Confirm the row shows **DP → SP**, **Internet kept**, **Video disconnected** and **1 account**.
2. Save the same combination as a second call. Refresh, then sign in on another device. Confirm a single matching row shows **2 accounts** and the call counter shows **2**.
3. Log two accounts on one call with identical starting services. Keep every original service on one account and disconnect every original service on the other. Confirm that the resulting rows carry the **Wash** tag and that call count increases by one.
4. Log one mobile order with three lines. Confirm the daily mobile row gains one order and three lines. The first order on an account that started without Mobile also earns one mobile service save.
5. Export the grouped report. Check that rows contain the expected dates, service tags and account or sales counts. Sign in to a different fresh workspace and verify its totals start empty.

Production history resides in Supabase. A browser refresh before submitting discards the current form. After a confirmed save, refreshing reloads the grouped totals. When storage cannot confirm a submission, check the current totals or use the retry action on the pending form before starting a new entry.

## Operational notes

History editing requires migration `20261113230000_edit_grouped_history.sql`. If the GitHub integration has not applied it, run the entire [enable-history-edit.sql](scripts/enable-history-edit.sql) file in the Supabase SQL Editor. The script installs the edit function once, records the matching migration version and returns `editing_ready = true`.

The API uses expiring sessions, salted password hashes, rate limits and atomic per-user database operations. Admin reporting is available to trusted admin accounts. Manage database backups and trusted operator access in Supabase. Keep server keys out of the frontend and source control.

Apply the password-hash upgrade migration before deploying its server release. New and admin-created accounts immediately use the stronger scrypt profile described in the README. A legacy upgrade compares the previously verified digest and identity to avoid overwriting a concurrent change. Existing sessions continue on their normal expiry schedule. Any rollback must retain verification for both the p=1 and p=3 formats. Each function instance runs at most two password derivations at once and queues up to eight more. Requests beyond capacity receive a retryable response.


## Team setup and permissions

Apply the checked-in migrations in filename order, including the team editor migration before deploying the combined name, supervisor and roster form. Upgrading preserves existing active accounts, sessions, roles, team assignments and history. New public sign-ups go to a private requests table. Active workspaces and sessions are created only for approved or admin-created accounts.

Use **Admin → Accounts** and **Admin → Teams** for normal operations.

1. Open a pending request and approve it as an agent or supervisor, or deny it. Denial removes the pending password hash and releases the username. Approvals let the person sign in with the credentials they already chose.
2. Give the intended leader the Supervisor role. Open **Admin → Teams → Create team**. Enter its name, choose the supervisor and select the roster in the same form. Use **Edit** on its row to update the team later. An agent or admin can also be assigned individually from the Accounts directory. Existing supervisors with rosters or games receive editable default names during the named-team migration.
3. To change a supervisor's role, move their members first. Each admin keeps their own admin role when editing their own assignment. Role and roster checks run in the database on each privileged operation.

### First admin on a fresh installation

The production tracker already has an admin. The steps below are only for a new database that has none. Have the intended owner submit a sign-up and confirm the username directly with them. As a database operator, find that username in the private sign-up requests table and copy the matching request ID into the transaction below. The query consumes that exact request, transfers its existing password hash and creates the admin in the same transaction.

```sql
begin;
lock table workspace_private.users, workspace_private.signup_requests in share row exclusive mode;
with initial as (
  delete from workspace_private.signup_requests
  where id = '<verified-request-uuid>'::uuid
    and not exists (select 1 from workspace_private.users where role = 'admin')
  returning username, username_key, password_hash
)
insert into workspace_private.users (username, username_key, password_hash, role)
select username, username_key, password_hash, 'admin' from initial
returning username, role;
commit;
```

Once an admin exists, the transaction affects zero rows. For team verification, use two synthetic teams and check that each supervisor can open only their assigned agents.

For cross-device game updates, the browser subscribes to an opaque Supabase Broadcast topic for its team. Messages contain an empty refresh signal. Each client reloads standings through the session-bound workspace endpoint. Removing or transferring a member rotates the old team's topic. The hosted project uses its publishable key for this socket. To rotate it or point the deployment at another hosted project, set `SUPABASE_PUBLISHABLE_KEY` to an enabled `sb_publishable_` key for `SUPABASE_URL` and redeploy. Server credentials stay in the server adapter. Live games fall back to polling during a socket outage.
