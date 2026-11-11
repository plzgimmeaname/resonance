import { $, $$, banner, empty, make, moveIndicator, theme } from "/lib/dom.js";
import { createRouter } from "/lib/router.js";
import { api, app, cover, pendingBlend, post, stopPreview } from "/app/shared.js";

// path → page in app/pages/ (an .html and a .js with the same name)
const routes = Object.fromEntries(["connect", "feed", "stats", "discover", "playlists", "concerts", "blend", "import"].map((p) => [`/${p}`, `/app/pages/${p}`]));

const router = createRouter({
  outlet: $("#page"),
  routes,
  // signed out: everything is the connect page. signed in: / and unknown paths go to the feed
  guard(path) {
    if (!app.me) return "/connect";
    if (!routes[path] || path === "/connect") return "/feed";
    if (path === "/concerts" && !app.status.features.concerts) return "/feed";
    return path;
  },
  onChange(path) {
    stopPreview(true);
    $("#tabs").hidden = $("#account").hidden = !app.me;
    $$("#tabs a").forEach((a) => a.classList.toggle("active", a.pathname === path));
    moveIndicator();
    const name = $("#tabs a.active")?.textContent;
    document.title = name ? `${name} · Resonance` : "Resonance";
    closeMenu();
  },
  onError: (e) => banner(e.message),
});
app.go = router.go;

async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const err = new URLSearchParams(location.search).get("error");
  if (err) banner(err === "blocked" ? "This account has been blocked by the site admin." : "Spotify sign-in failed. The admin should check the Client ID and that your Spotify email is added under User Management.");
  app.status = await api("/api/status");
  if (app.status.connected) app.me = await api("/api/me").catch(() => null);

  if (app.me) {
    $("#me-img").hidden = !app.me.image;
    if (app.me.image) $("#me-img").src = app.me.image;
    $("#me-initial").textContent = app.me.image ? "" : (app.me.name || "?").trim().charAt(0).toUpperCase();
    $("#me-name").textContent = app.me.name;
    // tabs that need an optional api key
    $("#tab-concerts").hidden = !app.status.features.concerts;
    loadNotifications();
    // back from signing in after clicking "blend with me" on a share page
    if (pendingBlend.has() && location.pathname === "/") history.replaceState(null, "", "/blend");
  }
  router.start();
}

// dialogs close from their ✕ button or a click on the backdrop. Esc is handled by <dialog> itself
for (const d of $$("dialog")) {
  d.addEventListener("click", (e) => { if (e.target === d || e.target.closest("[data-close]")) d.close(); });
}

// on phones the sheets sit at the bottom and can be dragged down to close. the sheet follows the finger 1:1,
// resists when pulled up, and on release the swipe's speed is projected forward to decide close or settle back
const project = (v, rate = 0.998) => ((v / 1000) * rate) / (1 - rate);
const rubberband = (x, dim, c = 0.55) => (x * dim * c) / (dim + c * Math.abs(x));
const SETTLE = "transform .35s cubic-bezier(.32,.72,0,1)";
for (const d of $$("dialog.sheet")) {
  let start = null;
  d.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || !e.target.closest(".grab, .sheet-head") || e.target.closest("button")) return;
    try { d.setPointerCapture(e.pointerId); } catch {} // keeps tracking if the finger leaves the sheet
    start ={ y: e.clientY, samples: [{ y: e.clientY, t: e.timeStamp }] };
    d.classList.add("dragging");
    d.style.transition = "none";
  });
  d.addEventListener("pointermove", (e) => {
    if (!start) return;
    const dy = e.clientY - start.y;
    d.style.transform = `translateY(${dy < 0 ? rubberband(dy, d.offsetHeight) : dy}px)`;
    start.samples = [...start.samples, { y: e.clientY, t: e.timeStamp }].slice(-5);
  });
  const release = (e) => {
    if (!start) return;
    const [a, b] = [start.samples[0], start.samples.at(-1)];
    const v = b.t > a.t ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0; // px/s
    const dy = e.clientY - start.y;
    start = null;
    d.classList.remove("dragging");
    d.style.transition = SETTLE;
    if (dy + project(v) > d.offsetHeight * 0.4) {
      d.style.transform = `translateY(${d.offsetHeight + 20}px)`;
      setTimeout(() => d.close(), 250);
    } else d.style.transform = "";
  };
  d.addEventListener("pointerup", release);
  d.addEventListener("pointercancel", release);
  d.addEventListener("close", () => { d.style.transform = d.style.transition = ""; });
}

// the header's divider only shows once content scrolls under it
const header = $("header");
const edge = () => header.classList.toggle("scrolled", scrollY > 4);
addEventListener("scroll", edge, { passive: true });
edge();

// new releases from your top artists, checked by the server in the background
let notes = [];
async function loadNotifications() {
  try {
    const r = await api("/api/notifications");
    notes = r.items;
    $("#bell-n").textContent = r.unread > 9 ? "9+" : String(r.unread);
    $("#bell-n").hidden = !r.unread;
  } catch {}
}
$("#bell").onclick = () => {
  $("#nt-list").replaceChildren(...(notes.length
    ? notes.map((n) => make("t-note", {
      note: { href: n.url || null, class: n.seen ? "note" : "note unseen" },
      cover: cover(n.image), title: n.title, body: n.body, when: new Date(n.created_at).toLocaleDateString(),
    }))
    : [empty("Nothing yet. New songs and albums from your top artists show up here.", { style: "padding:24px 0" })]));
  $("#nt-modal").showModal();
  if (notes.some((n) => !n.seen)) post("/api/notifications/seen", {}).then(() => { $("#bell-n").hidden = true; notes.forEach((n) => (n.seen = 1)); }).catch(() => {});
};
$("#nt-list").addEventListener("click", (e) => e.target.closest("a.note") && $("#nt-modal").close());

// account menu: theme, import, shortcuts, sign out
const menu = $("#me-menu"), meBtn = $("#me-btn");
function closeMenu() {
  menu.hidden = true;
  meBtn.setAttribute("aria-expanded", "false");
}
meBtn.onclick = () => {
  const open = menu.hidden;
  menu.hidden = !open;
  meBtn.setAttribute("aria-expanded", String(open));
  if (open) menu.querySelector("a, button")?.focus();
};
document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest(".menu-wrap")) closeMenu(); });
menu.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); meBtn.focus(); } });
const paintTheme = () => $$("#theme button").forEach((b) => b.classList.toggle("active", b.dataset.theme === theme.get()));
$("#theme").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-theme]");
  if (!b) return;
  theme.set(b.dataset.theme);
  paintTheme();
});
paintTheme();
$("#keys-btn").onclick = () => { closeMenu(); $("#keys-modal").showModal(); };

$("#logout").onclick = async () => { await post("/auth/logout", {}); location.assign("/"); };
$("#delete-me").onclick = async () => {
  closeMenu();
  if (!confirm("Delete your listening history, votes and account from this site? This can't be undone.")) return;
  await post("/auth/delete-me", {});
  location.assign("/");
};

// number keys switch tabs, ? lists the shortcuts. pages add their own (feed: j/k/space, discover: /)
const typing = (t) => t.closest?.("input, textarea, select, [contenteditable]");
document.addEventListener("keydown", (e) => {
  if (!app.me || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector("dialog[open]")) return;
  if (e.key === "?") { e.preventDefault(); $("#keys-modal").showModal(); return; }
  const tab = $$("#tabs a:not([hidden])")[Number(e.key) - 1];
  if (/^[1-9]$/.test(e.key) && tab) { e.preventDefault(); app.go(tab.pathname); }
});

init().catch((e) => banner(e.message));
