import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import express, { type Express, type Request, type Response } from "express";
import {
  adminExists, checkAdminPassword, checkSetupCode, clearSetupCode, endAdminSessions, ensureSetupCode, isAdmin,
  recordFail, requireAdmin, setAdminPassword, startAdminSession, tooManyAttempts,
} from "./auth.js";
import { db, dbPath, deleteUserData, logEvent } from "./db.js";
import { getSetting, saveSettings, type SettingKey } from "./settings.js";
import { syncAll, syncUser } from "./history.js";

const startedAt = Date.now();
const logs: string[] = [];

export function captureLogs() {
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      logs.push(`${new Date().toISOString().slice(11, 19)} ${level === "log" ? "" : level + " "}${args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(" ")}`.trim());
      if (logs.length > 200) logs.shift();
      orig(...args);
    };
  }
}

// small db helpers, rows = many, one = single row
const DAY = 864e5;
const rows = <T>(sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as unknown as T[];
const one = <T>(sql: string, ...p: (string | number)[]) => db.prepare(sql).get(...p) as unknown as T;
const csvCell = (v: unknown) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (head: string[], data: unknown[][]) => [head, ...data].map((r) => r.map(csvCell).join(",")).join("\n");

export function registerAdmin(app: Express, hooks: { clearCache: () => number; cacheSize: () => number; redirectUri: string; publicDir: string }) {
  const api = express.Router();
  const ip = (req: Request) => req.socket.remoteAddress ?? "?";

  api.get("/state", (req, res) => {
    res.json({ setup: !adminExists(), signedIn: isAdmin(req) });
  });

  api.post("/setup", (req, res) => {
    if (adminExists()) return res.status(400).json({ error: "Admin account already exists." });
    if (tooManyAttempts(ip(req))) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    const { code, password } = req.body as { code?: string; password?: string };
    if (!checkSetupCode(String(code ?? ""))) {
      recordFail(ip(req));
      return res.status(403).json({ error: "Wrong setup code. It's printed in the terminal where the app is running." });
    }
    if (!password || password.length < 8) return res.status(400).json({ error: "Use a password of at least 8 characters." });
    setAdminPassword(password);
    clearSetupCode();
    startAdminSession(res);
    logEvent("admin_setup");
    res.json({ ok: true });
  });

  api.post("/login", (req, res) => {
    if (tooManyAttempts(ip(req))) return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    if (!checkAdminPassword(String(req.body?.password ?? ""))) {
      recordFail(ip(req));
      return res.status(403).json({ error: "Wrong password." });
    }
    startAdminSession(res);
    logEvent("admin_login");
    res.json({ ok: true });
  });

  api.post("/logout", (req, res) => {
    endAdminSessions(req, res);
    res.json({ ok: true });
  });

  // everything below needs the admin cookie
  api.use(requireAdmin);

  api.post("/password", (req, res) => {
    const { current, next } = req.body as { current?: string; next?: string };
    if (!checkAdminPassword(String(current ?? ""))) return res.status(403).json({ error: "Current password is wrong." });
    if (!next || next.length < 8) return res.status(400).json({ error: "Use a password of at least 8 characters." });
    setAdminPassword(next);
    endAdminSessions(req, res, true);
    startAdminSession(res);
    res.json({ ok: true });
  });

  api.get("/overview", (_req, res) => {
    const now = Date.now();
    const users = rows<Record<string, unknown>>(
      `select u.id, u.name, u.image, u.created_at, u.last_seen, u.connected, u.blocked,
        (select count(*) from plays p where p.user_id = u.id) plays,
        (select count(*) from sessions s where s.user_id = u.id and s.expires > ?) sessions,
        (select count(*) from events e where e.user_id = u.id and e.ts > ?) events7d
       from users u order by u.last_seen desc`,
      now, now - 7 * DAY,
    );

    // fill in days with no logins so the chart has 14 bars
    const logins = rows<{ d: string; n: number }>(
      "select strftime('%Y-%m-%d', ts / 1000, 'unixepoch') d, count(*) n from events where kind = 'login' and ts > ? group by d",
      now - 14 * DAY,
    );
    const loginMap = new Map(logins.map((l) => [l.d, l.n]));
    const loginsByDay = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(now - (13 - i) * DAY).toISOString().slice(0, 10);
      return { day: d, n: loginMap.get(d) ?? 0 };
    });

    const hourly = rows<{ h: number; calls: number; errors: number }>(
      "select ts / 3600000 h, count(*) calls, sum(case when status = 0 or status >= 400 then 1 else 0 end) errors from spotify_calls where ts > ? group by h",
      now - 24 * 3600_000,
    );
    const hMap = new Map(hourly.map((h) => [h.h, h]));
    const nowH = Math.floor(now / 3600_000);
    const callsByHour = Array.from({ length: 24 }, (_, i) => {
      const h = nowH - 23 + i;
      return { hour: new Date(h * 3600_000).getHours(), calls: hMap.get(h)?.calls ?? 0, errors: hMap.get(h)?.errors ?? 0 };
    });
    const apiTotals = one<{ calls: number; errors: number; limited: number; avg: number | null }>(
      "select count(*) calls, coalesce(sum(case when status = 0 or status >= 400 then 1 else 0 end), 0) errors, coalesce(sum(status = 429), 0) limited, avg(ms) avg from spotify_calls where ts > ?",
      now - 24 * 3600_000,
    );
    const byPath = rows("select path, count(*) n, sum(case when status = 0 or status >= 400 then 1 else 0 end) errors, round(avg(ms)) avg_ms from spotify_calls where ts > ? group by path order by n desc limit 10", now - 24 * 3600_000);

    const features = rows<{ kind: string; n: number }>("select kind, count(*) n from events where ts > ? and kind not in ('login','error','admin_login','admin_setup') group by kind order by n desc", now - 7 * DAY);
    const errors = rows("select ts, user_id, detail from events where kind = 'error' order by ts desc limit 15");

    let dbBytes = 0;
    for (const f of [dbPath, dbPath + "-wal"]) if (fs.existsSync(f)) dbBytes += fs.statSync(f).size;
    const counts = one<{ plays: number; events: number; calls: number; users: number }>(
      "select (select count(*) from plays) plays, (select count(*) from events) events, (select count(*) from spotify_calls) calls, (select count(*) from users) users",
    );

    res.json({
      users,
      remote: rows("select instance, user_id, name, created_at, last_seen, plays, connected, reported_at from remote_users order by last_seen desc"),
      loginsByDay,
      api: { ...apiTotals, callsByHour, byPath },
      features,
      errors,
      system: {
        uptimeSec: Math.round((now - startedAt) / 1000),
        dbBytes,
        cacheEntries: hooks.cacheSize(),
        rssMb: Math.round(process.memoryUsage().rss / 1048576),
        node: process.version,
        host: `${os.platform()} ${os.arch()}`,
        counts,
      },
      logs: logs.slice(-120),
    });
  });

  api.get("/settings", (_req, res) =>
    res.json({
      clientId: getSetting("clientId"),
      city: getSetting("city"),
      country: getSetting("country"),
      reportUrl: getSetting("reportUrl"),
      reportKey: Boolean(getSetting("reportKey")),
      set: { lastfm: Boolean(getSetting("lastfm")), ticketmaster: Boolean(getSetting("ticketmaster")), anthropic: Boolean(getSetting("anthropic")) },
      redirectUri: hooks.redirectUri,
    }),
  );

  api.post("/settings", (req, res) => {
    const body = req.body as Partial<Record<SettingKey, string>>;
    if (body.clientId !== undefined && body.clientId.trim() && !/^[0-9a-f]{32}$/i.test(body.clientId.trim()))
      return res.status(400).json({ error: "That doesn't look like a Spotify Client ID (it's 32 letters and numbers)." });
    const before = getSetting("clientId");
    const patch: Partial<Record<SettingKey, string>> = {};
    for (const k of ["clientId", "lastfm", "ticketmaster", "city", "country", "anthropic", "reportUrl", "reportKey"] as SettingKey[]) {
      // a blank secret field means "leave unchanged"; "-" clears it
      if (body[k] === undefined || (body[k] === "" && ["lastfm", "ticketmaster", "anthropic", "reportKey"].includes(k))) continue;
      patch[k] = body[k] === "-" ? "" : body[k];
    }
    saveSettings(patch);
    // tokens from another client id are useless, so everyone has to sign in again
    if (getSetting("clientId") !== before) db.prepare("update users set access = null, refresh = null, connected = 0").run();
    hooks.clearCache();
    logEvent("admin_settings", Object.keys(patch).join(","));
    res.json({ ok: true });
  });

  api.post("/users/:id/disconnect", (req, res) => {
    db.prepare("update users set access = null, refresh = null, connected = 0 where id = ?").run(req.params.id);
    db.prepare("delete from sessions where user_id = ?").run(req.params.id);
    hooks.clearCache();
    res.json({ ok: true });
  });
  // blocking also kills sessions and tokens
  api.post("/users/:id/block", (req, res) => {
    const blocked = req.body?.blocked ? 1 : 0;
    db.prepare("update users set blocked = ? where id = ?").run(blocked, req.params.id);
    if (blocked) {
      db.prepare("delete from sessions where user_id = ?").run(req.params.id);
      db.prepare("update users set access = null, refresh = null, connected = 0 where id = ?").run(req.params.id);
    }
    hooks.clearCache();
    res.json({ ok: true });
  });
  api.delete("/users/:id", (req, res) => {
    deleteUserData(String(req.params.id));
    hooks.clearCache();
    logEvent("admin_delete_user", String(req.params.id));
    res.json({ ok: true });
  });

  api.post("/maintenance", async (req, res) => {
    const { action, userId } = req.body as { action?: string; userId?: string };
    try {
      if (action === "clear_cache") return res.json({ message: `Cleared ${hooks.clearCache()} cached items.` });
      if (action === "sync_history") {
        const n = userId ? await syncUser(userId) : await syncAll();
        return res.json({ message: `Synced history: ${n} new plays.` });
      }
      if (action === "reset_feedback") {
        if (userId) db.prepare("delete from feedback where user_id = ?").run(userId);
        else db.exec("delete from feedback");
        hooks.clearCache();
        return res.json({ message: userId ? "Reset that user's feedback." : "Reset everyone's feedback." });
      }
      if (action === "prune_logs") {
        const r = db.prepare("delete from events where ts < ?").run(Date.now() - 30 * DAY);
        const c = db.prepare("delete from spotify_calls where ts < ?").run(Date.now() - 30 * DAY);
        db.exec("vacuum");
        return res.json({ message: `Deleted ${Number(r.changes) + Number(c.changes)} log rows older than 30 days.` });
      }
      res.status(400).json({ error: "Unknown action." });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  api.get("/export/plays.csv", (_req, res: Response) => {
    const data = rows<Record<string, unknown>>("select u.name user, p.played_at, p.name track, p.artist, p.album, p.duration from plays p left join users u on u.id = p.user_id order by p.played_at");
    res.type("text/csv").attachment("plays.csv").send(toCsv(["user", "played_at", "track", "artist", "album", "duration_ms"], data.map((r) => Object.values(r))));
  });
  api.get("/export/usage.csv", (_req, res: Response) => {
    const data = rows<Record<string, unknown>>("select datetime(e.ts / 1000, 'unixepoch') time, u.name user, e.kind, e.detail from events e left join users u on u.id = e.user_id order by e.ts");
    res.type("text/csv").attachment("usage.csv").send(toCsv(["time_utc", "user", "kind", "detail"], data.map((r) => Object.values(r))));
  });
  // the backup has tokens, api keys and admin hash removed
  api.get("/export/backup.db", (_req, res: Response) => {
    const tmp = path.join(os.tmpdir(), `resonance-backup-${Date.now()}.db`);
    db.exec(`vacuum into '${tmp.replace(/'/g, "''")}'`);
    const copy = new DatabaseSync(tmp);
    copy.exec("update users set access = null, refresh = null; delete from kv; delete from sessions;");
    copy.close();
    res.download(tmp, "resonance-backup.db", () => fs.rm(tmp, { force: true }, () => {}));
  });

  app.use("/admin/api", express.json(), api);
  app.get("/admin", (_req, res) => res.sendFile(path.join(hooks.publicDir, "admin.html")));
}

export function printSetupCode() {
  const code = ensureSetupCode();
  if (code) console.log(`  admin setup code: ${code}   (open /admin and use it to create the admin password)\n`);
}
