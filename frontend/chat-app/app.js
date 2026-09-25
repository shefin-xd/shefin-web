import { apiUrl, beginSignIn, getSession, signOut } from "../shared/auth-client.js";

const status = document.querySelector("#status");
const loadChat = document.querySelector("#load-chat");
const signOutButton = document.querySelector("#sign-out");
const session = await getSession();
if (!session) {
  beginSignIn(window.location.href);
} else {
  status.textContent = `Signed in as ${session.fullName}. Your messages stay in the Chat API namespace.`;
  loadChat.hidden = false;
  signOutButton.hidden = false;
}
loadChat.addEventListener("click", async () => {
  const response = await fetch(apiUrl("/api/chat/users"), { credentials: "include" });
  status.textContent = response.ok ? "Chat API access confirmed." : "Unable to load conversations.";
});
signOutButton.addEventListener("click", async () => { await signOut(); beginSignIn(window.location.href); });
