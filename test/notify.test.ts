import "./setup.js";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { runAs } from "../src/context.js";
import { checkReleases, isFresh, listNotifications, markSeen } from "../src/notify.js";
import type { Release } from "../src/types.js";
import { addUser, artist, stubFetch, taste } from "./fixtures.js";

const day = (offset: number) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);
const release = (releaseDate: string): Release => ({ id: "r", name: "R", artists: [], releaseDate, kind: "album" });
let stub: ReturnType<typeof stubFetch> | null = null;
afterEach(() => stub?.restore());

test("only releases from the last two weeks count", () => {
  assert.equal(isFresh(release(day(-3))), true);
  assert.equal(isFresh(release(day(-20))), false);
  assert.equal(isFresh(release(day(5))), false, "announced but not out yet");
  assert.equal(isFresh(release("2001")), false);
  assert.equal(isFresh(release("garbage")), false);
});

test("new releases from top artists become one notification each, at most twice a day", async () => {
  addUser("n1");
  const t = taste({ all: [artist("Band", ["rock"], "band1"), artist("Other", ["pop"], "other1")] });
  stub = stubFetch((url) => {
    const id = url.pathname.split("/")[3];
    const items = id === "band1"
      ? [{ id: "new1", name: "New Single", album_type: "single", release_date: day(-1), artists: [{ name: "Band" }], images: [] },
         { id: "old1", name: "Old Album", album_type: "album", release_date: day(-200), artists: [{ name: "Band" }], images: [] }]
      : [];
    return { items };
  });
  await runAs("n1", async () => {
    assert.equal(await checkReleases(t), 1);
    // too soon, no spotify calls at all
    const calls = stub!.calls.length;
    assert.equal(await checkReleases(t), 0);
    assert.equal(stub!.calls.length, calls);
    // forced again: the same release isn't added twice
    assert.equal(await checkReleases(t, true), 0);

    const list = listNotifications();
    assert.equal(list.unread, 1);
    assert.equal(list.items.length, 1);
    assert.equal((list.items[0] as { body: string }).body, "New single from Band");
    markSeen();
    assert.equal(listNotifications().unread, 0);
  });
});
