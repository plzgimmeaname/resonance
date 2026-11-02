import assert from "node:assert/strict";
import { test } from "node:test";
import { TtlCache } from "../src/cache.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("concurrent callers share one computation, later ones hit the cache", async () => {
  const c = new TtlCache();
  let runs = 0;
  const slow = async () => {
    runs++;
    await tick();
    return "v";
  };
  const out = await Promise.all([c.get("k", 1000, slow), c.get("k", 1000, slow), c.get("k", 1000, slow)]);
  assert.deepEqual(out, ["v", "v", "v"]);
  assert.equal(runs, 1);
  await c.get("k", 1000, slow);
  assert.equal(runs, 1, "cached afterwards");
});

test("a failure reaches every waiting caller and is not cached", async () => {
  const c = new TtlCache();
  let runs = 0;
  const boom = async () => {
    runs++;
    await tick();
    throw new Error("nope");
  };
  const results = await Promise.allSettled([c.get("k", 1000, boom), c.get("k", 1000, boom)]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  assert.equal(runs, 1);
  assert.equal(await c.get("k", 1000, async () => "fine"), "fine", "the next caller tries again");
});

test("entries expire after their own ttl", async () => {
  const c = new TtlCache();
  let n = 0;
  const f = async () => ++n;
  assert.equal(await c.get("k", 10, f), 1);
  assert.equal(await c.get("k", 10, f), 1);
  await tick(20);
  assert.equal(await c.get("k", 10, f), 2);
});

test("invalidating while a computation runs keeps its stale result out of the cache", async () => {
  const c = new TtlCache();
  let n = 0;
  const first = c.get("u:k", 1000, async () => {
    n++;
    await tick(20);
    return "old";
  });
  c.deletePrefix("u:");
  assert.equal(await first, "old", "the caller that was waiting still gets an answer");
  assert.equal(await c.get("u:k", 1000, async () => (n++, "new")), "new");
  assert.equal(n, 2);
});

test("deleting a prefix only touches matching keys", async () => {
  const c = new TtlCache();
  for (const k of ["a:1", "a:2", "b:1"]) await c.get(k, 1000, async () => k);
  c.deletePrefix("a:");
  assert.equal(c.size, 1);
  assert.equal(c.clear(), 1);
  assert.equal(c.size, 0);
});

test("sweeping drops expired entries, and the size cap drops the oldest", async () => {
  const c = new TtlCache(2);
  await c.get("short", 5, async () => 1);
  await c.get("long", 10_000, async () => 2);
  await tick(15);
  assert.equal(c.sweep(), 1);
  assert.equal(c.size, 1);

  await c.get("x", 10_000, async () => 3);
  await c.get("y", 10_000, async () => 4);
  assert.equal(c.size, 2, "capped");
  let reran = false;
  await c.get("long", 10_000, async () => ((reran = true), 2));
  assert.ok(reran, "the oldest entry was the one evicted");
});
