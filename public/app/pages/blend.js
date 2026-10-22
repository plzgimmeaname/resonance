import { $, countUp, empty, h, make, reveal, skeleton } from "/lib/dom.js";
import { api, handleErr, post, savePlaylist, trackTile } from "/app/shared.js";

export function mount(root) {
  const mine = $("#mycode", root), out = $("#blend-result", root);
  api("/api/blend/export").then((r) => (mine.value = r.code)).catch((e) => handleErr(mine.parentElement, e));

  $("#copycode", root).onclick = async (e) => {
    await navigator.clipboard.writeText(mine.value);
    e.target.textContent = "Copied ✓";
    setTimeout(() => (e.target.textContent = "Copy"), 1500);
  };

  $("#compare", root).onclick = async () => {
    skeleton(out, true);
    try {
      const r = await post("/api/blend/compare", { code: $("#theircode", root).value });
      const chip = (text) => h("span", { class: "chip" }, text);
      const res = make("t-blend", {
        name: r.theirName,
        score: { dataset: { count: r.score } },
        genres: r.sharedGenres.length ? r.sharedGenres.map(chip) : chip("No shared genres, which is a fun blend in itself"),
        artists: r.sharedArtists.length ? `Both love: ${r.sharedArtists.join(", ")}` : null,
        tracks: r.tracks.map((t) => trackTile(t)),
      });
      out.replaceChildren(res);
      countUp(out);
      reveal($(".grid", out));
      $("#blend-save", out).onclick = (e) => savePlaylist(`Blend · you + ${r.theirName}`, r.tracks.map((x) => x.track.uri), e.target);
    } catch (e) { out.replaceChildren(empty(e.message)); }
  };
}
