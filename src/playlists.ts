import { artistGenres, upsertArtist } from "./db.js";
import type { Rec, Taste } from "./engine.js";
import { spotify } from "./spotify.js";
import type { PlaylistInfo, PlaylistTrack, Track } from "./types.js";

/*
 * Refining a playlist: work out what it is (its genres), flag what doesn't belong (duplicates and
 * outliers), suggest songs that do, and apply the removals. Spotify has no audio features for new apps,
 * so "fits" means "shares genres with most of the playlist".
 */

export const MAX_TRACKS = 500;
const norm = (s: string) => s.toLowerCase().trim();
const key = (t: Pick<Track, "name" | "artists">) => norm(`${t.name}|${t.artists[0]}`);

export interface RefinedTrack extends PlaylistTrack {
  genres: string[];
  // 0 to 1: how much of the playlist shares this song's best genre, null when its artists have no genres
  fit: number | null;
  flags: ("duplicate" | "outlier")[];
  // the position of the copy this one duplicates, and whether it is the very same track (not just the same song)
  dupOf?: number;
  exact?: boolean;
}

export interface Analysis {
  tracks: RefinedTrack[];
  genres: { name: string; pct: number }[];
  duplicates: number;
  outliers: number;
  unknownGenres: number;
  // false when too few songs have genres to say what the playlist is
  profiled: boolean;
}

// a song is an outlier when almost none of the playlist shares a genre with it
const OUTLIER_SHARE = 0.1;
const MIN_KNOWN = 8;
const MIN_TOP_SHARE = 0.3;

export function analyzeTracks(tracks: PlaylistTrack[], genresOf: (artistId: string) => string[] | undefined): Analysis {
  const withGenres = tracks.map((t) => ({ t, genres: [...new Set(t.artistIds.flatMap((id) => genresOf(id) ?? []))] }));
  const known = withGenres.filter((x) => x.genres.length);

  // share[g] = fraction of the songs with genres that have g
  const share = new Map<string, number>();
  for (const x of known) for (const g of x.genres) share.set(g, (share.get(g) ?? 0) + 1 / known.length);
  const topShare = Math.max(0, ...share.values());
  const profiled = known.length >= MIN_KNOWN && topShare >= MIN_TOP_SHARE;

  const firstByUri = new Map<string, number>();
  const firstByKey = new Map<string, number>();
  const refined = [...withGenres].sort((a, b) => a.t.position - b.t.position).map(({ t, genres }): RefinedTrack => {
    const best = Math.max(0, ...genres.map((g) => share.get(g) ?? 0));
    const flags: RefinedTrack["flags"] = [];
    let dupOf: number | undefined, exact: boolean | undefined;

    const sameUri = firstByUri.get(t.uri);
    if (sameUri !== undefined) {
      flags.push("duplicate");
      dupOf = sameUri;
      exact = true;
    } else {
      firstByUri.set(t.uri, t.position);
      const sameSong = firstByKey.get(key(t));
      if (sameSong !== undefined) {
        flags.push("duplicate");
        dupOf = sameSong;
        exact = false;
      } else firstByKey.set(key(t), t.position);
    }
    if (profiled && genres.length && best < OUTLIER_SHARE) flags.push("outlier");
    return { ...t, genres, fit: genres.length && topShare ? Math.round((best / topShare) * 100) / 100 : null, flags, dupOf, exact };
  });

  return {
    tracks: refined,
    genres: [...share].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, s]) => ({ name, pct: Math.round(s * 100) })),
    duplicates: refined.filter((t) => t.flags.includes("duplicate")).length,
    outliers: refined.filter((t) => t.flags.includes("outlier")).length,
    unknownGenres: withGenres.length - known.length,
    profiled,
  };
}

/*
 * Spotify removes every copy of a uri, there is no "remove just the second one". So to keep one copy of a
 * duplicated track we remove all copies and put one back where the first was. Re-inserting in playlist order
 * works because everything that belongs before a track is already in place when it goes in.
 */
export function planClean(tracks: PlaylistTrack[], remove: string[], dedupe: string[]) {
  const count = new Map<string, number>();
  const first = new Map<string, number>();
  for (const t of [...tracks].sort((a, b) => a.position - b.position)) {
    count.set(t.uri, (count.get(t.uri) ?? 0) + 1);
    if (!first.has(t.uri)) first.set(t.uri, t.position);
  }
  const rm = new Set(remove.filter((u) => count.has(u)));
  // only uris that really appear more than once, and not ones that are being removed outright
  const merge = new Set(dedupe.filter((u) => (count.get(u) ?? 0) > 1 && !rm.has(u)));
  // copies that won't be in the playlist afterwards
  const gone = (t: PlaylistTrack) => rm.has(t.uri) || (merge.has(t.uri) && first.get(t.uri) !== t.position);

  const reinserts = [...merge]
    .map((uri) => {
      const pos = first.get(uri)!;
      return { uri, position: pos - tracks.filter((t) => t.position < pos && gone(t)).length };
    })
    .sort((a, b) => a.position - b.position);
  return { deleteUris: [...rm, ...merge], removed: [...rm], reinserts };
}

