import type { NextFunction, Request, Response } from "express";

// sliding window counter: at most `max` hits per `windowMs` for each key
export function limiter(windowMs: number, max: number) {
  const hits = new Map<string, number[]>();
  let lastSweep = Date.now();
  return (key: string): boolean => {
    const now = Date.now();
    // drop idle keys now and then so the map can't grow forever
    if (now - lastSweep > windowMs) {
      for (const [k, ts] of hits) if (now - ts[ts.length - 1] > windowMs) hits.delete(k);
      lastSweep = now;
    }
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

export const clientKey = (req: Request) => req.userId ?? `ip:${req.socket.remoteAddress ?? "?"}`;

// express middleware, `when` picks which requests count
export function rateLimit(windowMs: number, max: number, when: (req: Request) => boolean = () => true) {
  const allow = limiter(windowMs, max);
  return (req: Request, res: Response, next: NextFunction) => {
    if (when(req) && !allow(clientKey(req))) {
      res.setHeader("Retry-After", Math.ceil(windowMs / 1000));
      return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
    }
    next();
  };
}

// runs at most `max` async jobs at once, the rest wait their turn in order
export function pool(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await job();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
