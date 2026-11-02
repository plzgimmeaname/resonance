import "./setup.js";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

// v1 was single-user: plays, snapshots and feedback had no user_id column.
// opening that database must keep the old rows as *_legacy and create the new tables
test("a v1 database is migrated without losing the old rows", async () => {
  const file = path.join(process.env.DATA_DIR!, "resonance.db");
  const v1 = new DatabaseSync(file);
  v1.exec(`
    create table plays(played_at text, track_id text, name text, artist text, primary key(played_at, track_id));
    create table snapshots(day text primary key, genres text not null);
    create table feedback(kind text, value text, score integer, primary key(kind, value));
    insert into plays values('2024-01-01T00:00:00.000Z', 't1', 'Song', 'Artist');
    insert into snapshots values('2024-01-01', '[]');
    insert into feedback values('genre', 'jazz', 1);
  `);
  v1.close();

  const { db } = await import("../src/db.js");
  const tables = (db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((t) => t.name);
  for (const t of ["plays", "snapshots", "feedback"]) {
    assert.ok(tables.includes(`${t}_legacy`), `${t}_legacy exists`);
    const cols = (db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("user_id"), `${t} has user_id`);
  }
  assert.deepEqual({ ...db.prepare("select name, artist from plays_legacy").get() }, { name: "Song", artist: "Artist" });
  assert.equal((db.prepare("select count(*) n from plays").get() as { n: number }).n, 0);
});

test("starting again on a migrated database changes nothing", async () => {
  const { db } = await import("../src/db.js");
  db.prepare("insert into plays(user_id, played_at, track_id, name, artist) values('u', '2024-02-01T00:00:00.000Z', 't2', 'New', 'A')").run();
  // a new module url runs db.ts from the top again, like a restart
  const restarted = await import(`../src/db.js?restart=${Date.now()}`);
  const again = restarted.db as DatabaseSync;
  assert.equal((again.prepare("select count(*) n from plays").get() as { n: number }).n, 1);
  assert.equal((again.prepare("select count(*) n from plays_legacy").get() as { n: number }).n, 1);
});

test("deleting a user removes all of their rows", async () => {
  const { db, deleteUserData } = await import("../src/db.js");
  db.prepare("insert into users(id, name) values('gone', 'Gone')").run();
  for (const [t, extra] of [["plays", "played_at, track_id"], ["snapshots", "day, genres"], ["feedback", "kind, value"], ["notifications", "id, title"], ["shares", "token, data"]]) {
    db.prepare(`insert into ${t}(user_id, ${extra}) values('gone', 'x', 'y')`).run();
  }
  deleteUserData("gone");
  for (const t of ["plays", "snapshots", "feedback", "notifications", "shares", "users"]) {
    const col = t === "users" ? "id" : "user_id";
    assert.equal((db.prepare(`select count(*) n from ${t} where ${col} = 'gone'`).get() as { n: number }).n, 0, t);
  }
});

test("deleting a user also clears their logs and release-check marker, and nobody else's", async () => {
  const { db, deleteUserData, kvGet, kvSet } = await import("../src/db.js");
  db.prepare("insert into users(id, name) values('d1', 'D1'), ('d2', 'D2')").run();
  for (const u of ["d1", "d2"]) {
    db.prepare("insert into events(ts, user_id, kind) values(1, ?, 'login')").run(u);
    db.prepare("insert into spotify_calls(ts, user_id, path, status, ms) values(1, ?, '/me', 200, 5)").run(u);
    kvSet(`releases_checked:${u}`, 1);
  }
  deleteUserData("d1");
  const n = (t: string, u: string) => (db.prepare(`select count(*) n from ${t} where user_id = ?`).get(u) as { n: number }).n;
  assert.equal(n("events", "d1") + n("spotify_calls", "d1"), 0);
  assert.equal(kvGet("releases_checked:d1"), undefined);
  assert.equal(n("events", "d2"), 1);
  assert.equal(n("spotify_calls", "d2"), 1);
  assert.equal(kvGet("releases_checked:d2"), 1);
});
