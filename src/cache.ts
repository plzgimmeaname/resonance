interface Entry {
  at: number;
  ttl: number;
  value: unknown;
}

// ttl cache where concurrent callers of one key share a single computation, and expired entries get swept
export class TtlCache {
  private store = new Map<string, Entry>();
  private flying = new Map<string, Promise<unknown>>();
  // bumped on every invalidation, so a computation that started before it can't store a stale result
  private epoch = 0;

  constructor(private maxEntries = 5000) {}

  get size() {
    return this.store.size;
  }

  async get<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit && Date.now() - hit.at < hit.ttl) return hit.value as T;
    const running = this.flying.get(key);
    if (running) return running as Promise<T>;

    const started = this.epoch;
    const p = fn().then((value) => {
      if (this.epoch === started) this.put(key, { at: Date.now(), ttl, value });
      return value;
    });
    this.flying.set(key, p);
    // failures aren't cached, the next caller tries again
    const done = () => {
      if (this.flying.get(key) === p) this.flying.delete(key);
    };
    p.then(done, done);
    return p;
  }

  private put(key: string, e: Entry) {
    this.store.delete(key);
    this.store.set(key, e);
    // maps keep insertion order, so the first key is the oldest
    while (this.store.size > this.maxEntries) this.store.delete(this.store.keys().next().value as string);
  }

  deletePrefix(prefix: string) {
    this.epoch++;
    for (const k of [...this.store.keys()]) if (k.startsWith(prefix)) this.store.delete(k);
    for (const k of [...this.flying.keys()]) if (k.startsWith(prefix)) this.flying.delete(k);
  }

  clear(): number {
    const n = this.store.size;
    this.epoch++;
    this.store.clear();
    this.flying.clear();
    return n;
  }

  sweep(now = Date.now()): number {
    let n = 0;
    for (const [k, e] of this.store) {
      if (now - e.at >= e.ttl) {
        this.store.delete(k);
        n++;
      }
    }
    return n;
  }
}
