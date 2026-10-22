import { $, $$, bar, countUp, empty, h, hist, make, reveal, skeleton } from "/lib/dom.js";
import { api, app, handleErr } from "/app/shared.js";

const RANGES = ["short", "medium", "long"];
const COLORS = ["#7c5cff", "#ff5c8a", "#3ddc97", "#ffb84d", "#4dc3ff", "#c77dff"];
const count = (n) => ({ dataset: { count: n } });

// artist rows are clickable for the last.fm deep dive when it's set up
function rankRow(i, img, title, sub, artist = false) {
  const dive = artist && app.status.features.lastfm;
  return make("t-rank", {
    rank: dive ? { "data-artist": title, style: "cursor:pointer", title: "Click for details" } : {},
    i: String(i + 1), img: img ? { src: img } : null, title, sub,
  });
}

const histogram = (arr, labels) => arr
  ? [hist(arr, arr.map((v) => `${v} plays`)), h("div", { class: "histlabels" }, labels.map((l) => h("span", {}, l)))]
  : empty("Collecting…");

function driftChart(drift) {
  if (drift.length < 2) return empty("Resonance saves a taste snapshot each day. Check back in a few days to see how your taste changes over time.", { style: "padding:20px 0" });
  const tally = new Map();
  drift.forEach((d) => d.genres.forEach(([g, p]) => tally.set(g, (tally.get(g) || 0) + p)));
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => x[0]);
  const rows = drift.map((d) => {
    const map = new Map(d.genres);
    const segs = top.map((g, i) => h("div", { style: `width:${map.get(g) || 0}%;background:${COLORS[i]}`, title: `${g} ${map.get(g) || 0}%` }));
    return h("div", { style: "display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted)" },
      h("span", { style: "width:72px" }, d.day.slice(5)), h("div", { class: "stack", style: "flex:1;margin:2px 0" }, segs));
  });
  return [...rows, h("div", { class: "legend" }, top.map((g, i) => h("span", {}, h("i", { style: `background:${COLORS[i]}` }), g)))];
}

async function artistDive(row) {
  const open = row.nextElementSibling;
  if (open?.classList.contains("dive")) return open.remove();
  const box = h("div", { class: "dive", style: "padding:8px 0 14px 34px;color:var(--muted);font-size:13px" }, "Loading…");
  row.after(box);
  try {
    const a = await api(`/api/artist?name=${encodeURIComponent(row.dataset.artist)}`);
    if (!a.name) return (box.textContent = "No Last.fm info for this artist.");
    box.replaceWith(make("t-dive", {
      tags: a.tags.flatMap((t) => [h("span", { class: "chip" }, t), " "]),
      listeners: `${a.listeners.toLocaleString()} Last.fm listeners`,
      bio: a.bio ? a.bio.slice(0, 400) + (a.bio.length > 400 ? "…" : "") : null,
      similar: a.similar.length ? `Similar: ${a.similar.join(", ")}` : null,
      link: { href: a.url },
    }));
  } catch (e) { box.textContent = e.message; }
}

function shareCard(s) {
  const c = document.createElement("canvas");
  c.width = 1080; c.height = 1350;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 1080, 1350);
  g.addColorStop(0, "#2a1b6e"); g.addColorStop(1, "#8a1f4f");
  x.fillStyle = g; x.fillRect(0, 0, 1080, 1350);
  x.fillStyle = "#fff"; x.font = "bold 54px -apple-system, sans-serif"; x.fillText("◉ Resonance", 80, 120);
  x.font = "36px -apple-system, sans-serif"; x.globalAlpha = .75; x.fillText(`${app.me.name}'s taste`, 80, 175); x.globalAlpha = 1;
  x.font = "bold 84px -apple-system, sans-serif"; x.fillText(s.persona.name, 80, 320);
  const list = (title, items, y) => {
    x.font = "bold 40px -apple-system, sans-serif"; x.fillStyle = "#ffd1e1"; x.fillText(title, 80, y);
    x.fillStyle = "#fff"; x.font = "38px -apple-system, sans-serif";
    items.forEach((t, i) => x.fillText(`${i + 1}  ${t.length > 28 ? t.slice(0, 27) + "…" : t}`, 80, y + 66 + i * 58));
  };
  list("Top artists", s.topArtists.slice(0, 5).map((a) => a.name), 460);
  list("Top genres", s.genres.slice(0, 5).map((a) => `${a.name} · ${a.pct}%`), 860);
  x.font = "32px -apple-system, sans-serif"; x.globalAlpha = .7; x.fillText(`Diversity ${s.diversity}/100`, 80, 1270);
  const a = document.createElement("a");
  a.download = "resonance-card.png";
  a.href = c.toDataURL("image/png");
  a.click();
}

