import { $, $$, reveal } from "/lib/dom.js";
import { api, banner, fail, post } from "/admin/shared.js";

const FIELDS = ["clientId", "lastfm", "ticketmaster", "city", "country", "anthropic", "reportUrl", "reportKey"];
const SECRETS = ["lastfm", "ticketmaster", "anthropic", "reportKey"];

export function mount(root) {
  const form = $("#sf", root);
  let redirectUri = "";

  // plain values are filled in, secrets stay blank and just show "✓ set"
  async function load() {
    try {
      const s = await api("/settings");
      for (const k of ["clientId", "city", "country", "reportUrl"]) form[k].value = s[k] ?? "";
      for (const k of SECRETS) form[k].value = "";
      $$(".is-set", form).forEach((el) => (el.hidden = !(el.dataset.key === "reportKey" ? s.reportKey : s.set[el.dataset.key])));
      redirectUri = s.redirectUri;
      $("#uri", form).textContent = redirectUri;
    } catch (e) { fail(root, e); }
  }

  $("#copy", form).onclick = async (e) => {
    await navigator.clipboard.writeText(redirectUri);
    e.target.textContent = "Copied ✓";
    setTimeout(() => (e.target.textContent = "Copy"), 1500);
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await post("/settings", Object.fromEntries(FIELDS.map((k) => [k, form[k].value])));
      banner("Settings saved.", true);
      load();
    } catch (err) { banner(err.message); }
  };
  $("#pf", root).onsubmit = async (e) => {
    e.preventDefault();
    try {
      await post("/password", { current: e.target.current.value, next: e.target.next.value });
      e.target.reset();
      banner("Password changed. Other admin sessions were signed out.", true);
    } catch (err) { banner(err.message); }
  };
  reveal(form);
  load();
}
