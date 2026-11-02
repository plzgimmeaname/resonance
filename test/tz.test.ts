import "./setup.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { localTime, parseTz, runAs } from "../src/context.js";
import { db } from "../src/db.js";
import { lifetime } from "../src/engine.js";

test("a browser's offset is read, anything odd becomes UTC", () => {
  assert.equal(parseTz("420"), 420);
  assert.equal(parseTz("-330"), -330);
  assert.equal(parseTz(["60", "x"]), 60);
  for (const junk of [undefined, "", "abc", "1.5", "99999", "-841", NaN]) assert.equal(parseTz(junk), 0, String(junk));
});

test("local time follows the offset, including the date and weekday", () => {
  const t = "2024-03-10T02:30:00.000Z"; // a Sunday, 02:30 UTC
  assert.deepEqual(localTime(t, 0), { hour: 2, day: 0, date: "2024-03-10" });
  // 420 is UTC-7: the evening before
  assert.deepEqual(localTime(t, 420), { hour: 19, day: 6, date: "2024-03-09" });
  // -540 is UTC+9
  assert.deepEqual(localTime(t, -540), { hour: 11, day: 0, date: "2024-03-10" });
});

test("hour and weekday charts are on the user's clock, not the server's", () => {
  db.prepare("insert into plays(user_id, played_at, track_id, name, artist, duration) values('tz1', '2024-03-10T02:30:00.000Z', 't', 'Song', 'Band', 1000)").run();
  const utc = runAs("tz1", () => lifetime(), 0)!;
  assert.equal(utc.hours[2], 1);
  assert.equal(utc.days[0], 1);
  const la = runAs("tz1", () => lifetime(), 420)!;
  assert.equal(la.hours[19], 1);
  assert.equal(la.hours[2], 0);
  assert.equal(la.days[6], 1);
});

test("the listening streak counts consecutive local days ending today or yesterday", () => {
  const ins = db.prepare("insert into plays(user_id, played_at, track_id, name, artist, duration) values(?,?,?,?,?,1000)");
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  // three days in a row, then a gap, then an older play
  [0, 24, 48, 120].forEach((h, i) => ins.run("streak", hoursAgo(h), `s${i}`, "Song", "Band"));
  assert.equal(runAs("streak", () => lifetime()!.streak, 0), 3);
  // nothing today but yesterday still counts
  [0, 24, 48].forEach((_, i) => ins.run("streak2", hoursAgo(30 + i * 24), `r${i}`, "Song", "Band"));
  assert.equal(runAs("streak2", () => lifetime()!.streak, 0), 3);
  // a gap of two full days breaks it
  ins.run("streak3", hoursAgo(80), "g0", "Song", "Band");
  assert.equal(runAs("streak3", () => lifetime()!.streak, 0), 0);
});
