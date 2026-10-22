import { $, $$, banner, moveIndicator } from "/lib/dom.js";
import { createRouter } from "/lib/router.js";
import { admin, api, post } from "/admin/shared.js";

// path → page in admin/pages/ (an .html and a .js with the same name)
const routes = Object.fromEntries(["login", "overview", "users", "usage", "settings", "tools"].map((p) => [`/admin/${p}`, `/admin/pages/${p}`]));

const router = createRouter({
  outlet: $("#page"),
  routes,
  // signed out: only the login page. signed in: /admin and the login page go to the overview
  guard(path) {
    if (!admin.signedIn) return "/admin/login";
    if (!routes[path] || path === "/admin/login") return "/admin/overview";
    return path;
  },
  onChange(path) {
    $("#tabs").hidden = $("#signout").hidden = !admin.signedIn;
    $$("#tabs a").forEach((a) => a.classList.toggle("active", a.pathname === path));
    moveIndicator();
    const name = $("#tabs a.active")?.textContent;
    document.title = name ? `${name} · Resonance admin` : "Resonance admin";
  },
  onError: (e) => banner(e.message),
});
admin.go = router.go;

$("#signout").addEventListener("click", async () => { await post("/logout"); location.assign("/admin"); });

async function boot() {
  Object.assign(admin, await api("/state"));
  router.start();
}
boot().catch((e) => banner(e.message));
