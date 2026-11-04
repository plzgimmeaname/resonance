import "./setup.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runAs } from "../src/context.js";
import { artistGenres, db } from "../src/db.js";
import { analyzePlaylist, analyzeTracks, applyClean, ensureGenres, planClean, suggest } from "../src/playlists.js";
import { hasPlaylistEdit, spotify } from "../src/spotify.js";
import type { PlaylistTrack } from "../src/types.js";
import { addUser, artist, spotifyTrack, stubFetch, taste } from "./fixtures.js";

addUser("pl1");
const as = <T>(fn: () => T) => runAs("pl1", fn);
let stub: ReturnType<typeof stubFetch> | null = null;
afterEach(() => stub?.restore());

// a playlist track by an artist whose id is the lowercase name
const pt = (name: string, artistName: string, position: number, uri = `spotify:track:${name}-${artistName}`.toLowerCase().replace(/\W/g, "")): PlaylistTrack => ({
  id: uri.slice(14), uri, name, artists: [artistName], artistIds: [artistName.toLowerCase()], album: "A", position,
});
const genresOf = (map: Record<string, string[]>) => (id: string) => map[id];

// ten rock songs by ten artists
const rock = (n = 10) => Array.from({ length: n }, (_, i) => pt(`Song ${i}`, `Rocker${i}`, i));
const rockGenres = (n = 10) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`rocker${i}`, ["rock", "indie"]]));

/* ------------------------------------------------------------ analysis */

test("a song whose genres nobody else in the playlist shares is an outlier, the rest fit", () => {
  const tracks = [...rock(), pt("Smooth", "Jazzer", 10)];
  const a = analyzeTracks(tracks, genresOf({ ...rockGenres(), jazzer: ["jazz"] }));
  assert.equal(a.profiled, true);
  assert.equal(a.outliers, 1);
  assert.deepEqual(a.tracks.filter((t) => t.flags.includes("outlier")).map((t) => t.name), ["Smooth"]);
  assert.equal(a.tracks[0].fit, 1);
  assert.equal(a.tracks[10].fit, 0.1, "1 of 11 songs has jazz, against 10 of 11 for rock");
  assert.deepEqual(a.genres.map((g) => g.name).slice(0, 2).sort(), ["indie", "rock"]);
  assert.equal(a.genres[0].pct, 91);
});

test("a mixed playlist has no identity, so nothing is called an outlier", () => {
  // ten songs, ten different genres: no genre covers 30% of them
  const tracks = Array.from({ length: 10 }, (_, i) => pt(`S${i}`, `A${i}`, i));
  const a = analyzeTracks(tracks, genresOf(Object.fromEntries(tracks.map((t, i) => [`a${i}`, [`genre${i}`]]))));
  assert.equal(a.profiled, false);
  assert.equal(a.outliers, 0);
});

test("too few songs with genres to judge: nothing is flagged", () => {
  const a = analyzeTracks([...rock(5), pt("Odd", "Jazzer", 5)], genresOf({ ...rockGenres(5), jazzer: ["jazz"] }));
  assert.equal(a.profiled, false);
  assert.equal(a.outliers, 0);
});

test("songs without genre info are counted but never flagged", () => {
  const a = analyzeTracks([...rock(), pt("Mystery", "Nobody", 10)], genresOf(rockGenres()));
  const mystery = a.tracks[10];
  assert.equal(a.unknownGenres, 1);
  assert.equal(mystery.fit, null);
  assert.deepEqual(mystery.flags, []);
});

test("every artist on a collaboration counts towards a song's genres", () => {
  const collab = { ...pt("Duet", "Rocker0", 10), artistIds: ["jazzer", "rocker0"], artists: ["Jazzer", "Rocker0"] };
  const a = analyzeTracks([...rock(), collab], genresOf({ ...rockGenres(), jazzer: ["jazz"] }));
  assert.deepEqual([...a.tracks[10].genres].sort(), ["indie", "jazz", "rock"]);
  assert.equal(a.tracks[10].flags.includes("outlier"), false);
});

