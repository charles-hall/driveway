# Driveway

Vehicle maintenance, shared parts inventory and iPhone reminders for the household. Lives at https://driveway.oaksync.com.

- **Server:** Node.js 22 + Express, run by cPanel's Setup Node.js App (Passenger)
- **Data:** one SQLite file (`tallazpo_driveway`), kept outside the web folder. Uses Node's built-in SQLite, so there's no native add-on to compile (requires Node 22.13 or later).
- **Households:** each family gets its own private Driveway (vehicles, parts, history, people). The header reads "*Name* Driveway." Only the site admin (`OWNER_EMAIL`) can create households.
- **Sign-in:** Google, invite only. Within a household, roles are owner, editor and viewer. One person can belong to several households and switch between them.
- **Notifications:** Web Push. On iPhone (iOS 16.4 or later), add the app to the Home Screen first.

Secrets (`.env`), the database and your vehicle data never go in git.

## First-time setup

### 1. Google sign-in (project `driveway-510522`)

In Google Cloud Console, with project **driveway-510522** selected:

1. **APIs & Services › OAuth consent screen** (Google Auth Platform):
   - User type: **External**
   - App name: Driveway
   - Support email: yours
   - Authorized domain: `oaksync.com`
   - Scopes: `openid`, `email` and `profile` (no sensitive scopes, so no Google review)
   - Under **Audience**, select **Publish app** so anyone you invite can sign in. The app itself only lets in people on the People list. Testing mode also works, but each person has to be added as a test user and sign-ins expire after 7 days.
2. **Clients › Create client**:
   - Type: **Web application**, named Driveway web
   - Authorized JavaScript origin: `https://driveway.oaksync.com`
   - Authorized redirect URI: `https://driveway.oaksync.com/auth/google/callback`
   - Optional for local testing: also add `http://localhost:3000` and `http://localhost:3000/auth/google/callback`
3. Copy the **Client ID** and **Client secret** for step 3.

### 2. cPanel

1. **Domains:** confirm `driveway.oaksync.com` exists. **SSL/TLS Status:** run AutoSSL so it has a certificate.
2. **Git Version Control:** the repo deploys to the app folder (for example `~/driveway.oaksync.com`). `.cpanel.yml` runs `scripts/deploy.sh` on each deploy, which installs packages and restarts the app.
3. **Setup Node.js App › Create Application:**
   - Node.js version: **22**
   - Application mode: **Production**
   - Application root: the repo folder (for example `driveway.oaksync.com`)
   - Application URL: `driveway.oaksync.com`
   - Startup file: `app.js`
   - Create the app, then click **Run NPM Install**.
4. Create the data folder outside the web root. In Terminal: `mkdir -p ~/driveway-data`

### 3. Settings (`.env`)

In the app folder, copy `.env.example` to `.env` and fill it in. File Manager works for this, or in Terminal: `cp .env.example .env && nano .env`.

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: from step 1
- `OWNER_EMAIL`: the Google account that becomes the first owner
- `SESSION_SECRET`: any long random string, from `openssl rand -hex 32`
- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`: in Terminal, activate the app's environment (cPanel shows the `source …/activate` command at the top of the app page), then run `npm run vapid` and paste both lines. Generate these once. Changing them later turns off notifications on every device.
- `VAPID_SUBJECT`: `mailto:` plus your email

Click **Restart** on the Node.js app page.

### 4. Bring over your data

1. Upload `vehicles.json`, `parts.json` and `history.json` (sent separately, not in the repo) into the app's `import/` folder.
2. With the environment activated, run `npm run import -- "Household name"` (the name can be left off when there is only one household). Existing records with the same ids are replaced, so it's safe to run again.
3. Delete the three JSON files from `import/` afterward.

### 5. Daily reminders

Under **cPanel › Cron Jobs**, add a job that runs once a day, for example at 8:05 a.m. Replace the paths with the ones from your Node.js app page:

```
5 8 * * * cd ~/driveway.oaksync.com && ~/nodevenv/driveway.oaksync.com/22/bin/node scripts/remind.js >> ~/driveway-data/remind.log 2>&1
```

Cron uses the server's time zone. Run `date` in Terminal to check it.

### 6. Sign in and invite people

1. Open https://driveway.oaksync.com and sign in with the `OWNER_EMAIL` account.
2. Under **Settings › People**, invite others by their Google email address and choose a role.
3. To add another family: **Settings › Households** (admin only), enter the household name and its owner's Google email, then let the owner know. They invite their own family from their Settings.
3. On each iPhone:
   - Open the site in Safari, tap **Share**, then **Add to Home Screen**.
   - Open Driveway from the Home Screen, go to **Settings**, then tap **Turn on notifications**.

## Day to day

- **Deploy:** push to `main` and the server picks it up. If a change doesn't show, click **Restart** on the Node.js app page.
- **Add a person from Terminal:** `npm run add-user -- name@gmail.com editor "Household name"`
- **Backup:** Settings › Account › Download a backup (owner only), or copy `~/driveway-data/tallazpo_driveway.sqlite`.
- **Health check:** https://driveway.oaksync.com/healthz

## What gets notified

| Notification | When |
|---|---|
| Overdue | The day an item goes overdue, then weekly until it's logged |
| Coming due | Once, about two weeks or 500 miles ahead |
| Out of stock | When a logged service uses the last of a part |
| Mileage check-in | Monthly, for daily drivers |

Each person chooses which notifications they get in Settings. Non-daily drivers are left out unless that person turns them on. The Home Screen badge shows the overdue count.

## Code map

| Path | What it does |
|---|---|
| `app.js` | Server: pages, data API, people and push routes |
| `lib/db.js` | SQLite tables and helpers |
| `lib/auth.js` | Google sign-in, sessions and roles |
| `lib/push.js` | Web Push sending |
| `lib/schedule.js` | Due-date logic used by reminders |
| `scripts/remind.js` | Daily reminder job |
| `scripts/import.js` | Imports JSON exports |
| `scripts/deploy.sh` | Post-deploy install and restart |
| `public/index.html` | The app: the original page, a small bridge to the server API, and the Settings, People and Households screens |
| `public/sw.js` | Service worker that shows notifications |

## Upgrading from the single-household version

The first start after this update converts the database automatically: everything that existed becomes the first household (named "Cottage", or whatever `FIRST_HOUSEHOLD_NAME` in `.env` says), and everyone keeps their current role in it. Nobody is signed out. Take a backup first: copy `~/driveway-data/tallazpo_driveway.sqlite` somewhere safe.
