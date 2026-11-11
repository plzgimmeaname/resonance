import { runAs, uid } from "./context.js";
import { artistGenres, db, pruneOld, upsertArtist } from "./db.js";
import { fillGenres } from "./genres.js";
import { buildTaste, snapshotDue, snapshotGenres } from "./engine.js";
import { checkReleases, pruneNotifications, releasesDue } from "./notify.js";
import { sendReport } from "./remote.js";
import { isConnected, spotify } from "./spotify.js";

// spotify only exposes the last 50 plays, so keep our own (per user)
export async function syncHistory(): Promise<number> {
  if (!isConnected()) return 0;
  const recent = await spotify.recent(50);
  const ins = db.prepare("insert or ignore into plays(user_id, played_at, track_id, name, artist_id, artist, album, image, duration) values(?,?,?,?,?,?,?,?,?)");
  let added = 0;
  for (const t of recent) {
    const r = ins.run(uid(), t.playedAt!, t.id, t.name, t.artistIds[0] ?? null, t.artists[0], t.album, t.image ?? null, t.durationMs ?? null);
    added += Number(r.changes);
  }
  // learn genres for artists we have none for, by name (see genres.ts), no spotify calls needed
  const known = artistGenres();
  const unknown = new Map<string, string>();
  for (const t of recent) if (t.artistIds[0] && !known.get(t.artistIds[0])?.length) unknown.set(t.artistIds[0], t.artists[0]);
  const found = await fillGenres([...unknown].slice(0, 20).map(([id, name]) => ({ id, name, genres: [] as string[] })));
  found.forEach(upsertArtist);
  return added;
}

export async function syncUser(userId: string): Promise<number> {
  return runAs(userId, async () => {
    const n = await syncHistory();
    // the taste costs about seven spotify calls, so only build it when a snapshot or release check is due
    if (snapshotDue() || releasesDue()) {
      const t = await buildTaste();
      snapshotGenres(t);
      await checkReleases(t);
    }
    return n;
  });
}

// a slow run must not overlap the next one, callers just wait for the one in progress
let running: Promise<number> | null = null;
export function syncAll(): Promise<number> {
  return (running ??= runAll().finally(() => (running = null)));
}

async function runAll(): Promise<number> {
  const users = db.prepare("select id from users where connected = 1 and blocked = 0").all() as { id: string }[];
  let total = 0;
  for (const u of users) {
    try {
      total += await syncUser(u.id);
    } catch (e) {
      console.warn("[history]", u.id, (e as Error).message);
    }
  }
  if (total) console.log(`[history] +${total} plays`);
  return total;
}

// background jobs: sync plays and report every 15 min, prune old logs every 6h
export function startPoller() {
  setTimeout(() => syncAll().catch(() => {}), 3000);
  setTimeout(() => sendReport(), 5000);
  setInterval(() => sendReport(), 15 * 60_000).unref();
  setInterval(() => syncAll().catch(() => {}), 15 * 60_000).unref();
  const prune = () => {
    pruneOld();
    pruneNotifications();
  };
  setInterval(prune, 6 * 3600_000).unref();
  prune();
}
