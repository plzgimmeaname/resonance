import { uid } from "./context.js";
import { artistGenres, db, feedback, upsertArtist } from "./db.js";
import { askClaude, concertsFor, similarArtists, upcomingEvents, type ConcertEvent } from "./extras.js";
import { spotify } from "./spotify.js";
import type { Artist, Range, Release, Track } from "./types.js";

const RANGE_WEIGHT: Record<Range, number> = { short: 3, medium: 2, long: 1 };
const RANGES: Range[] = ["short", "medium", "long"];
const norm = (s: string) => s.toLowerCase().trim();
const trackKey = (t: Track) => norm(`${t.name}|${t.artists[0]}`);

const settle = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
  try {
    return await p;
  } catch (e) {
    if ((e as Error).message === "not_connected") throw e;
    console.warn("[engine]", (e as Error).message);
    return fallback;
  }
};


export interface Taste {
  artists: Record<Range, Artist[]>;
  tracks: Record<Range, Track[]>;
  recent: Track[];
  genreWeights: Map<string, number>;
  rangeGenres: Record<Range, Map<string, number>>;
  knownArtists: Set<string>;
  knownTracks: Set<string>;
  dislikedArtists: Set<string>;
}

function genreMap(artists: Artist[]) {
  const m = new Map<string, number>();
  artists.forEach((a, i) => {
    for (const g of a.genres) m.set(g, (m.get(g) ?? 0) + (1 - i / 60) / Math.sqrt(a.genres.length));
  });
  return m;
}

export async function buildTaste(): Promise<Taste> {
  const artists = {} as Record<Range, Artist[]>;
  const tracks = {} as Record<Range, Track[]>;
  await Promise.all(
    RANGES.map(async (r) => {
      artists[r] = await settle(spotify.topArtists(r, 50), []);
      tracks[r] = await settle(spotify.topTracks(r, 50), []);
    }),
  );
  const recent = await settle(spotify.recent(50), []);
  RANGES.forEach((r) => artists[r].forEach(upsertArtist));

  const rangeGenres = Object.fromEntries(RANGES.map((r) => [r, genreMap(artists[r])])) as Record<Range, Map<string, number>>;
  const genreWeights = new Map<string, number>();
  for (const r of RANGES) for (const [g, w] of rangeGenres[r]) genreWeights.set(g, (genreWeights.get(g) ?? 0) + w * RANGE_WEIGHT[r]);

  // votes nudge the genre profile
  const max = Math.max(...genreWeights.values(), 1);
  for (const [g, s] of feedback("genre")) genreWeights.set(g, Math.max(0.01, (genreWeights.get(g) ?? 0) + s * max * 0.15));

  const knownArtists = new Set<string>();
  const knownTracks = new Set<string>(feedback("track").keys());
  for (const r of RANGES) {
    artists[r].forEach((a) => knownArtists.add(norm(a.name)));
    tracks[r].forEach((t) => {
      knownTracks.add(trackKey(t));
      t.artists.forEach((x) => knownArtists.add(norm(x)));
    });
  }
  recent.forEach((t) => {
    knownTracks.add(trackKey(t));
    t.artists.forEach((x) => knownArtists.add(norm(x)));
  });
  const dislikedArtists = new Set([...feedback("artist")].filter(([, s]) => s < 0).map(([a]) => a));

  return { artists, tracks, recent, genreWeights, rangeGenres, knownArtists, knownTracks, dislikedArtists };
}

const sortedGenres = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
const topGenres = (t: Taste, n: number, skip = 0) => sortedGenres(t.genreWeights).slice(skip, skip + n);


interface PlayRow {
  played_at: string;
  artist: string;
  duration: number | null;
  artist_id: string | null;
}

