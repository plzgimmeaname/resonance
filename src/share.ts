import crypto from "node:crypto";
import { uid } from "./context.js";
import { db } from "./db.js";
import { computeStats, exportTaste, type Taste } from "./engine.js";

/*
 * Public share links: a snapshot of your stats plus your taste code, frozen when you make the link,
 * so the page never shows live data. One link per user; making a new one replaces the old link.
 */

export interface ShareData {
  v: 1;
  name: string;
  image: string | null;
  persona: { name: string; blurb: string };
  diversity: number;
  genres: { name: string; pct: number }[];
  artists: { name: string; image: string | null }[];
  tracks: { name: string; artists: string[]; image: string | null }[];
  code: string;
  createdAt: number;
}

export function buildShare(t: Taste, me: { name: string; image: string | null }): ShareData {
  const s = computeStats(t, "medium");
  return {
    v: 1,
    name: me.name,
    image: me.image,
    persona: s.persona,
    diversity: s.diversity,
    genres: s.genres.slice(0, 8),
    artists: s.topArtists.slice(0, 8).map((a) => ({ name: a.name, image: a.image ?? null })),
    tracks: s.topTracks.slice(0, 5).map((x) => ({ name: x.name, artists: x.artists, image: x.image ?? null })),
    code: Buffer.from(JSON.stringify(exportTaste(t, me.name))).toString("base64"),
    createdAt: Date.now(),
  };
}

export function createShare(data: ShareData): string {
  const token = crypto.randomBytes(12).toString("base64url");
  db.prepare("insert into shares(token, user_id, data, created_at) values(?,?,?,?) on conflict(user_id) do update set token = excluded.token, data = excluded.data, created_at = excluded.created_at").run(
    token, uid(), JSON.stringify(data), data.createdAt,
  );
  return token;
}

export const myShare = () => (db.prepare("select token, created_at from shares where user_id = ?").get(uid()) as { token: string; created_at: number } | undefined) ?? null;
export const deleteShare = () => db.prepare("delete from shares where user_id = ?").run(uid());

// public: blocked or deleted users' links stop working
export function getShare(token: string): ShareData | null {
  if (!/^[\w-]{16}$/.test(token)) return null;
  const row = db.prepare("select s.data from shares s join users u on u.id = s.user_id where s.token = ? and u.blocked = 0").get(token) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as ShareData) : null;
}