test("the same track twice is an exact duplicate, another version of a song is a loose one", () => {
  const a = analyzeTracks(
    [pt("Intro", "Band", 0), pt("Other", "Band", 1), pt("Intro", "Band", 2) /* same uri */, pt("Intro", "Band", 3, "spotify:track:remastered"), pt("INTRO", "band", 4, "spotify:track:live")],
    genresOf({}),
  );
  const [first, , exact, remaster, live] = a.tracks;
  assert.deepEqual(first.flags, []);
  assert.deepEqual([exact.flags, exact.dupOf, exact.exact], [["duplicate"], 0, true]);
  assert.deepEqual([remaster.flags, remaster.dupOf, remaster.exact], [["duplicate"], 0, false]);
  assert.equal(live.exact, false);
  assert.equal(a.duplicates, 3);
});

test("a second copy of a re-release is an exact duplicate of the re-release", () => {
  const a = analyzeTracks([pt("Intro", "Band", 0), pt("Intro", "Band", 1, "spotify:track:re"), pt("Intro", "Band", 2, "spotify:track:re")], genresOf({}));
  assert.deepEqual([a.tracks[1].dupOf, a.tracks[1].exact], [0, false]);
  assert.deepEqual([a.tracks[2].dupOf, a.tracks[2].exact], [1, true], "points at the copy it really repeats");
});

test("positions decide which copy is first, whatever order the tracks arrive in", () => {
  const a = analyzeTracks([pt("Intro", "Band", 5), pt("Intro", "Band", 2)], genresOf({}));
  assert.deepEqual(a.tracks.map((t) => [t.position, t.flags.length]), [[2, 0], [5, 1]]);
});

/* ------------------------------------------------------------ planning */

// plays a plan against a list of entries (a uri, or null for a local file / episode) like spotify would
function simulate(entries: (string | null)[], plan: ReturnType<typeof planClean>) {
  const list = entries.filter((u) => u === null || !plan.deleteUris.includes(u));
  for (const r of plan.reinserts) list.splice(r.position, 0, r.uri);
  return list;
}
const toTracks = (entries: (string | null)[]) => entries.flatMap((uri, position) => (uri ? [pt(uri, "A", position, uri)] : []));

test("keeping one copy puts it back exactly where the first copy was", () => {
  const entries = ["a", "b", "a", "c", "b", "a"];
  const plan = planClean(toTracks(entries), [], ["a", "b"]);
  assert.deepEqual(simulate(entries, plan), ["a", "b", "c"]);
  assert.deepEqual(plan.reinserts, [{ uri: "a", position: 0 }, { uri: "b", position: 1 }]);
});

test("removed songs shift the positions of what is put back", () => {
  const entries = ["x", "a", "y", "a", "z"];
  assert.deepEqual(simulate(entries, planClean(toTracks(entries), ["x", "y"], ["a"])), ["a", "z"]);
});

test("local files and episodes keep their slots", () => {
  const entries = ["a", null, "b", null, "a", "b"];
  assert.deepEqual(simulate(entries, planClean(toTracks(entries), [], ["a", "b"])), ["a", null, "b", null]);
});

test("a song that appears once is left alone, and removing something absent does nothing", () => {
  const entries = ["a", "b", "c"];
  const plan = planClean(toTracks(entries), ["ghost"], ["a"]);
  assert.deepEqual(plan, { deleteUris: [], removed: [], reinserts: [] });
});

test("removing a song outright beats keeping one copy of it", () => {
  const entries = ["a", "b", "a"];
  const plan = planClean(toTracks(entries), ["a"], ["a"]);
  assert.deepEqual(simulate(entries, plan), ["b"]);
  assert.deepEqual(plan.reinserts, []);
});

