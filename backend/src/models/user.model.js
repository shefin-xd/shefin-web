import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
    },
    fullName: {
      type: String,
      required: true,
    },
    username: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
      match: /^[a-z0-9_]+$/,
    },
    usernameConfirmed: {
      type: Boolean,
      default: true,
    },
    password: {
      type: String,
      required: true,
      minlength: 6,
    },
    profilePic: {
      type: String,
      default: "",
    },
    about: {
      type: String,
      default: "Hey there! I am using Messenger.",
      maxlength: 139,
    },
    lastLogin: {
      type: Date,
      default: Date.now,
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
    },
    lastAdminActionAt: {
      type: Date,
      default: null,
    },
    isVerified: {
      type: Boolean,
      default: false,
    },
    isAdmin: {
      type: Boolean,
      default: false,
    },
    isSuspended: {
      type: Boolean,
      default: false,
    },

    // ── Online presence ──────────────────────────────────────
    // Set to true on socket connect, false on disconnect.
    isOnline: {
      type: Boolean,
      default: false,
    },
    // Stamped by the socket server the moment a user disconnects.
    // null while the user is currently online (or has never connected).
    lastSeen: {
      type: Date,
      default: null,
    },

    publicKey: {
      type: String,  // JWK-serialised ECDH P-256 public key
      default: null,
    },

    // ── Privacy settings ─────────────────────────────────────
    privacy: {
      lastSeen: {
        type: String,
        enum: ["everyone", "contacts", "nobody"],
        default: "everyone",
      },
      profilePhoto: {
        type: String,
        enum: ["everyone", "contacts", "nobody"],
        default: "everyone",
      },
      readReceipts: {
        type: Boolean,
        default: true,
      },
      allowCalls: {
        type: Boolean,
        default: true,
      },
      groupInvites: {
        type: String,
        enum: ["everyone", "contacts", "nobody"],
        default: "everyone",
      },
    },

    // ── Auth tokens ──────────────────────────────────────────
    // Reserved for a future forgot-password flow.
    resetPasswordToken: String,
    resetPasswordExpiresAt: Date,
    verificationToken: String,
    verificationTokenExpiresAt: Date,

    /**
     * BUG FIX: was `default: 0`.
     *
     * Mongoose casts 0 to new Date(0) (1970-01-01), which is truthy.  The
     * isOnCooldown helper's `if (user.lastOtpSentAt == null) return false`
     * guard then falls through to the elapsed-time branch for every brand-new
     * user — harmless in practice (1970 → now is ~1.7 trillion ms > 60 s) but
     * semantically wrong and confusing.
     *
     * null is the correct sentinel: "no OTP has ever been sent".
     */
    lastOtpSentAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

userSchema.index({ username: 1 });

const User = mongoose.model("User", userSchema);
export default User;
