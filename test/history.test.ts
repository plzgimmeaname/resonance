import "./setup.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { db } from "../src/db.js";
import { snapshotDue } from "../src/engine.js";
import { runAs } from "../src/context.js";
import { syncAll, syncUser } from "../src/history.js";
import { addUser, stubFetch } from "./fixtures.js";

let stub: ReturnType<typeof stubFetch> | null = null;
afterEach(() => stub?.restore());

const spotifyStub = () =>
  stubFetch((url) => {
    if (url.pathname.endsWith("/me/top/artists")) return { items: [{ id: "a1", name: "Band", genres: ["rock"], images: [] }] };
    if (url.pathname.endsWith("/me/top/tracks")) return { items: [] };
    if (url.pathname.endsWith("/recently-played")) return { items: [] };
    if (url.pathname.endsWith("/albums")) return { items: [] };
    return {};
  });
const count = (part: string) => stub!.calls.filter((u) => u.pathname.includes(part)).length;

test("the taste is only rebuilt when a snapshot or release check is due", async () => {
  addUser("h1");
  stub = spotifyStub();
  assert.equal(runAs("h1", () => snapshotDue()), true);

  await syncUser("h1");
  assert.equal(count("/me/top/artists"), 3, "first run builds it: one call per time range");
  assert.equal(count("/recently-played") >= 1, true);
  assert.equal(runAs("h1", () => snapshotDue()), false, "today's snapshot is saved");

  const before = stub.calls.length;
  await syncUser("h1");
  assert.equal(count("/me/top/artists"), 3, "second run only fetches recent plays");
  assert.equal(stub.calls.length - before, 1);
});

test("overlapping sync runs share one pass", async () => {
  db.prepare("update users set connected = 0").run();
  addUser("h2");
  stub = spotifyStub();
  const [a, b] = await Promise.all([syncAll(), syncAll()]);
  assert.equal(a, b);
  assert.equal(count("/me/top/artists"), 3, "one pass builds the taste once (a call per time range), not twice");
});
