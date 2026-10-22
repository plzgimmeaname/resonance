// things every page of the app uses: api calls, track cards, previews, playlists, votes
import { $, banner, empty, h, make, store } from "/lib/dom.js";

// server status and the signed in user, filled in by main.js. go() is the router's navigate
export const app = { status: null, me: null, go: null };

// all backend calls go through here, 401 means not logged in
export async function api(path, opts) {
  const r = await fetch(path, opts);
  if (r.status === 401) throw Object.assign(new Error("not_connected"), { code: 401 });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
export const post = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// the session ran out, back to the connect page
export function signedOut() {
  app.me = null;
  app.go("/connect", true);
}
export function handleErr(el, e) {
  if (e.code === 401) return signedOut();
  el.replaceChildren(empty(`Something went wrong: ${e.message}`));
}

export const cover = (src) => (src ? h("img", { src, alt: "", loading: "lazy" }) : h("div", { class: "ph" }));
const trackKey = (t) => `${t.name}|${t.artists[0]}`.toLowerCase().trim();

// preview / playlist / open / vote buttons under a track
export function actions(t, reason, genre, artist, withVotes) {
  const votes = withVotes ? {} : null;
  const el = make("t-actions", {
    preview: { dataset: { name: t.name, artist: t.artists[0], src: t.previewUrl || "" } },
    add: t.uri ? { dataset: { uri: t.uri } } : null,
    open: t.url ? { href: t.url } : null,
    up: votes, down: votes,
    why: withVotes && app.status.features.ai ? {} : null,
  });
  el.dataset.voteInfo = JSON.stringify({ track: t, reason, genre, artist });
  return el;
}

export const trackTile = ({ track: t, reason, genre = "", artist = "" }, withVotes = false) => make("t-tile", {
  cover: cover(t.image), title: { text: t.name, title: t.name }, by: t.artists.join(", "), why: reason,
  actions: actions(t, reason, genre, artist, withVotes),
});

export const eventItem = (e) => make("t-event", {
  artist: e.artist, name: e.name, where: `${e.date} · ${e.venue}, ${e.city}`, tickets: { href: e.url },
});


// song previews, one at a time
const audio = new Audio();
let playingBtn = null;
// want = the button that should be playing, so a slow lookup doesn't start after you scrolled away
let want = null;
export const autoplayOn = () => store.get("autoplay", true);
export const isPlaying = (btn) => playingBtn === btn;
// cancel also drops a preview that is still being looked up
export function stopPreview(cancel = false) {
  if (cancel) want = null;
  audio.pause();
  if (playingBtn) {
    playingBtn.textContent = "▶ Preview";
    playingBtn.closest(".tile, .item")?.classList.remove("playing");
  }
  playingBtn = null;
}
export async function togglePreview(btn, forcePlay = false) {
  const wasMe = playingBtn === btn;
  stopPreview();
  want = btn;
  if (wasMe && !forcePlay) return (want = null);
  if (!btn.dataset.src) {
    btn.textContent = "…";
    try {
      const { url } = await api(`/api/preview?name=${encodeURIComponent(btn.dataset.name)}&artist=${encodeURIComponent(btn.dataset.artist)}`);
      if (!url) { btn.textContent = "No preview"; btn.disabled = true; return; }
      btn.dataset.src = url;
    } catch { btn.textContent = "▶ Preview"; return; }
    if (want !== btn) return (btn.textContent = "▶ Preview");
  }
  audio.src = btn.dataset.src;
  btn.textContent = "■ Stop";
  btn.closest(".tile, .item")?.classList.add("playing");
  playingBtn = btn;
  // browsers can block autoplay until the page has been clicked, fall back to a normal button
  audio.play().catch(() => { if (playingBtn === btn) stopPreview(); });
  // in the feed, move on to the next card when the clip ends
  audio.onended = () => {
    const card = btn.closest(".reels > .item");
    stopPreview();
    if (card && autoplayOn()) card.nextElementSibling?.scrollIntoView({ behavior: "smooth" });
  };
}


// add a song to one of the user's existing playlists
let myPlaylists = null;
const closePlaylists = () => { $("#pl-modal").hidden = true; };
$("#pl-close").addEventListener("click", closePlaylists);
$("#pl-modal").addEventListener("click", (e) => e.target.id === "pl-modal" && closePlaylists());
document.addEventListener("keydown", (e) => e.key === "Escape" && closePlaylists());
async function openPlaylists(uri) {
  const list = $("#pl-list");
  $("#pl-modal").hidden = false;
  list.replaceChildren(empty("Loading…"));
  try {
    myPlaylists ??= await api("/api/playlists");
    if (!myPlaylists.length) return list.replaceChildren(empty("No playlists found."));
    list.replaceChildren(...myPlaylists.map((p) => {
      const b = make("t-pl", { cover: cover(p.image), name: p.name, tracks: String(p.tracks) });
      b.onclick = async () => {
        b.disabled = true;
        try {
          await post("/api/playlist/add", { playlistId: p.id, uri });
          closePlaylists();
          banner(`Added to ${p.name}`, true);
        } catch (e) { closePlaylists(); banner(e.message); }
      };
      return b;
    }));
  } catch (e) { closePlaylists(); banner(e.message); }
}

export async function savePlaylist(name, uris, btn) {
  if (!uris.length) return;
  btn.disabled = true;
  try {
    const r = await post("/api/playlist", { name, uris });
    banner(["Playlist created: ", h("a", { href: r.url, target: "_blank", rel: "noopener" }, "open in Spotify ↗")], true);
  } catch (e) { banner(e.message); }
  btn.disabled = false;
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
  } catch (e) { banner(e.message); }
}

async function explainRec(btn) {
  const { track, reason } = JSON.parse(btn.closest(".actions").dataset.voteInfo);
  const box = h("div", { class: "ai" }, "Thinking…");
  btn.closest(".tile, .meta, .item").appendChild(box);
  btn.remove();
  try { box.textContent = (await post("/api/explain", { track, reason })).text || "No explanation available."; }
  catch (e) { box.textContent = e.message; }
}

// track buttons work the same on every page
document.addEventListener("click", (e) => {
  const t = e.target;
  const add = t.closest?.("button.add-btn");
  if (add) return openPlaylists(add.dataset.uri);
  const play = t.closest?.("button.play:not(.add-btn):not(.why-btn)");
  if (play) return togglePreview(play);
  const vote = t.closest?.("button.vote");
  if (vote) return sendVote(vote);
  const why = t.closest?.("button.why-btn");
  if (why) return explainRec(why);
});
