const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = { tab: "feed", range: "medium", mode: "similar", status: null, me: null, recs: [], stats: null };

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) throw Object.assign(new Error("not_connected"), { code: 401 });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const skeleton = (el, tiles) => { el.innerHTML = `<div class="sk${tiles ? " tiles" : ""}">${"<i></i>".repeat(tiles ? 8 : 6)}</div>`; };
const reveal = (el) => { el.classList.add("reveal"); [...el.children].forEach((c, i) => c.style.setProperty("--i", i)); };
function countUp(root) {
  root.querySelectorAll("[data-count]").forEach((el) => {
    const end = Number(el.dataset.count), suffix = el.dataset.suffix || "", t0 = performance.now();
    const step = (t) => {
      const p = Math.min((t - t0) / 900, 1);
      el.textContent = Math.round(end * (1 - Math.pow(1 - p, 4))).toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
function moveIndicator() {
  const b = $("#tabs button.active"), ind = $("#ind");
  if (!b) return;
  ind.style.left = b.offsetLeft + 14 + "px";
  ind.style.width = b.offsetWidth - 28 + "px";
}
window.addEventListener("resize", moveIndicator);

function banner(html, ok = false) {
  const el = $("#banner");
  el.innerHTML = html || "";
  el.hidden = !html;
  el.classList.toggle("ok", ok);
}


async function init() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  const err = new URLSearchParams(location.search).get("error");
  if (err) {
    banner(err === "blocked" ? "This account has been blocked by the site admin." : "Spotify sign-in failed. The admin should check the Client ID and that your Spotify email is added under User Management.");
    history.replaceState({}, "", "/");
  }
  state.status = await api("/api/status");
  $("#setup").hidden = state.status.configured;
  $("#spotify-btn").hidden = !state.status.configured;
  if (!state.status.connected) return showConnect();
  try { state.me = await api("/api/me"); } catch { return showConnect(); }

  $("#connect").hidden = true;
  $("#tabs").hidden = false;
  const acct = $("#account");
  acct.hidden = false;
  acct.innerHTML = `${state.me.image ? `<img src="${esc(state.me.image)}" alt="">` : ""}<span>${esc(state.me.name)}</span><button id="logout">sign out</button><button id="delete-me">delete my data</button>`;
  $("#logout").onclick = async () => { await post("/auth/logout", {}); location.reload(); };
  $("#delete-me").onclick = async () => {
    if (!confirm("Delete your listening history, votes and account from this site? This can't be undone.")) return;
    await post("/auth/delete-me", {});
    location.reload();
  };
  switchTab(state.tab);
}

function showConnect() {
  $("#connect").hidden = false;
  $("#tabs").hidden = true;
  $("#account").hidden = true;
  $$(".view").forEach((v) => (v.hidden = true));
}


function switchTab(tab) {
  state.tab = tab;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  moveIndicator();
  $$(".view").forEach((v) => (v.hidden = v.id !== `view-${tab}`));
  ({ feed: loadFeed, stats: loadStats, discover: loadRecs, blend: loadBlend })[tab]();
}
$("#tabs").addEventListener("click", (e) => e.target.dataset.tab && switchTab(e.target.dataset.tab));
$("#range").addEventListener("click", (e) => {
  if (!e.target.dataset.range) return;
  state.range = e.target.dataset.range;
  $$("#range button").forEach((b) => b.classList.toggle("active", b === e.target));
  loadStats();
});
$("#mode").addEventListener("click", (e) => {
  if (!e.target.dataset.mode) return;
  state.mode = e.target.dataset.mode;
  $$("#mode button").forEach((b) => b.classList.toggle("active", b === e.target));
  loadRecs();
});

document.addEventListener("click", async (e) => {
  const t = e.target;
  if (t.dataset?.refresh === "feed") return loadFeed(true);
  if (t.dataset?.refresh === "discover") return loadRecs(true);
  const play = t.closest?.("button.play");
  if (play) return togglePreview(play);
  const vote = t.closest?.("button.vote");
  if (vote) return sendVote(vote);
  const why = t.closest?.("button.why-btn");
  if (why) return explainRec(why);
});

function handleErr(el, e) {
  if (e.code === 401) return showConnect();
  el.innerHTML = `<div class="empty">Something went wrong: ${esc(e.message)}</div>`;
}


const audio = new Audio();
let playingBtn = null;
function stopPreview() {
  audio.pause();
  if (playingBtn) {
    playingBtn.textContent = "▶ Preview";
    playingBtn.closest(".tile, .item")?.classList.remove("playing");
  }
  playingBtn = null;
}
async function togglePreview(btn) {
  const wasMe = playingBtn === btn;
  stopPreview();
  if (wasMe) return;
  if (!btn.dataset.src) {
    btn.textContent = "…";
    try {
      const { url } = await api(`/api/preview?name=${encodeURIComponent(btn.dataset.name)}&artist=${encodeURIComponent(btn.dataset.artist)}`);
      if (!url) { btn.textContent = "No preview"; btn.disabled = true; return; }
      btn.dataset.src = url;
    } catch { btn.textContent = "▶ Preview"; return; }
  }
  audio.src = btn.dataset.src;
  audio.play().catch(() => {});
  btn.textContent = "■ Stop";
  btn.closest(".tile, .item")?.classList.add("playing");
  playingBtn = btn;
  audio.onended = stopPreview;
}

const cover = (src) => (src ? `<img src="${esc(src)}" alt="" loading="lazy">` : `<div class="ph"></div>`);
const trackKey = (t) => `${t.name}|${t.artists[0]}`.toLowerCase().trim();
const dataAttrs = (o) => `data-vote-info="${esc(JSON.stringify(o))}"`;

function actions(t, reason, genre, artist, withVotes) {
  const info = { track: t, reason, genre, artist };
  return `<div class="actions" ${dataAttrs(info)}>
    <button class="play" data-name="${esc(t.name)}" data-artist="${esc(t.artists[0])}" data-src="${esc(t.previewUrl || "")}">▶ Preview</button>
    ${t.url ? `<a class="open" href="${esc(t.url)}" target="_blank" rel="noopener">Open ↗</a>` : ""}
    ${withVotes ? `<button class="vote" data-vote="1" title="More like this">👍</button><button class="vote" data-vote="-1" title="Less like this">👎</button>` : ""}
    ${withVotes && state.status.features.ai ? `<button class="play why-btn">Why?</button>` : ""}</div>`;
}

async function sendVote(btn) {
  const wrap = btn.closest(".actions");
  const { track, genre, artist } = JSON.parse(wrap.dataset.voteInfo);
  const vote = Number(btn.dataset.vote);
  try {
    await post("/api/feedback", { vote, trackKey: trackKey(track), genre, artist: vote < 0 ? track.artists[0] : artist });
    const card = btn.closest(".tile, .item");
    if (vote < 0) { card.style.opacity = ".35"; card.style.pointerEvents = "none"; }
    else btn.classList.add("on");
  } catch (e) { banner(esc(e.message)); }
}

async function explainRec(btn) {
  const { track, reason } = JSON.parse(btn.closest(".actions").dataset.voteInfo);
  const box = document.createElement("div");
  box.className = "ai";
  box.textContent = "Thinking…";
  btn.closest(".tile, .meta, .item").appendChild(box);
  btn.remove();
  try { box.textContent = (await post("/api/explain", { track, reason })).text || "No explanation available."; }
  catch (e) { box.textContent = e.message; }
}


async function loadFeed(refresh) {
  const el = $("#feed");
  skeleton(el);
  try {
    const items = await api(`/api/feed${refresh ? "?refresh=1" : ""}`);
    if (!items.length) return (el.innerHTML = `<div class="empty">Not enough listening data yet. Play some music and come back!</div>`);
    el.innerHTML = items.map(feedItem).join("");
    reveal(el);
    releaseAlerts(items.filter((i) => i.type === "release"));
  } catch (e) { handleErr(el, e); }
}

function feedItem(i) {
  if (i.type === "insight") return `<div class="item insight"><div class="why">Insight</div><div class="title">${esc(i.title)}</div><div class="by">${esc(i.body)}</div></div>`;
  if (i.type === "event") {
    const e = i.event;
    return `<div class="item event"><div class="meta"><div class="why">Live · ${esc(e.artist)}</div><div class="title">${esc(e.name)}</div><div class="by">${esc(e.date)} · ${esc(e.venue)}, ${esc(e.city)}</div></div><div class="actions"><a class="open" href="${esc(e.url)}" target="_blank" rel="noopener">Tickets ↗</a></div></div>`;
  }
  if (i.type === "release") {
    const r = i.release;
    return `<div class="item">${cover(r.image)}<div class="meta"><div class="why">${esc(i.reason)}</div><div class="title">${esc(r.name)}</div><div class="by">${esc(r.artists.join(", "))} · ${esc(r.kind)} · ${esc(r.releaseDate)}</div></div><div class="actions"><a class="open" href="${esc(r.url || "#")}" target="_blank" rel="noopener">Open ↗</a></div></div>`;
  }
  const t = i.track;
  const rec = i.genre || i.artist;
  return `<div class="item">${cover(t.image)}<div class="meta"><div class="why">${esc(i.reason)}</div><div class="title">${esc(t.name)}</div><div class="by">${esc(t.artists.join(", "))} · ${esc(t.album)}</div></div>${actions(t, i.reason, i.genre, i.artist, rec)}</div>`;
}

// notify once per new release
function releaseAlerts(releases) {
  const btn = $("#notify");
  if (!("Notification" in window)) return;
  btn.hidden = Notification.permission !== "default";
  btn.onclick = async () => { await Notification.requestPermission(); btn.hidden = true; releaseAlerts(releases); };
  const seen = new Set(store.get("seenReleases", []));
  const fresh = releases.filter((r) => !seen.has(r.release.id) && r.reason.startsWith("New from"));
  if (Notification.permission === "granted" && seen.size && fresh.length) {
    new Notification("New music from your artists", { body: fresh.slice(0, 3).map((r) => `${r.release.artists[0]} – ${r.release.name}`).join("\n") });
  }
  store.set("seenReleases", [...new Set([...seen, ...releases.map((r) => r.release.id)])].slice(-300));
}


const rankRow = (i, img, title, sub) => `<div class="rank"><div class="i">${i + 1}</div>${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ""}<div class="t"><div>${esc(title)}</div><div>${esc(sub)}</div></div></div>`;
const bar = (name, pct, max, i = 0) => `<div class="bar" style="--i:${i}"><div class="name" title="${esc(name)}">${esc(name)}</div><div class="track"><div class="fill" style="width:${(pct / max) * 100}%"></div></div><div class="v">${pct}%</div></div>`;
const hist = (arr, labels) => arr ? `<div class="hist">${arr.map((v, i) => `<div style="height:${(v / Math.max(...arr, 1)) * 100}%;animation-delay:${i * 25}ms" title="${v} plays"></div>`).join("")}</div><div class="histlabels">${labels.map((l) => `<span>${l}</span>`).join("")}</div>` : `<div class="empty">Collecting…</div>`;
const COLORS = ["#7c5cff", "#ff5c8a", "#3ddc97", "#ffb84d", "#4dc3ff", "#c77dff"];

function driftChart(drift) {
  if (drift.length < 2) return `<div class="empty" style="padding:20px 0">Resonance saves a taste snapshot each day. Check back in a few days to see how your taste changes over time.</div>`;
  const tally = new Map();
  drift.forEach((d) => d.genres.forEach(([g, p]) => tally.set(g, (tally.get(g) || 0) + p)));
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map((x) => x[0]);
  const rows = drift.map((d) => {
    const map = new Map(d.genres);
    const segs = top.map((g, i) => `<div style="width:${map.get(g) || 0}%;background:${COLORS[i]}" title="${esc(g)} ${map.get(g) || 0}%"></div>`).join("");
    return `<div style="display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted)"><span style="width:72px">${d.day.slice(5)}</span><div class="stack" style="flex:1;margin:2px 0">${segs}</div></div>`;
  }).join("");
  return rows + `<div class="legend">${top.map((g, i) => `<span><i style="background:${COLORS[i]}"></i>${esc(g)}</span>`).join("")}</div>`;
}

async function loadStats() {
  const el = $("#stats");
  skeleton(el);
  try {
    const s = (state.stats = await api(`/api/stats?range=${state.range}`));
    const L = s.lifetime;
    const maxG = s.genres[0]?.pct || 1;
    const chips = (list, cls) => list.map((g) => `<span class="chip ${cls}">${cls === "up" ? "▲" : "▼"} ${esc(g.name)} ${g.delta > 0 ? "+" : ""}${g.delta}</span>`).join("");
    el.innerHTML = `
      <div id="ai-sum"></div>
      <div class="persona"><div>Your listening personality</div><h2>${esc(s.persona.name)}</h2><div>${esc(s.persona.blurb)}</div></div>
      <div class="statgrid">
        <div class="stat"><div class="n" data-count="${s.diversity}">0</div><div class="l">Genre diversity /100</div></div>
        <div class="stat"><div class="n" data-count="${s.fresh}" data-suffix="%">0</div><div class="l">Recent plays outside your usual artists</div></div>
        <div class="stat"><div class="n" data-count="${s.loyalty}" data-suffix="%">0</div><div class="l">Recent plays by your top artist</div></div>
        ${L ? `<div class="stat"><div class="n" data-count="${L.streak}" data-suffix="d">0</div><div class="l">Day streak</div></div>` : ""}
      </div>
      ${s.rising.length || s.fading.length ? `<div class="panel" style="margin-bottom:24px"><h3>Your taste is shifting</h3><div class="chips">${chips(s.rising, "up")}${chips(s.fading, "down")}</div><div style="color:var(--muted);font-size:13px">Recent listening vs. your all-time profile (percentage points).</div></div>` : ""}
      <div class="cols">
        <div class="panel"><h3>Top artists</h3>${s.topArtists.slice(0, 10).map((a, i) => rankRow(i, a.image, a.name, a.genres.slice(0, 2).join(", "))).join("") || "<div class='empty'>No data</div>"}</div>
        <div class="panel"><h3>Top tracks</h3>${s.topTracks.slice(0, 10).map((t, i) => rankRow(i, t.image, t.name, t.artists.join(", "))).join("") || "<div class='empty'>No data</div>"}</div>
      </div>
      <div class="cols">
        <div class="panel"><h3>Top genres</h3>${s.genres.map((g, i) => bar(g.name, g.pct, maxG, i)).join("") || "<div class='empty'>No genre data</div>"}</div>
        <div class="panel"><h3>Taste over time</h3>${driftChart(s.drift)}</div>
      </div>
      <div class="panel" style="margin-bottom:24px"><h3>Your lifetime history <span style="color:var(--muted);font-weight:400;font-size:13px">${L ? `tracked since ${esc(L.since)}` : ""}</span></h3>
        ${L ? `<div class="statgrid"><div class="stat"><div class="n" data-count="${L.plays}">0</div><div class="l">Plays tracked</div></div><div class="stat"><div class="n" data-count="${Math.round(L.minutes / 60)}" data-suffix="h">0</div><div class="l">Hours listened</div></div><div class="stat"><div class="n" data-count="${L.activeDays}">0</div><div class="l">Active days</div></div></div>
        <div class="cols"><div>
          <div style="color:var(--muted);font-size:13px;margin-bottom:6px">Hour of day</div>${hist(L.hours, ["12a", "6a", "12p", "6p", "11p"])}
          <div style="color:var(--muted);font-size:13px;margin:16px 0 6px">Day of week</div>${hist(L.days, ["S", "M", "T", "W", "T", "F", "S"])}
        </div><div><div style="color:var(--muted);font-size:13px;margin-bottom:6px">Most played (tracked)</div>${L.topArtists.slice(0, 8).map((a, i) => rankRow(i, "", a.name, a.plays + " plays")).join("")}</div></div>`
        : `<div class="empty" style="padding:20px 0">Spotify only reports your last 50 plays, so Resonance records them in the background while it's running. Keep it open (or run it now and then) and your lifetime stats build up here.</div>`}
      </div>`;
    reveal(el);
    countUp(el);
    if (state.status.features.ai) api("/api/summary").then((r) => { if (r.text) $("#ai-sum").innerHTML = `<div class="ai-sum">✨ ${esc(r.text)}</div>`; }).catch(() => {});
  } catch (e) { handleErr(el, e); }
}

// share card
$("#share").addEventListener("click", () => {
  const s = state.stats;
  if (!s) return;
  const c = document.createElement("canvas");
  c.width = 1080; c.height = 1350;
  const x = c.getContext("2d");
  const g = x.createLinearGradient(0, 0, 1080, 1350);
  g.addColorStop(0, "#2a1b6e"); g.addColorStop(1, "#8a1f4f");
  x.fillStyle = g; x.fillRect(0, 0, 1080, 1350);
  x.fillStyle = "#fff"; x.font = "bold 54px -apple-system, sans-serif"; x.fillText("◉ Resonance", 80, 120);
  x.font = "36px -apple-system, sans-serif"; x.globalAlpha = .75; x.fillText(`${state.me.name}'s taste`, 80, 175); x.globalAlpha = 1;
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
});


async function loadRecs(refresh) {
  const el = $("#recs");
  skeleton(el, true);
  try {
    state.recs = await api(`/api/recommendations?mode=${state.mode}${refresh ? "&refresh=1" : ""}`);
    if (!state.recs.length) return (el.innerHTML = `<div class="empty">No recommendations found. Try another mode.</div>`);
    el.innerHTML = state.recs.map(({ track: t, reason, genre, artist }) => `<div class="tile">${cover(t.image)}<div class="title" title="${esc(t.name)}">${esc(t.name)}</div><div class="by">${esc(t.artists.join(", "))}</div><div class="why">${esc(reason)}</div>${actions(t, reason, genre, artist, true)}</div>`).join("");
    reveal(el);
  } catch (e) { handleErr(el, e); }
}

async function savePlaylist(name, uris, btn) {
  if (!uris.length) return;
  btn.disabled = true;
  try {
    const r = await post("/api/playlist", { name, uris });
    banner(`Playlist created: <a href="${esc(r.url)}" target="_blank" rel="noopener">open in Spotify ↗</a>`, true);
  } catch (e) { banner(esc(e.message)); }
  btn.disabled = false;
}
$("#save-pl").addEventListener("click", (e) => {
  const label = $("#mode button.active").textContent;
  savePlaylist(`Resonance · ${label} · ${new Date().toLocaleDateString()}`, state.recs.map((r) => r.track.uri), e.target);
});


async function loadBlend() {
  const box = $("#mycode");
  try { box.value = (await api("/api/blend/export")).code; } catch (e) { handleErr(box.parentElement, e); }
}
$("#copycode").addEventListener("click", async () => { await navigator.clipboard.writeText($("#mycode").value); $("#copycode").textContent = "Copied ✓"; setTimeout(() => ($("#copycode").textContent = "Copy"), 1500); });
$("#compare").addEventListener("click", async () => {
  const out = $("#blend-result");
  skeleton(out, true);
  try {
    const r = await post("/api/blend/compare", { code: $("#theircode").value });
    out.innerHTML = `
      <div class="panel" style="margin-bottom:32px;text-align:center">
        <div class="l" style="color:var(--muted)">You + ${esc(r.theirName)}</div><div class="big" data-count="${r.score}" data-suffix="%">0</div>
        <div class="chips" style="justify-content:center">${r.sharedGenres.map((g) => `<span class="chip">${esc(g)}</span>`).join("") || "<span class='chip'>No shared genres, which is a fun blend in itself</span>"}</div>
        ${r.sharedArtists.length ? `<div style="color:var(--muted)">Both love: ${r.sharedArtists.map(esc).join(", ")}</div>` : ""}
      </div>
      <div class="row"><h3 style="margin:0;margin-right:auto">Songs you might both like</h3><button class="ghost" id="blend-save">＋ Save as playlist</button></div>
      <div class="grid">${r.tracks.map(({ track: t, reason }) => `<div class="tile">${cover(t.image)}<div class="title">${esc(t.name)}</div><div class="by">${esc(t.artists.join(", "))}</div><div class="why">${esc(reason)}</div>${actions(t, reason, "", "", false)}</div>`).join("")}</div>`;
    countUp(out);
    reveal($("#blend-result .grid"));
    $("#blend-save").onclick = (e) => savePlaylist(`Blend · you + ${r.theirName}`, r.tracks.map((x) => x.track.uri), e.target);
  } catch (e) { out.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
});

init().catch((e) => banner(esc(e.message)));
