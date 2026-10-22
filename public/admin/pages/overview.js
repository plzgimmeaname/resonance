import { $, countUp, empty, make, reveal } from "/lib/dom.js";
import { api, errRow, fail, featureBars, histo, stat } from "/admin/shared.js";

export function mount(root) {
  const el = $("#body", root);
  async function load() {
    try {
      const d = await api("/overview");
      const connected = d.users.filter((u) => u.connected && !u.blocked).length;
      const body = make("t-overview", {
        stats: [
          stat(d.users.length, "Users"), stat(connected, "Connected to Spotify"),
          stat(d.system.counts.plays, "Plays tracked"), stat(d.api.calls, "Spotify calls (24h)"),
          stat(d.api.errors, "Failed calls (24h)"), stat(d.api.limited, "Rate-limited (24h)"),
        ],
        logins: histo(d.loginsByDay.map((x) => x.n), d.loginsByDay.map((x) => x.day)),
        calls: histo(d.api.callsByHour.map((x) => x.calls), d.api.callsByHour.map((x) => x.hour + ":00")),
        features: featureBars(d.features, (k) => k.replace("view_", "").replace("_", " ")),
        errors: d.errors.length ? d.errors.slice(0, 6).map((x) => errRow(x)) : empty("None 🎉"),
      });
      el.replaceChildren(...body.children);
      reveal(el); countUp(el, 800);
    } catch (e) { fail(el, e); }
  }
  $("#refresh", root).onclick = load;
  load();
}
