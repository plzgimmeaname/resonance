import crypto from "node:crypto";
import { uid } from "./context.js";
import { db, logCall } from "./db.js";
import { getSetting } from "./settings.js";
import type { Artist, Range, Release, Track } from "./types.js";

const API = process.env.SPOTIFY_API_URL ?? "https://api.spotify.com/v1";
const ACCOUNTS = process.env.SPOTIFY_ACCOUNTS_URL ?? "https://accounts.spotify.com";
export const clientId = () => getSetting("clientId");
export const SCOPES = "user-top-read user-read-recently-played playlist-modify-private";
const RANGE: Record<Range, string> = { short: "short_term", medium: "medium_term", long: "long_term" };

export class NotConnected extends Error {
  constructor() {
    super("not_connected");
  }
}

interface Stored {
  access: string;
  refresh?: string;
  expires: number;
  scope: string;
}

const b64url = (b: Buffer) => b.toString("base64url");
const pending = new Map<string, { verifier: string; at: number }>();

export function loginUrl(redirect: string) {
  const verifier = b64url(crypto.randomBytes(64));
  const state = b64url(crypto.randomBytes(16));
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
  pending.set(state, { verifier, at: Date.now() });
  return `${ACCOUNTS}/authorize?${new URLSearchParams({
    client_id: clientId(),
    response_type: "code",
    redirect_uri: redirect,
    scope: SCOPES,
    state,
    code_challenge_method: "S256",
    code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
  })}`;
}

async function tokenRequest(body: Record<string, string>) {
  const r = await fetch(`${ACCOUNTS}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId(), ...body }),
  });
  if (!r.ok) throw new Error(`Spotify token error ${r.status}: ${await r.text()}`);
  return (await r.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}

function loadTok(userId: string): Stored | undefined {
  const r = db.prepare("select access, refresh, expires, scope from users where id = ? and connected = 1").get(userId) as
    | { access: string; refresh: string | null; expires: number; scope: string }
    | undefined;
  return r?.access ? { access: r.access, refresh: r.refresh ?? undefined, expires: r.expires, scope: r.scope } : undefined;
}
function saveTok(userId: string, t: Stored) {
  db.prepare("update users set access = ?, refresh = ?, expires = ?, scope = ?, connected = 1 where id = ?").run(t.access, t.refresh ?? null, t.expires, t.scope, userId);
}

export class Blocked extends Error {}

// returns the spotify user id; creates or updates the user row
export async function finishLogin(code: string, state: string, redirect: string): Promise<string> {
  const p = pending.get(state);
  if (!p) throw new Error("state mismatch");
  pending.delete(state);
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: p.verifier });
  const res = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${t.access_token}` } });
  if (!res.ok) throw new Error(`Spotify ${res.status} on /me: ${(await res.text()).slice(0, 200)}`);
  const me: any = await res.json();
  const existing = db.prepare("select blocked from users where id = ?").get(me.id) as { blocked: number } | undefined;
  if (existing?.blocked) throw new Blocked();
  const now = Date.now();
  db.prepare(
    "insert into users(id, name, image, created_at, last_seen) values(?,?,?,?,?) on conflict(id) do update set name = excluded.name, image = excluded.image, last_seen = excluded.last_seen",
  ).run(me.id, me.display_name ?? me.id, img(me.images) ?? null, now, now);
  saveTok(me.id, { access: t.access_token, refresh: t.refresh_token, expires: now + t.expires_in * 1000, scope: t.scope ?? SCOPES });
  return me.id;
}

export const isConnected = () => Boolean(loadTok(uid()));
export const disconnect = (userId = uid()) => {
  db.prepare("update users set access = null, refresh = null, connected = 0 where id = ?").run(userId);
};
export const hasPlaylistScope = () => (loadTok(uid())?.scope ?? "").includes("playlist-modify-private");

async function accessToken(): Promise<string> {
  const id = uid();
  const s = loadTok(id);
  if (!s) throw new NotConnected();
  if (Date.now() < s.expires - 30_000) return s.access;
  if (!s.refresh) throw new NotConnected();
  try {
    const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: s.refresh });
    const next: Stored = { access: t.access_token, refresh: t.refresh_token ?? s.refresh, expires: Date.now() + t.expires_in * 1000, scope: t.scope ?? s.scope };
    saveTok(id, next);
    return next.access;
  } catch {
    disconnect(id);
    throw new NotConnected();
  }
}

