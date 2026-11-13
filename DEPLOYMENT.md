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

1. Sign up and record a call that starts with Internet and Video and keeps Internet. Confirm the row shows **DP → SP**, **Internet kept**, **Video disconnected** and **1 account**.
2. Save the same combination as a second call. Refresh, then sign in on another device. Confirm a single matching row shows **2 accounts** and the call counter shows **2**.
3. Log two accounts on one call with identical starting services. Keep every original service on one account and disconnect every original service on the other. Confirm that the resulting rows carry the **Wash** tag and that call count increases by one.
4. Log one mobile order with three lines. Confirm the daily mobile row gains one order and three lines. Adding Mobile as an account service also gives that service one save.
5. Export the grouped report. Check that rows contain the expected dates, service tags and account or sales counts. Sign in to a different fresh workspace and verify its totals start empty.

Production history resides in Supabase. A browser refresh before submitting discards the current form. After a confirmed save, refreshing reloads the grouped totals. When storage cannot confirm a submission, check the current totals or use the retry action on the pending form before starting a new entry.

## Operational notes

History editing requires migration `20261113230000_edit_grouped_history.sql`. If the GitHub integration has not applied it, run the entire [enable-history-edit.sql](scripts/enable-history-edit.sql) file in the Supabase SQL Editor. The script installs the edit function once, records the matching migration version and returns `editing_ready = true`.

The API uses expiring sessions, salted password hashes, rate limits and atomic per-user database operations. The app has no email password-reset or administrative interface. Manage database backups and trusted operator access in Supabase. Keep server keys out of the frontend and source control.
