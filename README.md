# Call workspace

A responsive tracker for call outcomes, mobile sales and daily goals. Sign in with a username and password, tap the account outcomes and save. Each successful save updates your grouped daily totals in Supabase.

## Logging and scoring a call

Select the original services, mark the services kept, and select any additions. Use **Add another account** for each additional account handled during the call. Enter mobile orders on the account that placed them. Entry uses fixed choices. UCIDs, customer account numbers, callback reminders and free-text notes have been retired.

The dashboard and supervisor goal builder use these eleven rates in the same order. The team overview divides pooled successes by pooled opportunities.

| Dashboard ring | Numerator divided by denominator |
| --- | --- |
| Internet save rate | Internet kept or added ÷ eligible internet opportunities |
| SPS | Full saves ÷ full saves and full disconnects on single-service accounts |
| Video save rate | Video kept or added ÷ eligible video opportunities |
| Mobile line save rate | Sum of the smaller of starting and ending lines per eligible account ÷ total starting lines on those accounts |
| Mobile line yield | New mobile lines sold ÷ all calls |
| Mobile order yield | Mobile orders placed ÷ all calls |
| Voice save rate | Voice kept or added ÷ eligible voice opportunities |
| DPS | Full saves ÷ full saves and full disconnects on two-service accounts |
| TPS | Full saves ÷ full saves and full disconnects on exactly three-service accounts |
| SP Internet | Internet-only starting accounts that kept internet ÷ eligible internet-only starting accounts |
| Subscriber save rate | Accounts keeping at least one original service ÷ eligible accounts |

Selecting Mobile as a starting service opens **Started with** and **Ended with**. Changing the starting balance copies it to the ending balance until the agent edits the ending value. For three lines at the start and three at the end, all three count as saved even if one was replaced. An account starting with three and ending with five receives 3/3. Log sales separately in **Mobile orders**. One three-line order across ten calls gives 30% line yield and 10% order yield. Each order supports 1–12 lines.

Reports exclude matched wash pairs from original-service, play and subscriber opportunities. A full save and a full disconnect on two accounts with the same starting services form a wash. Downgrades count for individual services and subscriber retention. A three-to-two downgrade appears as **TP → DP**. A four-to-three downgrade appears as **4 services → TP**. Added services can earn service credit. Historical groups without recorded mobile balances contribute to the other applicable rates and are left out of line retention.

Daily reports use Eastern time. In **Goals**, the supervisor chooses the whole team or selected agents, reviews all eleven percentages together, then saves the full set once. Shared targets are prefilled. A blank field marked **Varies** requires a percentage before saving.

### Grouped history

Each report date has one row per combination of outcome and service tags. Identical account outcomes increase the count on that row. A separate mobile sales row records the total number of orders and lines for that date.

| Outcome tags | Count |
| --- | --- |
| DP → SP · Internet kept · Video disconnected | 8 accounts |
| SPS · Internet kept | 11 accounts |
| Mobile sold | 6 orders · 9 lines |

In your own **Call log**, choose **Edit call** on an outcome or mobile-sales row. A single-call date opens with the original selections filled in. When multiple calls could match, choose the account outcomes and mobile totals that belonged to the call. Supabase stores daily groups, so it can’t recover which accounts or orders went together on those dates.

Change the starting, kept or added services, add or remove accounts, adjust mobile orders and lines, or change the Eastern report date. Under **Mobile sales**, mark which accounts gained Mobile service. **Save changes** updates the affected dates and recalculates their rates. To undo a mistaken entry, choose **Remove call** and confirm. **Edit day totals** opens the bulk editor. A correction checks both date snapshots and can be retried safely. Supervisors can view agent and team logs. Agents edit their own history.

The account counts and the sales counts use different units. For example, a call handling two accounts can increase two account counts, but still increases the daily call count by one. The grouped CSV includes the report date, outcome, service changes and counts in the chosen view.

## Accounts and storage

Supabase Postgres stores grouped daily history and goals for each signed-in user. After a confirmed save, refreshing, reopening the site or signing in on another device loads those totals. The browser holds only the displayed view and unfinished selections in memory. A refresh clears an unsaved form. There is no browser database, offline queue or end-of-shift save step.

Each submission includes a random retry token so retrying the same submission cannot add it twice. The server applies the grouped changes and daily counters in one transaction. Account-level outcome groups and daily mobile totals retain no association with individual orders or calls in the history.

Use credentials created specifically for this tracker. Each can contain 1–8 characters. Usernames cannot start with a digit, `p` or `P`. Existing accounts can continue to sign in with their original credentials. To request access, choose **Agent** or **Supervisor** on the sign-up screen. After an admin approves the request, sign in with the same username and password.

### Requests and password changes

In **Admin → Accounts → Requests**, search by username and filter by request type to review sign-ups or password changes. Sign-up approval includes the role and team assignment. A password change has a separate approval and leaves the person's role, team and call history intact.

1. From the login page, choose **Request password change** and submit your tracker username.
2. An admin verifies who requested the change, approves it in **Requests** and gives that person the one-time reset code privately. The code is shown to the approving admin once and expires in 30 minutes.
3. Return to **Request password change**, open the reset-code form and enter the username, code and new password. Then sign in with the new password. Completing the change ends existing sessions on every device.

