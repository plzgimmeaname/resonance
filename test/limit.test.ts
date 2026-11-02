import "./setup.js";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Request, Response } from "express";
import { limiter, rateLimit } from "../src/limit.js";

test("allows max hits per window per key, then frees up as the window slides", () => {
  mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const allow = limiter(60_000, 3);
    assert.deepEqual([allow("a"), allow("a"), allow("a"), allow("a")], [true, true, true, false]);
    assert.equal(allow("b"), true);
    mock.timers.tick(60_001);
    assert.equal(allow("a"), true);
  } finally {
    mock.timers.reset();
  }
});

test("middleware answers 429 with Retry-After, keyed by user before address", () => {
  const mw = rateLimit(60_000, 1);
  const call = (userId?: string, ip = "9.9.9.9") => {
    let status = 200, retry = "";
    const res = { setHeader: (_k: string, v: string) => (retry = String(v)), status: (s: number) => ((status = s), res), json: () => res } as unknown as Response;
    let passed = false;
    mw({ userId, socket: { remoteAddress: ip } } as unknown as Request, res, () => (passed = true));
    return { status, retry, passed };
  };
  assert.equal(call("u").passed, true);
  assert.deepEqual(call("u"), { status: 429, retry: "60", passed: false });
  // same address, different user is a different bucket
  assert.equal(call("v").passed, true);
  assert.equal(call(undefined).passed, true);
  assert.equal(call(undefined).passed, false);
});

test("`when` limits only the matching requests", () => {
  const mw = rateLimit(60_000, 1, (req) => req.path === "/vibe");
  const pass = (path: string) => {
    let ok = false;
    const res = { setHeader() {}, status: () => res, json: () => res } as unknown as Response;
    mw({ path, userId: "u", socket: {} } as unknown as Request, res, () => (ok = true));
    return ok;
  };
  assert.deepEqual([pass("/vibe"), pass("/vibe"), pass("/stats"), pass("/stats")], [true, false, true, true]);
});