test("random playlists always end up as intended", () => {
  // small deterministic generator so a failure can be replayed
  let seed = 42;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const alphabet = ["a", "b", "c", "d", "e", "f"];
  for (let run = 0; run < 300; run++) {
    const entries = Array.from({ length: 1 + Math.floor(rnd() * 14) }, () => (rnd() < 0.12 ? null : alphabet[Math.floor(rnd() * alphabet.length)]));
    const remove = alphabet.filter(() => rnd() < 0.25);
    const dedupe = alphabet.filter(() => rnd() < 0.5);

    const rm = new Set(remove);
    const mergeable = new Set(dedupe.filter((u) => !rm.has(u) && entries.filter((e) => e === u).length > 1));
    const seen = new Set<string>();
    const expected = entries.filter((u) => {
      if (u === null) return true;
      if (rm.has(u)) return false;
      if (mergeable.has(u)) {
        if (seen.has(u)) return false;
        seen.add(u);
      }
      return true;
    });
    assert.deepEqual(simulate(entries, planClean(toTracks(entries), remove, dedupe)), expected, JSON.stringify({ entries, remove, dedupe }));
  }
});

/* ------------------------------------------------------ spotify calls */

const entry = (i: number, over: Record<string, unknown> = {}) => ({ added_at: "2024-01-01", is_local: false, item: { type: "track", id: `id${i}`, uri: `spotify:track:id${i}`, name: `Song ${i}`, artists: [{ id: `ar${i}`, name: `Artist ${i}` }], album: { name: "Album", images: [] } }, ...over });

test("a playlist is read page by page, skipping local files and episodes but keeping positions true", async () => {
  stub = stubFetch((url) => {
    const offset = Number(url.searchParams.get("offset"));
    const items = Array.from({ length: 50 }, (_, i) => {
      const n = offset + i;
      if (n === 3) return entry(n, { is_local: true });
      if (n === 4) return entry(n, { item: { type: "episode", id: "ep", name: "Pod" } });
      if (n === 5) return null; // deleted track
      if (n === 6) return { track: entry(n).item }; // the deprecated name for `item`
      return entry(n);
    });
    return { items, total: 120, next: offset + 50 < 120 ? "more" : null };
  });
  const r = await as(() => spotify.playlistItems("pl", 100));
  assert.equal(stub.calls.length, 2, "stops at the cap");
  assert.deepEqual(stub.calls.map((u) => u.searchParams.get("offset")), ["0", "50"]);
  assert.equal(stub.calls[0].searchParams.get("limit"), "50");
  assert.equal(r.truncated, true);
  assert.equal(r.total, 120);
  assert.equal(r.tracks.length, 100 - 3, "three entries were skipped: a local file, an episode and a deleted track");
  const positions = r.tracks.map((t) => t.position);
  assert.deepEqual(positions.slice(0, 5), [0, 1, 2, 6, 7], "slots 3, 4 and 5 are taken by things we skipped");
  assert.equal(r.tracks.find((t) => t.position === 6)!.name, "Song 6");
});

test("a short playlist is read in one call and isn't truncated", async () => {
  stub = stubFetch(() => ({ items: [entry(0), entry(1)], total: 2, next: null }));
  const r = await as(() => spotify.playlistItems("pl"));
  assert.deepEqual([stub.calls.length, r.tracks.length, r.truncated], [1, 2, false]);
});

test("the library lists every playlist with who owns it", async () => {
  stub = stubFetch((url) => {
    const first = url.searchParams.get("offset") === "0";
    return {
      items: first
        ? [{ id: "mine", name: "Mine", owner: { id: "pl1" }, tracks: { total: 3 }, public: false, images: [] }, null]
        : [{ id: "theirs", name: "Theirs", owner: { id: "other" }, collaborative: false, items: { total: 9 } }, { id: "collab", name: "Collab", owner: { id: "other" }, collaborative: true }],
      next: first ? "more" : null,
    };
  });
  const all = await as(() => spotify.allPlaylists());
  assert.deepEqual(all.map((p) => [p.id, p.owned, p.collaborative, p.tracks]), [["mine", true, false, 3], ["theirs", false, false, 9], ["collab", false, true, 0]]);
});

test("removing sends the uris to the items endpoint in batches of 100", async () => {
  const sent: { method?: string; n: number }[] = [];
  stub = stubFetch((_url, init) => {
    sent.push({ method: init?.method, n: JSON.parse(String(init?.body)).items.length });
    return { snapshot_id: "s" };
  });
  const uris = Array.from({ length: 230 }, (_, i) => `spotify:track:u${i}`);
  await as(() => spotify.removeFromPlaylist("plX", uris));
  assert.deepEqual(sent, [{ method: "DELETE", n: 100 }, { method: "DELETE", n: 100 }, { method: "DELETE", n: 30 }]);
  assert.ok(stub.calls.every((u) => u.pathname === "/v1/playlists/plX/items"));
});