export function lifetime() {
  const rows = db.prepare("select played_at, artist, artist_id, duration from plays where user_id = ? order by played_at").all(uid()) as unknown as PlayRow[];
  if (!rows.length) return null;
  const hours = Array<number>(24).fill(0);
  const days = Array<number>(7).fill(0);
  const byArtist = new Map<string, number>();
  const monthly = new Map<string, number>();
  const dayset = new Set<string>();
  let ms = 0;
  for (const r of rows) {
    const d = new Date(r.played_at);
    hours[d.getHours()]++;
    days[d.getDay()]++;
    ms += r.duration ?? 0;
    byArtist.set(r.artist, (byArtist.get(r.artist) ?? 0) + 1);
    const m = r.played_at.slice(0, 7);
    monthly.set(m, (monthly.get(m) ?? 0) + 1);
    dayset.add(d.toLocaleDateString("en-CA"));
  }
  // streak of days ending today or yesterday
  let streak = 0;
  const cur = new Date();
  if (!dayset.has(cur.toLocaleDateString("en-CA"))) cur.setDate(cur.getDate() - 1);
  while (dayset.has(cur.toLocaleDateString("en-CA"))) {
    streak++;
    cur.setDate(cur.getDate() - 1);
  }
  return {
    plays: rows.length,
    minutes: Math.round(ms / 60000),
    since: rows[0].played_at.slice(0, 10),
    streak,
    activeDays: dayset.size,
    topArtists: [...byArtist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, plays]) => ({ name, plays })),
    hours,
    days,
    monthly: [...monthly.entries()].sort().slice(-12).map(([month, plays]) => ({ month, plays })),
  };
}

// genres you play around a given hour (±2h)
function genresAtHour(hour: number): Map<string, number> {
  const genres = artistGenres();
  const rows = db.prepare("select played_at, artist_id from plays where user_id = ?").all(uid()) as unknown as PlayRow[];
  const m = new Map<string, number>();
  for (const r of rows) {
    if (!r.artist_id) continue;
    const h = new Date(r.played_at).getHours();
    const dist = Math.min(Math.abs(h - hour), 24 - Math.abs(h - hour));
    if (dist > 2) continue;
    const gs = genres.get(r.artist_id) ?? [];
    for (const g of gs) m.set(g, (m.get(g) ?? 0) + (3 - dist) / Math.sqrt(gs.length));
  }
  return m;
}

export function drift() {
  const rows = db.prepare("select day, genres from snapshots where user_id = ? order by day desc limit 30").all(uid()) as { day: string; genres: string }[];
  return rows.reverse().map((r) => ({ day: r.day, genres: JSON.parse(r.genres) as [string, number][] }));
}

export function snapshotGenres(t: Taste) {
  const total = [...t.rangeGenres.medium.values()].reduce((a, b) => a + b, 0) || 1;
  const top = sortedGenres(t.rangeGenres.medium).slice(0, 12).map(([g, w]) => [g, Math.round((w / total) * 1000) / 10]);
  if (!top.length) return;
  const day = new Date().toLocaleDateString("en-CA");
  db.prepare("insert into snapshots(user_id, day, genres) values(?,?,?) on conflict(user_id, day) do update set genres = excluded.genres").run(uid(), day, JSON.stringify(top));
}


function risingFading(t: Taste) {
  const norm01 = (m: Map<string, number>) => {
    const tot = [...m.values()].reduce((a, b) => a + b, 0) || 1;
    return new Map([...m].map(([g, w]) => [g, w / tot]));
  };
  const s = norm01(t.rangeGenres.short);
  const l = norm01(t.rangeGenres.long);
  const diffs = [...new Set([...s.keys(), ...l.keys()])].map((g) => ({ name: g, delta: (s.get(g) ?? 0) - (l.get(g) ?? 0) }));
  diffs.sort((a, b) => b.delta - a.delta);
  const pct = (x: number) => Math.round(x * 1000) / 10;
  return {
    rising: diffs.filter((d) => d.delta > 0.005).slice(0, 4).map((d) => ({ name: d.name, delta: pct(d.delta) })),
    fading: diffs.filter((d) => d.delta < -0.005).slice(-4).reverse().map((d) => ({ name: d.name, delta: pct(d.delta) })),
  };
}

