# Changelog

## Unreleased

### Redesign
- New look across the app, share page and admin panel, following Apple's interface conventions with the same violet/pink colors: system font, frosted header and menus, grouped inset cards, segmented controls, tinted buttons, and a line-icon set (`public/icons.svg`) in place of emoji and text arrows.
- Track buttons (preview, add to playlist, open, 👍/👎, why) are compact icon buttons that fit on one line. Release, event and playlist rows are cleaner, and concerts show a calendar date.
- Light, dark or automatic theme, chosen from the new account menu (avatar, top right) and remembered per browser. Sign out, delete my data and import moved into that menu.
- Messages are toasts pinned under the header (bottom on phones), so "Added to playlist" is seen wherever you've scrolled. Successes go away by themselves, errors stay until closed.
- Dialogs are real `<dialog>`s (focus kept inside, Esc closes). On phones they open as bottom sheets you can drag down to close; the sheet follows your finger, resists upward pulls, and a quick flick closes it.
- Phones: the tabs scroll sideways instead of spilling out, mode switches stay on one line, stat tiles are two across, and tiles are two across.
- Respects reduced motion, reduced transparency and increased contrast settings. Visible keyboard focus everywhere, a skip-to-content link, labels on icon-only buttons.

### Added
- Plays by month chart on Stats (the server already sent this data; it wasn't shown). Hour and weekday charts label every bar in place and name your busiest hour and day.
- Keyboard shortcuts: number keys switch tabs, `j`/`k` move through the feed, space plays the current card, `/` jumps to the vibe box, `?` lists them all.
- Feed position dots, so you can tell where you are in the reel.
- Import: drag the history files onto the page, with a progress bar.
- 👎 now confirms what it did ("less like X from now on").
- The share image was redrawn to match the new persona card.

### Fixed
- Genres were empty everywhere (top genres, persona, taste drift, Discover, the feed, playlist fit and suggestions): Spotify stopped sending artist genres to developer apps in 2026, and artists were saved as "no genres" for good. Genres now come from Last.fm tags when a Last.fm key is set, otherwise from MusicBrainz (free, no key). Each artist is looked up once and cached; artists neither source knows are retried after 30 days. Learning genres no longer costs a Spotify call per artist.
- Album art, avatars and previews didn't load once the service worker was active: it re-fetched them itself, which the CSP blocks.
- Signed-out visitors saw the app tabs, bell and avatar, and the admin login showed the admin tabs and Sign out. CSS `display` rules were overriding the `hidden` attribute.
- The streak test failed between midnight and 06:00 UTC because it assumed "30 hours ago" was yesterday.
- Hour-of-day and weekday charts, the "Right now" mode and the listening streak used the server's clock (UTC in Docker), so they were shifted for everyone else. The browser now sends its time zone offset and these use the user's own clock.
- `docker stop` waited 10 seconds and force-killed the app, because node as PID 1 ignores SIGTERM. The app now closes the server and database and exits straight away (Ctrl+C too).
- "Delete my data" and the admin's delete left the user's API-call log and release-check marker behind. Both are removed now.
- Bad input (an empty vibe, a vote with no value, junk playlist ids, a malformed taste code) now returns a 400 and no longer shows up in the admin error log as a server error.
- A stray unhandled rejection in a background job could crash the server. It is logged instead.

### Changed
- One taste build is shared when the feed, stats and discover pages load at the same time (it was built once per request, up to 9 Spotify calls instead of 3).
- At most 6 Spotify requests are in flight at once, so a feed build no longer fires 20+ at the same moment and trips rate limits. The admin's response times measure Spotify, not time spent waiting in line.
- The background sync only rebuilds a user's taste when their daily snapshot or release check is due. Before, every user cost about 7 Spotify calls every 15 minutes.
- The response cache drops expired entries and has a size cap. Before it only ever grew.
- Taste codes from friends are validated and size capped before use.
- Playlist ids and track URIs, vote values, vibes and Claude prompts are checked and length limited on the server.
- Content-Security-Policy header: scripts and styles come from this site only, images and previews from https hosts.
- Docker health check on a new `/healthz` endpoint. The daily taste snapshot is dated in UTC.

### Added
- Playlists tab: pick one of your playlists to clear out duplicates and songs that don't fit its genres, and add songs that do. Exact duplicates are merged into one copy that stays in place, removals can be undone right after, and a cleaned copy can be saved without touching the original. Needs one new Spotify permission (`playlist-modify-public`), so people who signed in earlier are asked to allow it once.
- Tests for the playlist analysis, the merge planner (including a randomized check), the Spotify playlist calls and the suggestions.
- Tests for the cache, the Spotify request pool, time zones and streaks, taste-code parsing, the sync job and complete user deletion (50 tests in all).

## 1.1.0

### Added
- Import your full listening history from Spotify's privacy export (`/import`), in both the extended and account-data formats. Duplicates of plays already recorded are skipped.
- New-release notifications: the 🔔 in the header lists releases from your top artists in the last two weeks, checked twice a day.
- Public share links: a snapshot page of your stats with a "Blend with me" button. Blend also accepts a code from the link.
- Tests (`npm test`) for sessions, the admin password, the database migration, stats, blend, recommendation filtering, import, notifications, share links, rate limiting and the report collector.
- LICENSE (MIT), Dependabot config.

### Changed
- CI runs typecheck, tests, build, `npm audit` and a Docker build on Node 22 and 24 (it ran a missing `npm test` script on Node versions without `node:sqlite` before). `package.json` now requires Node 22.5+.
- The report collector requires a shared key, compares it in constant time, and only reports to `https://` collector URLs.
- API rate limits: 240 requests a minute per user, 20 a minute for refreshes, Claude features and blend.
- Security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`), no `X-Powered-By`.

### Fixed
- A request with `Origin: null` or a malformed origin crashed the cross-site check with a 500 instead of being refused.
- Bad JSON and oversized bodies return 400/413 instead of 500.
- body-parser updated for GHSA-27r3-jxmh-p828.
- The backup download also strips share links.

## 1.0.0

- Spotify stats, recommendations, feed with autoplay, blend, concerts, admin panel, multi-user, Docker setup, reporting between copies.
