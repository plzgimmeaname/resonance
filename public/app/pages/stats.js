import { $, $$, banner, bar, countUp, empty, h, hist, label, make, reveal, skeleton } from "/lib/dom.js";
import { api, app, handleErr, post } from "/app/shared.js";

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

// labels has one entry per bar, blanks for bars without one, so each label sits under its own bar
function histogram(arr, labels, names) {
  if (!arr) return empty("Collecting…");
  const chart = hist(arr, arr.map((v, i) => `${names[i]}: ${v.toLocaleString()} plays`));
  const top = arr.indexOf(Math.max(...arr));
  chart.children[top]?.classList.add("peak");
  return [chart, h("div", { class: "histlabels" }, labels.map((l) => h("span", {}, l)))];
}
const HOURS = Array.from({ length: 24 }, (_, i) => `${i % 12 || 12}${i < 12 ? "am" : "pm"}`);
const HOUR_LABELS = HOURS.map((x, i) => (i % 6 === 0 ? x.replace("m", "") : ""));
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const peakOf = (arr, names) => (arr?.some(Boolean) ? `· busiest ${names[arr.indexOf(Math.max(...arr))]}` : "");

// plays per month, last 12 months that have any
function monthsChart(monthly) {
  const max = Math.max(...monthly.map((m) => m.plays), 1);
  const peak = monthly.findIndex((m) => m.plays === max);
  return h("div", { class: "months" }, monthly.map((m, i) => {
    const d = new Date(`${m.month}-15T12:00:00`);
    const name = d.toLocaleDateString(undefined, { month: "short" });
    return h("div", { class: i === peak ? "peak" : null, title: `${d.toLocaleDateString(undefined, { month: "long", year: "numeric" })}: ${m.plays.toLocaleString()} plays` },
      h("b", {}, m.plays >= 1000 ? `${(m.plays / 1000).toFixed(1)}k` : String(m.plays)),
      h("i", { style: `height:${Math.max(2, (m.plays / max) * 100)}%;animation-delay:${i * 30}ms` }),
      h("small", {}, monthly.length > 8 ? name.charAt(0) : name));
  }));
}

function driftChart(drift) {
  if (drift.length < 2) return empty("Resonance saves a taste snapshot each day. Check back in a few days to see how your taste changes over time.", { style: "padding:20px 0" });
  const tally = new Map();
  drift.forEach((d) => d.genres.forEach(([g, p]) => tally.set(g, (tally.get(g) || 0) + p)));
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => x[0]);
  const rows = drift.map((d) => {
    const map = new Map(d.genres);
    const segs = top.map((g, i) => h("div", { style: `width:${map.get(g) || 0}%;background:${COLORS[i]}`, title: `${g} ${map.get(g) || 0}%` }));
    const day = new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return h("div", { class: "drift-row" }, h("span", {}, day), h("div", { class: "stack" }, segs));
  });
  return [...rows, h("div", { class: "legend" }, top.map((g, i) => h("span", {}, h("i", { style: `background:${COLORS[i]}` }), g)))];
}

async function artistDive(row) {
  const open = row.nextElementSibling;
  if (open?.classList.contains("dive")) return open.remove();
  const box = h("div", { class: "dive" }, "Loading…");
  row.after(box);
  try {
    const a = await api(`/api/artist?name=${encodeURIComponent(row.dataset.artist)}`);
    if (!a.name) return (box.textContent = "No Last.fm info for this artist.");
    box.replaceWith(make("t-dive", {
      tags: a.tags.map((t) => h("span", { class: "chip" }, t)),
      listeners: `${a.listeners.toLocaleString()} Last.fm listeners`,
      bio: a.bio ? a.bio.slice(0, 400) + (a.bio.length > 400 ? "…" : "") : null,
      similar: a.similar.length ? `Similar: ${a.similar.join(", ")}` : null,
      link: { href: a.url },
    }));
  } catch (e) { box.textContent = e.message; }
}

