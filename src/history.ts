import { runAs } from "./context.js";
import { artistGenres, db, pruneOld, upsertArtist } from "./db.js";
import { buildTaste, snapshotGenres } from "./engine.js";
import { isConnected, spotify } from "./spotify.js";
import { uid } from "./context.js";

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
  // learn genres for unseen artists (no batch endpoint)
  const known = artistGenres();
  const unknown = [...new Set(recent.flatMap((t) => t.artistIds.slice(0, 1)))].filter((id) => !known.has(id)).slice(0, 20);
  for (const id of unknown) {
    try {
      upsertArtist(await spotify.artist(id));
    } catch (e) {
      console.warn("[history]", (e as Error).message);
    }
  }
  return added;
}

export async function syncUser(userId: string): Promise<number> {
  return runAs(userId, async () => {
    const n = await syncHistory();
    snapshotGenres(await buildTaste());
    return n;
  });
}

export async function syncAll(): Promise<number> {
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

export function startPoller() {
  setTimeout(() => syncAll().catch(() => {}), 3000);
  setInterval(() => syncAll().catch(() => {}), 15 * 60_000).unref();
  setInterval(() => pruneOld(), 6 * 3600_000).unref();
  pruneOld();
}
