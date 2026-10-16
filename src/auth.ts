import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { db, kvGet, kvSet } from "./db.js";

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const secure = (process.env.BASE_URL ?? "").startsWith("https");

export function parseCookies(req: Request): Record<string, string> {
  return Object.fromEntries(
    (req.headers.cookie ?? "").split(";").map((c) => c.trim().split("=")).filter((p) => p.length >= 2).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]),
  );
}
function setCookie(res: Response, name: string, value: string, path: string, maxAgeSec: number) {
  res.append("Set-Cookie", `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`);
}

const USER_TTL = 30 * 864e5;

// sessions: only a hash of the cookie token is stored in the db
export function startUserSession(res: Response, userId: string) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("insert into sessions(token, user_id, created_at, last_seen, expires) values(?,?,?,?,?)").run(sha(token), userId, now, now, now + USER_TTL);
  setCookie(res, "rid", token, "/", USER_TTL / 1000);
}
export function endUserSession(req: Request, res: Response) {
  const t = parseCookies(req).rid;
  if (t) db.prepare("delete from sessions where token = ?").run(sha(t));
  setCookie(res, "rid", "", "/", 0);
}

declare module "express-serve-static-core" {
  interface Request {
    userId?: string;
  }
}

// runs on every request, finds the user from the cookie and updates last seen
export function userSession(req: Request, res: Response, next: NextFunction) {
  const t = parseCookies(req).rid;
  if (t) {
    const row = db
      .prepare("select s.user_id, s.last_seen, u.blocked from sessions s join users u on u.id = s.user_id where s.token = ? and s.expires > ?")
      .get(sha(t), Date.now()) as { user_id: string; last_seen: number; blocked: number } | undefined;
    if (row && !row.blocked) {
      req.userId = row.user_id;
      if (Date.now() - row.last_seen > 60_000) {
        db.prepare("update sessions set last_seen = ? where token = ?").run(Date.now(), sha(t));
        db.prepare("update users set last_seen = ? where id = ?").run(Date.now(), row.user_id);
      }
    }
  }
  next();
}

interface AdminRec {
  salt: string;
  hash: string;
}
const ADMIN_TTL = 12 * 3600_000;
// scrypt hash so the password is never stored as is
const hashPw = (pw: string, salt: string) => crypto.scryptSync(pw, salt, 64).toString("hex");

export const adminExists = () => Boolean(kvGet<AdminRec>("admin"));

// one-time code printed in the terminal, so a stranger can't claim the admin account first
let setupCode: string | null = null;
export function ensureSetupCode() {
  if (adminExists()) return null;
  setupCode ??= crypto.randomBytes(4).toString("hex");
  return setupCode;
}

export function setAdminPassword(pw: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  kvSet("admin", { salt, hash: hashPw(pw, salt) } satisfies AdminRec);
}
export function checkAdminPassword(pw: string): boolean {
  const rec = kvGet<AdminRec>("admin");
  if (!rec) return false;
  return crypto.timingSafeEqual(Buffer.from(hashPw(pw, rec.salt), "hex"), Buffer.from(rec.hash, "hex"));
}
export function checkSetupCode(code: string) {
  return Boolean(setupCode) && code.trim().toLowerCase() === setupCode;
}
export function clearSetupCode() {
  setupCode = null;
}

export function startAdminSession(res: Response) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("insert into sessions(token, user_id, created_at, last_seen, expires) values(?,?,?,?,?)").run(sha(token), "__admin__", now, now, now + ADMIN_TTL);
  setCookie(res, "radm", token, "/admin", ADMIN_TTL / 1000);
}
export function endAdminSessions(req: Request, res: Response, all = false) {
  if (all) db.prepare("delete from sessions where user_id = '__admin__'").run();
  else {
    const t = parseCookies(req).radm;
    if (t) db.prepare("delete from sessions where token = ?").run(sha(t));
  }
  setCookie(res, "radm", "", "/admin", 0);
}
export function isAdmin(req: Request): boolean {
  const t = parseCookies(req).radm;
  if (!t) return false;
  return Boolean(db.prepare("select 1 from sessions where token = ? and user_id = '__admin__' and expires > ?").get(sha(t), Date.now()));
}
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!isAdmin(req)) return res.status(401).json({ error: "admin_required" });
  next();
}

// 5 failed attempts per 10 minutes per address
const fails = new Map<string, number[]>();
export function tooManyAttempts(ip: string) {
  const recent = (fails.get(ip) ?? []).filter((t) => Date.now() - t < 10 * 60_000);
  fails.set(ip, recent);
  return recent.length >= 5;
}
export const recordFail = (ip: string) => fails.set(ip, [...(fails.get(ip) ?? []), Date.now()]);