export async function applyClean(playlistId: string, tracks: PlaylistTrack[], remove: string[], dedupe: string[]) {
  const plan = planClean(tracks, remove, dedupe);
  if (!plan.deleteUris.length) return { removed: [] as string[], merged: 0, failed: [] as string[] };
  await spotify.removeFromPlaylist(playlistId, plan.deleteUris);
  // a copy we failed to put back would be lost, so retry at the end and report whatever still fails
  const failed: string[] = [];
  for (const r of plan.reinserts) {
    try {
      await spotify.addTracksToPlaylist(playlistId, [r.uri], r.position);
    } catch (e) {
      if ((e as Error).message === "not_connected") throw e;
      try {
        await spotify.addTracksToPlaylist(playlistId, [r.uri]);
      } catch {
        failed.push(r.uri);
      }
    }
  }
  return { removed: plan.removed, merged: plan.reinserts.length - failed.length, failed };
}

// learns genres for the artists in a playlist that we haven't seen, most common first. returns how many are still unknown
export async function ensureGenres(tracks: PlaylistTrack[], limit = 60): Promise<number> {
  const known = artistGenres();
  const freq = new Map<string, number>();
  for (const t of tracks) for (const id of t.artistIds) if (id && !known.has(id)) freq.set(id, (freq.get(id) ?? 0) + 1);
  const wanted = [...freq].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
  await Promise.all(
    wanted.map(async (id) => {
      try {
        upsertArtist(await spotify.artist(id));
      } catch (e) {
        if ((e as Error).message === "not_connected") throw e;
        console.warn("[playlists]", (e as Error).message);
      }
    }),
  );
  return freq.size - wanted.length;
}

// songs that fit the playlist's genres, from artists the listener doesn't already have in it
export async function suggest(t: Taste, a: Analysis, existing: PlaylistTrack[]): Promise<Rec[]> {
  const seeds = a.profiled
    ? a.genres.slice(0, 3).map((g) => ({ genre: g.name, label: `Fits the ${g.name} in this playlist` }))
    : [...t.genreWeights].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([genre]) => ({ genre, label: `Fits your taste: ${genre}` }));

  const inList = new Set(existing.map((x) => x.uri));
  const keys = new Set(existing.map(key));
  const artistsIn = new Set(existing.flatMap((x) => x.artists.map(norm)));

  const batches = await Promise.all(
    seeds.map(async ({ genre, label }) => {
      try {
        return (await spotify.searchTracks({ genre }, 10)).map((track) => ({ track, genre, reason: label, score: 0 }));
      } catch (e) {
        if ((e as Error).message === "not_connected") throw e;
        console.warn("[playlists]", (e as Error).message);
        return [];
      }
    }),
  );

  const seen = new Set<string>();
  const perArtist = new Map<string, number>();
  return batches
    .flat()
    .map((r) => ({ ...r, score: 1 + (t.knownArtists.has(norm(r.track.artists[0])) ? 0.3 : 0) + (artistsIn.has(norm(r.track.artists[0])) ? -0.4 : 0) + Math.random() * 0.3 }))
    .sort((x, y) => y.score - x.score)
    .filter((r) => {
      const artist = norm(r.track.artists[0]);
      if (inList.has(r.track.uri) || keys.has(key(r.track)) || seen.has(r.track.uri) || t.dislikedArtists.has(artist)) return false;
      if ((perArtist.get(artist) ?? 0) >= 2) return false;
      seen.add(r.track.uri);
      perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
      return true;
    })
    .slice(0, 18);
}

export async function analyzePlaylist(info: PlaylistInfo, t: Taste) {
  const { tracks, total, truncated } = await spotify.playlistItems(info.id, MAX_TRACKS);
  const unknownArtists = await ensureGenres(tracks);
  const genres = artistGenres();
  const analysis = analyzeTracks(tracks, (id) => genres.get(id));
  return { playlist: info, total, truncated, canMerge: !truncated, unknownArtists, ...analysis, suggestions: await suggest(t, analysis, tracks) };
}
