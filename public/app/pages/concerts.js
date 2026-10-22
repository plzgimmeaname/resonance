import { $, empty, reveal, skeleton } from "/lib/dom.js";
import { api, eventItem, handleErr } from "/app/shared.js";

export function mount(root) {
  const el = $("#concerts", root);
  async function load(refresh) {
    skeleton(el);
    try {
      const list = await api(`/api/concerts${refresh ? "?refresh=1" : ""}`);
      if (!list.length) return el.replaceChildren(empty("No upcoming shows found for your top artists. Try a wider city in the admin settings."));
      el.replaceChildren(...list.map(eventItem));
      reveal(el);
    } catch (e) { handleErr(el, e); }
  }
  $("#refresh", root).onclick = () => load(true);
  load();
}
