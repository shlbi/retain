# Call workspace

A blue, unbranded call outcome tracker for desktop and phone. Sign in with a username and password, tap the service outcomes, and log the call. UCID and account number are optional.

## Mobile orders and mobiles sold

Each mobile order contains **1–12 mobiles**. A call can include multiple separate orders. The dashboard tracks both quantities and percentages:

| Metric | Calculation | Example over 10 calls |
| --- | --- | --- |
| Mobile orders | Number of orders ÷ calls × 100 | One order with 3 mobiles = 1 order, 10% |
| Mobile lines | Number of mobiles sold ÷ calls × 100 | The same order = 3 mobiles, 30% |
| Mobile save | Calls keeping existing mobile service ÷ calls starting with mobile × 100 | New sales are separate from retained service |

The other rings show overall, internet, TV, home phone, single-play, double-play, and triple-play (3+) save rates. Saves use retained service count; full disconnects use starting service count. A 3-to-2 downgrade is DPS plus its disconnected service. Play rates use each outcome pair, such as DPS ÷ (DPS + DPD). TP groups three or four services. Daily reports use Eastern time. Goals are editable and are not official company targets.

## Accounts and storage

- Username/password signup and sign-in; no email, password-complexity requirement, or verification step.
- Any nonempty password is accepted. Usernames are trimmed and case-insensitive; a username must be available.
- Passwords use salted scrypt hashes. Random session tokens are stored only as digests in the database and sent in HttpOnly, SameSite cookies.
- Records and goals are stored in Supabase Postgres and isolated by account. Use the same account on another device to access them.
- Same-origin Vercel server functions handle every database operation. Supabase secrets never reach the browser. Private database tables have RLS enabled and deny direct access; only explicitly granted server RPCs can read/write them.
- Concurrent edits are revision-checked. Duplicate nonblank UCIDs are rejected per account. Blank IDs may occur on any number of calls.
- Changes refresh on focus and every 30 seconds while visible. A failed request never falls back to a separate local database.
- There is no email recovery flow. Keep the username and password; a trusted operator can arrange password recovery separately.

## Setup

See [DEPLOYMENT.md](DEPLOYMENT.md). The repository is ready for Vercel's GitHub integration; no manual deployment command is needed. The database migration and two server environment values must be configured once.

Install the test dependency and run checks with Node.js 22:

```sh
npm ci
npm test
npm run build
```

There are no runtime npm dependencies. To run locally with an already configured Supabase project, supply the environment values in `.env.example` to your shell, then run `npm run dev`. The local server prints its URL. It does not automatically load `.env` files; Node's `--env-file` option can be used: `node --env-file=.env.local scripts/dev-server.mjs`.

## Backups and limits

Export CSV for reporting or JSON for full backup/restore. Restore merges records atomically, skips identical entries, and rejects conflicts without overwriting them. Backups include any entered call/account identifiers.

Version 2 backups with 0–12 mobiles on a call migrate to zero or one order. Legacy counts over 12 cannot reveal the number of orders and must be corrected into actual order quantities before import; the app never invents an order split. Version 3 preserves every order quantity.

The workspace supports at most 10,000 calls and a 3 MiB serialized snapshot; requests have a 4 MiB application limit. Each call supports up to 20 separate mobile orders as an input bound. These bounds keep responses below Vercel's function payload limit. Export a backup before removing old records when capacity is reached.
