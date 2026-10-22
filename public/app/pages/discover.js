import { $, $$, empty, reveal, skeleton } from "/lib/dom.js";
import { api, app, handleErr, post, savePlaylist, trackTile } from "/app/shared.js";

const MODES = ["similar", "now", "adventurous", "deepcuts"];

// ?mode= picks the recommendation mode
export function mount(root, { query, setQuery }) {
  const el = $("#recs", root);
  let mode = MODES.includes(query.get("mode")) ? query.get("mode") : "similar";
  let recs = [];

  const show = (list, withVotes, none) => {
    recs = list;
    if (!list.length) return el.replaceChildren(empty(none));
    el.replaceChildren(...list.map((r) => trackTile(r, withVotes)));
    reveal(el);
  };

  async function load(refresh) {
    $$("#mode button", root).forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
    skeleton(el, true);
    try { show(await api(`/api/recommendations?mode=${mode}${refresh ? "&refresh=1" : ""}`), true, "No recommendations found. Try another mode."); }
    catch (e) { handleErr(el, e); }
  }

  $("#mode", root).addEventListener("click", (e) => {
    if (!e.target.dataset.mode) return;
    mode = e.target.dataset.mode;
    setQuery({ mode: mode === "similar" ? null : mode });
    load();
  });
  $("#refresh", root).onclick = () => load(true);
  $("#save-pl", root).onclick = (e) => {
    const label = $("#mode button.active", root).textContent;
    savePlaylist(`Resonance · ${label} · ${new Date().toLocaleDateString()}`, recs.map((r) => r.track.uri), e.target);
  };

  // vibe playlist: claude picks songs, they show up as normal recommendations so save/preview work
  $("#vibe-box", root).hidden = !app.status.features.ai;
  const vibe = $("#vibe", root), go = $("#vibe-go", root);
  go.onclick = async () => {
    const text = vibe.value.trim();
    if (!text) return;
    go.disabled = true;
    skeleton(el, true);
    try { show(await post("/api/vibe", { vibe: text }), false, "Couldn't find songs for that. Try describing it differently."); }
    catch (e) { handleErr(el, e); }
    go.disabled = false;
  };
  vibe.addEventListener("keydown", (e) => e.key === "Enter" && go.click());

  load();
}
