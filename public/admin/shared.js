// things every admin page uses
import { banner as showBanner, bar, empty, h, hist, make } from "/lib/dom.js";

// signed in state from /admin/api/state, filled in by main.js. go() is the router's navigate
export const admin = { setup: false, signedIn: false, go: null };

export async function api(path, opts) {
  const r = await fetch("/admin/api" + path, opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.error === "admin_required") throw Object.assign(new Error("admin_required"), { auth: true });
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
export const post = (p, body = {}) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// success messages fade out on their own
export function banner(content, ok = false) {
  showBanner(content, ok);
  if (content && ok) setTimeout(() => { const el = document.getElementById("banner"); if (el.classList.contains("ok")) el.hidden = true; }, 5000);
}

// a 401 sends you back to sign in, anything else shows in the page
export function fail(el, e) {
  if (e.auth) {
    admin.signedIn = false;
    return admin.go("/admin/login", true);
  }
  el.replaceChildren(empty(e.message));
}

export const ago = (ms) => {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
};
export const bytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB");
export const dur = (s) => (s > 86400 ? Math.floor(s / 86400) + "d " : "") + (s > 3600 ? Math.floor((s % 86400) / 3600) + "h " : "") + Math.floor((s % 3600) / 60) + "m";

// counted number tile, or a plain text one
export const stat = (n, l) => make("t-stat", { n: { dataset: { count: n } }, l });
export const statText = (v, l) => make("t-stat", { n: String(v), l });
export const histo = (vals, labels) => hist(vals, vals.map((v, i) => `${labels[i]}: ${v}`), "hist tall");
export const errRow = (x, withUser = false) => make("t-err", { detail: x.detail, when: ago(x.ts) + (withUser && x.user_id ? ` · ${x.user_id}` : "") });
export const featureBars = (features, label) => features.length
  ? features.map((f, i) => bar(label(f.kind), f.n, features[0].n, i))
  : empty("No activity yet");
export const pill = (text, cls = "") => h("span", { class: `pill ${cls}`.trim() }, text);
