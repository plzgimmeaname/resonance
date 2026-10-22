// dom helpers shared by the app and the admin panel. markup lives in .html files as <template>s,
// js only clones them and fills in text/attributes, so nothing user-supplied is ever parsed as html
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// builds one element: h("div", { class: "x", "--i": 2 }, "text", otherNode)
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

// text sets textContent, --vars go on style, dataset is merged, null removes the attribute
function setAttrs(el, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") el.textContent = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("--")) el.style.setProperty(k, v);
    else if (v == null || v === false) el.removeAttribute(k);
    else el.setAttribute(k, v === true ? "" : v);
  }
}

// clones <template id="id"> and fills it, see fill()
export function make(id, slots = {}) {
  const tpl = document.getElementById(id);
  if (!tpl) throw new Error(`missing template #${id}`);
  return fill(tpl.content.firstElementChild.cloneNode(true), slots);
}

// fills a cloned template:
//   <slot name="k"> is replaced by the value (text or nodes)
//   [data-slot="k"] gets the value as its text, as its children (nodes), or as attributes (plain object)
//   null / false / undefined removes the element
export function fill(el, slots) {
  for (const [k, v] of Object.entries(slots)) {
    const gone = v == null || v === false;
    for (const n of el.querySelectorAll(`slot[name="${k}"]`)) {
      if (gone) n.remove();
      else n.replaceWith(...(v instanceof Node || Array.isArray(v) ? [v].flat() : [String(v)]));
    }
    const sel = `[data-slot="${k}"]`;
    for (const n of [...(el.matches(sel) ? [el] : []), ...el.querySelectorAll(sel)]) {
      if (gone) n.remove();
      else if (v instanceof Node || Array.isArray(v)) n.replaceChildren(...[v].flat());
      else if (typeof v === "object") setAttrs(n, v);
      else n.textContent = v;
    }
  }
  return el;
}

export const empty = (text, attrs = {}) => h("div", { class: "empty", ...attrs }, text);
export const skeleton = (el, tiles) => el.replaceChildren(h("div", { class: `sk${tiles ? " tiles" : ""}` }, Array.from({ length: tiles ? 8 : 6 }, () => h("i"))));
export const reveal = (el) => { el.classList.add("reveal"); [...el.children].forEach((c, i) => c.style.setProperty("--i", i)); };

// animates [data-count] numbers counting up
export function countUp(root, ms = 900) {
  $$("[data-count]", root).forEach((el) => {
    const end = Number(el.dataset.count), suffix = el.dataset.suffix || "", t0 = performance.now();
    const step = (t) => {
      const p = Math.min((t - t0) / ms, 1);
      el.textContent = Math.round(end * (1 - Math.pow(1 - p, 4))).toLocaleString() + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

// slides the underline under the active nav link
export function moveIndicator() {
  const a = $("#tabs .active"), ind = $("#ind");
  if (!a || !ind) return;
  ind.style.left = a.offsetLeft + 14 + "px";
  ind.style.width = a.offsetWidth - 28 + "px";
}
window.addEventListener("resize", moveIndicator);

// content is text or nodes, empty hides it
export function banner(content, ok = false) {
  const el = $("#banner");
  el.replaceChildren(...[content ?? []].flat());
  el.hidden = !content;
  el.classList.toggle("ok", ok);
}

// simple bar row and histogram, used by stats and admin
export const bar = (name, value, max, i = 0, label = value) => make("t-bar", {
  bar: { "--i": i }, name: { text: name, title: name }, fill: { style: `width:${(value / max) * 100}%` }, v: String(label),
});
export const hist = (vals, titles, cls = "hist") => h("div", { class: cls }, vals.map((v, i) =>
  h("div", { style: `height:${(v / Math.max(...vals, 1)) * 100}%;animation-delay:${i * 25}ms`, title: titles[i] })));
