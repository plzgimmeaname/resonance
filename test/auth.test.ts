import "./setup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import {
  adminExists, checkAdminPassword, checkSetupCode, clearSetupCode, ensureSetupCode, parseCookies, recordFail,
  setAdminPassword, startUserSession, endUserSession, tooManyAttempts, userSession,
} from "../src/auth.js";
import { db } from "../src/db.js";
import { addUser } from "./fixtures.js";

const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as unknown as Request;
// collects Set-Cookie headers
function res() {
  const cookies: string[] = [];
  return { cookies, append: (_k: string, v: string) => cookies.push(v) } as unknown as Response & { cookies: string[] };
}
const tokenFrom = (setCookie: string) => decodeURIComponent(setCookie.split(";")[0].split("=").slice(1).join("="));

test("parseCookies splits, trims and decodes", () => {
  assert.deepEqual(parseCookies(req("a=1; b=x%20y;c=has=equals")), { a: "1", b: "x y", c: "has=equals" });
  assert.deepEqual(parseCookies(req()), {});
  assert.deepEqual(parseCookies(req("junk; ok=1")), { ok: "1" });
});

test("a user session cookie signs the request in, and signing out ends it", () => {
  addUser("alice");
  const r = res();
  startUserSession(r, "alice");
  assert.match(r.cookies[0], /^rid=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
  const cookie = `rid=${encodeURIComponent(tokenFrom(r.cookies[0]))}`;

  // the db only keeps a hash, not the token itself
  const stored = db.prepare("select token from sessions where user_id = 'alice'").get() as { token: string };
  assert.notEqual(stored.token, tokenFrom(r.cookies[0]));

  const signedIn = req(cookie);
  userSession(signedIn, res(), () => {});
  assert.equal(signedIn.userId, "alice");

  endUserSession(req(cookie), res());
  const after = req(cookie);
  userSession(after, res(), () => {});
  assert.equal(after.userId, undefined);
});

test("blocked users and wrong tokens aren't signed in", () => {
  addUser("bob");
  const r = res();
  startUserSession(r, "bob");
  const cookie = `rid=${encodeURIComponent(tokenFrom(r.cookies[0]))}`;
  db.prepare("update users set blocked = 1 where id = 'bob'").run();
  const blocked = req(cookie);
  userSession(blocked, res(), () => {});
  assert.equal(blocked.userId, undefined);

  const wrong = req("rid=not-a-real-token");
  userSession(wrong, res(), () => {});
  assert.equal(wrong.userId, undefined);
});

test("setup code works until the admin exists, then the password is checked", () => {
  assert.equal(adminExists(), false);
  const code = ensureSetupCode()!;
  assert.match(code, /^[0-9a-f]{8}$/);
  assert.equal(checkSetupCode(` ${code.toUpperCase()} `), true);
  assert.equal(checkSetupCode("nope"), false);

  setAdminPassword("correct horse");
  clearSetupCode();
  assert.equal(adminExists(), true);
  assert.equal(ensureSetupCode(), null);
  assert.equal(checkSetupCode(code), false);
  assert.equal(checkAdminPassword("correct horse"), true);
  assert.equal(checkAdminPassword("wrong horse"), false);
});

test("five failed attempts lock an address out", () => {
  for (let i = 0; i < 5; i++) {
    assert.equal(tooManyAttempts("1.2.3.4"), false);
    recordFail("1.2.3.4");
  }
  assert.equal(tooManyAttempts("1.2.3.4"), true);
  assert.equal(tooManyAttempts("5.6.7.8"), false);
});