// ?range= picks the time range
export function mount(root, { query, setQuery }) {
  const el = $("#stats", root);
  let range = RANGES.includes(query.get("range")) ? query.get("range") : "medium";
  let stats = null;

  async function load() {
    $$("#range button", root).forEach((b) => b.classList.toggle("active", b.dataset.range === range));
    skeleton(el);
    try {
      const s = (stats = await api(`/api/stats?range=${range}`));
      const L = s.lifetime;
      const chips = (list, cls) => list.map((g) => h("span", { class: `chip ${cls}` }, `${cls === "up" ? "▲" : "▼"} ${g.name} ${g.delta > 0 ? "+" : ""}${g.delta}`));
      const body = make("t-stats", {
        persona: s.persona.name, blurb: s.persona.blurb,
        diversity: count(s.diversity), fresh: count(s.fresh), loyalty: count(s.loyalty),
        "streak-box": L ? {} : null, streak: L ? count(L.streak) : null,
        shift: s.rising.length || s.fading.length ? {} : null,
        "shift-chips": [...chips(s.rising, "up"), ...chips(s.fading, "down")],
        artists: s.topArtists.length ? s.topArtists.slice(0, 10).map((a, i) => rankRow(i, a.image, a.name, a.genres.slice(0, 2).join(", "), true)) : empty("No data"),
        tracks: s.topTracks.length ? s.topTracks.slice(0, 10).map((t, i) => rankRow(i, t.image, t.name, t.artists.join(", "))) : empty("No data"),
        genres: s.genres.length ? s.genres.map((g, i) => bar(g.name, g.pct, s.genres[0].pct || 1, i, `${g.pct}%`)) : empty("No genre data"),
        drift: driftChart(s.drift),
        since: L ? `tracked since ${L.since}` : "",
        lifetime: L ? {} : null,
        "no-lifetime": L ? null : {},
        ...(L && {
          plays: count(L.plays), "hours-total": count(Math.round(L.minutes / 60)), "days-active": count(L.activeDays),
          hours: histogram(L.hours, ["12a", "6a", "12p", "6p", "11p"]),
          days: histogram(L.days, ["S", "M", "T", "W", "T", "F", "S"]),
          played: L.topArtists.slice(0, 8).map((a, i) => rankRow(i, "", a.name, a.plays + " plays")),
        }),
      });
      el.replaceChildren(...body.children);
      reveal(el);
      countUp(el);
      if (app.status.features.ai) api("/api/summary").then((r) => {
        const box = $(".ai-sum", el);
        if (!r.text || !box) return;
        box.textContent = `✨ ${r.text}`;
        box.hidden = false;
      }).catch(() => {});
    } catch (e) { handleErr(el, e); }
  }

  $("#range", root).addEventListener("click", (e) => {
    if (!e.target.dataset.range) return;
    range = e.target.dataset.range;
    setQuery({ range: range === "medium" ? null : range });
    load();
  });
  el.addEventListener("click", (e) => {
    const row = e.target.closest(".rank[data-artist]");
    if (row) artistDive(row);
  });
  $("#share", root).onclick = () => stats && shareCard(stats);
  load();
}
