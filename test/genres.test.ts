import "./setup.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { artistGenres, db, upsertArtist } from "../src/db.js";
import { cachedGenres, cleanTags, fillGenres, lookupGenres } from "../src/genres.js";
import { saveSettings } from "../src/settings.js";
import { stubFetch } from "./fixtures.js";

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
