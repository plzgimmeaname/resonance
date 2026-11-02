import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { captureLogs, printSetupCode, registerAdmin } from "./admin.js";
import { endUserSession, startUserSession, userSession } from "./auth.js";
import { TtlCache } from "./cache.js";
import { parseTz, runAs, uid } from "./context.js";
import { addFeedback, closeDb, db, deleteUserData, logEvent } from "./db.js";
import { blendTracks, buildConcerts, buildFeed, buildTaste, compare, computeStats, explain, exportTaste, parseTasteCode, recommend, summarize, vibePlaylist, type RecMode, type Taste } from "./engine.js";
import { artistInfo, features, findPreview } from "./extras.js";
import { startPoller, syncHistory } from "./history.js";
import { importPlays, parseHistory } from "./importer.js";
import { rateLimit } from "./limit.js";
import { listNotifications, markSeen } from "./notify.js";
import { isReporting, registerCollector, sendReport } from "./remote.js";
import { getSetting } from "./settings.js";
import { buildShare, createShare, deleteShare, getShare, myShare } from "./share.js";
import { Blocked, clientId, finishLogin, hasPlaylistScope, isConnected, loginUrl, NotConnected, spotify } from "./spotify.js";
import type { Range, Track } from "./types.js";

captureLogs();

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
const REDIRECT = `${BASE_URL}/auth/spotify/callback`;
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  // scripts and styles only from this site; images and audio may come from any https host (spotify, itunes)
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; media-src 'self' https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  );
  next();
});

// for docker and uptime checks, answers before sessions and rate limits
app.get("/healthz", (_req, res) => {
  try {
    db.prepare("select 1").get();
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});
// history imports come in chunks of a few thousand plays, everything else is small
const bigJson = express.json({ limit: "4mb" });
const smallJson = express.json();
app.use((req, res, next) => (req.path === "/api/import" ? bigJson : smallJson)(req, res, next));

// refuse cross-site writes. browsers send "null" from sandboxed frames and some redirects, which isn't us either
const sameHost = (origin: string, host = "") => {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
};
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && origin && !sameHost(origin, req.headers.host)) return res.status(403).json({ error: "bad origin" });
  next();
});
app.use(userSession);

// keeps one user (or address) from burning through the spotify and claude quotas
const expensive = (req: Request) => req.query.refresh === "1" || ["/vibe", "/explain", "/blend/compare"].includes(req.path);
app.use("/api", rateLimit(60_000, 240), rateLimit(60_000, 20, expensive));

// per user cache with a ttl, cleared by the admin tools. concurrent requests share one computation
const cache = new TtlCache();
setInterval(() => cache.sweep(), 10 * 60_000).unref();
const clearCache = () => cache.clear();
const invalidate = (prefix = "") => cache.deletePrefix(`${uid()}:${prefix}`);
const cached = <T>(key: string, ttlMs: number, fn: () => Promise<T>) => cache.get<T>(`${uid()}:${key}`, ttlMs, fn);
const taste = () => cached<Taste>("taste", 5 * 60_000, buildTaste);

