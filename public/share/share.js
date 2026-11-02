// public share page (/s/:token): someone's stats snapshot, readable without signing in
import { $, banner, bar, empty, make, reveal } from "/lib/dom.js";

const rankRow = (i, img, title, sub) => make("t-rank", { i: String(i + 1), img: img ? { src: img } : null, title, sub });

async function init() {
  const token = location.pathname.split("/").pop();
  const r = await fetch(`/api/shared/${encodeURIComponent(token)}`);
  const s = await r.json().catch(() => ({}));
  if (!r.ok) {
    document.title = "Link not found · Resonance";
    return $("#page").replaceChildren(empty(s.error || "This link doesn't exist or was turned off."));
  }
  document.title = `${s.name}'s taste · Resonance`;
  const page = make("t-share", {
    name: s.name, name2: s.name,
    persona: s.persona.name, blurb: s.persona.blurb,
    artists: s.artists.length ? s.artists.map((a, i) => rankRow(i, a.image, a.name, "")) : empty("No data"),
    tracks: s.tracks.length ? s.tracks.map((t, i) => rankRow(i, t.image, t.name, t.artists.join(", "))) : empty("No data"),
    genres: s.genres.length ? s.genres.map((g, i) => bar(g.name, g.pct, s.genres[0].pct || 1, i, `${g.pct}%`)) : empty("No genre data"),
    diversity: `diversity ${s.diversity}/100`,
    when: `Snapshot from ${new Date(s.createdAt).toLocaleDateString()}`,
  });
  // signed out visitors keep the code through the spotify sign-in, see pendingBlend in app/shared.js
  $("[data-slot=blend]", page).href = "/blend";
  $("[data-slot=blend]", page).onclick = () => { try { sessionStorage.setItem("blend-code", s.code); } catch {} };
  $("#page").replaceChildren(page);
  reveal($(".cols", page));
}

init().catch((e) => banner(e.message));
