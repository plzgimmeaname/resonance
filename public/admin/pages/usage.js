import { $, countUp, empty, h, make, reveal } from "/lib/dom.js";
import { api, bytes, dur, errRow, fail, featureBars, histo, stat, statText } from "/admin/shared.js";

export function mount(root) {
  const el = $("#body", root);
  async function load() {
    try {
      const d = await api("/overview");
      const s = d.system;
      const hours = d.api.callsByHour.map((x) => x.hour + ":00");
      const body = make("t-usage", {
        health: [stat(d.api.calls, "Calls"), stat(d.api.errors, "Failed"), stat(d.api.limited, "Rate-limited (429)"), stat(Math.round(d.api.avg || 0), "Avg response (ms)")],
        calls: histo(d.api.callsByHour.map((x) => x.calls), hours),
        failures: histo(d.api.callsByHour.map((x) => x.errors), hours),
        endpoints: d.api.byPath.length
          ? d.api.byPath.map((p) => make("t-endpoint", { path: p.path, n: String(p.n), errors: String(p.errors), avg: String(p.avg_ms) }))
          : h("tr", {}, h("td", { colspan: 4 }, empty("No calls yet"))),
        features: featureBars(d.features, (k) => k.replace("view_", "views: ").replace("_", " ")),
        system: [statText(dur(s.uptimeSec), "Uptime"), statText(bytes(s.dbBytes), "Database size"), statText(s.cacheEntries, "Cached items"), statText(`${s.rssMb} MB`, "Memory")],
        host: `Node ${s.node} · ${s.host} · ${s.counts.events.toLocaleString()} event rows · ${s.counts.calls.toLocaleString()} API call rows`,
        errors: d.errors.length ? d.errors.map((x) => errRow(x, true)) : empty("None"),
        log: d.logs.join("\n") || "empty",
      });
      el.replaceChildren(...body.children);
      const log = $(".log", el);
      log.scrollTop = log.scrollHeight;
      reveal(el); countUp(el, 800);
    } catch (e) { fail(el, e); }
  }
  $("#refresh", root).onclick = load;
  load();
}
