import { $, $$, banner, countUp, empty, h, icon, label, make, reveal, skeleton } from "/lib/dom.js";
import { actions, api, cover, handleErr, post, savePlaylist } from "/app/shared.js";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const SHOW_FIRST = 40;

// ?id= opens one playlist, without it you get the list of playlists
export function mount(root, { query }) {
  let alive = true; // a slow response shouldn't draw over a page you already left
  const out = $("#pl-out", root);
  const id = query.get("id");
  if (id) detail(id);
  else list();

  /* ------------------------------------------------------------- list */

  async function list() {
    skeleton(out, true);
    try {
      const r = await api("/api/refine/playlists");
      if (!alive) return;
      const page = [h("div", { class: "row" }, h("h1", {}, "Playlists"))];
      page.push(h("p", { class: "sub", style: "margin-top:0" }, "Pick a playlist to clear out duplicates, drop songs that don't fit, and add ones that do."));
      if (!r.canEdit) {
        page.push(h("div", { class: "panel", style: "margin-bottom:24px" },
          h("p", { style: "margin-top:0" }, "Spotify needs one more permission before this app can change your playlists."),
          h("a", { class: "btn", href: "/auth/spotify/login" }, "Allow playlist editing")));
      }
      if (r.playlists.length) {
        page.push(h("div", { class: "grid", id: "pl-grid" }, r.playlists.map((p) => make("t-plcard", {
          link: { href: `/playlists?id=${encodeURIComponent(p.id)}` },
          cover: cover(p.image), name: { text: p.name, title: p.name },
          meta: [plural(p.tracks, "song"), p.public === true ? "public" : p.public === false ? "private" : null, p.collaborative ? "collaborative" : null].filter(Boolean).join(" · "),
        }))));
      } else page.push(empty("No playlists found."));
      if (r.hidden) page.push(h("p", { class: "sub", style: "font-size:13px;margin-top:24px" }, `${plural(r.hidden, "playlist")} you follow ${r.hidden === 1 ? "isn't" : "aren't"} shown. Spotify only lets apps open playlists you own or collaborate on.`));
      out.replaceChildren(...page);
      const grid = $("#pl-grid", out);
      if (grid) reveal(grid);
    } catch (e) { if (alive) handleErr(out, e); }
  }

  /* ----------------------------------------------------------- detail */

  async function detail(id, refresh = false) {
    skeleton(out);
    try {
      const d = await api(`/api/refine/playlists/${encodeURIComponent(id)}${refresh ? "?refresh=1" : ""}`);
      if (alive) render(id, d);
    } catch (e) {
      if (!alive) return;
      if (e.code === 401) return handleErr(out, e);
      out.replaceChildren(h("a", { class: "ghost", href: "/playlists" }, icon("back"), "Playlists"), empty(e.message));
    }
  }

  function render(id, d) {
    const tracks = d.tracks;
    const name = d.playlist.name;
    // positions of the songs ticked in any list. exact duplicates start ticked, since removing a copy loses nothing
    const sel = new Set(tracks.filter((t) => t.flags.includes("duplicate") && t.exact && d.canMerge).map((t) => t.position));
    const added = new Set();

    const fitCell = (t) => h("div", { class: `fit${t.fit !== null && t.fit < 0.3 ? " low" : ""}`, title: "How much of this playlist shares this song's genres" },
      t.fit === null ? "no genre info" : `${Math.round(t.fit * 100)}% fit`,
      h("div", { class: "fitbar" }, h("i", { "--w": `${Math.round((t.fit ?? 0) * 100)}%` })));

    const why = (t) => {
      if (t.flags.includes("duplicate")) return t.exact ? `Duplicate of #${t.dupOf + 1}` : `Another version of #${t.dupOf + 1}`;
      if (t.flags.includes("outlier")) return "Doesn't seem to fit";
      return t.genres.slice(0, 2).join(", ");
    };

    const row = (t) => make("t-refrow", {
      chk: {
        dataset: { pos: t.position }, "aria-label": `Select ${t.name}`,
        checked: sel.has(t.position),
        // without the full list we can't tell which copy is the first, so exact duplicates can't be merged
        disabled: t.flags.includes("duplicate") && t.exact && !d.canMerge,
      },
      cover: cover(t.image), title: { text: `${t.position + 1}. ${t.name}`, title: t.name }, by: t.artists.join(", "), why: why(t),
      fit: fitCell(t), actions: actions(t, "", "", "", false),
    });

    // what the ticked songs mean: copies to merge into one, and songs to take out completely
    const selection = () => {
      const remove = new Set(), dedupe = new Set();
      for (const t of tracks) if (sel.has(t.position)) (t.flags.includes("duplicate") && t.exact ? dedupe : remove).add(t.uri);
      for (const u of remove) dedupe.delete(u);
      return { remove: [...remove], dedupe: [...dedupe] };
    };

    const flagged = tracks.filter((t) => t.flags.length).sort((a, b) => Number(b.flags.includes("duplicate")) - Number(a.flags.includes("duplicate")) || a.position - b.position);

    const notes = [];
    if (d.truncated) notes.push(`Showing the first ${tracks.length} of ${d.total} songs.`);
    if (!d.canMerge) notes.push("This playlist is too long to merge exact duplicates safely, but you can still remove songs.");
    if (d.unknownArtists) notes.push(`Genres for ${plural(d.unknownArtists, "artist")} haven't been looked up yet. Re-analyze to learn more.`);
    if (!d.profiled) notes.push("There isn't enough genre information to say what this playlist is, so only duplicates are flagged.");
    else if (d.unknownGenres) notes.push(`${plural(d.unknownGenres, "song")} ${d.unknownGenres === 1 ? "has" : "have"} no genre info and ${d.unknownGenres === 1 ? "isn't" : "aren't"} judged.`);

    const stat = (n, label) => h("div", { class: "stat" }, h("div", { class: "n", "data-count": n }, "0"), h("div", { class: "l" }, label));
    const view = make("t-refine", {
      name: name,
      notes: notes.map((n) => h("p", { class: "refnote" }, n)),
      stats: [stat(tracks.length, "Songs"), stat(d.duplicates, "Duplicates"), stat(d.outliers, "May not fit"), stat(d.unknownGenres, "No genre info")],
      genres: d.genres.map((g) => h("span", { class: "chip" }, `${g.name} ${g.pct}%`)),
      "flag-head": flagged.length ? {} : null,
      flagged: flagged.length ? flagged.map(row) : empty("Nothing to clean up. No duplicates, and every song fits.", { style: "padding:24px 0" }),
      sugs: d.suggestions.length ? d.suggestions.map(({ track: t, reason }) => make("t-refsug", {
        cover: cover(t.image), title: { text: t.name, title: t.name }, by: t.artists.join(", "), why: reason,
        actions: actions(t, reason, "", "", false), add: { dataset: { uri: t.uri } },
      })) : empty("No suggestions right now. Try Re-analyze.", { style: "padding:24px 0" }),
      "all-title": `All ${plural(tracks.length, "song")}`,
      all: tracks.slice(0, SHOW_FIRST).map(row),
    });
    out.replaceChildren(view);
    countUp(view);
    ["flagged", "sugs"].forEach((_, i) => reveal($$(".feed", view)[i]));

    // the rest of a long playlist
    const more = $("#rf-more", view);
    if (tracks.length > SHOW_FIRST) {
      more.hidden = false;
      more.textContent = `Show all ${tracks.length} songs`;
      more.onclick = () => {
        $$(".feed", view)[2].append(...tracks.slice(SHOW_FIRST).map(row));
        more.hidden = true;
      };
    }

    /* selection and the bar at the bottom */
    const bar = $("#selbar", view);
    function updateBar() {
      const { remove, dedupe } = selection();
      bar.hidden = !sel.size;
      const parts = [remove.length && `remove ${plural(remove.length, "song")}`, dedupe.length && `merge ${plural(dedupe.length, "duplicate")}`].filter(Boolean);
      $("#sel-n", view).textContent = `${sel.size} selected${parts.length ? ` · will ${parts.join(" and ")}` : ""}`;
    }
    function setSel(pos, on) {
      if (on) sel.add(pos); else sel.delete(pos);
      $$(`input[data-pos="${pos}"]`, view).forEach((c) => (c.checked = on));
      updateBar();
    }
    view.addEventListener("change", (e) => {
      const c = e.target.closest?.("input[data-pos]");
      if (c) setSel(Number(c.dataset.pos), c.checked);
    });
    const clear = () => [...sel].forEach((p) => setSel(p, false));
    $("#rf-none", view)?.addEventListener("click", clear); // the header is gone when nothing is flagged
    updateBar();

    /* actions */
    $("#rf-refresh", view).onclick = () => detail(id, true);

    // a copy that leaves out what's ticked, nothing changes in the original
    $("#sel-copy", view).onclick = (e) => {
      const { remove, dedupe } = selection();
      const rm = new Set(remove), dd = new Set(dedupe), seen = new Set();
      const uris = tracks.filter((t) => {
        if (rm.has(t.uri) || (dd.has(t.uri) && seen.has(t.uri))) return false;
        seen.add(t.uri);
        return true;
      }).map((t) => t.uri);
      savePlaylist(`${name} (refined)`, uris, e.target);
    };

    $("#sel-apply", view).onclick = async (e) => {
      const { remove, dedupe } = selection();
      if (!remove.length && !dedupe.length) return;
      const parts = [remove.length && `remove ${plural(remove.length, "song")}`, dedupe.length && `keep one copy of ${plural(dedupe.length, "duplicate")}`].filter(Boolean);
      if (!confirm(`In "${name}": ${parts.join(" and ")}. Continue?\n\nSpotify has no undo, but right after this you can add removed songs back (at the end of the playlist).`)) return;
      e.target.disabled = true;
      try {
        const r = await post(`/api/refine/playlists/${encodeURIComponent(id)}/clean`, { remove, dedupe });
        const back = [...r.removed, ...r.failed];
        const note = r.failed.length
          ? `${plural(r.failed.length, "duplicate")} couldn't be put back, so ${r.failed.length === 1 ? "it was" : "they were"} left out of the playlist. `
          : `Removed ${plural(r.removed.length, "song")}${r.merged ? `, merged ${plural(r.merged, "duplicate")}` : ""}. `;
        const undo = h("button", { class: "ghost mini" }, "Undo");
        undo.onclick = async () => {
          undo.disabled = true;
          try {
            await post(`/api/refine/playlists/${encodeURIComponent(id)}/add`, { uris: back });
            banner("Added back at the end of the playlist.", true);
            if (alive) detail(id);
          } catch (err) { banner(err.message); }
        };
        banner(back.length ? [note, undo] : note, !r.failed.length);
        window.scrollTo({ top: 0, behavior: "smooth" });
        detail(id);
      } catch (err) {
        banner(err.message);
        e.target.disabled = false;
      }
    };

    const add = async (uris, buttons) => {
      buttons.forEach((b) => (b.disabled = true));
      try {
        await post(`/api/refine/playlists/${encodeURIComponent(id)}/add`, { uris });
        uris.forEach((u) => added.add(u));
        buttons.forEach((b) => label(b, "check", "Added"));
      } catch (err) {
        banner(err.message);
        buttons.forEach((b) => (b.disabled = false));
      }
    };
    view.addEventListener("click", (e) => {
      const b = e.target.closest?.("button.add-here");
      if (b) add([b.dataset.uri], [b]);
    });
    $("#rf-add-all", view).onclick = (e) => {
      const buttons = $$("button.add-here:not(:disabled)", view);
      if (!buttons.length) return;
      add(buttons.map((b) => b.dataset.uri), [...buttons, e.target]);
    };
  }

  return () => { alive = false; };
}
