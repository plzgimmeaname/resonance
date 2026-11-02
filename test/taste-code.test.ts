import "./setup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { exportTaste, parseTasteCode } from "../src/engine.js";
import { artist, taste } from "./fixtures.js";

const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");

test("a code we exported reads back the same", () => {
  const code = exportTaste(taste({ all: [artist("Band", ["rock", "indie"]), artist("Duo", ["pop"])] }), "Ana");
  assert.deepEqual(parseTasteCode(Buffer.from(JSON.stringify(code)).toString("base64")), code);
});

test("surrounding whitespace is fine", () => {
  const ok = encode({ v: 1, name: "Sam", genres: [["jazz", 1]], artists: ["Miles"] });
  assert.equal(parseTasteCode(`\n  ${ok}  \n`).name, "Sam");
});

test("garbage is refused with one friendly message", () => {
  const msg = /valid taste code/;
  for (const raw of [undefined, null, "", "not base64 json!", encode("a string"), encode(null), encode([]), encode({ v: 2, genres: [], artists: [] }), encode({ v: 1 }), encode({ v: 1, genres: [], artists: [] })]) {
    assert.throws(() => parseTasteCode(raw), msg, String(raw));
  }
});

test("malformed entries are dropped, the rest kept", () => {
  const c = parseTasteCode(encode({ v: 1, name: "X", genres: [["rock", 2], ["bad"], ["neg", -1], [1, 2], ["nan", "3"], null, ["pop", 0.5]], artists: ["A", 5, null, "B"] }));
  assert.deepEqual(c.genres, [["rock", 2], ["pop", 0.5]]);
  assert.deepEqual(c.artists, ["A", "B"]);
});

test("sizes are capped so a huge code can't bloat anything", () => {
  const genres = Array.from({ length: 500 }, (_, i) => [`g${i}`, 1]);
  const artists = Array.from({ length: 500 }, (_, i) => `a${i}`);
  const c = parseTasteCode(encode({ v: 1, name: "n".repeat(500), genres: [["x".repeat(500), 1], ...genres], artists: ["y".repeat(500), ...artists] }));
  assert.equal(c.genres.length, 60);
  assert.equal(c.artists.length, 120);
  assert.equal(c.name.length, 60);
  assert.equal(c.genres[0][0].length, 60);
  assert.equal(c.artists[0].length, 100);
});

test("a missing or non-text name becomes a default", () => {
  assert.equal(parseTasteCode(encode({ v: 1, genres: [["a", 1]], artists: [] })).name, "A friend");
  assert.equal(parseTasteCode(encode({ v: 1, name: { x: 1 }, genres: [["a", 1]], artists: [] })).name.length > 0, true);
});
