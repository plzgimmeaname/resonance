import { $ } from "/lib/dom.js";
import { app } from "/app/shared.js";

export function mount(root) {
  const { configured, reporting } = app.status;
  $("#setup", root).hidden = configured;
  $("#reporting", root).hidden = !reporting;
  $("#spotify-btn", root).hidden = !configured;
}
