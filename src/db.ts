import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { maybeUid, uid } from "./context.js";

const dir = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
fs.mkdirSync(dir, { recursive: true });
export const dbPath = path.join(dir, "resonance.db");
export const db = new DatabaseSync(dbPath);

// single-user tables from v1 are kept as *_legacy
const hasUserCol = (t: string) => (db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).some((c) => c.name === "user_id");
for (const t of ["plays", "snapshots", "feedback"]) {
  const cols = db.prepare(`pragma table_info(${t})`).all();
  if (cols.length && !hasUserCol(t)) db.exec(`alter table ${t} rename to ${t}_legacy`);
}

db.exec(`
  create table if not exists kv(k text primary key, v text not null);
  create table if not exists users(
    id text primary key, name text, image text, access text, refresh text, expires integer, scope text,
    created_at integer, last_seen integer, connected integer default 1, blocked integer default 0);
  create table if not exists sessions(token text primary key, user_id text, created_at integer, last_seen integer, expires integer);
  create table if not exists plays(
    user_id text, played_at text, track_id text, name text, artist_id text, artist text,
    album text, image text, duration integer, primary key(user_id, played_at, track_id));
  create table if not exists artists(id text primary key, name text, genres text, image text);
  create table if not exists snapshots(user_id text, day text, genres text not null, primary key(user_id, day));
  create table if not exists feedback(user_id text, kind text, value text, score integer, primary key(user_id, kind, value));
  create table if not exists events(ts integer, user_id text, kind text, detail text);
  create table if not exists spotify_calls(ts integer, user_id text, path text, status integer, ms integer);
  create index if not exists events_ts on events(ts);
  create index if not exists calls_ts on spotify_calls(ts);
`);

export function kvGet<T>(k: string): T | undefined {
  const row = db.prepare("select v from kv where k = ?").get(k) as { v: string } | undefined;
  return row ? (JSON.parse(row.v) as T) : undefined;
}
export function kvSet(k: string, v: unknown) {
  db.prepare("insert into kv(k, v) values(?, ?) on conflict(k) do update set v = excluded.v").run(k, JSON.stringify(v));
}

export function upsertArtist(a: { id: string; name: string; genres: string[]; image?: string }) {
  db.prepare(
    "insert into artists(id, name, genres, image) values(?,?,?,?) on conflict(id) do update set name=excluded.name, genres=excluded.genres, image=coalesce(excluded.image, image)",
  ).run(a.id, a.name, JSON.stringify(a.genres), a.image ?? null);
}

export function artistGenres(): Map<string, string[]> {
  const rows = db.prepare("select id, genres from artists").all() as { id: string; genres: string }[];
  return new Map(rows.map((r) => [r.id, JSON.parse(r.genres) as string[]]));
}

export function addFeedback(kind: "artist" | "genre" | "track", value: string, delta: number) {
  db.prepare(
    "insert into feedback(user_id, kind, value, score) values(?,?,?,?) on conflict(user_id, kind, value) do update set score = score + excluded.score",
  ).run(uid(), kind, value.toLowerCase(), delta);
}
export function feedback(kind: "artist" | "genre" | "track"): Map<string, number> {
  const rows = db.prepare("select value, score from feedback where user_id = ? and kind = ?").all(uid(), kind) as { value: string; score: number }[];
  return new Map(rows.map((r) => [r.value, r.score]));
}

export function logEvent(kind: string, detail = "", userId = maybeUid() ?? "") {
  db.prepare("insert into events(ts, user_id, kind, detail) values(?,?,?,?)").run(Date.now(), userId, kind, detail.slice(0, 300));
}

const normPath = (p: string) => p.replace(/\/(artists|playlists)\/[^/]+/, "/$1/:id");
export function logCall(path: string, status: number, ms: number) {
  db.prepare("insert into spotify_calls(ts, user_id, path, status, ms) values(?,?,?,?,?)").run(Date.now(), maybeUid() ?? "", normPath(path), status, ms);
}

export function pruneOld(days = 60) {
  const cutoff = Date.now() - days * 864e5;
  db.prepare("delete from events where ts < ?").run(cutoff);
  db.prepare("delete from spotify_calls where ts < ?").run(cutoff);
  db.prepare("delete from sessions where expires < ?").run(Date.now());
}

export function deleteUserData(userId: string, withAccount = true) {
  for (const t of ["plays", "snapshots", "feedback", "sessions"]) db.prepare(`delete from ${t} where user_id = ?`).run(userId);
  db.prepare("delete from events where user_id = ?").run(userId);
  if (withAccount) db.prepare("delete from users where id = ?").run(userId);
}