async function call(method: string, path: string, params: Record<string, string | number> = {}, body?: unknown, retry = true): Promise<any> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const t0 = Date.now();
  let status = 0;
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    if (res.status === 429 && retry) {
      logCall(path, status, Date.now() - t0);
      await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get("retry-after") ?? 1), 5) * 1000));
      return await call(method, path, params, body, false);
    }
    if (res.status === 401) {
      disconnect();
      throw new NotConnected();
    }
    if (!res.ok) throw new Error(`Spotify ${res.status} on ${method} ${path}: ${(await res.text()).slice(0, 200)}`);
    return res.status === 204 ? null : await res.json();
  } finally {
    if (status !== 429 || !retry) logCall(path, status, Date.now() - t0);
  }
}

const img = (images?: any[]) => images?.[1]?.url ?? images?.[0]?.url;

function mapTrack(t: any, playedAt?: string): Track {
  return {
    id: t.id,
    uri: t.uri ?? `spotify:track:${t.id}`,
    name: t.name,
    artists: (t.artists ?? []).map((a: any) => a.name),
    artistIds: (t.artists ?? []).map((a: any) => a.id),
    album: t.album?.name ?? "",
    image: img(t.album?.images),
    url: t.external_urls?.spotify,
    previewUrl: t.preview_url ?? undefined,
    durationMs: t.duration_ms,
    playedAt,
  };
}
const mapArtist = (a: any): Artist => ({ id: a.id, name: a.name, image: img(a.images), genres: a.genres ?? [], url: a.external_urls?.spotify });

function mapAlbum(a: any): Release {
  return {
    id: a.id,
    name: a.name,
    artists: (a.artists ?? []).map((x: any) => x.name),
    image: img(a.images),
    url: a.external_urls?.spotify,
    releaseDate: a.release_date,
    kind: a.album_type ?? "album",
  };
}

export const spotify = {
  async topArtists(range: Range, limit = 50): Promise<Artist[]> {
    return (await call("GET", "/me/top/artists", { time_range: RANGE[range], limit })).items.map(mapArtist);
  },
  async topTracks(range: Range, limit = 50): Promise<Track[]> {
    return (await call("GET", "/me/top/tracks", { time_range: RANGE[range], limit })).items.map((t: any) => mapTrack(t));
  },
  async recent(limit = 50): Promise<Track[]> {
    return (await call("GET", "/me/player/recently-played", { limit })).items.map((i: any) => mapTrack(i.track, i.played_at));
  },
  async artist(id: string): Promise<Artist> {
    return mapArtist(await call("GET", `/artists/${id}`));
  },
  // search is capped at 10 results
  async searchTracks(q: { genre?: string; artist?: string }, limit = 10): Promise<Track[]> {
    const query = [q.genre && `genre:"${q.genre}"`, q.artist && `artist:"${q.artist}"`].filter(Boolean).join(" ");
    const offset = q.artist ? 0 : Math.floor(Math.random() * 4) * 10;
    const d = await call("GET", "/search", { q: query, type: "track", limit: Math.min(limit, 10), offset });
    return d.tracks.items.filter(Boolean).map((t: any) => mapTrack(t));
  },
  async searchNewAlbums(genre: string): Promise<Release[]> {
    const d = await call("GET", "/search", { q: `genre:"${genre}" tag:new`, type: "album", limit: 10 });
    return d.albums.items.filter(Boolean).map(mapAlbum);
  },
  async artistReleases(id: string): Promise<Release[]> {
    const d = await call("GET", `/artists/${id}/albums`, { include_groups: "album,single", limit: 10 });
    return d.items.map(mapAlbum);
  },
  async createPlaylist(name: string, description: string, uris: string[]) {
    const pl = await call("POST", "/me/playlists", {}, { name, description, public: false });
    for (let i = 0; i < uris.length; i += 100) await call("POST", `/playlists/${pl.id}/items`, {}, { uris: uris.slice(i, i + 100) });
    return { id: pl.id as string, url: pl.external_urls?.spotify as string };
  },
};
