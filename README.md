# Call workspace

A responsive tracker for call outcomes, mobile sales and daily goals. Sign in with a username and password, tap the account outcomes and save. Each successful save updates your grouped daily totals in Supabase.

## Logging and scoring a call

Select the original services, mark the services kept, and select any additions. Use **Add another account** for each additional account handled during the call. Enter mobile orders on the account that placed them. Entry uses fixed choices. UCIDs, customer account numbers, callback reminders and free-text notes have been retired.

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

Each mobile order contains **1–12 mobiles**. A call can contain multiple orders. Across ten calls, one order for three mobiles gives a **10% order rate** and a **30% line rate**. Every call contributes once to each sales denominator, including calls with several customer accounts or a wash. Use **Mobile orders** on the selected account. If that account started without Mobile, its first order earns one mobile service save. Orders on an account that started with Mobile count toward sales, and its kept or disconnected choice determines mobile retention credit.

Daily reports use Eastern time. Each ring shows progress against the goal assigned by the supervisor.

### Grouped history

Each report date has one row per combination of outcome and service tags. Identical account outcomes increase the count on that row. A separate mobile sales row records the total number of orders and lines for that date.

| Outcome tags | Count |
| --- | --- |
| DP → SP · Internet kept · Video disconnected | 8 accounts |
| SPS · Internet kept | 11 accounts |
| Mobile sold | 6 orders · 9 lines |

Use **Edit** on a call-log row to correct that date’s grouped service outcomes, account counts and call or mobile totals. Changes update the daily stats in Supabase. An edit is rejected if the day has changed since the editor opened.

The account counts and the sales counts use different units. For example, a call handling two accounts can increase two account counts, but still increases the daily call count by one. The grouped CSV includes the report date, outcome, service changes and counts in the chosen view.

## Accounts and storage

Supabase Postgres stores grouped daily history and goals for each signed-in user. After a confirmed save, refreshing, reopening the site or signing in on another device loads those totals. The browser holds only the displayed view and unfinished selections in memory. A refresh clears an unsaved form. There is no browser database, offline queue or end-of-shift save step.

Each submission includes a random retry token so retrying the same submission cannot add it twice. The server applies the grouped changes and daily counters in one transaction. Account-level outcome groups and daily mobile totals retain no association with individual orders or calls in the history.

Use credentials created specifically for this tracker. Each can contain 1–8 characters. Usernames cannot start with a digit, `p` or `P`. Existing accounts can continue to sign in with their original credentials. To request access, choose **Agent** or **Supervisor** on the sign-up screen. After an admin approves the request, sign in with the same username and password.

The app uses its own username/password accounts and an HttpOnly session cookie. Passwords are salted and hashed with scrypt. The server connects to the private database through same-origin Vercel functions. Database credentials stay on the server.

## Team workspaces

| Role | Workspace |
| --- | --- |
| Agent | Log calls, correct personal history, view assigned goals and play the assigned team's game. |
| Supervisor | Select a team member in the sidebar to view that person's percentages and call log. In **Goals**, choose a metric and apply its target to the whole current roster or selected agents. In **Games**, schedule team bingo and see player progress. |
| Admin | Use the personal agent workspace and play on an assigned team. Open **Admin** to see performance charts, review sign-ups, create accounts, assign roles and manage team membership. |

In **Admin → Accounts**, review pending requests or create an account for someone who needs immediate access. The directory lets an admin change an existing user's role and supervisor. Assign the supervisor role first, then select that supervisor for each team member. Each agent or admin can belong to one team. Move a supervisor's team members before changing that supervisor's role. Admins can change their own team and retain their admin access.

### Team bingo

Open **Games** to see the current board. A supervisor sets the incentive, start and end in local time, and a metric and target for each of nine squares. Choose a line (horizontal, vertical or diagonal) or blackout (all nine). A team can schedule multiple games with nonoverlapping time windows. The first confirmed submission of a tally scores once when its Eastern report date matches today and the server receives it during the game. Historical corrections update reporting independently because grouped history does not identify the time of each call. A wash contributes calls and any eligible additions or sales under the existing scoring rules.

The compact leaderboard shows three players and the signed-in player's rank. A Supabase Realtime signal refreshes standings across devices after a new score. If the socket is unavailable, active games refresh every five seconds while the page is visible. Players who reach the winning pattern rank first, then players are ranked by completed squares. Ties share rank. Supervisors can expand each player's totals.

Open **Games** to keep the board beside the workspace. Both panes stay interactive, so an agent can log a call while watching the leaderboard. On narrow phones the panes stack and scroll independently. Opening or closing Games preserves the current call draft.

### Admin report

**Admin → Performance** charts tracker activity over the last 7, 14 or 28 Eastern reporting dates. Daily call volume shows how much work agents entered. Daily active agents counts people who logged at least one call that day. Switch the volume chart to **Per active agent** to see calls divided by that day's active agents. For the full period, the average divides total calls by the sum of daily active agents. Past-day corrections can change the workload charts. Select a day on a chart or open **View daily values** for the underlying numbers.

The technical section at the bottom reports authenticated workspace API requests, HTTP 5xx responses and mean server handling time. The average uses measured requests, and days without a measurement have no latency value. Telemetry began with the first team release. A database outage can prevent a measurement from being recorded.

## Setup

Follow the [deployment guide](DEPLOYMENT.md) to upgrade Supabase before enabling the new frontend and API. Vercel builds the repository from its root.

Install the test dependency and run checks with Node.js 22:

```sh
npm ci
npm test
npm run build
```

There are no runtime npm dependencies. To run locally with an already configured Supabase project, supply the environment values in `.env.example` to your shell, then run `npm run dev`. The local server prints its URL. It does not automatically load `.env` files; Node's `--env-file` option can be used: `node --env-file=.env.local scripts/dev-server.mjs`.

## Earlier records

The database upgrade converts historical records in Supabase to grouped daily counts. The [cleanup SQL](scripts/retain-grouped-cleanup.sql) verifies those counts and permanently removes the individual call records, callback notes and call revisions from the live database. Previously downloaded files and database backups may still contain customer details.
