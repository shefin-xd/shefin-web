import mongoose from "mongoose";

const userActivitySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    ip: { type: String, default: "" },
    userAgent: { type: String, default: "" },
  },
  { timestamps: true }
);

userActivitySchema.index({ userId: 1, createdAt: -1 });
userActivitySchema.index({ createdAt: -1 });

const UserActivity = mongoose.model("UserActivity", userActivitySchema);
export default UserActivity;
