// runs in <head> before the page paints, so a chosen light/dark theme doesn't flash. "system" follows the OS
try {
  const t = JSON.parse(localStorage.getItem("theme"));
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}
