import crypto from "node:crypto";
import type { Express } from "express";
import { db, kvGet, kvSet } from "./db.js";
import { limiter } from "./limit.js";
import { getSetting } from "./settings.js";
import { clientId } from "./spotify.js";

/*
 * Copies of the app that share one Spotify Client ID can report their (basic) accounts to a collector,
 * which is just another copy of the app reachable over https. The admin page of the collector then lists them.
 * Sent: Spotify id, display name, join/last-seen time, play count, connected flag. Never tokens or listening history.
 */

export function instanceId(): string {
  let id = kvGet<string>("instance");
  if (!id) kvSet("instance", (id = crypto.randomBytes(6).toString("hex")));
  return id;
}

export const reportUrl = () => getSetting("reportUrl").replace(/\/+$/, "");
export const isReporting = () => Boolean(reportUrl());

// the shared key goes in every report, so only send it over https (plain http is fine on this computer)
export function validReportUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname));
  } catch {
    return false;
  }
}

const sameKey = (a: string, b: string) => {
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

// posts our users to the collector, fire and forget
export async function sendReport() {
  const url = reportUrl();
  if (!url) return;
  if (!validReportUrl(url)) return console.warn("[report] collector URL must start with https://");
  const users = db
    .prepare(
      `select u.id, u.name, u.created_at, u.last_seen, u.connected,
        (select count(*) from plays p where p.user_id = u.id) plays
       from users u where u.blocked = 0`,
    )
    .all();
  try {
    const r = await fetch(`${url}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: clientId(), key: getSetting("reportKey"), instance: instanceId(), users }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) console.warn("[report] collector said", r.status);
  } catch (e) {
    console.warn("[report]", (e as Error).message);
  }
}

// per ip counter so nobody can spam the collector
const allow = limiter(3600_000, 60);
const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

export function registerCollector(app: Express) {
  app.post("/report", (req, res) => {
    if (!allow(req.socket.remoteAddress ?? "?")) return res.status(429).json({ error: "slow down" });

    const b = (req.body ?? {}) as { clientId?: string; key?: string; instance?: string; users?: Record<string, unknown>[] };
    // the client id is public (it's in every spotify login link), so a shared key is required too
    const key = getSetting("reportKey");
    if (!key) return res.status(403).json({ error: "collector not enabled" });
    if (!sameKey(String(b.key ?? ""), key)) return res.status(403).json({ error: "bad key" });
    // only accept reports made with our own client id
    const cid = clientId();
    if (!cid || b.clientId !== cid) return res.status(403).json({ error: "client id mismatch" });
    if (!b.instance || !/^[0-9a-f]{12}$/.test(b.instance) || !Array.isArray(b.users) || b.users.length > 50) return res.status(400).json({ error: "bad report" });

    const now = Date.now();
    db.exec("begin");
    try {
      // each report is a full snapshot, so replace the old rows
      db.prepare("delete from remote_users where instance = ?").run(b.instance);
      const ins = db.prepare("insert into remote_users(instance, user_id, name, created_at, last_seen, plays, connected, reported_at) values(?,?,?,?,?,?,?,?)");
      for (const u of b.users) ins.run(b.instance, str(u.id, 100), str(u.name, 100), num(u.created_at), num(u.last_seen), num(u.plays), u.connected ? 1 : 0, now);
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
    res.json({ ok: true });
  });
}
