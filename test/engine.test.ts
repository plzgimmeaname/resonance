import "./setup.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runAs } from "../src/context.js";
import { addFeedback } from "../src/db.js";
import { buildTaste, compare, computeStats, exportTaste, recommend } from "../src/engine.js";
import { addUser, artist, spotifyTrack, stubFetch, taste, track } from "./fixtures.js";

addUser("u1");
const as = <T>(fn: () => T) => runAs("u1", fn);
let stub: ReturnType<typeof stubFetch> | null = null;
afterEach(() => stub?.restore());

test("one genre has zero diversity, evenly spread genres have full diversity", () => {
  const narrow = as(() => computeStats(taste({ all: [artist("A", ["jazz"]), artist("B", ["jazz"])] }), "medium"));
  assert.equal(narrow.diversity, 0);
  assert.deepEqual(narrow.genres.map((g) => g.name), ["jazz"]);
  assert.equal(narrow.genres[0].pct, 100);

  const wide = as(() => computeStats(taste({ all: [artist("A", ["jazz", "rock", "pop", "folk"])] }), "medium"));
  assert.equal(wide.diversity, 100);
});

test("persona follows how the recent plays are spread", () => {
  const fav = artist("Fav", ["indie"]);
  const loyal = as(() => computeStats(taste({ all: [fav], recent: Array.from({ length: 10 }, (_, i) => track(`s${i}`, "Fav")) }), "medium"));
  assert.equal(loyal.persona.name, "The Loyalist");
  assert.equal(loyal.loyalty, 100);
  assert.equal(loyal.topRecentArtist, "Fav");

  // every recent play is by an artist outside the long-term favourites
  const others = Array.from({ length: 10 }, (_, i) => track(`s${i}`, `New ${i}`));
  const explorer = as(() => computeStats(taste({ all: [fav], recent: others }), "medium"));
  assert.equal(explorer.fresh, 100);
  assert.equal(explorer.persona.name, "The Explorer");
});

test("genres you play more lately are rising, ones you've left are fading", () => {
  const s = as(() => computeStats(taste({ short: [artist("A", ["hyperpop"])], medium: [], long: [artist("B", ["metal"])] }), "medium"));
  assert.deepEqual(s.rising.map((g) => g.name), ["hyperpop"]);
  assert.deepEqual(s.fading.map((g) => g.name), ["metal"]);
});

test("taste codes list each artist once and compare by genre and shared artists", () => {
  const mine = taste({ all: [artist("A", ["jazz", "soul"]), artist("B", ["soul"])] });
  const code = exportTaste(mine, "Me");
  assert.deepEqual(code.artists, ["A", "B"]);
  assert.ok(code.genres.reduce((s, [, w]) => s + w, 0) <= 1.0001);

  // identical genres give 75, each shared artist adds a sixth of the other 25 (2 of 6 here)
  const same = compare(mine, { ...code, name: "Twin" });
  assert.equal(same.score, 83);
  assert.deepEqual(same.sharedArtists, ["A", "B"]);
  assert.equal(same.theirName, "Twin");

  const other = compare(mine, { v: 1, name: "Other", genres: [["metal", 1]], artists: ["Z"] });
  assert.equal(other.score, 0);
  assert.deepEqual(other.sharedGenres, []);
});

test("votes nudge genres and hide disliked artists", async () => {
  stub = stubFetch((url) => {
    if (url.pathname.endsWith("/me/top/artists")) return { items: [{ id: "a", name: "A", genres: ["jazz"], images: [] }, { id: "b", name: "B", genres: ["rock"], images: [] }] };
    return { items: [] };
  });
  as(() => {
    addFeedback("genre", "rock", 3);
    addFeedback("artist", "Nope", -1);
  });
  const t = await as(buildTaste);
  assert.ok(t.genreWeights.get("rock")! > t.genreWeights.get("jazz")!, "rock was voted up past jazz");
  assert.ok(t.dislikedArtists.has("nope"));
});

test("recommendations skip known songs and disliked artists, and cap each artist at two", async () => {
  const t = taste({ all: [artist("Fav", ["shoegaze"])], tracks: [track("Old Hit", "Somebody")] });
  t.dislikedArtists.add("hated");
  stub = stubFetch((url) => {
    const q = url.searchParams.get("q") ?? "";
    if (q.startsWith("genre:")) {
      return { tracks: { items: [
        spotifyTrack("Old Hit", "Somebody"), // already known
        spotifyTrack("Fav Song", "Fav"), // known artist from a genre search
        spotifyTrack("Bad", "Hated"),
        spotifyTrack("One", "Newcomer"), spotifyTrack("Two", "Newcomer"), spotifyTrack("Three", "Newcomer"),
      ] } };
    }
    if (q.startsWith('artist:"Fav"')) return { tracks: { items: [spotifyTrack("Deep Cut", "Fav"), spotifyTrack("Cover", "Not Fav")] } };
    return { tracks: { items: [] } };
  });
  const recs = await as(() => recommend(t, "similar"));
  const names = recs.map((r) => r.track.name).sort();
  assert.deepEqual(names.filter((n) => ["One", "Two", "Three"].includes(n)).length, 2);
  assert.ok(names.includes("Deep Cut"), "more from a favourite is allowed");
  for (const n of ["Old Hit", "Fav Song", "Bad", "Cover"]) assert.ok(!names.includes(n), `${n} is filtered`);
});
