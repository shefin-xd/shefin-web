import mongoose from "mongoose";

const reactionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    emoji:  { type: String, required: true },
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    senderId:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    receiverId: { type: mongoose.Schema.Types.ObjectId, required: true },
    chatId:     { type: mongoose.Schema.Types.ObjectId, ref: "Chat", default: null },
    isGroupMessage: { type: Boolean, default: false },

    // ── Content — plain (legacy / unencrypted) ──────────────
    messageType: { type: String, enum: ["text","image","voice","system"], default: "text" },
    text:         { type: String, default: null },
    image:        { type: String, default: null },
    voice:        { type: String, default: null },
    voiceDuration:{ type: Number, default: null },
    isForwarded:  { type: Boolean, default: false },
    isEdited:     { type: Boolean, default: false },
    editedAt:     { type: Date,    default: null  },

    // ── E2EE encrypted content ───────────────────────────────
    // When isEncrypted is true, all readable content lives here as a
    // single AES-256-GCM blob.  text/image/voice are null on the server.
    // Only the two conversation participants can decrypt this field.
    isEncrypted:      { type: Boolean, default: false },
    encryptedContent: { type: String,  default: null  },

    // ── Delivery & read receipts ─────────────────────────────
    isDelivered: { type: Boolean, default: false },
    deliveredAt: { type: Date,    default: null  },
    isRead:      { type: Boolean, default: false },
    readAt:      { type: Date,    default: null  },

    // ── Threading ────────────────────────────────────────────
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: "Message", default: null },

    // ── Reactions & starring ──────────────────────────────────
    reactions: { type: [reactionSchema], default: [] },
    starredBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],

    // ── Soft delete ──────────────────────────────────────────
    deletedFor:           [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    isDeletedForEveryone: { type: Boolean, default: false },
  },
  { timestamps: true }
);

messageSchema.index({ senderId: 1, receiverId: 1, createdAt: -1 });
messageSchema.index({ chatId: 1, createdAt: -1 });
messageSchema.index({ receiverId: 1, isRead: 1 });

const Message = mongoose.model("Message", messageSchema);
export default Message;
