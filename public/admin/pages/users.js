import { $, empty, h, make, reveal } from "/lib/dom.js";
import { ago, api, banner, fail, pill, post } from "/admin/shared.js";

const status = (u) => (u.blocked ? pill("blocked", "bad") : u.connected ? pill("connected", "ok") : pill("disconnected"));

function userRow(u) {
  const blockAct = u.blocked ? "unblock" : "block";
  return make("t-user", {
    avatar: u.image ? h("img", { src: u.image, alt: "" }) : h("div", { class: "ph" }),
    name: u.name, id: u.id, status: status(u),
    sessions: u.sessions ? `${u.sessions} session${u.sessions > 1 ? "s" : ""}` : null,
    plays: u.plays.toLocaleString(), events: String(u.events7d), seen: ago(u.last_seen), joined: new Date(u.created_at).toLocaleDateString(),
    acts: { dataset: { id: u.id, name: u.name } },
    block: { "data-act": blockAct, text: u.blocked ? "Unblock" : "Block" },
  });
}

const remoteRow = (u) => make("t-remote-user", {
  name: u.name, id: u.user_id, instance: u.instance, status: u.connected ? pill("connected", "ok") : pill("disconnected"),
  plays: u.plays.toLocaleString(), seen: ago(u.last_seen), joined: u.created_at ? new Date(u.created_at).toLocaleDateString() : "", reported: ago(u.reported_at),
});

async function userAction(btn, reload) {
  const box = btn.closest(".acts");
  const { id, name } = box.dataset, act = btn.dataset.act;
  try {
    if (act === "delete") {
      if (!confirm(`Delete ${name} and all their history, votes and sessions? This can't be undone.`)) return;
      await api(`/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    } else if (act === "block" || act === "unblock") await post(`/users/${encodeURIComponent(id)}/block`, { blocked: act === "block" });
    else if (act === "disconnect") await post(`/users/${encodeURIComponent(id)}/disconnect`);
    else if (act === "sync") { btn.textContent = "Syncing…"; banner((await post("/maintenance", { action: "sync_history", userId: id })).message, true); }
    else if (act === "reset") banner((await post("/maintenance", { action: "reset_feedback", userId: id })).message, true);
    reload();
  } catch (e) { banner(e.message); }
}

export function mount(root) {
  const body = $("#users", root);
  async function load() {
    try {
      const d = await api("/overview");
      body.replaceChildren(...(d.users.length ? d.users.map(userRow) : [h("tr", {}, h("td", { colspan: 7 }, empty("Nobody has signed in yet.")))]));
      $("#remote", root).hidden = !d.remote.length;
      $("#remote-rows", root).replaceChildren(...d.remote.map(remoteRow));
      reveal(body);
    } catch (e) { fail(body, e); }
  }
  body.addEventListener("click", (e) => {
    const b = e.target.closest(".acts button");
    if (b) userAction(b, load);
  });
  $("#refresh", root).onclick = load;
  load();
}
