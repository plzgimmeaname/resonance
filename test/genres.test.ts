import "./setup.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { artistGenres, db, upsertArtist } from "../src/db.js";
import { runAs } from "../src/context.js";
import { cachedGenres, cleanTags, fillGenres, genreTracks, lookupGenres } from "../src/genres.js";
import { saveSettings } from "../src/settings.js";
import { addUser, spotifyTrack, stubFetch } from "./fixtures.js";

addUser("g1");
const as = <T>(fn: () => T) => runAs("g1", fn);

let stub: ReturnType<typeof stubFetch> | null = null;
afterEach(() => {
  stub?.restore();
  stub = null;
  saveSettings({ lastfm: "" });
});

test("tags are cleaned into genres: lower case, one spelling, no junk, popular first, five at most", () => {
  const tags = [
    { name: "seen live", count: 100 }, { name: "Hip-Hop", count: 90 }, { name: "rnb", count: 80 }, { name: "Drake", count: 70 },
    { name: "2010s", count: 60 }, { name: "trap", count: 50 }, { name: "hip hop", count: 40 }, { name: "canadian", count: 35 },
    { name: "pop rap", count: 30 }, { name: "rap", count: 20 }, { name: "dancehall", count: 15 }, { name: "noise", count: 5 },
  ];
  assert.deepEqual(cleanTags(tags, "Drake", 10), ["hip hop", "r&b", "trap", "pop rap", "rap"]);
  assert.deepEqual(cleanTags([{ name: "noise", count: 5 }], "", 10), []);
});

test("last.fm is asked first when there's a key, musicbrainz only when last.fm has nothing", async () => {
  saveSettings({ lastfm: "key" });
  stub = stubFetch((url) => {
    if (url.hostname === "ws.audioscrobbler.com") {
      const a = url.searchParams.get("artist");
      return { toptags: { tag: a === "Known" ? [{ name: "Shoegaze", count: 100 }, { name: "dream pop", count: 60 }] : [] } };
    }
    if (url.hostname === "musicbrainz.org") return { artists: [{ name: "Obscure", score: 100, tags: [{ name: "post-punk", count: 3 }, { name: "darkwave", count: 1 }] }] };
    return {};
  });
  assert.deepEqual(await lookupGenres("Known"), ["shoegaze", "dream pop"]);
  assert.equal(stub.calls.filter((u) => u.hostname === "musicbrainz.org").length, 0);
  assert.deepEqual(await lookupGenres("Obscure"), ["post punk", "darkwave"]);
  assert.equal(stub.calls.filter((u) => u.hostname === "musicbrainz.org").length, 1);
});

test("without a last.fm key it goes straight to musicbrainz, and only trusts an exact name match", async () => {
  stub = stubFetch((url) => {
    if (url.hostname === "ws.audioscrobbler.com") throw new Error("shouldn't be called without a key");
    const q = url.searchParams.get("query") ?? "";
    if (q.includes("Fuzzy")) return { artists: [{ name: "Fuzzy Band Tribute", score: 95, tags: [{ name: "rock", count: 9 }] }] };
    return { artists: [{ name: "Exact", score: 100, tags: [{ name: "Indie Folk", count: 4 }] }] };
  });
  assert.deepEqual(await lookupGenres("Exact"), ["indie folk"]);
  assert.deepEqual(await lookupGenres("Fuzzy"), []);
  assert.ok(stub.calls.every((u) => u.hostname === "musicbrainz.org"));
});

test("each artist is looked up once, and an empty answer is remembered for a while", async () => {
  stub = stubFetch(() => ({ artists: [{ name: "Once", score: 100, tags: [{ name: "jazz", count: 2 }] }] }));
  await Promise.all([lookupGenres("Once"), lookupGenres("once"), lookupGenres("Once")]);
  assert.equal(stub.calls.length, 1, "concurrent lookups share one request");
  assert.deepEqual(await lookupGenres("ONCE"), ["jazz"]);
  assert.equal(stub.calls.length, 1, "later ones come from the cache");

  stub.restore();
  stub = stubFetch(() => ({ artists: [] }));
  assert.deepEqual(await lookupGenres("Nobody Knows"), []);
  assert.deepEqual(cachedGenres("Nobody Knows"), [], "a fresh empty answer counts as known");
  db.prepare("update genre_cache set checked_at = ? where name = ?").run(Date.now() - 31 * 864e5, "nobody knows");
  assert.equal(cachedGenres("Nobody Knows"), undefined, "after 30 days it's tried again");
});

test("a network error isn't cached", async () => {
  stub = stubFetch(() => { throw new Error("offline"); });
  assert.deepEqual(await lookupGenres("Flaky"), []);
  assert.equal(cachedGenres("Flaky"), undefined);
});

