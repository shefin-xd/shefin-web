import express from "express";
import { protectRoute } from "../../middleware/auth.middleware.js";
import { createRateLimiter } from "../../middleware/rateLimit.middleware.js";
import {
  getMessages,
  getUsersForSidebar,
  searchUsersByUsername,
  sendMessage,
  markMessagesAsRead,
  editMessage,
  deleteMessage,
  getUnreadCounts,
  reactToMessage,
  starMessage,
  getGroupsForSidebar,
  createGroup,
  getGroupMessages,
  sendGroupMessage,
  updateGroupSettings,
  leaveGroup,
  getPublicGroupInvite,
  joinGroupByInvite,
} from "../../controllers/chat-app/message.controller.js";

const router = express.Router();

const messageWriteLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120, message: "Message action rate limit exceeded" });
const groupCreateLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 20, message: "Too many groups created, please try again later" });

// ── Sidebar & unread counts ──────────────────────────────────
router.get("/users",  protectRoute, getUsersForSidebar); // all users + unread count per user
router.get("/unread", protectRoute, getUnreadCounts);    // { [senderId]: count }
router.get("/search", protectRoute, searchUsersByUsername);
router.get("/groups/invite/:inviteCode", getPublicGroupInvite);
router.post("/groups/invite/:inviteCode/join", protectRoute, joinGroupByInvite);
router.get("/groups", protectRoute, getGroupsForSidebar);
router.post("/groups", protectRoute, groupCreateLimiter, createGroup);
router.get("/group/:chatId", protectRoute, getGroupMessages);
router.post("/group/:chatId/send", protectRoute, messageWriteLimiter, sendGroupMessage);
router.patch("/group/:chatId/settings", protectRoute, messageWriteLimiter, updateGroupSettings);
router.post("/group/:chatId/leave", protectRoute, messageWriteLimiter, leaveGroup);

// ── Conversation ─────────────────────────────────────────────
router.get("/:id",       protectRoute, getMessages);     // fetch messages + auto-mark read
router.post("/send/:id", protectRoute, messageWriteLimiter, sendMessage);     // send text / image / voice

// ── Read receipts ────────────────────────────────────────────
router.patch("/read/:id", protectRoute, markMessagesAsRead);

// ── Edit ─────────────────────────────────────────────────────
router.patch("/edit/:id", protectRoute, messageWriteLimiter, editMessage);

// ── Delete ───────────────────────────────────────────────────
// body: { deleteForEveryone: true | false }
router.delete("/:id", protectRoute, messageWriteLimiter, deleteMessage);

// ── Reactions ────────────────────────────────────────────────
// body: { emoji: string, receiverId: string }
router.patch("/react/:id", protectRoute, messageWriteLimiter, reactToMessage);

// ── Star / favourite ─────────────────────────────────────────
router.patch("/star/:id", protectRoute, messageWriteLimiter, starMessage);

export default router;
