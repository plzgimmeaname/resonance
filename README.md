# Resonance

A little website that runs **on your own computer** (or a small server). People connect their Spotify accounts and it shows them:

- **Feed**: new songs and albums from artists they like, plus things they might enjoy
- **Stats**: top artists, songs and genres
- **Discover**: new music picked for their taste (savable as a Spotify playlist)
- **Blend**: compare taste with a friend's

Several people can use one copy, each with their own private stats and history. There is also an **admin panel** for the person running the site (you), to see usage, manage users and set the API keys. Nothing is uploaded anywhere except to Spotify and the optional services you switch on.

---

## Before you start (one-time stuff)

You need three things:

1. **A Spotify Premium account.** Since February 2026, Spotify only lets Premium subscribers create a developer app, and the app stops working if the subscription lapses. The Premium account must be the one that owns the developer app (Step 1). Other people you add (up to 5) can have free accounts.
2. **Docker Desktop**, a free program that runs the app in a sealed box (no other installs needed).
   - Download it from https://www.docker.com/products/docker-desktop, install it like any other app, and open it so it's running.
   - To check it worked: open a terminal (see below) and type `docker -v`. You should see a version number.
3. **This folder** (`resonance`), which you already have.

### What's a terminal?
It's a window where you type commands.
- **Mac**: press `Cmd + Space`, type `Terminal`, press Enter.
- **Windows**: press the Windows key, type `PowerShell`, press Enter.

---

## Step 1: Get a Spotify "Client ID"

Spotify needs to know your app exists. Creating one is free, but the account you create it with must have Premium. It takes about 2 minutes.

1. Go to https://developer.spotify.com/dashboard and log in with your Spotify account.
2. Click **Create app**.
3. Fill in:
   - **App name**: `Resonance` (anything works)
   - **App description**: `My music app` (anything works)
   - **Redirect URI**: copy and paste this *exactly*, then click **Add**:
     ```
     http://127.0.0.1:3000/auth/spotify/callback
     ```
   - Tick **Web API**, agree to the terms, and click **Save**.
4. Open your new app, then go to **Settings**. Copy the **Client ID** (a long string of letters and numbers).
5. Still in Settings, open **User Management**. Add **your own name and the email you use for Spotify** (even if you own the app). If you skip this, Spotify will block you with a "not registered" error. You can add up to 5 people.

---

### Don't have Premium? Borrow someone's

The Premium requirement applies to whoever *owns* the developer app, not to the people using it. So a friend or family member with Premium can do Step 1 for you and:

1. Add **your** name and Spotify email under **User Management** (they can add up to 5 people).
2. Send you their **Client ID**. It's an app ID, not a password, and it can't be used to get into their account.

Then you use their Client ID in Step 2 and log in with your own Spotify account. Your listening data stays yours. Their account is never involved after setup, but their Premium must stay active or the app stops working for everyone.

## Step 2: Build and start the app

1. Open a terminal and go into this folder. Type this and press Enter (change the path if your folder is somewhere else):
   ```
   cd /Users/n00b/Coding/resonance
   ```
2. Build and start it (the first build takes a couple of minutes):
   ```
   docker compose up -d --build
   ```
3. Find the admin setup code. Run:
   ```
   docker compose logs
   ```
   Look for a line like:
   ```
   admin setup code: 3f9a1c2b
   ```
   You need it in a moment. It's printed every start until the admin account exists.

The app keeps running in the background (and restarts with Docker). It is only reachable from your own computer, not other devices on your network.

| Do this | Command |
|---|---|
| See logs | `docker compose logs -f` |
| Stop it | `docker compose down` |
| Start it again | `docker compose up -d` |
| Update after changing code | `docker compose up -d --build` |

Your history and login are saved in the `data` folder next to this README, so they survive restarts and rebuilds.

---

## Step 3: Create the admin account

1. In your browser, open **http://127.0.0.1:3000/admin**. (Type it exactly like that. **Don't use `localhost`**, because Spotify won't allow it.)
2. Paste the **setup code** from the logs, choose a password (8 or more characters), and click **Continue**.

The setup code is there so a stranger can't claim the admin account before you do. It's only needed this once.

## Step 4: Add your Spotify Client ID

1. Still in the admin panel, click **Settings**.
2. Paste your **Client ID** from Step 1 into the first box.
3. Copy the **Redirect URI** shown just below it into your Spotify app's settings (if you haven't already).
4. Click **Save settings**.

This is also where you can add the optional keys (Last.fm, Ticketmaster, Anthropic) later. They're saved on the server and never shown again.

## Step 5: Sign in with Spotify

Go to **http://127.0.0.1:3000**, click **Connect Spotify**, approve the permissions, and you're in. Anyone else you've added under **User Management** in Spotify can do the same on their own device.

---

## The admin panel

Open **/admin** any time and sign in with your admin password. It has five tabs:

| Tab | What it's for |
|---|---|
| **Overview** | How many users, plays tracked, Spotify calls and failures, sign-ins per day, most-used features, recent errors |
| **Users** | Everyone who signed in. Sync their history, reset their 👍/👎, disconnect them, block them, or delete them and all their data |
| **Usage** | Spotify API health (calls per hour, failures, rate limiting, slowest and busiest endpoints), feature usage, uptime, database size, memory, and the live server log |
| **Settings** | Spotify Client ID, optional API keys, and changing the admin password |
| **Tools** | Clear caches, sync everyone now, reset votes, prune old logs, and download plays (CSV), the usage log (CSV) or a database backup |

