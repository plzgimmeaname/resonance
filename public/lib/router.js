// small history-api router. a route maps a path to a page base url: <base>.html holds the page's
// markup and <template>s (one root element), <base>.js exports mount(root, ctx), which wires the
// page up and can return a cleanup function that runs when you leave it
const pages = new Map();
function loadHtml(url) {
  if (!pages.has(url)) {
    const p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Couldn't load ${url}`);
      return r.text();
    });
    p.catch(() => pages.delete(url));
    pages.set(url, p);
  }
  return pages.get(url).then((text) => {
    const doc = new DOMParser().parseFromString(text, "text/html");
    return document.importNode(doc.body.firstElementChild, true);
  });
}

const clean = (p) => p.replace(/\/+$/, "") || "/";

// guard(path) returns the path to actually show (redirects use replaceState),
// onChange(path) runs as soon as the page is decided, before it loads
export function createRouter({ outlet, routes, guard = (p) => p, onChange = () => {}, onError = console.error }) {
  let cleanup = null, seq = 0;

  const ctx = {
    get query() { return new URLSearchParams(location.search); },
    // update the query string without re-rendering, e.g. a filter the page already applied
    setQuery(params) {
      const u = new URL(location.href);
      for (const [k, v] of Object.entries(params)) v == null ? u.searchParams.delete(k) : u.searchParams.set(k, v);
      history.replaceState(null, "", u);
    },
    go: (url, replace) => go(url, replace),
  };

  async function render() {
    const n = ++seq;
    const path = clean(location.pathname);
    const target = guard(path);
    if (target !== path) {
      history.replaceState(null, "", target);
      return render();
    }
    onChange(path);
    try {
      const base = routes[path];
      const [root, mod] = await Promise.all([loadHtml(`${base}.html`), import(`${base}.js`)]);
      if (n !== seq) return; // a newer navigation won
      cleanup?.();
      cleanup = null;
      outlet.replaceChildren(root);
      const c = mod.mount(root, ctx);
      if (typeof c === "function") cleanup = c;
    } catch (e) { if (n === seq) onError(e); }
  }

  function go(url, replace = false) {
    history[replace ? "replaceState" : "pushState"](null, "", url);
    window.scrollTo({ top: 0, behavior: "instant" });
    return render();
  }

  // same-origin links to a known route navigate in place, everything else is a normal page load
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]");
    if (!a || a.target || a.hasAttribute("download") || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const url = new URL(a.href);
    if (url.origin !== location.origin || !(clean(url.pathname) in routes)) return;
    e.preventDefault();
    go(url.pathname + url.search);
  });
  window.addEventListener("popstate", render);

  return { go, start: render };
}
