/**
 * Artist genres. Spotify stopped sending genres to new developer apps in 2026, so they come from two free
 * sources: Last.fm tags when the admin has set a Last.fm key, then MusicBrainz (no key, about one request a second).
 * Results are cached by artist name, so each artist is looked up once; an artist neither knows is retried after 30 days.
 */
import { db } from "./db.js";
import { getSetting } from "./settings.js";
import type { Artist } from "./types.js";

db.exec("create table if not exists genre_cache(name text primary key, genres text not null, source text, checked_at integer)");

const RETRY_EMPTY_MS = 30 * 864e5;
const MAX_GENRES = 5;
const UA = "Resonance/1.1 ( https://github.com/plzgimmeaname/resonance )";

// tags that describe the listener, the voice or the era rather than the music
const NOT_GENRES = new Set([
  "seen live", "favorites", "favourites", "favorite", "my favorite", "love", "awesome", "beautiful", "cool", "amazing", "good",
  "male vocalists", "female vocalists", "male vocalist", "female vocalist", "singer-songwriter", "singer songwriter", "vocalists",
  "american", "british", "canadian", "english", "uk", "usa", "australian", "german", "french", "swedish", "irish", "korean", "japanese",
  "all", "music", "spotify", "swag", "under 2000 listeners", "albums i own", "best", "legend", "genius", "sexy", "chill", "mellow",
]);

// lower case, one spelling per genre, junk dropped, most popular first, at most five
export function cleanTags(tags: { name: string; count?: number }[], artistName = "", minCount = 0): string[] {
  const out: string[] = [];
  const self = artistName.toLowerCase().trim();
  for (const t of [...tags].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))) {
    if ((t.count ?? minCount) < minCount) continue;
    const g = t.name.toLowerCase().trim().replace(/[-_]+/g, " ").replace(/\s+/g, " ").replace(/^rnb$|^r and b$/, "r&b").replace(/^hiphop$/, "hip hop");
    if (!g || g.length > 32 || g === self || NOT_GENRES.has(g) || /^\d{2,4}s?$/.test(g) || /^(19|20)\d\d$/.test(g)) continue;
    if (!out.includes(g)) out.push(g);
    if (out.length === MAX_GENRES) break;
  }
  return out;
}

async function fromLastfm(name: string): Promise<string[]> {
  const key = getSetting("lastfm");
  if (!key) return [];
  const u = new URL("https://ws.audioscrobbler.com/2.0/");
  u.search = new URLSearchParams({ method: "artist.gettoptags", artist: name, api_key: key, format: "json", autocorrect: "1" }).toString();
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) return [];
  const d: any = await r.json();
  // last.fm counts are 0-100 relative to the top tag; below 10 is mostly noise
  return cleanTags((d.toptags?.tag ?? []).map((t: any) => ({ name: String(t.name), count: Number(t.count) })), name, 10);
}

// musicbrainz allows one request a second per client, so its calls go out one at a time
let mbQueue: Promise<unknown> = Promise.resolve();
let mbLast = 0;
function mbFetch(url: URL): Promise<Response> {
  const run = mbQueue.then(async () => {
    const wait = mbLast + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    mbLast = Date.now();
    return fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  });
  mbQueue = run.catch(() => {});
  return run;
}

async function fromMusicBrainz(name: string): Promise<string[]> {
  const u = new URL("https://musicbrainz.org/ws/2/artist/");
  u.search = new URLSearchParams({ query: `artist:"${name.replace(/"/g, "")}"`, limit: "3", fmt: "json" }).toString();
  const r = await mbFetch(u);
  if (!r.ok) return [];
  const d: any = await r.json();
  // only trust a near-exact name match, a fuzzy hit is usually a different artist
  const hit = (d.artists ?? []).find((a: any) => (a.score ?? 0) >= 90 && String(a.name).toLowerCase() === name.toLowerCase());
  return hit ? cleanTags((hit.tags ?? []).map((t: any) => ({ name: String(t.name), count: Number(t.count) })), name) : [];
}

const getCached = db.prepare("select genres, checked_at from genre_cache where name = ?");
const putCached = db.prepare("insert into genre_cache(name, genres, source, checked_at) values(?,?,?,?) on conflict(name) do update set genres=excluded.genres, source=excluded.source, checked_at=excluded.checked_at");

// cached genres for a name, or undefined when it should be (re)looked up
export function cachedGenres(name: string): string[] | undefined {
  const row = getCached.get(name.toLowerCase()) as { genres: string; checked_at: number } | undefined;
  if (!row) return undefined;
  const g = JSON.parse(row.genres) as string[];
  return g.length || Date.now() - row.checked_at < RETRY_EMPTY_MS ? g : undefined;
}

// one lookup per name at a time, however many builds ask for it
const inflight = new Map<string, Promise<string[]>>();
export function lookupGenres(name: string): Promise<string[]> {
  const k = name.toLowerCase();
  const hit = cachedGenres(name);
  if (hit) return Promise.resolve(hit);
  let p = inflight.get(k);
  if (!p) {
    p = (async () => {
      let genres: string[] = [], source = "";
      try {
        genres = await fromLastfm(name);
        source = "lastfm";
        if (!genres.length) { genres = await fromMusicBrainz(name); source = "musicbrainz"; }
      } catch (e) {
        // a network error isn't an answer, don't cache it
        console.warn("[genres]", name, (e as Error).message);
        return [];
      }
      putCached.run(k, JSON.stringify(genres), genres.length ? source : "", Date.now());
      return genres;
    })().finally(() => inflight.delete(k));
    inflight.set(k, p);
  }
  return p;
}

/**
 * Fills in genres for artists Spotify sent without any, in place. Waits up to budgetMs for lookups;
 * the ones still running finish in the background and are cached for next time.
 */
export async function fillGenres<T extends Pick<Artist, "name" | "genres">>(artists: T[], budgetMs = 8000): Promise<T[]> {
  const missing = artists.filter((a) => !a.genres.length);
  if (!missing.length) return artists;
  const names = [...new Set(missing.map((a) => a.name))];
  const done = new Map<string, string[]>();
  // last.fm is fast, so a few at once; musicbrainz calls queue themselves
  let next = 0;
  const worker = async () => {
    while (next < names.length) {
      const n = names[next++];
      done.set(n, await lookupGenres(n));
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(4, names.length) }, worker)).catch(() => {});
  await Promise.race([all, new Promise((r) => setTimeout(r, budgetMs).unref?.())]);
  for (const a of missing) a.genres = done.get(a.name) ?? cachedGenres(a.name) ?? [];
  return artists;
}