If the code expires or is lost, submit a new request. Requesting a change, approving it or denying it leaves the current password usable until a reset succeeds.

The app uses its own username/password accounts and an HttpOnly session cookie. Each password has a random 128-bit salt and a one-way scrypt hash. New hashes use `N=32768, r=8, p=3`. A successful credential check upgrades an older hash, including on a pending account. Pending applicants still need approval to sign in. Database credentials stay in the same-origin Vercel functions. The eight-character password limit is a product constraint and restricts resistance to guessing.

The [database schema guide](docs/SCHEMA.md) explains how accounts, memberships, game scores, daily totals and API permissions fit together. Run the [read-only inventory query](scripts/schema-inventory.sql) in the Supabase SQL Editor to inspect the deployed structure without reading account or call data.

## Team workspaces

| Role | Workspace |
| --- | --- |
| Agent | Log calls, correct personal history, view assigned goals and play the assigned team's game. |
| Supervisor | Select a name in **Agents**, the expandable list below **Goals**, to view that person's percentages and call log. The list starts open and stays open when switching agents. In **Goals**, apply a target to the whole roster or selected agents. In **Games → Game library**, customize and schedule games enabled by an admin. |
| Admin | Use the personal agent workspace and play on an assigned team. Open **Admin** to see performance charts, review sign-ups, create accounts, assign roles, manage named teams and control the game library. |

Supervisors can click the **team name** at the top of the sidebar to switch both **Overview** and **Call log** to the whole team. Select a name under **Agents** to return to that person. If two agents save 1 of 1 and 2 of 9 eligible calls, the team saves 3 of 10 (30%). The rings show a shared goal when everyone has the same target for that metric. The team call log combines identical outcomes for the same date and supports the date filters and CSV export.

Team reports cover the current roster for every report date. Transferring a member changes which team's report includes that person's history.

**Admin → Teams** lists every active team with its supervisor, member count and an **Edit** button. Choose **Create team** at the top right, enter the team name, pick an available supervisor and check the agents to include. The checklist shows each person's current team. Submit the form once to save the team and its roster together.

Choose **Edit** beside a team to change its name, supervisor or members. Current members start checked. Unchecking someone removes them from the team. Checking someone from another team transfers them when you save. A change of supervisor carries the team's games and scores to the new supervisor. Use **Admin → Accounts** to create or approve a missing account, or give an available account the Supervisor role.

Each team has one supervisor. A supervisor leads one team and an agent or admin can belong to one team. Updating a team's name preserves its roster and games. Existing supervisors with a roster or games receive a default name that an admin can edit. Move a supervisor's members before changing that supervisor's role.

If you demote a supervisor after moving their members, a team with games keeps its name and history until you promote that same person again. An empty team without games releases its name.

### Permanent deletion

Only admins can delete teams or accounts. Open **Edit** beside the team or person, choose **Delete team** or **Delete account**, then confirm the name shown.

| What you delete | What happens |
| --- | --- |
| A team | Its games and scores are removed. Its members become unassigned. Everyone keeps their login, goals and call history, and the supervisor can lead another team. |
| An agent or supervisor account | The person loses access across devices. Their credentials, sessions, goals, call tallies and game scores are removed. The username becomes available again. |
| An account that owns a team | The confirmation also names the team that will be deleted. To keep that team and its games, give it a new supervisor in **Admin → Teams** before deleting the account. |

Admin accounts are protected from deletion. Confirmed deletions have no in-app undo.

### Game library

Open **Admin → Games**, choose an illustrated game card, then check the supervisors who can schedule it. Access is independent for each game and supervisor. An admin can also schedule a round directly for a named team. New launches require an explicit grant for supervisors, including Bingo. Removing access prevents future launches. Scheduled rounds continue for their participants.

Supervisors open **Games → Game library**. Each game page has round setup (local scheduling time, round name, incentive, start and end) and a rules block with the settings used by that specific game. Agents see the active board and use the moves they have earned. The compact standings and winner announcement work even with the game drawer closed. Reduced-motion settings suppress celebratory animation.

| Games | What players do |
| --- | --- |
| Bingo Hall, Vault Break, Last Domino | Complete a card, unlock three team locks, or build a chain and select its route. |
| Crew Rally, The Belt, Ghost Shift | Race on balanced crew scores, challenge a champion over equal call quotas, or race a previous personal result. |
| Mission Draft, Fantasy Shift, One More Floor | Commit to future contracts, draft a squad of outcomes, or risk a climb before banking it. |
| Moon Heist, Switchboard, Queen City Takeover | Hide and scan lockers, rotate and bridge relays, or connect neighboring city blocks. |
| After Hours FM, Swap Meet, Caption Clash | Mix and play a team track, exchange duplicate stamps, or enter and vote on captions. |
| What on Earth?, Same Wavelength, Wrong Manual, Plot Twist | Identify a mystery object, read a teammate's dial, decode a partner's panel, or vote on a branching story. |

### Bingo

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
