import crypto from "node:crypto";
import type { Express } from "express";
import { db, kvGet, kvSet } from "./db.js";
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

// posts our users to the collector, fire and forget
export async function sendReport() {
  const url = reportUrl();
  if (!url) return;
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
const hits = new Map<string, number[]>();
const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

export function registerCollector(app: Express) {
  app.post("/report", (req, res) => {
    const ip = req.socket.remoteAddress ?? "?";
    const recent = (hits.get(ip) ?? []).filter((t) => Date.now() - t < 3600_000);
    hits.set(ip, [...recent, Date.now()]);
    if (recent.length >= 60) return res.status(429).json({ error: "slow down" });

    const b = req.body as { clientId?: string; key?: string; instance?: string; users?: Record<string, unknown>[] };
    // only accept reports made with our own client id
    const cid = clientId();
    if (!cid || b.clientId !== cid) return res.status(403).json({ error: "client id mismatch" });
    const key = getSetting("reportKey");
    if (key && b.key !== key) return res.status(403).json({ error: "bad key" });
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
