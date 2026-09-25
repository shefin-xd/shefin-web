/**
 * Small, framework-free SSO client used by every Shefin web property.
 *
 * Deploy this file with each app (or publish it as an internal package). The
 * API owns the httpOnly session cookie; apps never receive a JWT in JavaScript.
 */
const API_ORIGIN = window.SHEFIN_API_ORIGIN || "https://api.shefin.dev";
const AUTH_ORIGIN = window.SHEFIN_AUTH_ORIGIN || "https://auth.shefin.dev";

export const apiUrl = (path) => `${API_ORIGIN}${path}`;

export async function getSession() {
  const response = await fetch(apiUrl("/auth/check"), { credentials: "include" });
  if (!response.ok) return null;
  return response.json();
}

export function beginSignIn(returnTo = window.location.href) {
  const url = new URL(AUTH_ORIGIN);
  url.searchParams.set("returnTo", returnTo);
  window.location.assign(url);
}

export async function signOut() {
  await fetch(apiUrl("/auth/logout"), {
    method: "POST",
    credentials: "include",
  });
}
