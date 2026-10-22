import { $, $$, banner, moveIndicator } from "/lib/dom.js";
import { createRouter } from "/lib/router.js";
import { api, app, post, stopPreview } from "/app/shared.js";

// path → page in app/pages/ (an .html and a .js with the same name)
const routes = Object.fromEntries(["connect", "feed", "stats", "discover", "concerts", "blend"].map((p) => [`/${p}`, `/app/pages/${p}`]));

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
    $("#me-name").textContent = app.me.name;
    // tabs that need an optional api key
    $("#tab-concerts").hidden = !app.status.features.concerts;
  }
  router.start();
}

$("#logout").onclick = async () => { await post("/auth/logout", {}); location.assign("/"); };
$("#delete-me").onclick = async () => {
  if (!confirm("Delete your listening history, votes and account from this site? This can't be undone.")) return;
  await post("/auth/delete-me", {});
  location.assign("/");
};

init().catch((e) => banner(e.message));