test("adding can insert at a position", async () => {
  const bodies: unknown[] = [];
  stub = stubFetch((_url, init) => {
    bodies.push({ method: init?.method, body: JSON.parse(String(init?.body)) });
    return { snapshot_id: "s" };
  });
  await as(() => spotify.addTracksToPlaylist("plX", ["spotify:track:a"], 4));
  await as(() => spotify.addTracksToPlaylist("plX", ["spotify:track:b"]));
  assert.deepEqual(bodies, [
    { method: "POST", body: { uris: ["spotify:track:a"], position: 4 } },
    { method: "POST", body: { uris: ["spotify:track:b"] } },
  ]);
});

test("changing playlists needs both modify scopes", () => {
  const set = (scope: string) => db.prepare("update users set scope = ? where id = 'pl1'").run(scope);
  set("user-top-read playlist-read-private playlist-modify-private");
  assert.equal(as(() => hasPlaylistEdit()), false, "signed in before the public scope existed");
  set("playlist-modify-private playlist-modify-public");
  assert.equal(as(() => hasPlaylistEdit()), true);
  set("user-top-read playlist-read-private");
});

/* ------------------------------------------------------------- applying */

test("applying a clean-up removes first, then puts one copy back in place", async () => {
  const log: { method?: string; body: any; path: string }[] = [];
  stub = stubFetch((url, init) => {
    log.push({ method: init?.method, path: url.pathname, body: JSON.parse(String(init?.body)) });
    return { snapshot_id: "s" };
  });
  const tracks = toTracks(["spotify:track:aaa", "spotify:track:bbb", "spotify:track:aaa", "spotify:track:ccc"]);
  const r = await as(() => applyClean("plX", tracks, ["spotify:track:ccc"], ["spotify:track:aaa"]));
  assert.deepEqual(log.map((l) => l.method), ["DELETE", "POST"]);
  assert.deepEqual(log[0].body.items.map((i: { uri: string }) => i.uri).sort(), ["spotify:track:aaa", "spotify:track:ccc"]);
  assert.deepEqual(log[1].body, { uris: ["spotify:track:aaa"], position: 0 });
  assert.deepEqual([r.removed, r.merged, r.failed], [["spotify:track:ccc"], 1, []]);
});

test("a copy that can't be put back in place is appended instead, and reported only if that fails too", async () => {
  let posts = 0;
  stub = stubFetch((_url, init) => {
    if (init?.method !== "POST") return { snapshot_id: "s" };
    posts++;
    const body = JSON.parse(String(init.body));
    // the first uri fails with a position and succeeds without; the second never succeeds
    if (body.uris[0].endsWith("aaa") && body.position !== undefined) return new Response("no", { status: 400 });
    if (body.uris[0].endsWith("bbb")) return new Response("no", { status: 500 });
    return { snapshot_id: "s" };
  });
  const tracks = toTracks(["spotify:track:aaa", "spotify:track:bbb", "spotify:track:aaa", "spotify:track:bbb"]);
  const r = await as(() => applyClean("plX", tracks, [], ["spotify:track:aaa", "spotify:track:bbb"]));
  assert.equal(posts, 4, "aaa twice, bbb twice");
  assert.deepEqual([r.merged, r.failed], [1, ["spotify:track:bbb"]]);
});

test("nothing to do means no spotify calls", async () => {
  stub = stubFetch(() => ({}));
  const r = await as(() => applyClean("plX", toTracks(["spotify:track:aaa"]), [], ["spotify:track:aaa"]));
  assert.deepEqual(r, { removed: [], merged: 0, failed: [] });
  assert.equal(stub.calls.length, 0);
});

/* -------------------------------------------------- genres and suggestions */

