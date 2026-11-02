import "./setup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runAs } from "../src/context.js";
import { db } from "../src/db.js";
import { buildShare, createShare, deleteShare, getShare, myShare } from "../src/share.js";
import { addUser, artist, taste, track } from "./fixtures.js";

const t = taste({ all: [artist("A", ["jazz"]), artist("B", ["soul"])], tracks: [track("Song", "A")] });

test("a share snapshot has the stats and a taste code that decodes", () => {
  addUser("s1", "Sam");
  const data = runAs("s1", () => buildShare(t, { name: "Sam", image: null }));
  assert.equal(data.name, "Sam");
  assert.deepEqual(data.artists.map((a) => a.name), ["A", "B"]);
  assert.deepEqual(data.tracks.map((x) => x.name), ["Song"]);
  const code = JSON.parse(Buffer.from(data.code, "base64").toString("utf8"));
  assert.equal(code.v, 1);
  assert.equal(code.name, "Sam");
});

test("one link per user: a new link replaces the old, turning it off removes it", () => {
  addUser("s2", "Kai");
  runAs("s2", () => {
    const data = buildShare(t, { name: "Kai", image: null });
    const first = createShare(data);
    assert.equal(getShare(first)?.name, "Kai");
    const second = createShare(data);
    assert.notEqual(first, second);
    assert.equal(getShare(first), null);
    assert.equal(myShare()?.token, second);
    deleteShare();
    assert.equal(getShare(second), null);
    assert.equal(myShare(), null);
  });
});

test("blocked users' links stop working and malformed tokens are refused", () => {
  addUser("s3", "Lee");
  const token = runAs("s3", () => createShare(buildShare(t, { name: "Lee", image: null })));
  db.prepare("update users set blocked = 1 where id = 's3'").run();
  assert.equal(getShare(token), null);
  assert.equal(getShare("' or 1=1 --"), null);
});
