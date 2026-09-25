import "dotenv/config";
import { Server } from "socket.io";
import http from "http";
import express from "express";
import mongoose from "mongoose";
import User from "../models/user.model.js";
import { isConfiguredAdmin } from "../middleware/admin.middleware.js";
import Message from "../models/message.model.js";

const app    = express();
const server = http.createServer(app);

const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:5173,https://chat.shefin.dev")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const io = new Server(server, {
  cors: { origin: allowedOrigins, credentials: true },
});

// ─────────────────────────────────────────────────────────────
//  In-memory presence map  { userId(string): Set<socketId> }
//
//  IMPORTANT: This map is process-local. In a multi-instance
//  deployment (cluster / load balancer) each process has its own
//  map, so cross-instance message delivery will silently fail.
//  For multi-instance setups, replace with a Redis adapter:
//    npm i @socket.io/redis-adapter
// ─────────────────────────────────────────────────────────────
const userSocketMap = {};
const activeCallMap = new Map();

const getOnlineUserIds = () =>
  Object.entries(userSocketMap)
    .filter(([, socketIds]) => socketIds.size > 0)
    .map(([id]) => id);

/**
 * Returns every active socket id for a user, or undefined if offline.
 * Accepts both string and Mongoose ObjectId (calls .toString() safely).
 * Socket.IO accepts an array in io.to(...), which lets multi-tab users
 * receive messages, receipts, typing indicators, and profile events everywhere.
 */
export function getReceiverSocketId(userId) {
  if (!userId) return undefined;
  const sockets = userSocketMap[userId.toString()];
  if (!sockets?.size) return undefined;
  return Array.from(sockets);
}

export const emitUserCreated = (user) => {
  if (!user?._id) return;
  io.emit("userCreated", {
    _id: user._id.toString(),
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    profilePic: user.profilePic || "",
    about: user.about || "",
    isVerified: user.isVerified,
    isAdmin: isConfiguredAdmin(user),
    isSuspended: !!user.isSuspended,
    isOnline: false,
    lastSeen: user.lastSeen || null,
    privacy: user.privacy,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    unreadCount: 0,
    lastMessage: null,
  });
};


export const emitUserProfileUpdated = (user) => {
  if (!user?._id) return;
  io.emit("userProfileUpdated", {
    userId: user._id.toString(),
    fullName: user.fullName,
    username: user.username,
    email: user.email,
    profilePic: user.profilePic || "",
    about: user.about || "",
    isVerified: !!user.isVerified,
    isAdmin: isConfiguredAdmin(user),
    isSuspended: !!user.isSuspended,
    updatedAt: user.updatedAt,
  });
};

export const emitMaintenanceUpdated = (settings) => {
  io.emit("maintenanceUpdated", {
    maintenanceMode: !!settings?.maintenanceMode,
    maintenanceMessage: settings?.maintenanceMessage || "Messenger is temporarily in maintenance mode. Please check back soon.",
    updatedAt: settings?.updatedAt || new Date(),
  });
};

export const emitAdminUserUpdated = (user) => {
  if (!user?._id) return;
  io.emit("adminUserUpdated", {
    userId: user._id.toString(),
    fullName: user.fullName,
    username: user.username,
    profilePic: user.profilePic || "",
    isVerified: !!user.isVerified,
    isAdmin: !!user.isAdmin,
    isSuspended: !!user.isSuspended,
    updatedAt: user.updatedAt,
  });
};

export const emitAdminUserDeleted = (userId) => {
  if (!userId) return;
  io.emit("adminUserDeleted", { userId: userId.toString() });
};

export const emitAdminLogCreated = (log) => {
  if (!log) return;
  io.to("admins").emit("adminLogCreated", log.toObject ? log.toObject() : log);
};

export const emitUserActivityCreated = (activity) => {
  if (!activity) return;
  io.to("admins").emit("userActivityCreated", activity.toObject ? activity.toObject() : activity);
};

export const emitAdminAnnouncement = (payload) => {
  io.emit("adminAnnouncement", {
    subject: payload.subject,
    message: payload.message,
    sentAt: payload.sentAt || new Date(),
  });
};


export const emitGroupUpdated = (group, payload, previousMembers = []) => {
  if (!group?._id || !payload) return;
  const memberIds = new Set([
    ...(group.users || []).map((id) => id.toString()),
    ...previousMembers.map((id) => id.toString()),
  ]);
  memberIds.forEach((memberId) => {
    const sid = getReceiverSocketId(memberId);
    if (sid) io.to(sid).emit("groupUpdated", payload);
  });
};

