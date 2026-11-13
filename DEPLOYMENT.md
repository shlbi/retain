# Vercel + Supabase setup

Vercel deploys this repository automatically after GitHub pushes. The app includes `vercel.json`, the static frontend in `dist/`, and the server endpoint in `api/workspace.js`. Keep the Vercel project root at the repository root; do not set its root to `dist/`.

## 1. Deploy the database schema from GitHub

The Supabase project **retain** is connected to **shlbi/retain**. In Supabase → Project Settings → Integrations → GitHub, use working directory **`.`**, production branch **`main`**, and enable **Deploy to production**. The working directory is the parent of `supabase/`, not `supabase/` itself.

On each push to `main`, Supabase applies unapplied SQL files from `supabase/migrations/` and records their versions. No separate GitHub Action or manual SQL-editor execution is needed. Check the Supabase deployment status after pushing; the GitHub test job only validates the app, not the hosted database deployment.

Keep applied migration files unchanged. For future schema changes, run `supabase migration new descriptive_name`, put the SQL in the generated file, test it, and commit it. Never rerun the initial schema in the SQL editor or rename a migration already recorded by Supabase. The initial migration creates the tables and functions. The follow-up account outcomes and callbacks migration updates validation and the bundle goal. Existing single-account records remain readable and are scored from their original and kept services.

This app uses Supabase **Postgres**, with its own username/password authentication. It does not create Supabase Auth users, so email confirmation settings and Supabase Auth password rules do not affect signup. Data is stored in a private schema; public RPC functions are executable only by `service_role`. The browser cannot call those functions directly.

For an existing deployment, verify that Supabase lists migration versions `20261106005417` and `20261113022327` before saving a call with extra accounts, added services, or a callback. The second version is the upgrade for a database already initialized with the first migration.

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

- Create an account with a username and a simple password. There is no email step.
- Save a call with both IDs blank. Reload and confirm it remains saved.
- Start a triple-play account with Internet, Video and Voice. Keep Video and Voice. Confirm **TP → DP** and an Internet disconnect in the call log. The service rings include the account and the play and bundle rings exclude it.
- On another call, add a second account with the same original services as the first. Keep all originals on one and disconnect all on the other. Confirm the wash and check that the call contributes once to the sales denominator.
- Add mobile service and one order with 3 mobiles. Confirm one mobile service save, one order, and three sold lines.
- Schedule a callback with a note. Check that Cancel leaves the change unscheduled and Yes lets you save it. Reopen the app after the due time and confirm the reminder and note are available.
- Sign in from another browser/device and confirm the same records.
- Sign out and create a different account. It must start with no calls.
- Try a stale edit from a second tab, export/restore a backup, and check phone layout.

Without the Supabase variables or migration, the app shows a setup/storage error and does not pretend to save records locally.

## Existing browser-local records

Before replacing the previous local-only version, download its JSON backup. After signing in to the new version, use **How your numbers work → Restore backup**. Review the restored count. The app never uploads another browser user's local database automatically.

Cloud records belong to the Supabase project and account, so a domain change does not move or erase them. Sign in again on the new domain. Keep the same Supabase configuration to access the same data.

## Operational notes

The application includes hashed passwords, persistent authentication rate limits, expiring/revocable sessions, same-origin request checks, private database tables, per-account ownership, and optimistic concurrency checks. There is no email-based password reset, administrative UI, or Spectrum account lookup. Manage database backups and trusted operator access in your Supabase project. Never expose the server secret key in frontend code.