// collector takes reports from other copies, admin serves the admin panel
registerCollector(app);
registerAdmin(app, { clearCache, cacheSize: () => cache.size, redirectUri: REDIRECT, publicDir });
app.use(express.static(publicDir));
// app pages are routed in the browser (public/app/main.js), they all get the same shell
app.get(["/connect", "/feed", "/stats", "/discover", "/concerts", "/blend", "/import"], (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
// public share pages, see src/share.ts
app.get("/s/:token", (_req, res) => res.sendFile(path.join(publicDir, "share.html")));
app.get("/api/shared/:token", (req, res) => {
  const data = getShare(req.params.token);
  if (!data) return res.status(404).json({ error: "This link doesn't exist or was turned off." });
  res.json(data);
});

// spotify login: send them to spotify, then handle the callback
app.get("/auth/spotify/login", (_req, res) => {
  if (!clientId()) return res.redirect("/?error=no_client_id");
  res.redirect(loginUrl(REDIRECT));
});

app.get("/auth/spotify/callback", async (req, res) => {
  const { code, state, error } = req.query as Record<string, string>;
  if (error || !code) return res.redirect("/?error=spotify_auth");
  try {
    const userId = await finishLogin(code, state, REDIRECT);
    startUserSession(res, userId);
    logEvent("login", "", userId);
    runAs(userId, () => syncHistory()).catch(() => {});
    sendReport().catch(() => {});
    res.redirect("/");
  } catch (e) {
    if (e instanceof Blocked) return res.redirect("/?error=blocked");
    logEvent("error", `login: ${(e as Error).message}`, "");
    console.error(e);
    res.redirect("/?error=spotify_token");
  }
});

app.post("/auth/logout", (req, res) => {
  endUserSession(req, res);
  res.json({ ok: true });
});

app.post("/auth/delete-me", (req, res) => {
  if (!req.userId) return res.status(401).json({ error: "not_connected" });
  const id = req.userId;
  endUserSession(req, res);
  runAs(id, () => invalidate());
  deleteUserData(id);
  sendReport().catch(() => {});
  res.json({ ok: true });
});

// a 400 for bad input; the error handler at the bottom uses err.status
const bad = (message: string) => Object.assign(new Error(message), { status: 400 });
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const TRACK_URI = /^spotify:track:[A-Za-z0-9]{22}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{22}$/;

// wraps api routes: needs a logged in user, runs on their clock, logs the feature use, maps errors to 401/400/500
const wrap = (kind: string | null, fn: (req: Request) => Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  if (!req.userId) return res.status(401).json({ error: "not_connected" });
  await runAs(req.userId, async () => {
    if (!isConnected()) return res.status(401).json({ error: "not_connected" });
    try {
      const out = await fn(req);
      if (kind) logEvent(kind);
      res.json(out);
    } catch (e) {
      if (e instanceof NotConnected) return res.status(401).json({ error: "not_connected" });
      if (((e as { status?: number }).status ?? 500) >= 500) {
        console.error(e);
        logEvent("error", `${req.path}: ${(e as Error).message}`);
      }
      next(e);
    }
  }, parseTz(req.headers["x-tz-offset"]));
};

app.get("/api/status", (req, res) => {
  const base = { configured: Boolean(clientId()), features: features(), reporting: isReporting(), redirectUri: REDIRECT };
  if (!req.userId) return res.json({ ...base, connected: false, playlistScope: false, user: null });
  runAs(req.userId, () => {
    const user = db.prepare("select id, name, image from users where id = ?").get(req.userId!);
    res.json({ ...base, connected: isConnected(), playlistScope: hasPlaylistScope(), user });
  });
});

app.get("/api/me", wrap(null, async () => db.prepare("select id, name, image from users where id = ?").get(uid())));

app.get("/api/stats", wrap("view_stats", async (req) => {
  const range = (["short", "medium", "long"].includes(req.query.range as string) ? req.query.range : "medium") as Range;
  return computeStats(await taste(), range);
}));

app.get("/api/recommendations", wrap("view_discover", async (req) => {
  const mode = (["similar", "adventurous", "deepcuts", "now"].includes(req.query.mode as string) ? req.query.mode : "similar") as RecMode;
  const key = `recs:${mode}`;
  if (req.query.refresh === "1") invalidate(key);
  return cached(key, 10 * 60_000, async () => recommend(await taste(), mode));
}));

app.get("/api/feed", wrap("view_feed", async (req) => {
  if (req.query.refresh === "1") invalidate("feed");
  return cached("feed", 10 * 60_000, async () => buildFeed(await taste()));
}));

app.get("/api/concerts", wrap("view_concerts", async (req) => {
  if (req.query.refresh === "1") invalidate("concerts");
  return cached("concerts", 60 * 60_000, async () => buildConcerts(await taste()));
}));

app.get("/api/artist", wrap("artist_info", async (req) => {
  const name = String(req.query.name ?? "").slice(0, 100);
  return (await cached(`artist:${name.toLowerCase()}`, 24 * 3600_000, () => artistInfo(name))) ?? {};
}));

app.post("/api/vibe", wrap("vibe", async (req) => {
  const vibe = text(req.body?.vibe, 200);
  if (!vibe) throw bad("Describe a vibe first.");
  return vibePlaylist(await taste(), vibe);
}));

app.get("/api/summary", wrap(null, async () => ({ text: await cached("summary", 60 * 60_000, async () => summarize(await taste())) })));

app.post("/api/explain", wrap("explain", async (req) => {
  const t = req.body?.track ?? {};
  const artists = Array.isArray(t.artists) ? t.artists.map((a: unknown) => text(a, 100)).filter(Boolean).slice(0, 5) : [];
  const name = text(t.name, 200);
  if (!name || !artists.length) throw bad("bad request");
  return { text: await explain(await taste(), { name, artists, album: text(t.album, 200) } as Track, text(req.body?.reason, 200)) };
}));

app.get("/api/preview", async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: "not_connected" });
  const { name, artist } = req.query as Record<string, string>;
  logEvent("preview", "", req.userId);
  res.json({ url: name && artist ? await findPreview(name, artist) : null });
});

