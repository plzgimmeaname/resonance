import { uid } from "./context.js";
import { db, kvGet, kvSet } from "./db.js";
import type { Taste } from "./engine.js";
import { spotify } from "./spotify.js";
import type { Artist, Release } from "./types.js";

// new releases from your top artists become notifications, checked at most twice a day per user
const CHECK_EVERY = 12 * 3600_000;
const MAX_AGE_DAYS = 14;

export const releaseArtists = (t: Taste): Artist[] =>
  [...t.artists.short.slice(0, 10), ...t.artists.medium.slice(0, 10), ...t.artists.long.slice(0, 10)].filter((a, i, l) => l.findIndex((x) => x.id === a.id) === i).slice(0, 20);

// releases out in the last two weeks, dates can be just a year or year-month
export function isFresh(r: Release, now = Date.now()) {
  const d = r.releaseDate.length === 4 ? `${r.releaseDate}-01-01` : r.releaseDate.length === 7 ? `${r.releaseDate}-01` : r.releaseDate;
  const t = Date.parse(d);
  return Number.isFinite(t) && t <= now && now - t < MAX_AGE_DAYS * 864e5;
}

const checkedKey = () => `releases_checked:${uid()}`;
export const releasesDue = () => Date.now() - (kvGet<number>(checkedKey()) ?? 0) >= CHECK_EVERY;

export async function checkReleases(t: Taste, force = false): Promise<number> {
  const key = checkedKey();
  if (!force && !releasesDue()) return 0;
  kvSet(key, Date.now());
  const ins = db.prepare(
    "insert or ignore into notifications(user_id, id, kind, title, body, url, image, created_at) values(?,?,?,?,?,?,?,?)",
  );
  let added = 0;
  for (const a of releaseArtists(t)) {
    let releases: Release[];
    try {
      releases = await spotify.artistReleases(a.id);
    } catch (e) {
      if ((e as Error).message === "not_connected") throw e;
      console.warn("[notify]", (e as Error).message);
      continue;
    }
    for (const r of releases.filter((r) => isFresh(r))) {
      const kind = r.kind === "single" ? "single" : "album";
      added += Number(ins.run(uid(), r.id, "release", r.name, `New ${kind} from ${a.name}`, r.url ?? null, r.image ?? null, Date.now()).changes);
    }
  }
  return added;
}

export function listNotifications() {
  const items = db
    .prepare("select id, kind, title, body, url, image, created_at, seen from notifications where user_id = ? order by created_at desc, id limit 30")
    .all(uid());
  const { n } = db.prepare("select count(*) n from notifications where user_id = ? and seen = 0").get(uid()) as { n: number };
  return { items, unread: n };
}

export const markSeen = () => db.prepare("update notifications set seen = 1 where user_id = ?").run(uid());

export const pruneNotifications = (days = 90) => db.prepare("delete from notifications where created_at < ?").run(Date.now() - days * 864e5);
