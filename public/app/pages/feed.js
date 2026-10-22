import { $, make, reveal, skeleton, store, empty } from "/lib/dom.js";
import { actions, api, autoplayOn, cover, eventItem, handleErr, isPlaying, stopPreview, togglePreview } from "/app/shared.js";

// feed filters: each item belongs to one category, chips only show categories that have items
const FEED_FILTERS = [
  ["all", "All"], ["artists", "New from your artists"], ["genre", "Fresh in your genres"], ["similar", "Recommended"], ["simartist", "Similar artists"],
  ["adventurous", "Adventurous"], ["deepcuts", "Deep cuts"], ["throwback", "Throwbacks"], ["event", "Concerts"], ["insight", "Insights"],
];
function feedCategory(i) {
  if (i.type === "release") return i.reason.startsWith("New from") ? "artists" : "genre";
  if (i.type === "track") return i.src || "similar";
  return i.type;
}

function feedItem(i) {
  if (i.type === "insight") return make("t-insight", { title: i.title, body: i.body });
  if (i.type === "event") return eventItem(i.event);
  if (i.type === "release") {
    const r = i.release;
    return make("t-release", { cover: cover(r.image), why: i.reason, title: r.name, by: `${r.artists.join(", ")} · ${r.kind} · ${r.releaseDate}`, open: { href: r.url || "#" } });
  }
  const t = i.track;
  return make("t-track", { cover: cover(t.image), why: i.reason, title: t.name, by: `${t.artists.join(", ")} · ${t.album}`, actions: actions(t, i.reason, i.genre, i.artist, i.genre || i.artist) });
}

// notify once per new release
function releaseAlerts(btn, releases) {
  if (!("Notification" in window)) return;
  btn.hidden = Notification.permission !== "default";
  btn.onclick = async () => { await Notification.requestPermission(); btn.hidden = true; releaseAlerts(btn, releases); };
  const seen = new Set(store.get("seenReleases", []));
  const fresh = releases.filter((r) => !seen.has(r.release.id) && r.reason.startsWith("New from"));
  if (Notification.permission === "granted" && seen.size && fresh.length) {
    new Notification("New music from your artists", { body: fresh.slice(0, 3).map((r) => `${r.release.artists[0]} – ${r.release.name}`).join("\n") });
  }
  store.set("seenReleases", [...new Set([...seen, ...releases.map((r) => r.release.id)])].slice(-300));
}

export function mount(root) {
  const el = $("#feed", root), filters = $("#feed-filters", root), auto = $("#autoplay", root);
  let feed = [];

  // plays the song on whichever card is mostly on screen, stops on cards without a song
  let reelObserver = null;
  function watchReels() {
    reelObserver?.disconnect();
    reelObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting || !autoplayOn()) continue;
        const btn = e.target.querySelector("button.play[data-name]");
        if (!btn) { stopPreview(true); continue; }
        if (!isPlaying(btn)) togglePreview(btn, true);
      }
    }, { root: el, threshold: 0.65 });
    [...el.children].forEach((c) => reelObserver.observe(c));
  }

  function render() {
    const counts = {};
    feed.forEach((i) => { const c = feedCategory(i); counts[c] = (counts[c] || 0) + 1; });
    let f = store.get("feedFilter", "all");
    if (f !== "all" && !counts[f]) f = "all";
    filters.replaceChildren(...FEED_FILTERS.filter(([k]) => k === "all" || counts[k]).map(([k, label]) =>
      make("t-filter", { chip: { text: k === "all" ? label : `${label} ${counts[k]}`, "data-filter": k, class: k === f ? "chip up" : "chip" } })));
    stopPreview(true);
    el.replaceChildren(...(f === "all" ? feed : feed.filter((i) => feedCategory(i) === f)).map(feedItem));
    el.scrollTop = 0;
    reveal(el);
    watchReels();
  }

  async function load(refresh) {
    skeleton(el);
    try {
      feed = await api(`/api/feed${refresh ? "?refresh=1" : ""}`);
      if (!feed.length) return el.replaceChildren(empty("Not enough listening data yet. Play some music and come back!"));
      render();
      releaseAlerts($("#notify", root), feed.filter((i) => i.type === "release"));
    } catch (e) { handleErr(el, e); }
  }

  filters.addEventListener("click", (e) => {
    if (!e.target.dataset.filter) return;
    store.set("feedFilter", e.target.dataset.filter);
    render();
  });

  const paintAutoplay = () => { auto.textContent = autoplayOn() ? "🔊 Autoplay on" : "🔈 Autoplay off"; };
  auto.onclick = () => {
    store.set("autoplay", !autoplayOn());
    paintAutoplay();
    if (!autoplayOn()) stopPreview(true);
    else watchReels();
  };
  paintAutoplay();
  $("#refresh", root).onclick = () => load(true);
  load();

  return () => { reelObserver?.disconnect(); stopPreview(true); };
}
