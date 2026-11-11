import { $, banner, h } from "/lib/dom.js";
import { handleErr, post } from "/app/shared.js";

const CHUNK = 2000;
// only audio history files, the export also has playlists, search queries, podcasts etc.
const wanted = (name) => /^(Streaming_History_Audio|StreamingHistory_music|StreamingHistory\d|endsong)/i.test(name);

async function readEntries(file) {
  try {
    const data = JSON.parse(await file.text());
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

export function mount(root) {
  const input = $("#files", root), btn = $("#pick", root), progress = $("#progress", root), drop = $("#drop", root), bar = $("#bar", root);
  let stopped = false;
  btn.onclick = () => input.click();
  input.onchange = () => { const list = [...input.files]; input.value = ""; run(list); };
  // files can be dropped straight from the unzipped folder
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (!btn.disabled) run([...e.dataTransfer.files]); });

  async function run(list) {
    const files = list.filter((f) => wanted(f.name));
    if (!files.length) return banner("None of those look like streaming history files. Pick the Streaming_History_Audio or StreamingHistory_music files.");
    banner(null);
    btn.disabled = true;
    progress.hidden = bar.hidden = false;
    bar.style.setProperty("--p", "0%");
    const total = { added: 0, skipped: 0, ignored: 0 };
    try {
      for (const [n, file] of files.entries()) {
        const entries = await readEntries(file);
        for (let i = 0; i < entries.length && !stopped; i += CHUNK) {
          progress.textContent = `File ${n + 1} of ${files.length} (${file.name}): ${Math.min(i + CHUNK, entries.length).toLocaleString()} of ${entries.length.toLocaleString()} entries…`;
          const r = await post("/api/import", { entries: entries.slice(i, i + CHUNK) });
          bar.style.setProperty("--p", `${((n + Math.min(i + CHUNK, entries.length) / (entries.length || 1)) / files.length) * 100}%`);
          for (const k of Object.keys(total)) total[k] += r[k];
        }
        if (stopped) return;
      }
      bar.style.setProperty("--p", "100%");
      progress.textContent = `Done. Added ${total.added.toLocaleString()} plays. ${total.skipped.toLocaleString()} were already here, and ${total.ignored.toLocaleString()} were skips under 30 seconds or podcasts.`;
      if (total.added) banner(["Imported. ", h("a", { href: "/stats" }, "See your stats →")], true);
    } catch (e) {
      handleErr(progress, e);
    } finally {
      btn.disabled = false;
    }
  }
  // leaving the page stops the upload between chunks
  return () => { stopped = true; };
}
