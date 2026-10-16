import { kvGet, kvSet } from "./db.js";

const KEYS = {
  clientId: "SPOTIFY_CLIENT_ID",
  lastfm: "LASTFM_API_KEY",
  ticketmaster: "TICKETMASTER_API_KEY",
  city: "TICKETMASTER_CITY",
  country: "TICKETMASTER_COUNTRY",
  anthropic: "ANTHROPIC_API_KEY",
  reportUrl: "REPORT_URL",
  reportKey: "REPORT_KEY",
} as const;
export type SettingKey = keyof typeof KEYS;
export const settingKeys = Object.keys(KEYS) as SettingKey[];

// values saved in the app win over .env
export function getSetting(k: SettingKey): string {
  return kvGet<Record<string, string>>("settings")?.[k] ?? process.env[KEYS[k]] ?? "";
}

export function saveSettings(patch: Partial<Record<SettingKey, string>>) {
  const cur = kvGet<Record<string, string>>("settings") ?? {};
  for (const [k, v] of Object.entries(patch)) {
    const val = String(v ?? "").trim();
    if (val) cur[k] = val;
    else delete cur[k];
  }
  kvSet("settings", cur);
}
