import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { captureLogs, printSetupCode, registerAdmin } from "./admin.js";
import { endUserSession, startUserSession, userSession } from "./auth.js";
import { runAs, uid } from "./context.js";
import { addFeedback, db, deleteUserData, logEvent } from "./db.js";
import { blendTracks, buildFeed, buildTaste, compare, computeStats, explain, exportTaste, recommend, summarize, type RecMode, type Taste, type TasteCode } from "./engine.js";
import { features, findPreview } from "./extras.js";
import { startPoller, syncHistory } from "./history.js";
import { getSetting } from "./settings.js";
import { Blocked, clientId, finishLogin, hasPlaylistScope, isConnected, loginUrl, NotConnected, spotify } from "./spotify.js";
import type { Range } from "./types.js";

captureLogs();

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
const REDIRECT = `${BASE_URL}/auth/spotify/callback`;
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const app = express();
app.use(express.json());

// refuse cross-site writes
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (req.method !== "GET" && origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ error: "bad origin" });
  next();
});
app.use(userSession);

/* cache (per user) */
const cache = new Map<string, { at: number; value: unknown }>();
const clearCache = () => {
  const n = cache.size;
  cache.clear();
  return n;
};
const invalidate = (prefix = "") => [...cache.keys()].filter((k) => k.startsWith(`${uid()}:${prefix}`)).forEach((k) => cache.delete(k));
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const k = `${uid()}:${key}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
  const value = await fn();
  cache.set(k, { at: Date.now(), value });
  return value;
}
const taste = () => cached<Taste>("taste", 5 * 60_000, buildTaste);

registerAdmin(app, { clearCache, cacheSize: () => cache.size, redirectUri: REDIRECT, publicDir });
app.use(express.static(publicDir));

/* auth */
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
  res.json({ ok: true });
});

/* api */
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
      console.error(e);
      logEvent("error", `${req.path}: ${(e as Error).message}`);
      next(e);
    }
  });
};

app.get("/api/status", (req, res) => {
  const base = { configured: Boolean(clientId()), features: features(), redirectUri: REDIRECT };
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

app.get("/api/summary", wrap(null, async () => ({ text: await cached("summary", 60 * 60_000, async () => summarize(await taste())) })));

app.post("/api/explain", wrap("explain", async (req) => {
  const { track, reason } = req.body;
  return { text: await explain(await taste(), track, String(reason ?? "")) };
}));

app.get("/api/preview", async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: "not_connected" });
  const { name, artist } = req.query as Record<string, string>;
  logEvent("preview", "", req.userId);
  res.json({ url: name && artist ? await findPreview(name, artist) : null });
});

// votes nudge genre weights and hide disliked artists
app.post("/api/feedback", wrap("vote", async (req) => {
  const { vote, trackKey, artist, genre } = req.body as { vote: 1 | -1; trackKey?: string; artist?: string; genre?: string };
  if (vote !== 1 && vote !== -1) throw new Error("bad vote");
  if (trackKey) addFeedback("track", trackKey, vote);
  if (artist) addFeedback("artist", artist, vote);
  if (genre) addFeedback("genre", genre, vote);
  invalidate();
  return { ok: true };
}));

app.post("/api/playlist", wrap("playlist", async (req) => {
  if (!hasPlaylistScope()) throw new Error("Sign out and connect again to grant playlist permission.");
  const { name, uris } = req.body as { name: string; uris: string[] };
  if (!uris?.length) throw new Error("no tracks");
  return spotify.createPlaylist(name || "Resonance picks", "Created by Resonance", uris);
}));

app.get("/api/blend/export", wrap("view_blend", async () => {
  const me = db.prepare("select name from users where id = ?").get(uid()) as { name: string };
  const code = exportTaste(await taste(), me.name);
  return { code: Buffer.from(JSON.stringify(code)).toString("base64") };
}));

app.post("/api/blend/compare", wrap("blend_compare", async (req) => {
  const other = parseCode(req.body.code);
  const t = await taste();
  const result = compare(t, other);
  const tracks = await blendTracks(t, result.sharedGenres.length ? result.sharedGenres : other.genres.slice(0, 3).map((g) => g[0]));
  return { ...result, tracks };
}));

function parseCode(raw: string): TasteCode {
  try {
    const c = JSON.parse(Buffer.from(String(raw).trim(), "base64").toString("utf8")) as TasteCode;
    if (c.v !== 1 || !Array.isArray(c.genres) || !Array.isArray(c.artists)) throw new Error();
    return c;
  } catch {
    throw new Error("That doesn't look like a valid taste code.");
  }
}

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: err.message });
});

app.listen(PORT, process.env.HOST ?? "127.0.0.1", () => {
  console.log(`\n  Resonance running → ${BASE_URL}\n  admin panel      → ${BASE_URL}/admin\n`);
  if (!getSetting("clientId")) console.log("  no spotify client id yet: add it in the admin panel under settings\n");
  printSetupCode();
  startPoller();
});
