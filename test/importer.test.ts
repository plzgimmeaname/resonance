import "./setup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runAs } from "../src/context.js";
import { db, upsertArtist } from "../src/db.js";
import { importPlays, parseEntry, parseHistory } from "../src/importer.js";
import { addUser } from "./fixtures.js";

const extended = (over: Record<string, unknown> = {}) => ({
  ts: "2024-03-01T18:04:05Z", ms_played: 200_000, master_metadata_track_name: "Song", master_metadata_album_artist_name: "Artist",
  master_metadata_album_album_name: "Album", spotify_track_uri: "spotify:track:abc123", ...over,
});
const basic = (over: Record<string, unknown> = {}) => ({ endTime: "2024-03-01 18:04", artistName: "Artist", trackName: "Song", msPlayed: 200_000, ...over });

test("reads the extended streaming history format", () => {
  assert.deepEqual(parseEntry(extended()), {
    playedAt: "2024-03-01T18:04:05.000Z", trackId: "abc123", name: "Song", artist: "Artist", album: "Album", duration: 200_000,
  });
});

test("reads the account data format, whose times are UTC without a zone", () => {
  assert.deepEqual(parseEntry(basic()), {
    playedAt: "2024-03-01T18:04:00.000Z", trackId: "import:song|artist", name: "Song", artist: "Artist", album: null, duration: 200_000,
  });
});

test("skips short plays, podcasts and junk", () => {
  assert.equal(parseEntry(extended({ ms_played: 12_000 })), null);
  assert.equal(parseEntry(extended({ master_metadata_track_name: null, episode_name: "A podcast" })), null);
  assert.equal(parseEntry(basic({ endTime: "not a date" })), null);
  assert.deepEqual(parseHistory([null, 42, "x", extended(), basic({ msPlayed: 1 })]).map((p) => p.trackId), ["abc123"]);
});

test("importing twice adds nothing new, and plays already recorded live are skipped", () => {
  addUser("imp");
  upsertArtist({ id: "artist-id", name: "Artist", genres: ["pop"] });
  runAs("imp", () => {
    // the live history has the same play with millisecond precision
    db.prepare("insert into plays(user_id, played_at, track_id, name, artist) values('imp', '2024-03-01T18:04:05.123Z', 'abc123', 'Song', 'Artist')").run();
    const plays = parseHistory([extended(), extended({ ts: "2024-03-02T10:00:00Z" }), basic({ endTime: "2024-03-03 09:30", trackName: "Other" })]);
    assert.deepEqual(importPlays(plays), { added: 2, skipped: 1 });
    assert.deepEqual(importPlays(plays), { added: 0, skipped: 3 });
  });
  const rows = db.prepare("select name, artist_id from plays where user_id = 'imp' order by played_at").all() as { name: string; artist_id: string | null }[];
  assert.equal(rows.length, 3);
  // artist ids come from artists we already know, so genre stats work for imported plays
  assert.deepEqual(rows.map((r) => r.artist_id), [null, "artist-id", "artist-id"]);
});
