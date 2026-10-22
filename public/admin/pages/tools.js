import { $, $$, reveal } from "/lib/dom.js";
import { banner, fail, post } from "/admin/shared.js";

export function mount(root) {
  $$("button[data-action]", root).forEach((b) => (b.onclick = async () => {
    if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
    const old = b.textContent;
    b.textContent = "Working…"; b.disabled = true;
    try { banner((await post("/maintenance", { action: b.dataset.action })).message, true); }
    catch (e) { if (e.auth) fail(root, e); else banner(e.message); }
    b.textContent = old; b.disabled = false;
  }));
  reveal($("#maintenance", root));
}
