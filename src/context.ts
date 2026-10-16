import { AsyncLocalStorage } from "node:async_hooks";

const als = new AsyncLocalStorage<{ userId: string }>();

export const runAs = <T>(userId: string, fn: () => T): T => als.run({ userId }, fn);
export const maybeUid = () => als.getStore()?.userId;
export function uid(): string {
  const id = als.getStore()?.userId;
  if (!id) throw new Error("no user in context");
  return id;
}