export function computeStats(t: Taste, range: Range) {
  const total = [...t.genreWeights.values()].reduce((a, b) => a + b, 0) || 1;
  const genres = topGenres(t, 12).map(([name, w]) => ({ name, pct: Math.round((w / total) * 1000) / 10 }));

  const probs = [...t.genreWeights.values()].map((w) => w / total);
  const entropy = -probs.reduce((s, p) => s + p * Math.log(p), 0);
  const diversity = probs.length > 1 ? Math.round((entropy / Math.log(probs.length)) * 100) : 0;

  // share of recent plays outside long-term favourites
  const longNames = new Set(t.artists.long.map((a) => norm(a.name)));
  const fresh = t.recent.length ? Math.round((t.recent.filter((r) => !longNames.has(norm(r.artists[0]))).length / t.recent.length) * 100) : 0;

  const counts = new Map<string, number>();
  t.recent.forEach((r) => counts.set(r.artists[0], (counts.get(r.artists[0]) ?? 0) + 1));
  const topRecent = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const loyalty = t.recent.length && topRecent ? Math.round((topRecent[1] / t.recent.length) * 100) : 0;

  const life = lifetime();
  return {
    topArtists: t.artists[range].slice(0, 20),
    topTracks: t.tracks[range].slice(0, 20),
    genres,
    diversity,
    fresh,
    loyalty,
    topRecentArtist: topRecent?.[0] ?? null,
    persona: persona(diversity, fresh, loyalty),
    ...risingFading(t),
    lifetime: life,
    drift: drift(),
  };
}

function persona(diversity: number, fresh: number, loyalty: number) {
  if (loyalty >= 35) return { name: "The Loyalist", blurb: "When you find an artist you love, you really commit." };
  if (diversity >= 85 || fresh >= 60) return { name: "The Explorer", blurb: "Wide-ranging taste, and always chasing something new." };
  if (fresh <= 15) return { name: "The Creature of Habit", blurb: "You know what you like, and you stick with it." };
  return { name: "The Balanced Listener", blurb: "A healthy mix of old favourites and fresh finds." };
}


export interface Rec {
  track: Track;
  reason: string;
  score: number;
  genre?: string;
  artist?: string;
}
export type RecMode = "similar" | "adventurous" | "deepcuts" | "now";

const hourLabel = (h: number) => (h < 5 ? "late night" : h < 12 ? "the morning" : h < 17 ? "the afternoon" : h < 21 ? "the evening" : "tonight");

export async function recommend(t: Taste, mode: RecMode = "similar"): Promise<Rec[]> {
  const jobs: Promise<Rec[]>[] = [];
  let seeds: [string, number][];
  let label = (g: string) => `Because you listen to ${g}`;
  if (mode === "deepcuts") seeds = [];
  else if (mode === "adventurous") seeds = topGenres(t, 5, 4);
  else if (mode === "now") {
    const h = new Date().getHours();
    seeds = sortedGenres(genresAtHour(h)).slice(0, 4);
    if (!seeds.length) seeds = topGenres(t, 4);
    label = (g) => `Your usual ${g} for ${hourLabel(h)}`;
  } else seeds = topGenres(t, 4);
  const maxW = seeds[0]?.[1] || 1;

  for (const [genre, w] of seeds) {
    jobs.push(
      settle(spotify.searchTracks({ genre }, 10), []).then((ts) =>
        ts.map((track) => ({ track, genre, reason: label(genre), score: w / maxW + Math.random() * 0.3 })),
      ),
    );
  }
  const favs = t.artists.long.slice(0, 5).concat(t.artists.short.slice(0, 3));
  if (mode === "similar" || mode === "deepcuts") {
    for (const a of favs) {
      jobs.push(
        settle(spotify.searchTracks({ artist: a.name }, 10), []).then((ts) =>
          ts.filter((x) => x.artists.some((n) => norm(n) === norm(a.name))).map((track) => ({ track, artist: a.name, reason: `More from ${a.name}`, score: 0.8 + Math.random() * 0.3 })),
        ),
      );
    }
  }
  if (mode === "similar" || mode === "adventurous") {
    // last.fm: unheard artists similar to favourites
    for (const a of favs.slice(0, 4)) {
      jobs.push(
        settle(similarArtists(a.name, 8), []).then(async (names) => {
          const fresh = names.filter((n) => !t.knownArtists.has(norm(n))).slice(0, 2);
          const out = await Promise.all(fresh.map((n) => settle(spotify.searchTracks({ artist: n }, 3), [])));
          return out.flatMap((ts, i) =>
            ts.filter((x) => norm(x.artists[0]) === norm(fresh[i])).slice(0, 2).map((track) => ({ track, artist: fresh[i], reason: `Fans of ${a.name} also love ${fresh[i]}`, score: 1.1 + Math.random() * 0.2 })),
          );
        }),
      );
    }
  }

  const seen = new Set<string>();
  const perArtist = new Map<string, number>();
  const out: Rec[] = [];
  for (const r of (await Promise.all(jobs)).flat().sort((a, b) => b.score - a.score)) {
    const key = trackKey(r.track);
    const artist = norm(r.track.artists[0]);
    if (seen.has(key) || t.knownTracks.has(key) || t.dislikedArtists.has(artist)) continue;
    if (r.genre && t.knownArtists.has(artist)) continue; // genre seeds surface new artists
    if ((perArtist.get(artist) ?? 0) >= 2) continue;
    seen.add(key);
    perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
    out.push(r);
  }
  return out.slice(0, 40);
}


