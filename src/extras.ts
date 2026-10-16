// optional integrations, inactive unless a key is set
import { getSetting } from "./settings.js";

export const features = () => ({ lastfm: Boolean(getSetting("lastfm")), concerts: Boolean(getSetting("ticketmaster")), ai: Boolean(getSetting("anthropic")) });

export async function similarArtists(name: string, limit = 8): Promise<string[]> {
  const LASTFM = getSetting("lastfm");
  if (!LASTFM) return [];
  const u = new URL("https://ws.audioscrobbler.com/2.0/");
  u.search = new URLSearchParams({ method: "artist.getsimilar", artist: name, api_key: LASTFM, format: "json", limit: String(limit), autocorrect: "1" }).toString();
  const r = await fetch(u);
  if (!r.ok) return [];
  const d: any = await r.json();
  return (d.similarartists?.artist ?? []).map((a: any) => a.name as string);
}

export interface ConcertEvent {
  artist: string;
  name: string;
  date: string;
  venue: string;
  city: string;
  url: string;
}

export async function upcomingEvents(artist: string): Promise<ConcertEvent[]> {
  const TICKETMASTER = getSetting("ticketmaster");
  if (!TICKETMASTER) return [];
  const p = new URLSearchParams({ apikey: TICKETMASTER, keyword: artist, classificationName: "music", size: "3", sort: "date,asc" });
  if (getSetting("city")) p.set("city", getSetting("city"));
  if (getSetting("country")) p.set("countryCode", getSetting("country"));
  const r = await fetch(`https://app.ticketmaster.com/discovery/v2/events.json?${p}`);
  if (!r.ok) return [];
  const d: any = await r.json();
  return (d._embedded?.events ?? [])
    // keyword search is fuzzy, keep exact matches
    .filter((e: any) => e.name?.toLowerCase().includes(artist.toLowerCase()))
    .map((e: any) => ({
      artist,
      name: e.name,
      date: e.dates?.start?.localDate ?? "",
      venue: e._embedded?.venues?.[0]?.name ?? "",
      city: e._embedded?.venues?.[0]?.city?.name ?? "",
      url: e.url,
    }));
}

const clean = (s: string) =>
  s.toLowerCase().replace(/\(.*?\)|\[.*?\]|- .*(remaster|version|mix|edit).*$/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const previewCache = new Map<string, string | null>();

// spotify rarely returns preview urls now, so look the song up on itunes (30s clips, no key)
export async function findPreview(name: string, artist: string): Promise<string | null> {
  const key = clean(`${name} ${artist}`);
  if (previewCache.has(key)) return previewCache.get(key)!;
  let url: string | null = null;
  try {
    const r = await fetch(`https://itunes.apple.com/search?${new URLSearchParams({ term: `${artist} ${name}`, entity: "song", limit: "8" })}`);
    if (r.ok) {
      const d: any = await r.json();
      const hit = (d.results ?? []).find((x: any) => x.previewUrl && clean(x.trackName) === clean(name) && clean(x.artistName).includes(clean(artist)));
      url = hit?.previewUrl ?? null;
    }
  } catch {}
  previewCache.set(key, url);
  return url;
}

export async function askClaude(prompt: string): Promise<string | null> {
  const ANTHROPIC = getSetting("anthropic");
  if (!ANTHROPIC) return null;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-5-5", max_tokens: 250, messages: [{ role: "user", content: prompt }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d: any = await r.json();
  return d.content?.[0]?.text ?? null;
}
