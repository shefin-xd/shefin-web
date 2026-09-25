import mongoose from "mongoose";
import User from "../../models/user.model.js";
import Message from "../../models/message.model.js";
import { Chat } from "../../models/chat.model.js";
import cloudinary from "../../lib/cloudinary.js";
import { getReceiverSocketId, io } from "../../lib/socket.js";

const applyPrivacyForViewer = (user, viewerId) => {
  const plainUser = typeof user.toObject === "function" ? user.toObject() : { ...user };
  const viewer = viewerId.toString();
  const isSelf = plainUser._id.toString() === viewer;

  if (isSelf) return plainUser;

  // The app does not model contacts yet, so contacts-only values are treated
  // conservatively as hidden until a contact graph exists.
  if (["nobody", "contacts"].includes(plainUser.privacy?.profilePhoto)) {
    plainUser.profilePic = "";
  }

  if (["nobody", "contacts"].includes(plainUser.privacy?.lastSeen)) {
    plainUser.lastSeen = null;
    plainUser.isOnline = false;
  }

  return plainUser;
};


export const searchUsersByUsername = async (req, res) => {
  try {
    const myId = req.user._id;
    const query = String(req.query.username || "").trim().toLowerCase().replace(/^@/, "");
    if (query.length < 2) return res.status(200).json([]);

    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const users = await User.find({
      _id: { $ne: myId },
      $or: [
        { username: { $regex: escaped, $options: "i" } },
        { fullName: { $regex: escaped, $options: "i" } },
      ],
    })
      .select("fullName username profilePic about privacy isOnline lastSeen")
      .limit(10);

    res.status(200).json(users.map((user) => applyPrivacyForViewer(user, myId)));
  } catch (error) {
    console.error("searchUsersByUsername:", error.message);
    res.status(500).json({ message: "Unable to search users right now" });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /chat/users
// Returns every user except the requester, with an unread-message
// count attached so the sidebar can render badges without a
// separate request.
// ─────────────────────────────────────────────────────────────
export const getUsersForSidebar = async (req, res) => {
  try {
    const myId = req.user._id; // Mongoose ObjectId

    // Fetch all users except the logged-in user, excluding passwords
    const users = await User.find({ _id: { $ne: myId } }).select("-password");

    // Aggregate unread counts in one DB round-trip.
    // BUG FIX: cast myId to ObjectId explicitly so the $match works
    // correctly inside an aggregation pipeline (which bypasses Mongoose
    // schema casting and operates on raw BSON).
    const unreadAgg = await Message.aggregate([
      {
        $match: {
          receiverId:           new mongoose.Types.ObjectId(myId),
          isRead:               false,
          isDeletedForEveryone: false,
          deletedFor:           { $ne: new mongoose.Types.ObjectId(myId) },
        },
      },
      { $group: { _id: "$senderId", count: { $sum: 1 } } },
    ]);

    const unreadMap = {};
    unreadAgg.forEach(({ _id, count }) => {
      unreadMap[_id.toString()] = count;
    });

    const lastMessageAgg = await Message.aggregate([
      {
        $match: {
          isDeletedForEveryone: false,
          deletedFor: { $ne: new mongoose.Types.ObjectId(myId) },
          $or: [
            { senderId: new mongoose.Types.ObjectId(myId) },
            { receiverId: new mongoose.Types.ObjectId(myId) },
          ],
        },
      },
      { $sort: { createdAt: -1 } },
      {
        $project: {
          otherUser: {
            $cond: [
              { $eq: ["$senderId", new mongoose.Types.ObjectId(myId)] },
              "$receiverId",
              "$senderId",
            ],
          },
          text: 1,
          image: 1,
          voice: 1,
          messageType: 1,
          isEncrypted: 1,
          isForwarded: 1,
          isEdited: 1,
          editedAt: 1,
          createdAt: 1,
        },
      },
      { $group: { _id: "$otherUser", message: { $first: "$$ROOT" } } },
    ]);

    const lastMessageMap = {};
    lastMessageAgg.forEach(({ _id, message }) => {
      lastMessageMap[_id.toString()] = message;
    });

    const usersWithMeta = users.map((u) => ({
      ...applyPrivacyForViewer(u, myId),
      unreadCount: unreadMap[u._id.toString()] || 0,
      lastMessage: lastMessageMap[u._id.toString()] || null,
    }));

    res.status(200).json(usersWithMeta);
  } catch (error) {
    console.error("getUsersForSidebar:", error.message);
    res.status(500).json({ message: "Unable to load users right now" });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /chat/:id
// Fetches the full conversation between the requester and user :id.
// Also auto-marks all unread incoming messages as delivered + read
// and notifies the sender via socket so double-ticks update.
// ─────────────────────────────────────────────────────────────
export const getMessages = async (req, res) => {
  try {
    const { id: userToChatId } = req.params;
    const myId = req.user._id;

    // BUG FIX: validate that userToChatId is a valid ObjectId before querying
    // to prevent a CastError that would surface as a confusing 500.
    if (!mongoose.Types.ObjectId.isValid(userToChatId)) {
      return res.status(400).json({ error: "Invalid user id" });
    }

    const shouldSendReadReceipts = req.user.privacy?.readReceipts !== false;

    const messages = await Message.find({
      $or: [
        { senderId: myId,          receiverId: userToChatId },
        { senderId: userToChatId,  receiverId: myId },
      ],
      // Exclude messages the requester has soft-deleted ("Delete for me").
      // BUG FIX: use the Mongoose ObjectId directly — passing a string to $ne
      // against an ObjectId array field would never match.
      deletedFor: { $ne: myId },
      // NOTE: isDeletedForEveryone is intentionally NOT filtered.
      // Deleted-for-everyone messages are kept in the result so the
      // "This message was deleted" placeholder persists after a page refresh.
      // The document exists; only its content fields are null.
    })
      .populate("replyTo", "text encryptedContent isEncrypted voice image messageType senderId isForwarded isEdited")
      .sort({ createdAt: 1 });

    // Auto-mark incoming unread messages as delivered + read in one write.
    // We do this server-side (rather than relying on a separate client event)
    // so read status is always consistent even if the client is slow.
    const bulk = shouldSendReadReceipts
      ? await Message.updateMany(
          { senderId: userToChatId, receiverId: myId, isRead: false },
          { $set: { isDelivered: true, deliveredAt: new Date(), isRead: true, readAt: new Date() } }
        )
      : { modifiedCount: 0 };

    // Notify the sender via socket so their double-ticks turn blue immediately
    if (shouldSendReadReceipts && bulk.modifiedCount > 0) {
      const sid = getReceiverSocketId(userToChatId);
      if (sid) {
        io.to(sid).emit("conversationReadAck", {
          readerId: myId.toString(),
          readAt:   new Date(),
        });
      }
    }

    res.status(200).json(messages);
  } catch (error) {
    console.error("getMessages:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────
// POST /chat/send/:id
//
// Supports two paths:
//
//   E2EE path  — client sends { encryptedContent, isEncrypted: true, messageType }
//     • encryptedContent is an AES-256-GCM base64 blob that only the two
//       conversation participants can decrypt.
//     • No Cloudinary upload — we never see the plaintext content.
//     • text / image / voice are null on the server.
//
//   Plain path — client sends { text?, image?, voice? }
//     • image and voice are uploaded to Cloudinary and the URLs stored.
//     • Falls back gracefully when E2EE keys are not yet loaded.
// ─────────────────────────────────────────────────────────────
export const sendMessage = async (req, res) => {
  try {
    const {
      text, image, voice, voiceDuration, replyTo, isForwarded,
      encryptedContent, isEncrypted, messageType,
    } = req.body;
    const { id: receiverId } = req.params;
    const senderId = req.user._id;

    // Validate receiver id
    if (!mongoose.Types.ObjectId.isValid(receiverId)) {
      return res.status(400).json({ error: "Invalid receiver id" });
    }

    // BUG FIX: Ensure the receiver actually exists.
    // Without this, a message could be saved for a non-existent userId,
    // producing orphaned documents and confusing the sidebar query.
    const receiverExists = await User.exists({ _id: receiverId });
    if (!receiverExists) {
      return res.status(404).json({ error: "Receiver not found" });
    }

    // BUG FIX: Require at least some content regardless of encryption mode.
    // Previously a request with no body fields would save an empty message.
    if (isEncrypted) {
      if (!encryptedContent) {
        return res.status(400).json({ error: "encryptedContent is required for encrypted messages" });
      }
    } else if (!text?.trim() && !image && !voice) {
      return res.status(400).json({ error: "Message must have text, image, or voice" });
    }

    let imageUrl     = null;
    let voiceUrl     = null;
    let resolvedType = messageType || "text";

    if (!isEncrypted) {
      // ── Plain upload path ───────────────────────────────
      if (image) {
        const upload = await cloudinary.uploader.upload(image, {
          resource_type: "image",
          folder:        "chat_images",
        });
        imageUrl     = upload.secure_url;
        resolvedType = "image";
      }
      if (voice) {
        const upload = await cloudinary.uploader.upload(voice, {
          resource_type: "video",
          folder:        "chat_voice",
          format:        "mp3",
        });
        voiceUrl     = upload.secure_url;
        resolvedType = "voice";
      }
      // BUG FIX: if neither image nor voice was provided, resolve type from
      // the presence of text so messageType is never misleadingly "image"
      // or "voice" when the upload failed silently.
      if (!imageUrl && !voiceUrl) resolvedType = "text";
    }

    // Delivery status — if receiver has an active socket, mark delivered now
    const receiverSocketId = getReceiverSocketId(receiverId);
    const isDelivered      = !!receiverSocketId;

    // BUG FIX: validate replyTo is a real message that belongs to this
    // conversation before wiring the reference. A forged replyTo pointing to
    // a message from a different conversation would leak its existence.
    if (replyTo) {
      if (!mongoose.Types.ObjectId.isValid(replyTo)) {
        return res.status(400).json({ error: "Invalid replyTo id" });
      }
      const replyMsg = await Message.findById(replyTo).select("senderId receiverId");
      if (!replyMsg) {
        return res.status(404).json({ error: "Replied-to message not found" });
      }
      const participants = [replyMsg.senderId.toString(), replyMsg.receiverId.toString()];
      if (!participants.includes(senderId.toString()) || !participants.includes(receiverId.toString())) {
        return res.status(403).json({ error: "Cannot reply to a message from a different conversation" });
      }
    }

    const newMessage = new Message({
      senderId,
      receiverId,
      // Plain content — null when using E2EE
      text:          isEncrypted ? null : (text?.trim() || null),
      image:         isEncrypted ? null : imageUrl,
      voice:         isEncrypted ? null : voiceUrl,
      voiceDuration: isEncrypted ? null : (voiceDuration || null),
      messageType:   resolvedType,
      isForwarded:   !!isForwarded,
      // E2EE — server stores the opaque blob; content fields stay null
      isEncrypted:      !!isEncrypted,
      encryptedContent: isEncrypted ? encryptedContent : null,
      // Metadata
      replyTo:     replyTo  || null,
      isDelivered,
      deliveredAt: isDelivered ? new Date() : null,
    });

    await newMessage.save();

    // Populate replyTo preview only when a reply reference is present
    if (replyTo) {
      await newMessage.populate(
        "replyTo",
        "text encryptedContent isEncrypted voice image messageType senderId isForwarded isEdited"
      );
    }

    // Push to both participants in real time. The sender also receives the
    // event so their other open tabs/devices stay in sync; clients de-dupe by id.
    const senderSocketId = getReceiverSocketId(senderId);
    if (senderSocketId) io.to(senderSocketId).emit("newMessage", newMessage);
    if (receiverSocketId) io.to(receiverSocketId).emit("newMessage", newMessage);

    res.status(201).json(newMessage);
  } catch (error) {
    console.error("sendMessage:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────
// PATCH /chat/read/:id
// Marks all unread messages from user :id as read and notifies
// them via socket. Called when the user opens a conversation.
// ─────────────────────────────────────────────────────────────
export const markMessagesAsRead = async (req, res) => {
  try {
    const { id: senderId } = req.params;
    const myId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(senderId)) {
      return res.status(400).json({ error: "Invalid sender id" });
    }
    if (req.user.privacy?.readReceipts === false) {
      return res.status(200).json({ success: true, readReceiptsDisabled: true });
    }

    await Message.updateMany(
      { senderId, receiverId: myId, isRead: false },
      { $set: { isRead: true, readAt: new Date() } }
    );

    // Notify the sender so their double-ticks turn blue
    const sid = getReceiverSocketId(senderId);
    if (sid) {
      io.to(sid).emit("conversationReadAck", {
        readerId: myId.toString(),
        readAt:   new Date(),
      });
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("markMessagesAsRead:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────
// PATCH /chat/edit/:id
// Lets the original sender edit text messages. For encrypted messages the
// client sends a fresh encryptedContent blob so plaintext never reaches the
// server. Both participants receive a real-time messageEdited event.
// ─────────────────────────────────────────────────────────────
export const editMessage = async (req, res) => {
  try {
    const { id: messageId } = req.params;
    const { text, encryptedContent, isEncrypted } = req.body;
    const myId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ error: "Invalid message id" });
    }

    const message = await Message.findById(messageId).populate(
      "replyTo",
      "text encryptedContent isEncrypted voice image messageType senderId isForwarded isEdited"
    );
    if (!message) return res.status(404).json({ error: "Message not found" });

    if (!message.senderId.equals(myId)) {
      return res.status(403).json({ error: "Only the sender can edit this message" });
    }
    if (message.isDeletedForEveryone) {
      return res.status(400).json({ error: "Cannot edit a deleted message" });
    }
    if (message.image || message.voice || message.messageType !== "text") {
      return res.status(400).json({ error: "Only text messages can be edited" });
    }

    if (message.isEncrypted || isEncrypted) {
      if (!encryptedContent || typeof encryptedContent !== "string") {
        return res.status(400).json({ error: "encryptedContent is required for encrypted edits" });
      }
      message.encryptedContent = encryptedContent;
      message.text = null;
      message.isEncrypted = true;
    } else {
      if (!text?.trim()) {
        return res.status(400).json({ error: "Edited message cannot be empty" });
      }
      message.text = text.trim();
    }

    message.isEdited = true;
    message.editedAt = new Date();
    await message.save();

    const sid = getReceiverSocketId(message.receiverId.toString());
    if (sid) io.to(sid).emit("messageEdited", message);

    res.status(200).json(message);
  } catch (error) {
    console.error("editMessage:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE /chat/:id
//
// Two modes:
//   deleteForEveryone: true  — sender only; wipes content for both parties.
//     The document is kept with isDeletedForEveryone:true so the placeholder
//     "This message was deleted" persists for both users after refresh.
//   deleteForEveryone: false — soft-delete for the requester only (hides it
//     from their view; the other party still sees it).
// ─────────────────────────────────────────────────────────────
export const deleteMessage = async (req, res) => {
  try {
    const { id: messageId }             = req.params;
    const { deleteForEveryone = false } = req.body;
    const myId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ error: "Invalid message id" });
    }

    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });

    if (deleteForEveryone) {
      // Only the original sender may delete for everyone
      if (!message.senderId.equals(myId)) {
        return res.status(403).json({ error: "Only the sender can delete for everyone" });
      }

      // BUG FIX: Idempotency guard — if content is already wiped, skip the
      // redundant save (avoids unnecessary DB write on accidental double-tap).
      if (message.isDeletedForEveryone) {
        return res.status(200).json({ success: true, alreadyDeleted: true });
      }

      message.isDeletedForEveryone = true;
      message.text             = null;
      message.image            = null;
      message.voice            = null;
      message.encryptedContent = null; // wipe E2EE blob too
      await message.save();

      // Notify participants in real-time so their UI shows the placeholder
      if (message.isGroupMessage && message.chatId) {
        const chat = await Chat.findById(message.chatId).select("users");
        chat?.users.forEach((memberId) => {
          if (memberId.equals(myId)) return;
          const sid = getReceiverSocketId(memberId.toString());
          if (sid) io.to(sid).emit("messageDeleted", { messageId });
        });
      } else {
        const sid = getReceiverSocketId(message.receiverId.toString());
        if (sid) io.to(sid).emit("messageDeleted", { messageId });
      }

    } else {
      // BUG FIX: use Mongoose .equals() for ObjectId comparison instead of
      // .map(String).includes(string) — cleaner, avoids unnecessary allocation.
      const alreadySoftDeleted = message.deletedFor.some((id) => id.equals(myId));
      if (!alreadySoftDeleted) {
        message.deletedFor.push(myId);
        await message.save();
      }
      // Idempotent — return success even if it was already soft-deleted
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("deleteMessage:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────
// GET /chat/unread
// Returns a map of { [senderId]: unreadCount } for the requester.
// Used to seed badge counts in the sidebar without re-fetching all users.
// ─────────────────────────────────────────────────────────────
export const getUnreadCounts = async (req, res) => {
  try {
    const myId = req.user._id;

    // BUG FIX: cast to ObjectId for consistent aggregation matching
    const agg = await Message.aggregate([
      {
        $match: {
          receiverId:           new mongoose.Types.ObjectId(myId),
          isRead:               false,
          isDeletedForEveryone: false,
          deletedFor:           { $ne: new mongoose.Types.ObjectId(myId) },
        },
      },
      { $group: { _id: "$senderId", count: { $sum: 1 } } },
    ]);

    const result = {};
    agg.forEach(({ _id, count }) => { result[_id.toString()] = count; });

    res.status(200).json(result);
  } catch (error) {
    console.error("getUnreadCounts:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────
// PATCH /chat/star/:id
// Toggles the requester's starred state for one message. StarredBy is kept
// on the message so the state follows the user across devices.
// ─────────────────────────────────────────────────────────────
export const starMessage = async (req, res) => {
  try {
    const { id: messageId } = req.params;
    const myId = req.user._id;

    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ error: "Invalid message id" });
    }

    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });

    let groupForMessage = null;
    const isDirectParticipant = message.senderId.equals(myId) || (!message.isGroupMessage && message.receiverId.equals(myId));
    if (message.isGroupMessage && message.chatId) {
      groupForMessage = await Chat.findOne({ _id: message.chatId, users: myId }).select("users");
    }
    const isParticipant = isDirectParticipant || !!groupForMessage;
    if (!isParticipant) {
      return res.status(403).json({ error: "You can only star your own conversations" });
    }

    const idx = message.starredBy.findIndex((id) => id.equals(myId));
    const isStarred = idx === -1;

    if (isStarred) message.starredBy.push(myId);
    else message.starredBy.splice(idx, 1);

    await message.save();

    const payload = {
      messageId,
      userId: myId.toString(),
      isStarred,
      starredBy: message.starredBy,
    };

    if (groupForMessage) {
      groupForMessage.users.forEach((memberId) => {
        if (memberId.equals(myId)) return;
        const sid = getReceiverSocketId(memberId.toString());
        if (sid) io.to(sid).emit("messageStarred", payload);
      });
    } else {
      const otherUserId = message.senderId.equals(myId)
        ? message.receiverId.toString()
        : message.senderId.toString();
      const sid = getReceiverSocketId(otherUserId);
      if (sid) io.to(sid).emit("messageStarred", payload);
    }

    res.status(200).json(payload);
  } catch (error) {
    console.error("starMessage:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────
// PATCH /chat/react/:id
// Adds, replaces, or removes (toggles) the requester's emoji reaction
// on a message. Both conversation participants are notified via socket.
// ─────────────────────────────────────────────────────────────
export const reactToMessage = async (req, res) => {
  try {
    const { id: messageId } = req.params;
    const { emoji } = req.body;
    const myId = req.user._id;

    // Validate the message id and restrict reactions to a compact emoji value.
    // This prevents malformed ids, empty payloads, and oversized strings from
    // being written into every participant's realtime message state.
    if (!mongoose.Types.ObjectId.isValid(messageId)) {
      return res.status(400).json({ error: "Invalid message id" });
    }
    const normalizedEmoji = String(emoji || "").trim();
    if (!normalizedEmoji || normalizedEmoji.length > 16) {
      return res.status(400).json({ error: "A valid emoji reaction is required" });
    }

    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ error: "Message not found" });
    if (message.isDeletedForEveryone) {
      return res.status(400).json({ error: "Cannot react to a deleted message" });
    }

    let memberIds = [];
    if (message.isGroupMessage && message.chatId) {
      const group = await Chat.findOne({ _id: message.chatId, users: myId }).select("users");
      if (!group) return res.status(403).json({ error: "You can only react in your own conversations" });
      memberIds = group.users.map((id) => id.toString());
    } else {
      const sender = message.senderId.toString();
      const receiver = message.receiverId.toString();
      if (![sender, receiver].includes(myId.toString())) {
        return res.status(403).json({ error: "You can only react in your own conversations" });
      }
      memberIds = [sender, receiver];
    }

    // One reaction per user: same emoji toggles off; different emoji replaces.
    const idx = message.reactions.findIndex((r) => r.userId.equals(myId));
    if (idx !== -1 && message.reactions[idx].emoji === normalizedEmoji) {
      message.reactions.splice(idx, 1);
    } else if (idx !== -1) {
      message.reactions[idx].emoji = normalizedEmoji;
    } else {
      message.reactions.push({ userId: myId, emoji: normalizedEmoji });
    }
    await message.save();

    const payload = { messageId, reactions: message.reactions };
    memberIds.forEach((memberId) => {
      const sid = getReceiverSocketId(memberId);
      if (sid) io.to(sid).emit("reactionUpdated", payload);
    });

    res.status(200).json(payload);
  } catch (error) {
    console.error("reactToMessage:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

const GROUP_MESSAGE_POPULATE = [
  { path: "senderId", select: "fullName profilePic" },
  { path: "replyTo", select: "text encryptedContent isEncrypted voice image messageType senderId isForwarded isEdited" },
];

const createGroupSystemMessage = async (chat, text) => {
  const message = await Message.create({
    senderId: chat.groupAdmin?.[0] || chat.users?.[0],
    receiverId: chat._id,
    chatId: chat._id,
    isGroupMessage: true,
    messageType: "system",
    text,
    isDelivered: true,
    deliveredAt: new Date(),
  });
  chat.latestMessage = message._id;
  await chat.save();
  return message;
};

const emitGroupRealtime = (chat, payload, previousMembers = []) => {
  const ids = new Set([...(chat.users || []).map((id) => id.toString()), ...previousMembers.map((id) => id.toString())]);
  ids.forEach((memberId) => {
    const sid = getReceiverSocketId(memberId);
    if (sid) io.to(sid).emit("groupUpdated", payload);
  });
};

const emitGroupSystemMessage = async (chat, text, previousMembers = []) => {
  const message = await createGroupSystemMessage(chat, text);
  const ids = new Set([...(chat.users || []).map((id) => id.toString()), ...previousMembers.map((id) => id.toString())]);
  ids.forEach((memberId) => {
    const sid = getReceiverSocketId(memberId);
    if (sid) io.to(sid).emit("newGroupMessage", { chatId: chat._id.toString(), message });
  });
};

const serializeGroup = (chat, unreadCount = 0) => {
  const obj = chat.toObject ? chat.toObject() : chat;
  return {
    ...obj,
    _id: obj._id.toString(),
    fullName: obj.chatName,
    profilePic: obj.groupIcon,
    groupAdmin: (obj.groupAdmin || []).map((id) => id.toString()),
    adminOnlyChat: !!obj.adminOnlyChat,
    adminOnlyEdit: !!obj.adminOnlyEdit,
    inviteCode: obj.inviteCode,
    isGroupChat: true,
    unreadCount,
  };
};

const assertGroupMember = async (chatId, userId) => {
  if (!mongoose.Types.ObjectId.isValid(chatId)) return null;
  return Chat.findOne({ _id: chatId, isGroupChat: true, users: userId });
};


export const getPublicGroupInvite = async (req, res) => {
  try {
    const group = await Chat.findOne({ inviteCode: req.params.inviteCode, isGroupChat: true })
      .populate("users", "fullName profilePic isOnline lastSeen");
    if (!group) return res.status(404).json({ error: "Group invite not found" });
    res.status(200).json(serializeGroup(group));
  } catch (error) {
    console.error("getPublicGroupInvite:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const joinGroupByInvite = async (req, res) => {
  try {
    const myId = req.user._id;
    const group = await Chat.findOne({ inviteCode: req.params.inviteCode, isGroupChat: true });
    if (!group) return res.status(404).json({ error: "Group invite not found" });
    if (!group.users.some((id) => id.equals(myId))) group.users.push(myId);
    await group.save();
    await group.populate("users", "fullName profilePic isOnline lastSeen");
    const payload = serializeGroup(group);
    group.users.forEach((memberId) => {
      const sid = getReceiverSocketId(memberId.toString());
      if (sid) io.to(sid).emit("groupUpdated", payload);
    });
    res.status(200).json(payload);
  } catch (error) {
    console.error("joinGroupByInvite:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getGroupsForSidebar = async (req, res) => {
  try {
    const myId = req.user._id;
    const groups = await Chat.find({ isGroupChat: true, users: myId })
      .populate("latestMessage")
      .populate("users", "fullName profilePic isOnline lastSeen")
      .sort({ updatedAt: -1 });

    res.status(200).json(groups.map((group) => serializeGroup(group, 0)));
  } catch (error) {
    console.error("getGroupsForSidebar:", error.message);
    res.status(500).json({ message: "Unable to load groups right now" });
  }
};

export const createGroup = async (req, res) => {
  try {
    const myId = req.user._id;
    const chatName = req.body.chatName?.trim();
    const groupDescription = req.body.groupDescription?.trim() || "Welcome to our group!";
    const groupIcon = typeof req.body.groupIcon === "string" ? req.body.groupIcon : "";
    const userIds = Array.isArray(req.body.userIds) ? req.body.userIds : [];

    if (!chatName || chatName.length < 2 || chatName.length > 80) {
      return res.status(400).json({ error: "Group name must be between 2 and 80 characters" });
    }

    const uniqueIds = [...new Set(userIds.filter((id) => mongoose.Types.ObjectId.isValid(id)))];
    const members = [...new Set([myId.toString(), ...uniqueIds])];
    if (members.length < 3) {
      return res.status(400).json({ error: "Select at least two other members" });
    }

    const foundUsers = await User.find({ _id: { $in: members } }).select("_id privacy");
    if (foundUsers.length !== members.length) {
      return res.status(400).json({ error: "One or more selected users could not be found" });
    }

    const blockedInvite = foundUsers.find((u) => !u._id.equals(myId) && u.privacy?.groupInvites === "nobody");
    if (blockedInvite) {
      return res.status(403).json({ error: "One selected user does not allow group invites" });
    }

    const groupData = {
      chatName,
      isGroupChat: true,
      users: members,
      groupAdmin: [myId],
      groupDescription: groupDescription.slice(0, 250),
      inviteCode: new mongoose.Types.ObjectId().toString(),
    };

    if (groupIcon) {
      if (!/^data:image\/(jpeg|png|gif|webp);base64,/.test(groupIcon)) {
        return res.status(400).json({ error: "Group photo must be a JPG, PNG, GIF, or WEBP image" });
      }
      const upload = await cloudinary.uploader.upload(groupIcon, { folder: "group_icons" });
      groupData.groupIcon = upload.secure_url;
    }

    const group = await Chat.create(groupData);

    await group.populate("users", "fullName profilePic isOnline lastSeen");

    members.forEach((memberId) => {
      const sid = getReceiverSocketId(memberId);
      if (sid) io.to(sid).emit("groupCreated", serializeGroup(group));
    });

    res.status(201).json(serializeGroup(group));
  } catch (error) {
    console.error("createGroup:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getGroupMessages = async (req, res) => {
  try {
    const { chatId } = req.params;
    const chat = await assertGroupMember(chatId, req.user._id);
    if (!chat) return res.status(404).json({ error: "Group not found" });

    const messages = await Message.find({
      chatId: chat._id,
      deletedFor: { $ne: req.user._id },
    })
      .populate(GROUP_MESSAGE_POPULATE)
      .sort({ createdAt: 1 });

    res.status(200).json(messages);
  } catch (error) {
    console.error("getGroupMessages:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const sendGroupMessage = async (req, res) => {
  try {
    const { chatId } = req.params;
    const { text, image, voice, voiceDuration, replyTo, isForwarded, messageType } = req.body;
    const senderId = req.user._id;

    const chat = await assertGroupMember(chatId, senderId);
    if (!chat) return res.status(404).json({ error: "Group not found" });
    if (chat.adminOnlyChat && !chat.groupAdmin.some((id) => id.toString() === senderId.toString())) {
      return res.status(403).json({ error: "Only admins can send messages in this group" });
    }
    if (!text?.trim() && !image && !voice) {
      return res.status(400).json({ error: "Message must have text, image, or voice" });
    }

    let imageUrl = null;
    let voiceUrl = null;
    let resolvedType = messageType || "text";

    if (image) {
      const upload = await cloudinary.uploader.upload(image, { resource_type: "image", folder: "chat_images" });
      imageUrl = upload.secure_url;
      resolvedType = "image";
    }
    if (voice) {
      const upload = await cloudinary.uploader.upload(voice, { resource_type: "video", folder: "chat_voice", format: "mp3" });
      voiceUrl = upload.secure_url;
      resolvedType = "voice";
    }
    if (!imageUrl && !voiceUrl) resolvedType = "text";

    if (replyTo) {
      if (!mongoose.Types.ObjectId.isValid(replyTo)) return res.status(400).json({ error: "Invalid replyTo id" });
      const replyMsg = await Message.findOne({ _id: replyTo, chatId: chat._id }).select("_id");
      if (!replyMsg) return res.status(404).json({ error: "Replied-to message not found" });
    }

    const message = await Message.create({
      senderId,
      receiverId: chat._id,
      chatId: chat._id,
      isGroupMessage: true,
      text: text?.trim() || null,
      image: imageUrl,
      voice: voiceUrl,
      voiceDuration: voiceDuration || null,
      messageType: resolvedType,
      isForwarded: !!isForwarded,
      replyTo: replyTo || null,
      isDelivered: true,
      deliveredAt: new Date(),
    });

    chat.latestMessage = message._id;
    await chat.save();
    await message.populate(GROUP_MESSAGE_POPULATE);

    chat.users.forEach((memberId) => {
      const sid = getReceiverSocketId(memberId.toString());
      // Emit to every member, including the sender, so all of their open tabs
      // receive the same realtime group update. The frontend ignores duplicates.
      if (sid) io.to(sid).emit("newGroupMessage", { chatId: chat._id.toString(), message });
    });

    res.status(201).json(message);
  } catch (error) {
    console.error("sendGroupMessage:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const leaveGroup = async (req, res) => {
  try {
    const { chatId } = req.params;
    const myId = req.user._id;
    const chat = await Chat.findOne({ _id: chatId, isGroupChat: true, users: myId });
    if (!chat) return res.status(404).json({ error: "Group not found" });

    const previousMembers = chat.users.map((id) => id.toString());
    chat.users = chat.users.filter((id) => !id.equals(myId));
    chat.groupAdmin = chat.groupAdmin.filter((id) => !id.equals(myId));

    if (chat.users.length === 0) {
      await Chat.deleteOne({ _id: chat._id });
      previousMembers.forEach((memberId) => {
        const sid = getReceiverSocketId(memberId);
        if (sid) io.to(sid).emit("groupUpdated", { _id: chatId, left: true });
      });
      return res.status(200).json({ left: true, deleted: true });
    }

    if (chat.groupAdmin.length === 0) chat.groupAdmin.push(chat.users[0]);
    await chat.save();
    await chat.populate("users", "fullName profilePic isOnline lastSeen");
    const payload = serializeGroup(chat);
    previousMembers.forEach((memberId) => {
      const sid = getReceiverSocketId(memberId);
      if (sid) io.to(sid).emit("groupUpdated", memberId === myId.toString() ? { ...payload, left: true } : payload);
    });

    res.status(200).json({ left: true, group: payload });
  } catch (error) {
    console.error("leaveGroup:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const updateGroupSettings = async (req, res) => {
  try {
    const { chatId } = req.params;
    const myId = req.user._id;
    const chat = await Chat.findOne({ _id: chatId, isGroupChat: true, users: myId });
    if (!chat) return res.status(404).json({ error: "Group not found" });
    if (!chat.groupAdmin.some((id) => id.equals(myId))) {
      return res.status(403).json({ error: "Only group admins can update settings" });
    }

    const beforeMembers = chat.users.map((id) => id.toString());
    const systemEvents = [];

    ["adminOnlyChat", "adminOnlyEdit"].forEach((field) => {
      if (typeof req.body[field] === "boolean") chat[field] = req.body[field];
    });
    if (typeof req.body.chatName === "string") {
      const chatName = req.body.chatName.trim();
      if (chatName.length < 2 || chatName.length > 60) return res.status(400).json({ error: "Group name must be 2-60 characters" });
      if (chat.chatName !== chatName) systemEvents.push(`Group name changed to ${chatName}`);
      chat.chatName = chatName;
    }
    if (typeof req.body.groupDescription === "string") {
      systemEvents.push("Group description was updated");
      chat.groupDescription = req.body.groupDescription.trim().slice(0, 250);
    }
    if (typeof req.body.groupIcon === "string" && req.body.groupIcon) {
      if (!/^data:image\/(jpeg|png|gif|webp);base64,/.test(req.body.groupIcon)) {
        return res.status(400).json({ error: "Group photo must be a JPG, PNG, GIF, or WEBP image" });
      }
      const upload = await cloudinary.uploader.upload(req.body.groupIcon, { folder: "group_icons" });
      chat.groupIcon = upload.secure_url;
      systemEvents.push("Group photo was updated");
    }
    if (req.body.addUserId) {
      const userId = req.body.addUserId.toString();
      if (!chat.users.some((id) => id.toString() === userId)) {
        chat.users.push(req.body.addUserId);
        const addedUser = await User.findById(userId).select("fullName username");
        systemEvents.push(`${addedUser?.fullName || addedUser?.username || "A user"} was added to the group`);
      }
    }
    if (req.body.removeUserId) {
      const userId = req.body.removeUserId.toString();
      if (userId === myId.toString()) return res.status(400).json({ error: "Admins cannot remove themselves here" });
      const removedUser = await User.findById(userId).select("fullName username");
      chat.users = chat.users.filter((id) => id.toString() !== userId);
      chat.groupAdmin = chat.groupAdmin.filter((id) => id.toString() !== userId);
      systemEvents.push(`${removedUser?.fullName || removedUser?.username || "A user"} was removed from the group`);
    }
    if (req.body.addAdminId) {
      const memberId = req.body.addAdminId.toString();
      if (!chat.users.some((id) => id.toString() === memberId)) {
        return res.status(400).json({ error: "User must be a group member before becoming admin" });
      }
      if (!chat.groupAdmin.some((id) => id.toString() === memberId)) {
        chat.groupAdmin.push(req.body.addAdminId);
        const promotedUser = await User.findById(memberId).select("fullName username");
        systemEvents.push(`${promotedUser?.fullName || promotedUser?.username || "A user"} is now an admin`);
      }
    }
    if (req.body.removeAdminId) {
      const adminId = req.body.removeAdminId.toString();
      if (adminId === myId.toString()) return res.status(400).json({ error: "Admins cannot demote themselves" });
      const demotedUser = await User.findById(adminId).select("fullName username");
      chat.groupAdmin = chat.groupAdmin.filter((id) => id.toString() !== adminId);
      systemEvents.push(`${demotedUser?.fullName || demotedUser?.username || "A user"} is no longer an admin`);
      if (chat.groupAdmin.length === 0) chat.groupAdmin.push(myId);
    }
    await chat.save();
    await chat.populate("users", "fullName profilePic isOnline lastSeen");
    const payload = serializeGroup(chat);
    emitGroupRealtime(chat, payload, beforeMembers);
    for (const eventText of systemEvents) await emitGroupSystemMessage(chat, eventText, beforeMembers);
    res.status(200).json(payload);
  } catch (error) {
    console.error("updateGroupSettings:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};
