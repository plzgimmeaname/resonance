import assert from "node:assert/strict";
import { test } from "node:test";
import { pool } from "../src/limit.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("never runs more than max jobs at once, and starts the rest in order", async () => {
  const run = pool(2);
  let active = 0, peak = 0;
  const started: number[] = [];
  const job = (i: number) => run(async () => {
    started.push(i);
    peak = Math.max(peak, ++active);
    await tick(10);
    active--;
    return i;
  });
  const out = await Promise.all([0, 1, 2, 3, 4].map(job));
  assert.deepEqual(out, [0, 1, 2, 3, 4]);
  assert.equal(peak, 2);
  assert.deepEqual(started, [0, 1, 2, 3, 4]);
});

test("a failing job frees its slot", async () => {
  const run = pool(1);
  await assert.rejects(run(async () => { throw new Error("x"); }), /x/);
  assert.equal(await run(async () => "ok"), "ok");
});
