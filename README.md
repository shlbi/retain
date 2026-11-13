# Call workspace

A blue, unbranded call outcome tracker for desktop and phone. Sign in with a username and password, tap the service outcomes, and log the call. UCID and account number are optional.

## Logging and scoring a call

Enter the original services for each customer account, mark the services kept, and select any services added during the call. Use **Add another account** for a second or subsequent account handled on the same call. Each account has its own optional account number. The call has one optional UCID and one set of mobile orders.

| Account outcome | History tag | Rates affected |
| --- | --- | --- |
| Single service kept or disconnected | SPS or SPD | That service and single-play |
| All original services kept or all disconnected on a double account | DPS or DPD | Each original service, double-play, and bundle |
| All original services kept or all disconnected on a triple account | TPS or TPD | Each original service, triple-play, and bundle |
| Some original services kept on a bundle | DP → SP, TP → DP, or TP → SP | Each original service counts as kept or lost. All play and bundle rates exclude the downgrade. |
| New service added | Service added | One success and one opportunity for that service |

For example, a customer starts with Internet, Video and Voice. Keeping Video and Voice and disconnecting Internet gives **TP → DP**. Video and Voice each earn a save. Internet records one opportunity and zero saves. This call counts once in overall save rate because the customer kept an original service.

Triple-play includes accounts starting with three or four services. A four-to-three downgrade is labeled **TP (4 → 3)**. Added services earn service credit independently of how the original services turned out.

A **wash** pairs two accounts on the same call that started with exactly the same services when one kept every original service and the other disconnected every original service. Each account can participate in one pair. Paired original outcomes are excluded from service, play, bundle, and overall results. Added services and mobile sales still earn credit. Other accounts on the same call score normally. Overall save rate counts one opportunity per call with an unpaired account and one success if any such account kept an original service.

### Mobile orders and mobiles sold

Each mobile order contains **1–12 mobiles**. A call can contain multiple orders. Across ten calls, one order for three mobiles gives a **10% order rate** and a **30% line rate**. Every call contributes once to each sales denominator, including calls with several customer accounts or a wash. Adding mobile service to an account earns one mobile service save. Record the sold lines in the mobile order controls.

Daily reports use Eastern time. Goals are editable. Existing single-account records and imported history use the same scoring rules.

### Callback reminders

Choose a callback date and time, add an optional note, and confirm that your supervisor approved the callback. Save the call to keep its reminder. The workspace shows due callbacks while it is open and checks for overdue callbacks when you return.

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

See [DEPLOYMENT.md](DEPLOYMENT.md). Vercel deploys the app from GitHub, and the connected Supabase GitHub integration applies migrations from `supabase/migrations/`. Enable **Deploy to production** for `main` in Supabase. Two server environment values must be configured in Vercel once; neither deployment needs a manual command.

Install the test dependency and run checks with Node.js 22:

```sh
npm ci
npm test
npm run build
```

There are no runtime npm dependencies. To run locally with an already configured Supabase project, supply the environment values in `.env.example` to your shell, then run `npm run dev`. The local server prints its URL. It does not automatically load `.env` files; Node's `--env-file` option can be used: `node --env-file=.env.local scripts/dev-server.mjs`.

## Backups and limits

Export CSV for reporting or download a JSON backup for a full restore. Open **How your numbers work → Restore backup** and select the JSON file. Restore merges records atomically, skips identical entries, and rejects conflicts without overwriting them. Backups include customer account details, any entered identifiers, and saved callback notes.

Version 2 backups with 0–12 mobiles on a call migrate to zero or one order. Legacy counts over 12 cannot reveal the number of orders and must be corrected into actual order quantities before import; the app never invents an order split. Version 3 preserves every order quantity.

The workspace supports at most 10,000 calls and a 3 MiB serialized snapshot; requests have a 4 MiB application limit. Each call supports up to 20 separate mobile orders as an input bound. These bounds keep responses below Vercel's function payload limit. Export a backup before removing old records when capacity is reached.