export type FeedItem =
  | { type: "release"; release: Release; reason: string }
  // src says where a song came from, the feed filters use it
  | { type: "track"; track: Track; reason: string; genre?: string; artist?: string; src?: "similar" | "adventurous" | "deepcuts" | "throwback" | "simartist" }
  | { type: "event"; event: ConcertEvent }
  | { type: "insight"; title: string; body: string };

const RECENT_DAYS = 45;
const parseDate = (d: string) => Date.parse(d.length === 4 ? `${d}-01-01` : d.length === 7 ? `${d}-01` : d);

// tracks from unheard artists that last.fm lists as similar to your top artists
async function similarArtistItems(t: Taste): Promise<FeedItem[]> {
  const favs = [...t.artists.short.slice(0, 6), ...t.artists.long.slice(0, 6)].filter((a, i, l) => l.findIndex((x) => x.id === a.id) === i);
  const claimed = new Set<string>();
  const perFav = await Promise.all(
    favs.map(async (a) => ({ a, names: await settle(similarArtists(a.name, 10), []) })),
  );
  const picks: { from: string; name: string }[] = [];
  for (const { a, names } of perFav) {
    let n = 0;
    for (const name of names) {
      const k = norm(name);
      if (n >= 3 || t.knownArtists.has(k) || t.dislikedArtists.has(k) || claimed.has(k)) continue;
      claimed.add(k);
      picks.push({ from: a.name, name });
      n++;
    }
  }
  const found = await Promise.all(picks.map((p) => settle(spotify.searchTracks({ artist: p.name }, 5), [])));
  const seen = new Set<string>();
  return found.flatMap((ts, i) =>
    ts
      .filter((x) => norm(x.artists[0]) === norm(picks[i].name) && !t.knownTracks.has(trackKey(x)) && !seen.has(trackKey(x)) && seen.add(trackKey(x)))
      .slice(0, 2)
      .map((track): FeedItem => ({ type: "track", track, reason: `Similar to ${picks[i].from}: ${picks[i].name}`, artist: picks[i].name, src: "simartist" })),
  );
}

