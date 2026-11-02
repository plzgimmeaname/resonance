# Changelog

## Unreleased

### Fixed
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
