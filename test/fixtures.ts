import { db } from "../src/db.js";
import type { Taste } from "../src/engine.js";
import type { Artist, Range, Track } from "../src/types.js";

export const artist = (name: string, genres: string[], id = name.toLowerCase().replace(/\W/g, "")): Artist => ({ id, name, genres });

export const track = (name: string, artistName: string, id = `${name}-${artistName}`.toLowerCase().replace(/\W/g, "")): Track => ({
  id, uri: `spotify:track:${id}`, name, artists: [artistName], artistIds: [artistName.toLowerCase()], album: "Album",
});

// a taste with the given artists in every range, unless a range is passed separately
export function taste(p: Partial<Record<Range, Artist[]>> & { all?: Artist[]; tracks?: Track[]; recent?: Track[] } = {}): Taste {
  const ranges = { short: p.short ?? p.all ?? [], medium: p.medium ?? p.all ?? [], long: p.long ?? p.all ?? [] };
  const rangeGenres = {} as Record<Range, Map<string, number>>;
  const genreWeights = new Map<string, number>();
  for (const r of ["short", "medium", "long"] as Range[]) {
    const m = new Map<string, number>();
    ranges[r].forEach((a, i) => a.genres.forEach((g) => m.set(g, (m.get(g) ?? 0) + (1 - i / 60) / Math.sqrt(a.genres.length))));
    rangeGenres[r] = m;
    for (const [g, w] of m) genreWeights.set(g, (genreWeights.get(g) ?? 0) + w);
  }
  const tracks = p.tracks ?? [];
  const known = [...ranges.short, ...ranges.medium, ...ranges.long].map((a) => a.name.toLowerCase());
  return {
    artists: ranges,
    tracks: { short: tracks, medium: tracks, long: tracks },
    recent: p.recent ?? [],
    genreWeights,
    rangeGenres,
    knownArtists: new Set([...known, ...tracks.flatMap((t) => t.artists.map((a) => a.toLowerCase()))]),
    knownTracks: new Set(tracks.map((t) => `${t.name}|${t.artists[0]}`.toLowerCase())),
    dislikedArtists: new Set(),
  };
}

// a connected user with a token that won't need refreshing
export function addUser(id: string, name = id) {
  db.prepare("insert or replace into users(id, name, access, refresh, expires, scope, created_at, last_seen, connected) values(?,?,?,?,?,?,?,?,1)").run(
    id, name, "token", "refresh", Date.now() + 3600_000, "user-top-read playlist-read-private", Date.now(), Date.now(),
  );
}

// replaces fetch for the duration of a test. the handler gets the url and returns the json body (or a Response)
export function stubFetch(handler: (url: URL, init?: RequestInit) => unknown) {
  const real = globalThis.fetch;
  const calls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push(url);
    const out = await handler(url, init);
    return out instanceof Response ? out : Response.json(out);
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

export const spotifyTrack = (name: string, artistName: string) => ({
  id: `${name}-${artistName}`.toLowerCase().replace(/\W/g, ""),
  name,
  artists: [{ name: artistName, id: artistName.toLowerCase() }],
  album: { name: "Album", images: [] },
});
