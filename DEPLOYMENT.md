# Vercel + Supabase setup

Vercel deploys this repository automatically after GitHub pushes. The app includes `vercel.json`, the static frontend in `dist/`, and the server endpoint in `api/workspace.js`. Keep the Vercel project root at the repository root; do not set its root to `dist/`.

## 1. Create the database tables and functions

Open the intended Supabase project, open its SQL editor, and run **`supabase/migrations/001_workspace.sql`** once as the database owner. Alternatively, apply it through your usual migration runner. The migration is transactional and intentionally does not drop existing objects or overwrite data.

This app uses Supabase **Postgres**, with its own username/password authentication. It does not create Supabase Auth users, so email confirmation settings and Supabase Auth password rules do not affect signup. Data is stored in a private schema; public RPC functions are executable only by `service_role`. The browser cannot call those functions directly.

## 2. Set Vercel server environment variables

In the Vercel project's Environment Variables settings, add:

| Name | Value |
| --- | --- |
| `SUPABASE_URL` | Your project's HTTPS URL, for example `https://your-project.supabase.co` |
| `SUPABASE_SECRET_KEY` | A Supabase server secret key (`sb_secret_…`) |

Older projects may use `SUPABASE_SERVICE_ROLE_KEY` instead of `SUPABASE_SECRET_KEY`. Use only the intended project. Never put these values in GitHub files or variables prefixed `NEXT_PUBLIC_` or `VITE_`. The anonymous/publishable key is not sufficient for this server adapter.

Optional `APP_ORIGIN` fixes the allowed origin to a canonical URL such as `https://your-domain.com`. If omitted, requests must match the host that served the app. If set, use the correct origin separately for each environment; a production-only value would intentionally reject mutations from preview URLs.

Use separate Supabase projects for production and previews if preview builds should not access production records. Vercel supplies `VERCEL` itself, enabling Secure cookies. Setting environment variables requires a new deployment to take effect; the next GitHub push can trigger it.

## 3. Verify the configured app

- Create an account with a username and a simple password. There is no email step.
- Save a call with both IDs blank. Reload and confirm it remains saved.
- Add one order with 3 mobiles. Confirm 1 order and 3 mobiles, with separate rate rings.
- Sign in from another browser/device and confirm the same records.
- Sign out and create a different account. It must start with no calls.
- Try a stale edit from a second tab, export/restore a backup, and check phone layout.

Without the Supabase variables or migration, the app shows a setup/storage error and does not pretend to save records locally.

## Existing browser-local records

Before replacing the previous local-only version, download its JSON backup. After signing in to the new version, use **Daily goals → Records & backups → Restore a backup**. Review the restored count. The app never uploads another browser user's local database automatically.

Cloud records belong to the Supabase project and account, so a domain change does not move or erase them. Sign in again on the new domain. Keep the same Supabase configuration to access the same data.

## Operational notes

The application includes hashed passwords, persistent authentication rate limits, expiring/revocable sessions, same-origin request checks, private database tables, per-account ownership, and optimistic concurrency checks. There is no email-based password reset, administrative UI, or Spectrum account lookup. Manage database backups and trusted operator access in your Supabase project. Never expose the server secret key in frontend code.