export const emitPrivacyUpdated = (user) => {
  if (!user?._id) return;
  io.emit("userPrivacyUpdated", {
    userId: user._id.toString(),
    privacy: user.privacy,
    profilePic: user.privacy?.profilePhoto === "everyone" ? (user.profilePic || "") : "",
    lastSeen: user.privacy?.lastSeen === "everyone" ? (user.lastSeen || null) : null,
    isOnline: user.privacy?.lastSeen === "everyone" ? user.isOnline : false,
  });
};

// ─────────────────────────────────────────────────────────────
//  Startup cleanup — reset stale isOnline flags after MongoDB connects.
// ─────────────────────────────────────────────────────────────
export const clearStalePresence = async () => {
  const result = await User.updateMany(
    { isOnline: true },
    { $set: { isOnline: false, lastSeen: new Date() } }
  );
  console.log(`✅  Cleared ${result.modifiedCount} stale online flag(s) on startup`);
};

// ─────────────────────────────────────────────────────────────
//  Helper — validate a raw string as a MongoDB ObjectId.
//  Used throughout handlers to reject forged / malformed ids
//  before they reach the database layer.
// ─────────────────────────────────────────────────────────────
const isValidId = (id) => id && mongoose.Types.ObjectId.isValid(id);

// ─────────────────────────────────────────────────────────────
//  Connection handler
//
//  NOTE: Socket.IO does NOT await async event handlers and does
//  NOT catch their rejections automatically. Every async block
//  must have its own try/catch to prevent unhandled rejections
//  from crashing the process in Node 15+.
// ─────────────────────────────────────────────────────────────
io.on("connection", async (socket) => {
  const userId = socket.handshake.query.userId;

  // BUG FIX: Validate userId before any DB or map operation.
  // Without this, a client that connects without a userId (or with a
  // malformed one) would insert `undefined` into userSocketMap and
  // attempt to query MongoDB with an invalid ObjectId — causing a
  // CastError that bubbles up as an unhandled promise rejection.
  const isAuthenticatedSocket = isValidId(userId);
  if (!isAuthenticatedSocket) {
    console.warn(`⚠️  Socket ${socket.id} connected without a valid userId — limited public realtime channel only`);
  }

  // ── Register presence ──────────────────────────────────
  // BUG FIX: Wrap the entire async connect body in try/catch.
  // An uncaught rejection here would crash the process (Node 15+).
  try {
    if (!isAuthenticatedSocket) return;
    if (!userSocketMap[userId]) userSocketMap[userId] = new Set();
    const wasOffline = userSocketMap[userId].size === 0;
    userSocketMap[userId].add(socket.id);

    const socketUser = await User.findByIdAndUpdate(
      userId,
      wasOffline ? { isOnline: true, lastSeen: null, lastActiveAt: new Date() } : { lastActiveAt: new Date() },
      { new: true }
    );
    if (isConfiguredAdmin(socketUser)) socket.join("admins");

    // Broadcast updated presence to all clients immediately. Even when this is
    // a second tab, emitting the list repairs any client that missed an event.
    io.emit("getOnlineUsers", getOnlineUserIds());
    if (wasOffline) {
      io.emit("userStatusChanged", { userId, isOnline: true, lastSeen: null });
    }

    console.log(`✅  connected   user=${userId}  socket=${socket.id}`);
  } catch (err) {
    console.error(`connect DB error for user=${userId}:`, err.message);
    // Don't disconnect — the socket still works for messaging even if
    // the presence update failed; stale status is a minor UX issue.
  }

  // ── Typing indicator ───────────────────────────────────
  socket.on("typing", ({ receiverId } = {}) => {
    if (!isAuthenticatedSocket) return;
    // BUG FIX: Guard against missing / invalid receiverId.
    // Calling getReceiverSocketId(undefined) returns undefined which is
    // safe, but the guard makes the intent explicit and prevents a
    // nonsense emit to the sender themselves if receiverId === userId.
    if (!isValidId(receiverId) || receiverId === userId) return;
    const sid = getReceiverSocketId(receiverId);
    if (sid) io.to(sid).emit("userTyping", { senderId: userId });
  });

  socket.on("stopTyping", ({ receiverId } = {}) => {
    if (!isAuthenticatedSocket) return;
    if (!isValidId(receiverId) || receiverId === userId) return;
    const sid = getReceiverSocketId(receiverId);
    if (sid) io.to(sid).emit("userStopTyping", { senderId: userId });
  });

  // ── Voice recording indicator ──────────────────────────
  socket.on("voiceRecording", ({ receiverId } = {}) => {
    if (!isAuthenticatedSocket) return;
    if (!isValidId(receiverId) || receiverId === userId) return;
    const sid = getReceiverSocketId(receiverId);
    if (sid) io.to(sid).emit("userVoiceRecording", { senderId: userId });
  });

  socket.on("stopVoiceRecording", ({ receiverId } = {}) => {
    if (!isAuthenticatedSocket) return;
    if (!isValidId(receiverId) || receiverId === userId) return;
    const sid = getReceiverSocketId(receiverId);
    if (sid) io.to(sid).emit("userStopVoiceRecording", { senderId: userId });
  });

  // ── Read receipt (single message) ──────────────────────
  socket.on("messageRead", async ({ messageId, senderId } = {}) => {
    if (!isAuthenticatedSocket) return;
    // BUG FIX: Both ids must be valid ObjectIds.
    // Previously, passing an invalid messageId would cause findByIdAndUpdate
    // to throw a CastError that propagated as an unhandled rejection.
    if (!isValidId(messageId) || !isValidId(senderId)) return;

    try {
      await Message.findByIdAndUpdate(messageId, {
        $set: { isRead: true, readAt: new Date() },
      });
      const sid = getReceiverSocketId(senderId);
      if (sid) {
        io.to(sid).emit("messageReadAck", {
          messageId,
          readerId: userId,
          readAt:   new Date(),
        });
      }
    } catch (err) {
      console.error("messageRead handler error:", err.message);
    }
  });

  // ── Read receipt (whole conversation) ──────────────────
  socket.on("conversationRead", async ({ senderId } = {}) => {
    if (!isAuthenticatedSocket) return;
    if (!isValidId(senderId)) return;

    try {
      // BUG FIX: Cast senderId and userId to ObjectId.
      // Message.senderId and receiverId are stored as ObjectIds in MongoDB.
      // Querying with raw strings works in Mongoose .find(), but
      // .updateMany() can mismatch types in some driver/version combinations,
      // silently updating zero documents. Explicit casting is always safe.
      await Message.updateMany(
        {
          senderId:   new mongoose.Types.ObjectId(senderId),
          receiverId: new mongoose.Types.ObjectId(userId),
          isRead: false,
        },
        { $set: { isRead: true, readAt: new Date() } }
      );

      const sid = getReceiverSocketId(senderId);
      if (sid) {
        io.to(sid).emit("conversationReadAck", {
          readerId: userId,
          readAt:   new Date(),
        });
      }
    } catch (err) {
      console.error("conversationRead handler error:", err.message);
    }
  });

  // ── Reaction ───────────────────────────────────────────
  socket.on("reactToMessage", async ({ messageId, receiverId, emoji } = {}) => {
    if (!isValidId(messageId) || !isValidId(receiverId)) return;
    if (!emoji || typeof emoji !== "string") return;

    try {
      const message = await Message.findById(messageId);
      if (!message) return;

      // BUG FIX: Do not allow reactions on deleted messages.
      // The REST controller already guards this, but a client could bypass
      // REST and call this socket event directly.
      if (message.isDeletedForEveryone) return;

      // BUG FIX: use .equals() for ObjectId comparison instead of
      // .toString() === userId (string). .equals() is the correct Mongoose
      // method and avoids string allocation for every comparison.
      const idx = message.reactions.findIndex((r) =>
        r.userId.equals(new mongoose.Types.ObjectId(userId))
      );

      if (idx !== -1 && message.reactions[idx].emoji === emoji) {
        message.reactions.splice(idx, 1);           // toggle off
      } else if (idx !== -1) {
        message.reactions[idx].emoji = emoji;        // replace
      } else {
        message.reactions.push({ userId: new mongoose.Types.ObjectId(userId), emoji });
      }

      await message.save();

      const payload = { messageId, reactions: message.reactions };

      // Notify both participants so both UIs update atomically
      socket.emit("reactionUpdated", payload);
      const sid = getReceiverSocketId(receiverId);
      if (sid) io.to(sid).emit("reactionUpdated", payload);
    } catch (err) {
      console.error("reactToMessage handler error:", err.message);
    }
  });


  // ── Realtime audio/video call signalling ─────────────────
  // Media remains peer-to-peer in the browsers; the server only relays
  // WebRTC offers, answers and ICE candidates between authenticated sockets.
  const isValidCallType = (type) => ["audio", "video"].includes(type);
  const isValidCallId = (callId) => typeof callId === "string" && /^[a-zA-Z0-9:_-]{12,96}$/.test(callId);
  const isValidSessionDescription = (description) =>
    description && ["offer", "answer"].includes(description.type) &&
    typeof description.sdp === "string" && description.sdp.length > 20 && description.sdp.length <= 200000;
  const isValidIceCandidate = (candidate) =>
    candidate && typeof candidate.candidate === "string" && candidate.candidate.length <= 4096 &&
    (candidate.sdpMid == null || typeof candidate.sdpMid === "string") &&
    (candidate.sdpMLineIndex == null || Number.isInteger(candidate.sdpMLineIndex));
  const registerCall = (callId, callerId, calleeId) => {
    activeCallMap.set(callId, { callerId: callerId.toString(), calleeId: calleeId.toString(), expiresAt: Date.now() + 60 * 60 * 1000 });
  };
  const getCallPeer = (callId, actorId, expectedPeerId) => {
    const session = activeCallMap.get(callId);
    if (!session || session.expiresAt < Date.now()) {
      activeCallMap.delete(callId);
      return null;
    }
    const actor = actorId.toString();
    const peer = expectedPeerId.toString();
    const isCaller = session.callerId === actor && session.calleeId === peer;
    const isCallee = session.calleeId === actor && session.callerId === peer;
    return isCaller || isCallee ? session : null;
  };
  const closeCall = (callId) => activeCallMap.delete(callId);
  const sanitizeCaller = (caller = {}) => ({
    _id: caller._id?.toString() || userId,
    fullName: typeof caller.fullName === "string" ? caller.fullName.slice(0, 100) : "Incoming caller",
    profilePic: typeof caller.profilePic === "string" ? caller.profilePic.slice(0, 500) : "",
    about: typeof caller.about === "string" ? caller.about.slice(0, 139) : "",
  });

  socket.on("call:offer", async ({ to, callId, type, offer } = {}) => {
    if (!isAuthenticatedSocket || !isValidId(to) || to === userId || !isValidCallId(callId) || !isValidCallType(type) || !isValidSessionDescription(offer) || offer.type !== "offer") return;
    const [callee, caller] = await Promise.all([
      User.findById(to).select("privacy.allowCalls"),
      User.findById(userId).select("fullName profilePic about"),
    ]);
    if (callee?.privacy?.allowCalls === false) {
      socket.emit("call:unavailable", { callId, reason: "User is not accepting calls" });
      return;
    }
    const sid = getReceiverSocketId(to);
    if (!sid) {
      socket.emit("call:unavailable", { callId, reason: "User is offline or unavailable" });
      return;
    }

    registerCall(callId, userId, to);
    io.to(sid).emit("call:incoming", {
      from: userId,
      callId,
      type,
      offer,
      caller: sanitizeCaller(caller),
    });
  });

  socket.on("call:answer", ({ to, callId, answer } = {}) => {
    if (!isAuthenticatedSocket || !isValidId(to) || to === userId || !isValidCallId(callId) || !isValidSessionDescription(answer) || answer.type !== "answer") return;
    if (!getCallPeer(callId, userId, to)) return;
    const sid = getReceiverSocketId(to);
    if (sid) io.to(sid).emit("call:accepted", { from: userId, callId, answer });
  });

  socket.on("call:ice-candidate", ({ to, callId, candidate } = {}) => {
    if (!isAuthenticatedSocket || !isValidId(to) || to === userId || !isValidCallId(callId) || !isValidIceCandidate(candidate)) return;
    if (!getCallPeer(callId, userId, to)) return;
    const sid = getReceiverSocketId(to);
    if (sid) io.to(sid).emit("call:ice-candidate", { from: userId, callId, candidate });
  });

  socket.on("call:reject", ({ to, callId, reason } = {}) => {
    if (!isAuthenticatedSocket || !isValidId(to) || to === userId || !isValidCallId(callId)) return;
    if (!getCallPeer(callId, userId, to)) return;
    const sid = getReceiverSocketId(to);
    if (sid) {
      io.to(sid).emit("call:rejected", {
        from: userId,
        callId,
        reason: typeof reason === "string" ? reason.slice(0, 120) : "Call declined",
      });
    }
    closeCall(callId);
  });

  socket.on("call:busy", ({ to, callId } = {}) => {
    if (!isAuthenticatedSocket || !isValidId(to) || to === userId || !isValidCallId(callId)) return;
    if (!getCallPeer(callId, userId, to)) return;
    const sid = getReceiverSocketId(to);
    if (sid) io.to(sid).emit("call:busy", { from: userId, callId });
    closeCall(callId);
  });

  socket.on("call:end", ({ to, callId } = {}) => {
    if (!isAuthenticatedSocket || !isValidId(to) || to === userId || !isValidCallId(callId)) return;
    if (!getCallPeer(callId, userId, to)) return;
    const sid = getReceiverSocketId(to);
    if (sid) io.to(sid).emit("call:ended", { from: userId, callId });
    closeCall(callId);
  });

  // ── Privacy updated ────────────────────────────────────
  // The REST controller already broadcasts saved privacy settings. This socket
  // event is a harmless fallback for older clients that emit after saving.
  socket.on("privacyUpdated", async () => {
    if (!isAuthenticatedSocket) return;
    try {
      const user = await User.findById(userId).select("privacy profilePic lastSeen isOnline");
      if (!user) return;
      socket.broadcast.emit("userPrivacyUpdated", {
        userId,
        privacy: user.privacy,
        profilePic: user.privacy?.profilePhoto === "everyone" ? user.profilePic : "",
        lastSeen: user.privacy?.lastSeen === "everyone" ? user.lastSeen : null,
        isOnline: user.privacy?.lastSeen === "everyone" ? user.isOnline : false,
      });
    } catch (err) {
      console.error("privacyUpdated handler error:", err.message);
    }
  });

  // ── Profile updated ────────────────────────────────────
  // Fired by the client after a successful PUT /auth/update-profile.
  // Broadcasts the new name/avatar to every other online user so
  // sidebars and chat headers refresh without a page reload.
  socket.on("profileUpdated", ({ fullName, profilePic, about } = {}) => {
    if (!isAuthenticatedSocket) return;
    // BUG FIX: Sanitise inputs before broadcasting.
    // A malicious client could emit arbitrary data here (XSS payloads,
    // oversized strings, etc.). Enforce types and reasonable limits.
    if (fullName    !== undefined && typeof fullName    !== "string") return;
    if (profilePic  !== undefined && typeof profilePic  !== "string") return;
    if (about       !== undefined && typeof about       !== "string") return;
    if (fullName    && fullName.length    > 100) return;
    if (profilePic  && profilePic.length  > 500) return; // URL max
    if (about       && about.length       > 139) return;

    // Broadcast to everyone except the sender
    socket.broadcast.emit("userProfileUpdated", {
      userId,
      fullName:   fullName   ?? undefined,
      profilePic: profilePic ?? undefined,
      about:      about      ?? undefined,
    });
  });

  // ── Disconnect ─────────────────────────────────────────
  socket.on("disconnect", async () => {
    console.log(`❌  disconnected user=${userId || "guest"}  socket=${socket.id}`);
    if (!isAuthenticatedSocket) return;

    // Multi-tab guard: remove only this socket id. A user stays online until
    // every browser tab/device socket has disconnected.
    userSocketMap[userId]?.delete(socket.id);
    if (userSocketMap[userId]?.size) {
      io.emit("getOnlineUsers", getOnlineUserIds());
      console.log(`ℹ️  User ${userId} still has ${userSocketMap[userId].size} active socket(s)`);
      return;
    }

    // BUG FIX: Wrap DB + emit in try/catch.
    // An uncaught rejection inside a disconnect handler causes an
    // unhandled promise rejection in Node 15+.
    try {
      delete userSocketMap[userId];
      for (const [callId, session] of activeCallMap.entries()) {
        if (session.callerId !== userId && session.calleeId !== userId) continue;
        const peerId = session.callerId === userId ? session.calleeId : session.callerId;
        const sid = getReceiverSocketId(peerId);
        if (sid) io.to(sid).emit("call:ended", { from: userId, callId });
        activeCallMap.delete(callId);
      }
      const lastSeen = new Date();

      await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen });

      // Broadcast updated presence to all remaining clients
      io.emit("getOnlineUsers", getOnlineUserIds());
      io.emit("userStatusChanged", {
        userId,
        isOnline: false,
        lastSeen: lastSeen.toISOString(),
      });
    } catch (err) {
      console.error(`disconnect DB error for user=${userId}:`, err.message);
      // The socket map entry was already deleted above, so the user
      // won't receive further messages. The DB flag may be stale until
      // the next server restart (handled by the startup IIFE).
    }
  });
});

export { io, app, server };
