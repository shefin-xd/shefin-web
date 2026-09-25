import mongoose from "mongoose";

const chatSchema = new mongoose.Schema(
  {
    chatName: { type: String, trim: true, default: "" },
    isGroupChat: { type: Boolean, default: false },
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    latestMessage: { type: mongoose.Schema.Types.ObjectId, ref: "Message" },
    groupAdmin: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    groupIcon: {
      type: String,
      default: ""
    },
    groupDescription: { type: String, max: 250, default: "Welcome to our group!" },
    adminOnlyChat: { type: Boolean, default: false },
    adminOnlyEdit: { type: Boolean, default: false },
    inviteCode: { type: String, unique: true, sparse: true },
    ephemeralDuration: {
      type: Number,
      default: 0 // Message lifespan in seconds. 0 means persistent/disabled.
    },
    mutedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }]
  },
  { timestamps: true }
);

// Indexes optimizing high-frequency conversational routing
chatSchema.index({ users: 1 });
chatSchema.index({ updatedAt: -1 });

export const Chat = mongoose.model("Chat", chatSchema);
