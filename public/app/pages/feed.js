import { $, empty, h, label, make, reveal, skeleton, store } from "/lib/dom.js";
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
  const el = $("#feed", root), filters = $("#feed-filters", root), auto = $("#autoplay", root), dots = $("#reel-pos", root);
  let feed = [], current = 0;

  // the dots on the right show where you are, a window of up to 9 around the current card
  function paintDots() {
    const n = el.children.length;
    const from = Math.max(0, Math.min(current - 4, n - 9));
    dots.replaceChildren(...Array.from({ length: Math.min(n, 9) }, (_, i) => h("i", { class: from + i === current ? "on" : null })));
  }

  // plays the song on whichever card is mostly on screen, stops on cards without a song
  let reelObserver = null;
  function watchReels() {
    reelObserver?.disconnect();
    reelObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        current = [...el.children].indexOf(e.target);
        paintDots();
        if (!autoplayOn()) continue;
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
    filters.replaceChildren(...FEED_FILTERS.filter(([k]) => k === "all" || counts[k]).map(([k, name]) => {
      const chip = make("t-filter", { chip: { "data-filter": k, class: k === f ? "chip up" : "chip", "aria-pressed": String(k === f) } });
      chip.append(name, ...(k === "all" ? [] : [" ", h("span", { class: "n" }, String(counts[k]))]));
      return chip;
    }));
    stopPreview(true);
    el.replaceChildren(...(f === "all" ? feed : feed.filter((i) => feedCategory(i) === f)).map(feedItem));
    el.scrollTop = 0;
    current = 0;
    paintDots();
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
    const chip = e.target.closest("[data-filter]");
    if (!chip) return;
    store.set("feedFilter", chip.dataset.filter);
    render();
  });

  // j / k (or the arrow keys while the feed has focus) move a card, space plays or stops it
  const go = (d) => el.children[Math.max(0, Math.min(current + d, el.children.length - 1))]?.scrollIntoView({ behavior: "smooth" });
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest("input, textarea, select") || document.querySelector("dialog[open]")) return;
    const inFeed = e.target === el;
    if (e.key === "j" || (inFeed && e.key === "ArrowDown")) { e.preventDefault(); go(1); }
    else if (e.key === "k" || (inFeed && e.key === "ArrowUp")) { e.preventDefault(); go(-1); }
    else if (e.key === " " && (inFeed || e.target === document.body)) {
      const btn = el.children[current]?.querySelector("button.play");
      if (btn) { e.preventDefault(); togglePreview(btn); }
    }
  };
  document.addEventListener("keydown", onKey);

  const paintAutoplay = () => {
    label(auto, autoplayOn() ? "volume" : "mute", autoplayOn() ? "Autoplay on" : "Autoplay off");
    auto.setAttribute("aria-pressed", String(autoplayOn()));
  };
  auto.onclick = () => {
    store.set("autoplay", !autoplayOn());
    paintAutoplay();
    if (!autoplayOn()) stopPreview(true);
    else watchReels();
  };
  paintAutoplay();
  $("#refresh", root).onclick = () => load(true);
  load();

  return () => { reelObserver?.disconnect(); stopPreview(true); document.removeEventListener("keydown", onKey); };
}
