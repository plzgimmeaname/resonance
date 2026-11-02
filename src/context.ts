import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<{ userId: string; tz: number }>();

// tz is the browser's Date.getTimezoneOffset(): minutes to add to local time to get UTC (420 for UTC-7)
export const runAs = <T>(userId: string, fn: () => T, tz = 0): T => als.run({ userId, tz }, fn);
export const maybeUid = () => als.getStore()?.userId;
export function uid(): string {
  const id = als.getStore()?.userId;
  if (!id) throw new Error("no user in context");
  return id;
}

// reads the offset a browser sent, ignoring anything that isn't a real zone
export function parseTz(header: unknown): number {
  const n = Number(Array.isArray(header) ? header[0] : header);
  return Number.isInteger(n) && Math.abs(n) <= 14 * 60 ? n : 0;
}

// hour, weekday and calendar date of a timestamp on the current user's clock
export function localTime(iso: string | number, tz = als.getStore()?.tz ?? 0) {
  const d = new Date(new Date(iso).getTime() - tz * 60_000);
  return { hour: d.getUTCHours(), day: d.getUTCDay(), date: d.toISOString().slice(0, 10) };
}