test("genres are learned for unknown artists, most common first, up to the limit", async () => {
  db.prepare("insert into artists(id, name, genres) values('known1', 'Known', '[\"rock\"]')").run();
  const tracks = [pt("a", "Known", 0), pt("b", "Often", 1), pt("c", "Often", 2), pt("d", "Rare", 3), pt("e", "Rarer", 4)].map((t) => (t.artists[0] === "Known" ? { ...t, artistIds: ["known1"] } : t));
  stub = stubFetch((url) => {
    const id = url.pathname.split("/").pop()!;
    return { id, name: id, genres: [`g-${id}`], images: [] };
  });
  const left = await as(() => ensureGenres(tracks, 2));
  const fetched = stub.calls.map((u) => u.pathname.split("/").pop()).sort();
  assert.deepEqual(fetched.includes("often"), true, "the artist with two songs comes first");
  assert.equal(fetched.length, 2);
  assert.equal(left, 1, "one unknown artist is left for next time");
  assert.deepEqual(artistGenres().get("often"), ["g-often"]);
});

test("suggestions fit the playlist's genres and skip what it has, disliked artists, and a third song by one artist", async () => {
  const existing = rock();
  const a = analyzeTracks(existing, genresOf(rockGenres()));
  const t = taste({ all: [artist("Fan Favourite", ["rock"])] });
  t.dislikedArtists.add("hated");
  stub = stubFetch((url) => {
    const q = url.searchParams.get("q") ?? "";
    assert.match(q, /^genre:"(rock|indie)"$/);
    return { tracks: { items: [
      spotifyTrack("Song 1", "Rocker1"), // already in the playlist
      spotifyTrack("Nope", "Hated"),
      spotifyTrack("New A", "Fresh"), spotifyTrack("New B", "Fresh"), spotifyTrack("New C", "Fresh"),
      spotifyTrack("Loved", "Fan Favourite"),
    ] } };
  });
  const recs = await as(() => suggest(t, a, existing));
  const names = recs.map((r) => r.track.name);
  assert.ok(!names.includes("Song 1") && !names.includes("Nope"));
  assert.equal(names.filter((n) => n.startsWith("New")).length, 2);
  assert.ok(names.includes("Loved"), "a favourite is a fine addition");
  assert.ok(recs.every((r) => /^Fits the (rock|indie) in this playlist$/.test(r.reason)));
  assert.equal(new Set(names).size, names.length);
});

test("when the playlist has no identity, suggestions come from the listener's taste", async () => {
  const a = analyzeTracks([pt("x", "Solo", 0)], genresOf({}));
  stub = stubFetch(() => ({ tracks: { items: [spotifyTrack("Pick", "Someone")] } }));
  const recs = await as(() => suggest(taste({ all: [artist("Fav", ["shoegaze"])] }), a, []));
  assert.equal(recs[0].reason, "Fits your taste: shoegaze");
  assert.ok(stub.calls[0].searchParams.get("q")!.includes("shoegaze"));
});

test("analysing a playlist ties it together: tracks, genres learned along the way, flags and suggestions", async () => {
  addUser("pl2");
  const items = [...Array.from({ length: 9 }, (_, i) => entry(i)), entry(0) /* the same track again */, entry(20)];
  stub = stubFetch((url) => {
    const p = url.pathname;
    if (p.endsWith("/items")) return { items, total: items.length, next: null };
    if (p.includes("/artists/")) {
      const id = p.split("/").pop()!;
      return { id, name: id, genres: id === "ar20" ? ["opera"] : ["rock"], images: [] };
    }
    if (p.endsWith("/search")) return { tracks: { items: [spotifyTrack("Suggested", "Fresh")] } };
    return {};
  });
  const info = { id: "plY", name: "Mix", tracks: items.length, owned: true, collaborative: false, public: false };
  const out = await runAs("pl2", () => analyzePlaylist(info, taste({ all: [artist("Fan", ["rock"])] })));
  assert.equal(out.total, items.length);
  assert.equal(out.canMerge, true);
  assert.equal(out.duplicates, 1);
  assert.equal(out.outliers, 1);
  assert.equal(out.unknownArtists, 0);
  assert.deepEqual(out.tracks.filter((t) => t.flags.includes("outlier")).map((t) => t.name), ["Song 20"]);
  assert.equal(out.genres[0].name, "rock");
  assert.equal(out.suggestions[0].track.name, "Suggested");
});