export async function buildFeed(t: Taste): Promise<FeedItem[]> {
  const favs = new Map<string, Artist>();
  [...t.artists.short.slice(0, 8), ...t.artists.long.slice(0, 8)].forEach((a) => favs.set(a.id, a));
  const cutoff = Date.now() - RECENT_DAYS * 864e5;

  const relJobs: Promise<FeedItem[]>[] = [...favs.values()].map((a) =>
    settle(spotify.artistReleases(a.id), []).then((rs) =>
      rs
        .filter((r) => parseDate(r.releaseDate) > cutoff)
        .map((release) => ({ type: "release" as const, release, reason: `New from ${a.name}, one of your top artists` })),
    ),
  );
  for (const [genre] of topGenres(t, 2)) {
    relJobs.push(
      settle(spotify.searchNewAlbums(genre), []).then((rs) =>
        rs.filter((r) => !t.dislikedArtists.has(norm(r.artists[0]))).map((release) => ({ type: "release" as const, release, reason: `Fresh ${genre} release` })),
      ),
    );
  }

  const eventJobs = [...favs.values()].slice(0, 12).map((a) => settle(upcomingEvents(a.name), []));

  const [relAll, recs, adv, deep, events, simArtists] = await Promise.all([
    Promise.all(relJobs),
    recommend(t, "similar"),
    settle(recommend(t, "adventurous"), []),
    settle(recommend(t, "deepcuts"), []),
    Promise.all(eventJobs),
    settle(similarArtistItems(t), []),
  ]);
  const seenRel = new Set<string>();
  const releases = relAll
    .flat()
    .filter((r): r is Extract<FeedItem, { type: "release" }> => r.type === "release")
    .sort((a, b) => b.release.releaseDate.localeCompare(a.release.releaseDate))
    .filter((r) => !seenRel.has(r.release.id) && seenRel.add(r.release.id));

  const recentKeys = new Set([...t.tracks.short, ...t.recent].map(trackKey));
  const throwbacks: FeedItem[] = t.tracks.long
    .filter((x) => !recentKeys.has(trackKey(x)))
    .slice(0, 6)
    .map((track) => ({ type: "track", track, reason: "Throwback: you used to play this a lot", src: "throwback" }));

  const s = computeStats(t, "medium");
  const insights: FeedItem[] = [];
  if (s.genres[0]) insights.push({ type: "insight", title: `${s.genres[0].name} is your sound`, body: `It makes up ${s.genres[0].pct}% of your taste profile.` });
  if (s.rising[0]) insights.push({ type: "insight", title: `You're getting into ${s.rising[0].name}`, body: `It's up ${s.rising[0].delta} points in your recent listening vs. your all-time profile.` });
  if (s.fading[0]) insights.push({ type: "insight", title: `Drifting from ${s.fading[0].name}`, body: `You've been playing less of it lately.` });
  if (s.topRecentArtist && s.loyalty >= 15) insights.push({ type: "insight", title: `${s.topRecentArtist} on repeat`, body: `${s.loyalty}% of your recent plays are this one artist.` });

  const asItems = (list: Rec[], src: "similar" | "adventurous" | "deepcuts"): FeedItem[] => list.map((r) => ({ type: "track", track: r.track, reason: r.reason, genre: r.genre, artist: r.artist, src }));
  const recItems = asItems(recs, "similar");
  const advItems = asItems(adv, "adventurous").slice(0, 10);
  const deepItems = asItems(deep, "deepcuts").slice(0, 10);
  const eventItems: FeedItem[] = events.flat().slice(0, 6).map((event) => ({ type: "event", event }));

  const queues = [releases, recItems.slice(0, 14), recItems.slice(14), throwbacks, insights, eventItems, advItems, deepItems, simArtists.sort(() => Math.random() - 0.5).slice(0, 24)].map((q) => [...q]);
  const pattern = [0, 1, 8, 6, 2, 3, 8, 5, 7, 1, 4, 8, 0, 6, 2, 7];
  const feed: FeedItem[] = [];
  while (queues.some((q) => q.length) && feed.length < 90) {
    for (const i of pattern) {
      const item = queues[i].shift();
      if (item) feed.push(item);
    }
  }
  return feed;
}


export interface TasteCode {
  v: 1;
  name: string;
  genres: [string, number][];
  artists: string[];
}

export function exportTaste(t: Taste, name: string): TasteCode {
  const total = [...t.genreWeights.values()].reduce((a, b) => a + b, 0) || 1;
  return {
    v: 1,
    name,
    genres: topGenres(t, 30).map(([g, w]) => [g, Math.round((w / total) * 10000) / 10000]),
    artists: [...t.artists.long.slice(0, 30), ...t.artists.short.slice(0, 15)].map((a) => a.name).filter((n, i, a) => a.indexOf(n) === i),
  };
}