// votes nudge genre weights and hide disliked artists
app.post("/api/feedback", wrap("vote", async (req) => {
  const { vote } = req.body ?? {};
  if (vote !== 1 && vote !== -1) throw bad("bad vote");
  const trackKey = text(req.body.trackKey, 200), artist = text(req.body.artist, 100), genre = text(req.body.genre, 60);
  if (trackKey) addFeedback("track", trackKey, vote);
  if (artist) addFeedback("artist", artist, vote);
  if (genre) addFeedback("genre", genre, vote);
  invalidate();
  return { ok: true };
}));

app.post("/api/playlist", wrap("playlist", async (req) => {
  if (!hasPlaylistScope()) throw bad("Sign out and connect again to grant playlist permission.");
  const uris = req.body?.uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 200 || !uris.every((u) => typeof u === "string" && TRACK_URI.test(u))) throw bad("no tracks");
  return spotify.createPlaylist(text(req.body.name, 100) || "Resonance picks", "Created by Resonance", uris);
}));

const needPlaylistScope = () => {
  if (!hasPlaylistScope()) throw bad("Sign out and connect again to grant playlist permission.");
};

app.get("/api/playlists", wrap(null, async () => {
  needPlaylistScope();
  return spotify.myPlaylists();
}));

app.post("/api/playlist/add", wrap("playlist_add", async (req) => {
  needPlaylistScope();
  const { playlistId, uri } = req.body as { playlistId?: string; uri?: string };
  if (!playlistId || !SPOTIFY_ID.test(playlistId) || !uri || !TRACK_URI.test(uri)) throw bad("bad request");
  await spotify.addToPlaylist(playlistId, uri);
  return { ok: true };
}));

app.get("/api/blend/export", wrap("view_blend", async () => {
  const me = db.prepare("select name from users where id = ?").get(uid()) as { name: string };
  const code = exportTaste(await taste(), me.name);
  return { code: Buffer.from(JSON.stringify(code)).toString("base64") };
}));

app.post("/api/blend/compare", wrap("blend_compare", async (req) => {
  let other;
  try {
    other = parseTasteCode(req.body?.code);
  } catch (e) {
    throw bad((e as Error).message);
  }
  const t = await taste();
  const result = compare(t, other);
  const tracks = await blendTracks(t, result.sharedGenres.length ? result.sharedGenres : other.genres.slice(0, 3).map((g) => g[0]));
  return { ...result, tracks };
}));

// one link per user with a snapshot of their stats and taste code
app.get("/api/share", wrap(null, async () => myShare()));
app.post("/api/share", wrap("share", async () => {
  const me = db.prepare("select name, image from users where id = ?").get(uid()) as { name: string; image: string | null };
  const token = createShare(buildShare(await taste(), me));
  return myShare() ?? { token };
}));
app.delete("/api/share", wrap(null, async () => {
  deleteShare();
  return { ok: true };
}));

app.get("/api/notifications", wrap(null, async () => listNotifications()));
app.post("/api/notifications/seen", wrap(null, async () => {
  markSeen();
  return { ok: true };
}));

// plays from spotify's privacy export, the browser reads the files and sends them in chunks
app.post("/api/import", wrap(null, async (req) => {
  const entries = req.body?.entries;
  if (!Array.isArray(entries) || entries.length > 5000) throw bad("Send up to 5000 entries at a time.");
  const r = importPlays(parseHistory(entries));
  if (r.added) {
    logEvent("import", String(r.added));
    invalidate();
  }
  return { ...r, ignored: entries.length - r.added - r.skipped };
}));

// body parser errors carry their own status (400 bad json, 413 too big)
app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.message });
});

const server = app.listen(PORT, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`\n  Resonance running → ${BASE_URL}\n  admin panel      → ${BASE_URL}/admin\n`);
  if (!getSetting("clientId")) console.log("  no spotify client id yet: add it in the admin panel under settings\n");
  printSetupCode();
  startPoller();
});

// docker stop sends SIGTERM and node as PID 1 ignores it unless we handle it
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log("shutting down");
  const finish = () => {
    closeDb();
    process.exit(0);
  };
  server.close(finish);
  setTimeout(finish, 5000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// a stray rejection in a background job shouldn't take the whole site down
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));
