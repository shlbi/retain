# Tracker database

Run [schema-inventory.sql](../scripts/schema-inventory.sql) in the Supabase SQL Editor to inspect the installed database. The first rows list schemas and their tables or views. Subsequent rows describe the application's columns, keys, indexes, row-level security, policies and routine signatures. The query reads only PostgreSQL catalogs. Its output can be shared for schema review without including usernames, credentials, tokens or customer records.

## What production contained before named teams

The November 19, 2026 inventory found ten application tables in `workspace_private`. The `public` schema contained 22 application routines and zero tables or views. Supabase owns separate schemas including `auth`, `storage`, `realtime`, `vault` and `supabase_migrations`. The tracker uses its own accounts in `workspace_private`. Supabase's `auth.users` is a separate identity system.

| Table in `workspace_private` | One row represents | Key and relationships |
| --- | --- | --- |
| `users` | An approved tracker account, with display username, lookup key, password hash, role, goal settings and bingo channel ID | `id` is the primary key. `username_key` is unique. The composite foreign key `(supervisor_id, supervisor_role)` points to another user's `(id, role)` and requires that account to be a supervisor. |
| `signup_requests` | A pending username, salted password hash, requested role and submission time | `id` is the primary key. `username_key` is unique. Approval creates the active user and consumes the request in one transaction. Denial removes it and releases the username. |
| `sessions` | One login session, with a token digest, issue time and expiry | Primary key `token_hash`. `user_id` references `users.id`. |
| `auth_limits` | Attempts in one authentication rate-limit bucket and its current window | Primary key `bucket_key`. The server hashes user or network identifiers when constructing applicable bucket keys. |
| `tally_days` | One agent's totals for one Eastern reporting date, including calls, save opportunities, saves, mobile orders and lines | Primary key `(user_id, day)`. `user_id` references `users.id`. |
| `tally_groups` | The number of customer accounts with the same fixed service/outcome tags for an agent on a date | Primary key `(user_id, day, tags)`. `(user_id, day)` references `tally_days`. |
| `tally_receipts` | A digest of a submission's random retry token, with a digest used to verify repeat submissions | Primary key `(user_id, retry_key)`. `user_id` references `users.id`. Repeating a confirmed submission with the same data counts it once. |
| `bingo_games` | One supervisor's game, schedule, incentive, winning pattern and nine squares | Primary key `id`. `supervisor_id` references `users.id`. |
| `bingo_scores` | A player's accumulated scoring counters for one game | Primary key `(game_id, user_id)`. These IDs reference `bingo_games.id` and `users.id`. |
| `request_days` | Authenticated API request count, HTTP 5xx count and total measured handling time for an Eastern date | Primary key `day`. The admin charts combine these daily measurements with aggregate activity from `tally_days`. |

## Teams and read access

A supervisor's user ID identifies the roster. Each agent or admin can have one current supervisor. The roster used for dashboard access, goals, games and standings comes from the same `users.supervisor_id` relationship. The current leader of a game’s team is recorded in `bingo_games.supervisor_id`. A change of team updates who can see the agent and which team's live game receives future eligible scores. Games continue to use the existing game and player IDs.

The named-team migration adds an eleventh table, `workspace_private.teams`. The primary key `supervisor_id` references the team leader's `users.id`. The case-insensitive unique index on `lower(name)` reserves each display name. The deletion migration adds a unique `id` that survives leadership changes. Creating a team always generates a fresh ID, even when its supervisor and name match a previously deleted team. A foreign key also links every `bingo_games.supervisor_id` to its team. The migration names existing rosters and game owners, including former supervisors who already had historical games. Assigning an agent through an older client also provisions a name if needed.

A named team is active while its assigned leader holds the supervisor role. The membership foreign key requires all members to move before that role can change. Demoting a supervisor retires an empty team without games. A team with games becomes dormant, disappears from the active directory and keeps its name and game IDs. Its former leader can participate as a player on their newly assigned team. Re-promoting that leader reactivates the dormant team with an empty roster. The admin can then assign its members again.