// a 1080x1350 image of your persona, top artists and genres, drawn to match the persona card on the page
function shareCard(s) {
  const W = 1080, H = 1350, P = 88;
  const c = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const x = c.getContext("2d");
  const font = (w, size) => `${w} ${size}px -apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif`;
  const glow = (cx, cy, r, color) => {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, color); g.addColorStop(1, "rgba(0,0,0,0)");
    x.fillStyle = g; x.fillRect(0, 0, W, H);
  };
  x.fillStyle = "#0b0816"; x.fillRect(0, 0, W, H);
  glow(0, 0, 900, "rgba(139,108,255,.75)");
  glow(W, H, 900, "rgba(224,85,214,.6)");
  const fit = (t, max) => { let out = t; while (x.measureText(out).width > max && out.length > 1) out = out.slice(0, -2) + "…"; return out; };

  x.fillStyle = "#fff";
  x.font = font(600, 34); x.fillText("resonance", P, P + 20);
  x.globalAlpha = .7; x.font = font(600, 26); x.fillText(`${app.me.name.toUpperCase()}'S LISTENING PERSONALITY`, P, 280); x.globalAlpha = 1;
  x.font = font(700, 104); x.fillText(fit(s.persona.name, W - P * 2), P, 390);
  x.globalAlpha = .8; x.font = font(400, 34); x.fillText(fit(s.persona.blurb, W - P * 2), P, 450); x.globalAlpha = 1;

  // two frosted panels
  const panel = (y, h) => { x.fillStyle = "rgba(255,255,255,.1)"; x.beginPath(); x.roundRect(P - 28, y, W - (P - 28) * 2, h, 36); x.fill(); };
  panel(530, 400);
  x.fillStyle = "#fff"; x.globalAlpha = .65; x.font = font(600, 24); x.fillText("TOP ARTISTS", P, 590); x.globalAlpha = 1;
  s.topArtists.slice(0, 5).forEach((a, i) => {
    x.globalAlpha = .5; x.font = font(600, 36); x.fillText(String(i + 1), P, 655 + i * 62); x.globalAlpha = 1;
    x.font = font(600, 40); x.fillText(fit(a.name, W - P * 2 - 70), P + 60, 655 + i * 62);
  });
  panel(960, 300);
  x.globalAlpha = .65; x.font = font(600, 24); x.fillText("TOP GENRES", P, 1020); x.globalAlpha = 1;
  const top = s.genres.slice(0, 4), max = top[0]?.pct || 1;
  top.forEach((g, i) => {
    const y = 1065 + i * 52;
    x.font = font(500, 32); x.fillText(fit(g.name, 340), P, y + 10);
    x.fillStyle = "rgba(255,255,255,.18)"; x.beginPath(); x.roundRect(P + 380, y - 8, 440, 14, 7); x.fill();
    x.fillStyle = "#fff"; x.beginPath(); x.roundRect(P + 380, y - 8, Math.max(14, 440 * (g.pct / max)), 14, 7); x.fill();
    x.globalAlpha = .7; x.font = font(500, 26); x.fillText(`${g.pct}%`, P + 840, y + 8); x.globalAlpha = 1;
  });
  x.globalAlpha = .6; x.font = font(500, 26); x.fillText(`Genre diversity ${s.diversity}/100`, P, H - 50); x.globalAlpha = 1;

  const a = document.createElement("a");
  a.download = "resonance-card.png";
  a.href = c.toDataURL("image/png");
  a.click();
}

// public link with a snapshot of your stats, see src/share.ts
function shareLink(root) {
  const modal = $("#share-modal", root), url = $("#share-url", root);
  const show = (r) => {
    if (!r) return modal.close();
    url.value = `${location.origin}/s/${r.token}`;
    $("#share-local", root).hidden = !["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
    if (!modal.open) modal.showModal();
    url.select();
  };
  const run = (btn, fn) => async () => {
    btn.disabled = true;
    try { await fn(); } catch (e) { banner(e.message); } finally { btn.disabled = false; }
  };
  $("#share-link", root).onclick = run($("#share-link", root), async () => show((await api("/api/share")) ?? (await post("/api/share", {}))));
  $("#share-new", root).onclick = run($("#share-new", root), async () => show(await post("/api/share", {})));
  $("#share-off", root).onclick = run($("#share-off", root), async () => {
    await api("/api/share", { method: "DELETE" });
    modal.close();
    banner("Share link turned off.", true);
  });
  const copy = $("#share-copy", root);
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(url.value); } catch { url.select(); return; }
    label(copy, "check", "Copied");
    setTimeout(() => label(copy, "copy", "Copy"), 1500);
  };
  $("#share-close", root).onclick = () => modal.close();
  modal.addEventListener("click", (e) => e.target === modal && modal.close());
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
          hours: histogram(L.hours, HOUR_LABELS, HOURS),
          days: histogram(L.days, DAYS.map((d) => d.slice(0, 3)), DAYS),
          "peak-hour": peakOf(L.hours, HOURS), "peak-day": peakOf(L.days, DAYS),
          "months-box": L.monthly?.length > 1 ? {} : null,
          months: L.monthly?.length > 1 ? monthsChart(L.monthly) : null,
          played: L.topArtists.slice(0, 8).map((a, i) => rankRow(i, "", a.name, a.plays + " plays")),
        }),
      });
      el.replaceChildren(...body.children);
      reveal(el);
      countUp(el);
      if (app.status.features.ai) api("/api/summary").then((r) => {
        const box = $(".ai-sum", el);
        if (!r.text || !box) return;
        box.lastElementChild.textContent = r.text;
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
  shareLink(root);
  load();
}
