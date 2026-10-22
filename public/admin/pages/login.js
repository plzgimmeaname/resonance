import { $ } from "/lib/dom.js";
import { admin, banner, post } from "/admin/shared.js";

// first visit creates the admin account with the setup code, after that it's a normal sign-in
export function mount(root, { go }) {
  const setup = admin.setup;
  $("#auth-code", root).hidden = !setup;
  if (setup) {
    $("#auth-title", root).textContent = "Create admin account";
    $("#auth-sub", root).textContent = "Choose a password (8+ characters). Enter the setup code printed in the terminal where the app is running (or in `docker compose logs`).";
  }
  $("#auth-form", root).onsubmit = async (e) => {
    e.preventDefault();
    try {
      if (setup) await post("/setup", { code: $("#auth-code", root).value, password: $("#auth-pw", root).value });
      else await post("/login", { password: $("#auth-pw", root).value });
      Object.assign(admin, { setup: false, signedIn: true });
      banner("");
      go("/admin/overview", true);
    } catch (err) { banner(err.message); }
  };
}
