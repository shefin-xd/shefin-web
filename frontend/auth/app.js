import { apiUrl, getSession } from "../shared/auth-client.js";

const form = document.querySelector("#login-form");
const message = document.querySelector("#message");
const returnTo = new URLSearchParams(window.location.search).get("returnTo");

function safeReturnTo(value) {
  if (!value) return "https://chat.shefin.dev";
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && /(^|\.)shefin\.dev$/i.test(url.hostname)) return url.href;
  } catch {
    // An invalid return URL falls back to the default app.
  }
  return "https://chat.shefin.dev";
}

const destination = safeReturnTo(returnTo);

const existingSession = await getSession();
if (existingSession) window.location.replace(destination);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "Signing in…";
  const response = await fetch(apiUrl("/auth/login"), {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: document.querySelector("#email").value,
      password: document.querySelector("#password").value,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    message.textContent = data.message || "Unable to sign in. Please try again.";
    return;
  }
  window.location.assign(destination);
});
