import "./setup.js";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { db } from "../src/db.js";
import { registerCollector, validReportUrl } from "../src/remote.js";
import { saveSettings } from "../src/settings.js";

const CID = "0123456789abcdef0123456789abcdef";
let base = "";
let close = () => {};
before(async () => {
  const app = express();
  app.use(express.json());
  registerCollector(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const report = (body: Record<string, unknown>) =>
  fetch(`${base}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const good = { clientId: CID, key: "s3cret", instance: "a1b2c3d4e5f6", users: [{ id: "x", name: "X", plays: 3, connected: true }] };

test("the collector is off until a shared key is set, even with the right client id", async () => {
  saveSettings({ clientId: CID });
  assert.equal((await report(good)).status, 403);
});

test("reports need the key and our client id, and replace the instance's rows", async () => {
  saveSettings({ clientId: CID, reportKey: "s3cret" });
  assert.equal((await report({ ...good, key: "wrong" })).status, 403);
  assert.equal((await report({ ...good, clientId: "f".repeat(32) })).status, 403);
  assert.equal((await report({ ...good, instance: "../../etc" })).status, 400);

  assert.equal((await report(good)).status, 200);
  assert.equal((await report({ ...good, users: [{ id: "y", name: "Y" }] })).status, 200);
  const rows = db.prepare("select user_id from remote_users where instance = 'a1b2c3d4e5f6'").all() as { user_id: string }[];
  assert.deepEqual(rows.map((r) => r.user_id), ["y"]);
});

test("collector URLs must be https, except on this computer", () => {
  assert.equal(validReportUrl("https://example.com"), true);
  assert.equal(validReportUrl("http://127.0.0.1:3000"), true);
  assert.equal(validReportUrl("http://example.com"), false);
  assert.equal(validReportUrl("not a url"), false);
});
