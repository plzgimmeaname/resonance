const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s = "") => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = { tab: "overview", data: null };

async function api(path, opts) {
  const r = await fetch("/admin/api" + path, opts);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && data.error === "admin_required") throw Object.assign(new Error("admin_required"), { auth: true });
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}
const post = (p, body = {}) => api(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function banner(html, ok = false) {
  const el = $("#banner");
  el.innerHTML = html || "";
  el.hidden = !html;
  el.classList.toggle("ok", ok);
  if (html && ok) setTimeout(() => { if (el.classList.contains("ok")) el.hidden = true; }, 5000);
}

const ago = (ms) => {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
};
const bytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB");
const dur = (s) => (s > 86400 ? Math.floor(s / 86400) + "d " : "") + (s > 3600 ? Math.floor((s % 86400) / 3600) + "h " : "") + Math.floor((s % 3600) / 60) + "m";
const reveal = (el) => { el.classList.add("reveal"); [...el.children].forEach((c, i) => c.style.setProperty("--i", i)); };
const stat = (n, l) => `<div class="stat"><div class="n" data-count="${n}">0</div><div class="l">${l}</div></div>`;
function countUp(root) {
  $$("[data-count]", root).forEach((el) => {
    const end = Number(el.dataset.count), t0 = performance.now();
    const step = (t) => {
      const p = Math.min((t - t0) / 800, 1);
      el.textContent = Math.round(end * (1 - Math.pow(1 - p, 4))).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
function moveIndicator() {
  const b = $("#tabs button.active"), ind = $("#ind");
  if (!b) return;
  ind.style.left = b.offsetLeft + 14 + "px";
  ind.style.width = b.offsetWidth - 28 + "px";
}
const hist = (vals, labels) => {
  const max = Math.max(...vals, 1);
  return `<div class="hist tall">${vals.map((v, i) => `<div style="height:${(v / max) * 100}%;animation-delay:${i * 25}ms" title="${labels[i]}: ${v}"></div>`).join("")}</div>`;
};
const bar = (name, v, max, i) => `<div class="bar" style="--i:${i}"><div class="name" title="${esc(name)}">${esc(name)}</div><div class="track"><div class="fill" style="width:${(v / max) * 100}%"></div></div><div class="v">${v}</div></div>`;

/* auth */
async function boot() {
  window.addEventListener("resize", moveIndicator);
  const s = await api("/state");
  if (s.signedIn) return enter();
  showAuth(s.setup);
}

function showAuth(setup) {
  $("#dash").hidden = true;
  $("#tabs").hidden = true;
  $("#signout").hidden = true;
  $("#auth").hidden = false;
  $("#auth-code").hidden = !setup;
  $("#auth-title").textContent = setup ? "Create admin account" : "Admin sign-in";
  $("#auth-sub").textContent = setup
    ? "Choose a password (8+ characters). Enter the setup code printed in the terminal where the app is running (or in `docker compose logs`)."
    : "Enter the admin password.";
  $("#auth-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (setup) await post("/setup", { code: $("#auth-code").value, password: $("#auth-pw").value });
      else await post("/login", { password: $("#auth-pw").value });
      $("#auth-pw").value = "";
      banner("");
      enter();
    } catch (err) { banner(esc(err.message)); }
  };
}

function enter() {
  $("#auth").hidden = true;
  $("#dash").hidden = false;
  $("#tabs").hidden = false;
  $("#signout").hidden = false;
  show(state.tab);
}
$("#signout").addEventListener("click", async () => { await post("/logout"); location.reload(); });
$("#tabs").addEventListener("click", (e) => e.target.dataset.tab && show(e.target.dataset.tab));

async function show(tab) {
  state.tab = tab;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  moveIndicator();
  const view = $("#view");
  view.style.animation = "none"; view.offsetHeight; view.style.animation = "";
  try {
    if (tab === "settings") return await renderSettings(view);
    if (!state.data || tab === state.tab) state.data = await api("/overview");
    ({ overview: renderOverview, users: renderUsers, usage: renderUsage, tools: renderTools })[tab](view, state.data);
  } catch (e) {
    if (e.auth) return showAuth((await api("/state").catch(() => ({}))).setup);
    view.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
const refresh = () => show(state.tab);

/* overview */
function renderOverview(el, d) {
  const connected = d.users.filter((u) => u.connected && !u.blocked).length;
  el.innerHTML = `
    <div class="row"><h1>Overview</h1><button class="ghost" id="refresh">↻ Refresh</button></div>
    <div class="statgrid">
      ${stat(d.users.length, "Users")}${stat(connected, "Connected to Spotify")}
      ${stat(d.system.counts.plays, "Plays tracked")}${stat(d.api.calls, "Spotify calls (24h)")}
      ${stat(d.api.errors, "Failed calls (24h)")}${stat(d.api.limited, "Rate-limited (24h)")}
    </div>
    <div class="cols">
      <div class="panel"><h3>Sign-ins, last 14 days</h3>${hist(d.loginsByDay.map((x) => x.n), d.loginsByDay.map((x) => x.day))}</div>
      <div class="panel"><h3>Spotify calls per hour (24h)</h3>${hist(d.api.callsByHour.map((x) => x.calls), d.api.callsByHour.map((x) => x.hour + ":00"))}</div>
    </div>
    <div class="cols">
      <div class="panel"><h3>Feature usage, 7 days</h3>${d.features.length ? d.features.map((f, i) => bar(f.kind.replace("view_", "").replace("_", " "), f.n, d.features[0].n, i)).join("") : `<div class="empty">No activity yet</div>`}</div>
      <div class="panel"><h3>Recent errors</h3>${d.errors.length ? d.errors.slice(0, 6).map((x) => `<div class="rank"><div class="t"><div>${esc(x.detail)}</div><div>${ago(x.ts)}</div></div></div>`).join("") : `<div class="empty">None 🎉</div>`}</div>
    </div>`;
  $("#refresh").onclick = async () => { state.data = null; refresh(); };
  reveal(el); countUp(el);
}

/* users */
function renderUsers(el, d) {
  el.innerHTML = `
    <div class="row"><h1>Users</h1><button class="ghost" id="refresh">↻ Refresh</button></div>
    <p class="sub" style="margin-top:0">Spotify development mode allows 5 users per app. Add each person's email under User Management in the Spotify dashboard.</p>
    <div class="scroll"><table class="tbl"><thead><tr><th>User</th><th>Status</th><th>Plays</th><th>Activity 7d</th><th>Last seen</th><th>Joined</th><th></th></tr></thead><tbody>
    ${d.users.map((u) => `<tr>
      <td><div class="who">${u.image ? `<img src="${esc(u.image)}" alt="">` : `<div class="ph"></div>`}<div>${esc(u.name)}<div style="color:var(--muted);font-size:12px">${esc(u.id)}</div></div></div></td>
      <td>${u.blocked ? `<span class="pill bad">blocked</span>` : u.connected ? `<span class="pill ok">connected</span>` : `<span class="pill">disconnected</span>`} ${u.sessions ? `<span class="pill">${u.sessions} session${u.sessions > 1 ? "s" : ""}</span>` : ""}</td>
      <td>${u.plays.toLocaleString()}</td><td>${u.events7d}</td><td>${ago(u.last_seen)}</td><td>${new Date(u.created_at).toLocaleDateString()}</td>
      <td><div class="acts" data-id="${esc(u.id)}" data-name="${esc(u.name)}">
        <button class="ghost mini" data-act="sync">Sync</button>
        <button class="ghost mini" data-act="reset">Reset votes</button>
        <button class="ghost mini" data-act="disconnect">Disconnect</button>
        <button class="ghost mini" data-act="${u.blocked ? "unblock" : "block"}">${u.blocked ? "Unblock" : "Block"}</button>
        <button class="ghost mini danger" data-act="delete">Delete</button></div></td></tr>`).join("") || `<tr><td colspan="7"><div class="empty">Nobody has signed in yet.</div></td></tr>`}
    </tbody></table></div>`;
  $("#refresh").onclick = async () => { state.data = null; refresh(); };
  $$(".acts button", el).forEach((b) => (b.onclick = () => userAction(b)));
  reveal($("tbody", el));
}

async function userAction(btn) {
  const box = btn.closest(".acts");
  const id = box.dataset.id, name = box.dataset.name, act = btn.dataset.act;
  try {
    if (act === "delete") {
      if (!confirm(`Delete ${name} and all their history, votes and sessions? This can't be undone.`)) return;
      await api(`/users/${encodeURIComponent(id)}`, { method: "DELETE" });
    } else if (act === "block" || act === "unblock") await post(`/users/${encodeURIComponent(id)}/block`, { blocked: act === "block" });
    else if (act === "disconnect") await post(`/users/${encodeURIComponent(id)}/disconnect`);
    else if (act === "sync") { btn.textContent = "Syncing…"; banner((await post("/maintenance", { action: "sync_history", userId: id })).message, true); }
    else if (act === "reset") banner((await post("/maintenance", { action: "reset_feedback", userId: id })).message, true);
    state.data = null;
    refresh();
  } catch (e) { banner(esc(e.message)); }
}

/* usage */
function renderUsage(el, d) {
  const s = d.system;
  el.innerHTML = `
    <div class="row"><h1>Usage</h1><button class="ghost" id="refresh">↻ Refresh</button></div>
    <h3 class="sect">Spotify API health, last 24 hours</h3>
    <div class="statgrid">${stat(d.api.calls, "Calls")}${stat(d.api.errors, "Failed")}${stat(d.api.limited, "Rate-limited (429)")}${stat(Math.round(d.api.avg || 0), "Avg response (ms)")}</div>
    <div class="cols">
      <div class="panel"><h3>Calls per hour</h3>${hist(d.api.callsByHour.map((x) => x.calls), d.api.callsByHour.map((x) => x.hour + ":00"))}<div class="histlabels"><span>24h ago</span><span>now</span></div></div>
      <div class="panel"><h3>Failures per hour</h3>${hist(d.api.callsByHour.map((x) => x.errors), d.api.callsByHour.map((x) => x.hour + ":00"))}<div class="histlabels"><span>24h ago</span><span>now</span></div></div>
    </div>
    <div class="panel" style="margin-bottom:40px"><h3>Busiest endpoints</h3><div class="scroll"><table class="tbl"><thead><tr><th>Endpoint</th><th>Calls</th><th>Failed</th><th>Avg ms</th></tr></thead><tbody>
      ${d.api.byPath.map((p) => `<tr><td><code>${esc(p.path)}</code></td><td>${p.n}</td><td>${p.errors}</td><td>${p.avg_ms}</td></tr>`).join("") || `<tr><td colspan="4"><div class="empty">No calls yet</div></td></tr>`}</tbody></table></div></div>
    <h3 class="sect">Feature usage, last 7 days</h3>
    <div class="panel" style="margin-bottom:40px">${d.features.map((f, i) => bar(f.kind.replace("view_", "views: ").replace("_", " "), f.n, d.features[0].n, i)).join("") || `<div class="empty">No activity yet</div>`}</div>
    <h3 class="sect">System</h3>
    <div class="statgrid" style="margin-bottom:24px">
      <div class="stat"><div class="n">${dur(s.uptimeSec)}</div><div class="l">Uptime</div></div>
      <div class="stat"><div class="n">${bytes(s.dbBytes)}</div><div class="l">Database size</div></div>
      <div class="stat"><div class="n">${s.cacheEntries}</div><div class="l">Cached items</div></div>
      <div class="stat"><div class="n">${s.rssMb} MB</div><div class="l">Memory</div></div>
    </div>
    <p class="sub" style="font-size:13px;margin:0 0 24px">Node ${esc(s.node)} · ${esc(s.host)} · ${s.counts.events.toLocaleString()} event rows · ${s.counts.calls.toLocaleString()} API call rows</p>
    <h3 class="sect">Recent errors</h3>
    <div class="panel" style="margin-bottom:40px">${d.errors.map((x) => `<div class="rank"><div class="t"><div>${esc(x.detail)}</div><div>${ago(x.ts)}${x.user_id ? " · " + esc(x.user_id) : ""}</div></div></div>`).join("") || `<div class="empty">None</div>`}</div>
    <h3 class="sect">Server log</h3>
    <pre class="log" id="log">${esc(d.logs.join("\n")) || "empty"}</pre>`;
  $("#refresh").onclick = async () => { state.data = null; refresh(); };
  const log = $("#log"); log.scrollTop = log.scrollHeight;
  reveal(el); countUp(el);
}

/* settings */
async function renderSettings(el) {
  const s = await api("/settings");
  const hint = (k) => (s.set[k] ? ` <span style="color:var(--ok)">✓ set</span>` : "");
  el.innerHTML = `
    <div class="row"><h1>Settings</h1></div>
    <form id="sf" class="form-grid">
      <label>Spotify Client ID<input name="clientId" value="${esc(s.clientId)}" autocomplete="off" spellcheck="false"></label>
      <p class="hint" style="margin:-6px 0 0">Add this redirect URI in your Spotify app: <code id="uri">${esc(s.redirectUri)}</code> <button type="button" class="ghost mini" id="copy">Copy</button></p>
      <h3 style="margin:14px 0 0">Optional integrations</h3>
      <label>Last.fm API key${hint("lastfm")}<input name="lastfm" type="password" autocomplete="off" placeholder="similar-artist recommendations"></label>
      <label>Ticketmaster API key${hint("ticketmaster")}<input name="ticketmaster" type="password" autocomplete="off" placeholder="concerts in the feed"></label>
      <div class="two"><label>City<input name="city" value="${esc(s.city)}" placeholder="optional"></label><label>Country<input name="country" value="${esc(s.country)}" placeholder="US"></label></div>
      <label>Anthropic API key${hint("anthropic")}<input name="anthropic" type="password" autocomplete="off" placeholder="“why?” explanations and taste summaries"></label>
      <p class="hint">Saved on the server only and never shown again. Leave a key blank to keep it; type <code>-</code> to remove it. Changing the Client ID signs everyone out.</p>
      <div><button class="btn" type="submit">Save settings</button></div>
    </form>
    <h3 style="margin:48px 0 14px">Admin password</h3>
    <form id="pf" class="form-grid">
      <label>Current password<input name="current" type="password" autocomplete="current-password"></label>
      <label>New password (8+ characters)<input name="next" type="password" autocomplete="new-password"></label>
      <div><button class="ghost" type="submit">Change password</button></div>
    </form>`;
  $("#copy").onclick = async (e) => { await navigator.clipboard.writeText(s.redirectUri); e.target.textContent = "Copied ✓"; setTimeout(() => (e.target.textContent = "Copy"), 1500); };
  $("#sf").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await post("/settings", Object.fromEntries(["clientId", "lastfm", "ticketmaster", "city", "country", "anthropic"].map((k) => [k, f[k].value])));
      banner("Settings saved.", true);
      renderSettings(el);
    } catch (err) { banner(esc(err.message)); }
  };
  $("#pf").onsubmit = async (e) => {
    e.preventDefault();
    try { await post("/password", { current: e.target.current.value, next: e.target.next.value }); e.target.reset(); banner("Password changed. Other admin sessions were signed out.", true); }
    catch (err) { banner(esc(err.message)); }
  };
  reveal($("#sf"));
}

/* tools */
function renderTools(el) {
  const tool = (title, desc, action, label, extra = "") => `<div class="tool"><b>${title}</b><span>${desc}</span>${action ? `<button class="ghost" data-action="${action}">${label}</button>` : extra}</div>`;
  el.innerHTML = `
    <div class="row"><h1>Tools</h1></div>
    <h3 class="sect">Maintenance</h3>
    <div class="tools">
      ${tool("Clear caches", "Forget cached taste profiles, feeds and recommendations so they rebuild fresh.", "clear_cache", "Clear caches")}
      ${tool("Sync history now", "Pull the latest plays for every connected user instead of waiting for the 15 minute timer.", "sync_history", "Sync everyone")}
      ${tool("Reset all votes", "Delete every 👍/👎 for all users. Recommendations go back to the plain taste profile.", "reset_feedback", "Reset votes")}
      ${tool("Prune old logs", "Delete usage and API logs older than 30 days and shrink the database.", "prune_logs", "Prune")}
    </div>
    <h3 class="sect">Export and backup</h3>
    <div class="tools">
      ${tool("Plays (CSV)", "Every tracked play for all users.", "", "", `<a class="ghost" href="/admin/api/export/plays.csv">Download</a>`)}
      ${tool("Usage log (CSV)", "Sign-ins, feature use and errors.", "", "", `<a class="ghost" href="/admin/api/export/usage.csv">Download</a>`)}
      ${tool("Database backup", "A copy of the whole database. Spotify tokens, API keys and the admin password are removed from the copy.", "", "", `<a class="ghost" href="/admin/api/export/backup.db">Download</a>`)}
    </div>`;
  $$("button[data-action]", el).forEach((b) => (b.onclick = async () => {
    const action = b.dataset.action;
    if (action === "reset_feedback" && !confirm("Delete all votes for all users?")) return;
    const old = b.textContent;
    b.textContent = "Working…"; b.disabled = true;
    try { banner(esc((await post("/maintenance", { action })).message), true); state.data = null; }
    catch (e) { banner(esc(e.message)); }
    b.textContent = old; b.disabled = false;
  }));
  reveal($(".tools", el));
}

boot().catch((e) => banner(esc(e.message)));
