import { uid } from "./context.js";
import { db } from "./db.js";

/*
 * Import from Spotify's privacy export (spotify.com/account/privacy). Two formats exist:
 *  - "Extended streaming history" (Streaming_History_Audio_*.json): { ts, ms_played, master_metadata_track_name, ... }
 *  - "Account data" (StreamingHistory_music_*.json): { endTime: "2024-01-31 18:04", artistName, trackName, msPlayed }
 * Both list one entry per play, timestamped when the play ended (UTC), the same as the live history.
 */

export interface ImportedPlay {
  playedAt: string;
  trackId: string;
  name: string;
  artist: string;
  album: string | null;
  duration: number;
}

// spotify counts a stream after 30 seconds, skips and podcasts are left out
const MIN_MS = 30_000;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function parseEntry(e: Record<string, unknown>): ImportedPlay | null {
  const extended = "ts" in e;
  const name = str(extended ? e.master_metadata_track_name : e.trackName);
  const artist = str(extended ? e.master_metadata_album_artist_name : e.artistName);
  const ms = Number(extended ? e.ms_played : e.msPlayed);
  // account data times are "YYYY-MM-DD HH:MM" in UTC without a zone
  const when = extended ? str(e.ts) : `${str(e.endTime).replace(" ", "T")}Z`;
  const t = Date.parse(when);
  if (!name || !artist || !Number.isFinite(ms) || ms < MIN_MS || !Number.isFinite(t)) return null;
  const uri = str(e.spotify_track_uri);
  return {
    playedAt: new Date(t).toISOString(),
    // the account data export has no track ids
    trackId: uri.startsWith("spotify:track:") ? uri.slice("spotify:track:".length) : `import:${name}|${artist}`.toLowerCase(),
    name: name.slice(0, 300),
    artist: artist.slice(0, 300),
    album: str(e.master_metadata_album_album_name).slice(0, 300) || null,
    duration: Math.round(ms),
  };
}

export const parseHistory = (entries: unknown[]) =>
  entries.flatMap((e) => (e && typeof e === "object" ? [parseEntry(e as Record<string, unknown>)] : [])).filter((p): p is ImportedPlay => p !== null);

// a play of the same song within a minute is the same play (the live history has ms precision, exports don't)
export function importPlays(plays: ImportedPlay[]): { added: number; skipped: number } {
  const ins = db.prepare(
    `insert or ignore into plays(user_id, played_at, track_id, name, artist_id, artist, album, image, duration)
     select ?, ?, ?, ?, (select id from artists where lower(name) = lower(?) limit 1), ?, ?, null, ?
     where not exists (select 1 from plays where user_id = ? and lower(name) = lower(?) and lower(artist) = lower(?) and played_at between ? and ?)`,
  );
  const id = uid();
  let added = 0;
  db.exec("begin");
  try {
    for (const p of plays) {
      const t = Date.parse(p.playedAt);
      const lo = new Date(t - 60_000).toISOString();
      const hi = new Date(t + 60_000).toISOString();
      added += Number(ins.run(id, p.playedAt, p.trackId, p.name, p.artist, p.artist, p.album, p.duration, id, p.name, p.artist, lo, hi).changes);
    }
    db.exec("commit");
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
  return { added, skipped: plays.length - added };
}
