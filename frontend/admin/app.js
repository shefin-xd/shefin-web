import { apiUrl, beginSignIn, getSession, signOut } from "../shared/auth-client.js";
const status = document.querySelector("#status");
const openAdmin = document.querySelector("#open-admin");
const signOutButton = document.querySelector("#sign-out");
const session = await getSession();
if (!session) beginSignIn(window.location.href);
else if (!session.isAdmin) status.textContent = "This Shefin account is signed in but does not have admin access.";
else { status.textContent = `Welcome, ${session.fullName}. Your admin session is ready.`; openAdmin.hidden = false; signOutButton.hidden = false; }
openAdmin.addEventListener("click", async () => { const response = await fetch(apiUrl("/api/admin/dashboard"), { credentials: "include" }); status.textContent = response.ok ? "Dashboard API access confirmed." : "Your admin session could not be confirmed."; });
signOutButton.addEventListener("click", async () => { await signOut(); beginSignIn(window.location.href); });