export function compare(t: Taste, other: TasteCode) {
  const mine = exportTaste(t, "me");
  const a = new Map(mine.genres);
  const b = new Map(other.genres);
  let dot = 0, na = 0, nb = 0;
  for (const v of a.values()) na += v * v;
  for (const v of b.values()) nb += v * v;
  for (const [g, v] of a) dot += v * (b.get(g) ?? 0);
  const cosine = na && nb ? dot / Math.sqrt(na * nb) : 0;
  const theirs = new Set(other.artists.map(norm));
  const sharedArtists = mine.artists.filter((n) => theirs.has(norm(n)));
  const sharedGenres = [...a.keys()].filter((g) => b.has(g)).sort((x, y) => (a.get(y)! + b.get(y)!) - (a.get(x)! + b.get(x)!));
  const score = Math.round(100 * Math.min(1, 0.75 * cosine + 0.25 * Math.min(1, sharedArtists.length / 6)));
  return { score, sharedArtists: sharedArtists.slice(0, 12), sharedGenres: sharedGenres.slice(0, 8), theirName: other.name };
}

// shared-genre tracks by unheard artists
export async function blendTracks(t: Taste, genres: string[]): Promise<Rec[]> {
  const results = await Promise.all(genres.slice(0, 4).map((genre) => settle(spotify.searchTracks({ genre }, 10), []).then((ts) => ts.map((track) => ({ track, genre, reason: `Shared taste: ${genre}`, score: Math.random() })))));
  const seen = new Set<string>();
  return results.flat().filter((r) => !t.knownTracks.has(trackKey(r.track)) && !seen.has(r.track.id) && seen.add(r.track.id)).slice(0, 25);
}

// concerts tab: shows for your top artists
export async function buildConcerts(t: Taste): Promise<ConcertEvent[]> {
  const names = [...new Set([...t.artists.short.slice(0, 15), ...t.artists.medium.slice(0, 15), ...t.artists.long.slice(0, 10)].map((a) => a.name))];
  return concertsFor(names.slice(0, 30));
}

// vibe playlist: claude suggests songs for a description, spotify finds them
export async function vibePlaylist(t: Taste, vibe: string): Promise<Rec[]> {
  const genres = topGenres(t, 5).map(([g]) => g).join(", ");
  const artists = t.artists.medium.slice(0, 8).map((a) => a.name).join(", ");
  const text = await askClaude(
    `Suggest 12 real songs for this request: "${vibe.slice(0, 200)}". The listener's top genres: ${genres}. Top artists: ${artists}. ` +
      `Mix familiar territory with a few new finds. Reply with only a JSON array of {"title": string, "artist": string}. Only songs you are sure exist.`,
    900,
  );
  let picks: { title: string; artist: string }[] = [];
  try {
    picks = JSON.parse(text?.match(/\[[\s\S]*\]/)?.[0] ?? "[]");
  } catch {}
  const found = await Promise.all(picks.slice(0, 12).map((p) => settle(spotify.findTrack(String(p.title), String(p.artist)), null)));
  const seen = new Set<string>();
  return found
    .filter((track): track is Track => track !== null && !seen.has(track.id) && (seen.add(track.id), true))
    .map((track) => ({ track, reason: `Matches "${vibe.slice(0, 40)}"`, score: 1 }));
}

export async function explain(t: Taste, track: Track, reason: string) {
  const genres = topGenres(t, 5).map(([g]) => g).join(", ");
  const artists = t.artists.long.slice(0, 6).map((a) => a.name).join(", ");
  return askClaude(
    `A music app recommended "${track.name}" by ${track.artists.join(", ")} (album: ${track.album}) to a listener. The app's reason: "${reason}". ` +
      `Their top genres: ${genres}. Top artists: ${artists}. In 1-2 friendly sentences, say why they might enjoy it. Only claim things you're confident about; don't invent facts about the song.`,
  );
}

export async function summarize(t: Taste) {
  const s = computeStats(t, "medium");
  return askClaude(
    `Write a fun, warm 2-3 sentence summary of a listener's music taste. Persona: ${s.persona.name}. Top genres: ${s.genres.slice(0, 6).map((g) => `${g.name} (${g.pct}%)`).join(", ")}. ` +
      `Top artists: ${t.artists.medium.slice(0, 6).map((a) => a.name).join(", ")}. Rising: ${s.rising.map((r) => r.name).join(", ") || "none"}. Genre diversity ${s.diversity}/100. No bullet points.`,
  );
}