test("fillGenres only touches artists without genres and stops waiting at the budget", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  stub = stubFetch(async (url) => {
    if ((url.searchParams.get("query") ?? "").includes("Slow")) await gate;
    return { artists: [{ name: (url.searchParams.get("query") ?? "").replace(/artist:"|"/g, ""), score: 100, tags: [{ name: "soul", count: 1 }] }] };
  });
  const list = [{ name: "Has", genres: ["rock"] }, { name: "Fast", genres: [] as string[] }, { name: "Slow", genres: [] as string[] }];
  const t0 = Date.now();
  await fillGenres(list, 2500);
  assert.ok(Date.now() - t0 < 4000);
  assert.deepEqual(list.map((a) => a.genres), [["rock"], ["soul"], []]);
  release();
  await new Promise((r) => setTimeout(r, 1300));
  assert.deepEqual(cachedGenres("Slow"), ["soul"], "the slow one still lands in the cache");
});

test("an empty genre list never wipes genres an artist already has", () => {
  upsertArtist({ id: "keep1", name: "Keep", genres: ["folk"] });
  upsertArtist({ id: "keep1", name: "Keep", genres: [] });
  assert.deepEqual(artistGenres().get("keep1"), ["folk"]);
  upsertArtist({ id: "keep1", name: "Keep", genres: ["folk rock"] });
  assert.deepEqual(artistGenres().get("keep1"), ["folk rock"]);
});

test("genre songs come from last.fm's top tracks for the tag: one per artist, avoided artists skipped, lookups cached", async () => {
  saveSettings({ lastfm: "key" });
  const top = [
    { name: "Alpha", artist: { name: "Band A" } }, { name: "Alpha 2", artist: { name: "Band A" } },
    { name: "Beta", artist: { name: "Band B" } }, { name: "Gamma", artist: { name: "Known" } }, { name: "Delta", artist: { name: "Band D" } },
  ];
  stub = stubFetch((url) => {
    if (url.hostname === "ws.audioscrobbler.com") return { tracks: { track: url.searchParams.get("tag") === "dreamgaze" ? top : [] } };
    const q = url.searchParams.get("q") ?? "";
    assert.ok(!q.startsWith("genre:"), "spotify's genre search isn't used when last.fm has songs");
    const m = q.match(/^track:"(.+)" artist:"(.+)"$/)!;
    // spotify's best match for Delta is a cover by someone else
    return { tracks: { items: [spotifyTrack(m[1], m[2] === "Band D" ? "Cover Band" : m[2])] } };
  });
  const got = await as(() => genreTracks("Dreamgaze", 10, (a) => a === "known"));
  const names = got.map((x) => x.artists[0]).sort();
  assert.deepEqual(names, ["Band A", "Band B"], "one song per artist, the avoided one and the cover left out");
  const spotifyCalls = stub.calls.filter((u) => u.hostname !== "ws.audioscrobbler.com").length;
  assert.equal(spotifyCalls, 3);

  await as(() => genreTracks("dreamgaze", 10, (a) => a === "known"));
  assert.equal(stub.calls.filter((u) => u.hostname === "ws.audioscrobbler.com").length, 1, "the tag's list is cached");
  assert.ok(stub.calls.filter((u) => u.hostname !== "ws.audioscrobbler.com").length <= spotifyCalls + 1, "looked-up songs are cached");
});

test("without last.fm songs, genre picks fall back to spotify's search", async () => {
  stub = stubFetch((url) => {
    assert.notEqual(url.hostname, "ws.audioscrobbler.com");
    return { tracks: { items: [spotifyTrack("Fallback", "Someone")] } };
  });
  const got = await as(() => genreTracks("nowhere", 5));
  assert.deepEqual(got.map((x) => x.name), ["Fallback"]);
  assert.match(stub.calls[0].searchParams.get("q")!, /^genre:"nowhere"$/);
});

test("a genre pick looks up at most three new songs on spotify per call, cached ones are free", async () => {
  saveSettings({ lastfm: "key" });
  const top = Array.from({ length: 12 }, (_, i) => ({ name: `Song ${i}`, artist: { name: `Artist ${i}` } }));
  stub = stubFetch((url) => {
    if (url.hostname === "ws.audioscrobbler.com") return { tracks: { track: top } };
    const m = (url.searchParams.get("q") ?? "").match(/^track:"(.+)" artist:"(.+)"$/)!;
    return { tracks: { items: [spotifyTrack(m[1], m[2])] } };
  });
  const lookups = () => stub!.calls.filter((u) => u.hostname !== "ws.audioscrobbler.com").length;
  assert.equal((await as(() => genreTracks("capped", 8))).length, 3);
  assert.equal(lookups(), 3);
  assert.equal((await as(() => genreTracks("capped", 8))).length, 6, "three from the cache plus three new");
  assert.equal(lookups(), 6);
});