The team editor calls `workspace_admin_save_team_details` to save the name, supervisor and complete roster in one transaction. It checks the original team name and membership plus the prior assignment of each selected member. An outdated edit returns a conflict. On a leadership handoff, the team’s games and scores keep their IDs and the new supervisor receives access. The earlier team procedures remain available to clients already open during rollout. The server takes the acting user from their session. Supervisor reads, goal changes and game launches use the supervisor's own roster. On transfer, the old team's Realtime topic rotates. Broadcasts contain an empty refresh signal. Standings are retrieved through the authenticated API.

## Permanent deletion

`workspace_admin_delete_team` checks the team's identity, supervisor, name and roster against the admin's confirmation. It clears the members' assignments, removes team games and their scores, and deletes the team in one transaction. Members retain their goals and tallies.

`workspace_admin_delete_account` checks the account ID, username, role, assignment and any owned team's identity, name and members. This includes dormant teams with game history. The transaction removes an owned team, then the agent or supervisor account and its dependent sessions, tally days, groups, submission receipts and scores. A reused username identifies a new account. Admin accounts cannot be deleted by these procedures.

These operations remove live application records. Daily technical request counts are aggregate measurements. Database backups and earlier exports have their own retention schedules.

## Credentials and privileges

The username is visible in the roster and directory. The server stores a salted scrypt password verifier in `users.password_hash` or `signup_requests.password_hash`. A successful verification of an older password hash can upgrade it in place with the password-hash upgrade migration and matching server release. That routine compares the stored hash with the verified hash before replacing it, so a concurrent approval or edit cannot overwrite a changed credential. The browser holds the session token in an HttpOnly cookie. Only its digest is stored in `sessions`.

The password-change migration adds two tables to `workspace_private`. Each references `users.id` and cascades on account deletion.

| Table | Stored data and lifetime |
| --- | --- |
| `password_change_requests` | A request ID, user ID and submission time. Each active account can have one pending request. Approval or denial consumes the request. |
| `password_change_codes` | A user ID, SHA-256 digest of a randomly generated reset code and expiry time. A code is usable once for 30 minutes. Approving a later request replaces the earlier code. |

The admin directory projects the request ID, username and submission time. The approving admin receives the code for private delivery. The user submits the code and chooses the new password. Redemption replaces the password hash, consumes the reset and revokes the account’s sessions in one transaction. Sign-in checks that the credential verified by the server still matches the account before it issues a session.

The baseline inventory showed RLS enabled on all ten tables. The `anon`, `authenticated` and `service_role` roles had no direct table grants. Among those roles, only `service_role` could execute the application's public routines. The backend calls fixed routine names with structured arguments using its server-only key. Privileged operations check the session user's current role and membership inside Postgres. Database owners retain administrative access.

| Routine group | Purpose |
| --- | --- |
| `auth_*` | Submit an access request, verify credentials, manage sessions and enforce authentication rate limits. The compatibility routine `auth_register` routes older clients into the approval queue. |
| `workspace_admin_*` | Review or create accounts, make assignments and serve administrator reports. `workspace_admin_performance` supplies the chart data. `workspace_admin_stats` supports older clients. |
| `workspace_team_context`, `workspace_agent_state`, `workspace_team_goals` | Resolve the signed-in user's role and roster, read an assigned agent's dashboard and set team goals. |
| `workspace_tally`, `workspace_tally_state`, `workspace_edit_day` | Apply a call's aggregate changes transactionally, read grouped history and correct a stored reporting day. |
| `workspace_launch_game`, `workspace_game_state` | Schedule a game and return the appropriately scoped board and standings. |
| `workspace_record_request` | Accumulate technical measurements for the date. |

## Legacy and migration history

The production inventory found neither `workspace_private.calls` nor `workspace_private.call_versions`. Historic migrations and the [grouped cleanup script](../scripts/retain-grouped-cleanup.sql) mention them because older installations used individual call records. Those files describe prior database versions. Backups and earlier exports have separate lifecycles.

Compare live catalog output and Supabase migration history before proposing any schema cleanup. The [migrations](../supabase/migrations/) define upgrades in order. The [deployment guide](../DEPLOYMENT.md) covers rollout and first-admin setup.