The backup file has Spotify tokens, API keys and the admin password stripped out, so it's safe to keep.

**Forgot the admin password?** Run `docker compose down`, open the database file `data/resonance.db` with any SQLite tool and run `delete from kv where k = 'admin';`, then run `docker compose up -d`. It prints a new setup code in `docker compose logs`. (This also removes saved API keys, so enter them again.)

---

## Tips

- **Song previews**: every song has a **▶ Preview** button that plays a 30-second clip. Spotify no longer provides clips to new apps, so Resonance looks the song up on Apple's free iTunes catalog when you click. A few songs have no clip and show "No preview".
- **Stats look empty?** Spotify only reveals your last 50 plays, so Resonance keeps its own record *while it's running*. Leave it running while you listen and your history builds up. "Right now" recommendations and "Taste over time" get better after a few days.
- **Recommendations feel off?** Use 👍 and 👎. It learns what you like, and 👎 hides that artist.
- **Saving a playlist didn't work?** Click **sign out** (top right) and connect again so Spotify can ask for playlist permission.
- **Blend with a friend**: copy your code from the Blend tab and send it to them, then paste theirs. It works between people on different copies of the app too.
- **Your data**: **delete my data** (top right) wipes your history, votes and account from the site.
- **Limit**: Spotify development-mode apps allow 5 users. More than that needs Spotify's approval, which they only give to registered businesses.
- **Share your stats**: the **Share card** button on the Stats tab downloads a picture.
- **Install it like an app**: in Chrome or Edge, click the install icon in the address bar.

---

## If something goes wrong

| What you see | What to do |
|---|---|
| `command not found: docker` | Docker Desktop isn't installed (or reopen the terminal after installing). See "Before you start". |
| `Cannot connect to the Docker daemon` | Open Docker Desktop and wait until it says it's running. |
| `command not found: cd` / `No such file or directory` | The folder path is wrong. Drag the folder into the terminal window to paste its path after `cd `. |
| Home page says the site isn't set up | The admin hasn't added the Client ID yet. See Steps 3 and 4. |
| I lost the admin setup code | Run `docker compose logs`; the code is printed every start until the admin account exists. |
| Spotify says `INVALID_CLIENT: Invalid redirect URI` | The Redirect URI in the Spotify dashboard isn't exactly `http://127.0.0.1:3000/auth/spotify/callback`. |
| Errors (403) from Spotify even though login worked | The account that owns the developer app needs an active **Premium** plan. |
| Spotify says you're not registered / login fails | Add your name and Spotify email under **User Management** (Step 1.5). |
| `port is already allocated` | Something else uses port 3000. Close it, or in `docker-compose.yml` change the port mapping, `PORT` and `BASE_URL` to 3001, then use port 3001 in your browser and in the Redirect URI. |
| A section says "Something went wrong" | Wait 30 seconds and press the refresh button on that page. Spotify sometimes rate limits. |

---

## Seeing accounts from other copies

If friends run their own copy with the **same Client ID**, their accounts can show up in your admin panel (Users tab, "Other copies"). One copy collects, the others report to it:

1. **Your copy** must be reachable over https (for example through a tunnel such as Cloudflare Tunnel). In **Settings**, set a **Shared key** and leave the collector URL empty.
2. **Their copies**: in **Settings** (or `.env` as `REPORT_URL` and `REPORT_KEY`), set the collector URL to your copy's address and the same key.

Reporting sends only a Spotify name and ID, join and last-seen times and a play count, every 15 minutes. Never tokens or listening history. Copies that report show this in a notice on their connect page, and leaving the URL empty turns it off.

## Optional extras (skip these at first)

Add these in the admin panel under **Settings** to switch on more features:

- **Last.fm API key**: more "fans of X also like Y" recommendations (free at https://www.last.fm/api)
- **Ticketmaster API key** (plus city and country): shows concerts from your top artists in the feed (free at https://developer.ticketmaster.com)
- **Anthropic API key**: adds a "Why?" button that explains each recommendation, and a short summary of your taste

(Advanced: any of these, and `SPOTIFY_CLIENT_ID`, can also be set in a `.env` file next to `docker-compose.yml`, then `docker compose up -d`. Values saved in the admin panel win.)

---

## For developers

- `src/server.ts`: web server and user routes; `src/admin.ts`: admin routes; `src/auth.ts`: sessions, admin password
- `src/spotify.ts`: login (PKCE), per-user token refresh, Spotify API calls
- `src/engine.ts`: taste profile, stats, recommendations, feed, blend
- `src/history.ts`: background play-history collector
- `src/db.ts`: SQLite storage (`data/resonance.db`); `src/context.ts`: which user a request belongs to
- `src/extras.ts`: optional Last.fm / Ticketmaster / Claude
- `Dockerfile`, `docker-compose.yml`: container setup (listens on `HOST`, default `127.0.0.1`)
- `public/`: the web UI (plain HTML, CSS and JS)

Spotify removed several API features for new apps (recommendations, audio features, popularity, batch lookups) and caps search at 10 results. Resonance builds recommendations from your genre profile plus search, filtered against what you already play. `npm run typecheck` checks the TypeScript, and `npm run build` compiles it to `dist/` (this needs Node.js; Docker users don't need it). `src/remote.ts`: reporting between copies.
