import crypto from "crypto";
import bcrypt from "bcryptjs";
import cloudinary from "../../lib/cloudinary.js";
import mailtrap from "../../services/mailtrap.js";
import User from "../../models/user.model.js";
import UserActivity from "../../models/userActivity.model.js";
import Message from "../../models/message.model.js";
import { emitAdminUserDeleted, emitPrivacyUpdated, emitUserActivityCreated, emitUserCreated, emitUserProfileUpdated } from "../../lib/socket.js";
import { generateToken } from "../../lib/utils.js";
import { isConfiguredAdmin } from "../../middleware/admin.middleware.js";
import { app as appConfig } from "../../config/keys.js";

// Constants
import {
  NAME_REGEX,
  EMAIL_REGEX,
  BCRYPT_SALT_ROUNDS,
  MIN_NAME_LENGTH,
  MAX_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  RESET_PASSWORD_TOKEN_BYTES,
  RESET_PASSWORD_EXPIRY_MS,
} from "../../constants/auth.constants.js";

// Helpers
import {
  safeCompareOtp,
  extractCloudinaryPublicId,
  sanitizeUser,
  isOnCooldown,
  assignNewOtp,
} from "../../lib/auth.helpers.js";


const normalizeClientUrl = (req) => {
  const configuredUrl = appConfig.clientURL?.split(",")[0]?.trim();
  if (configuredUrl) return configuredUrl.replace(/\/$/, "");
  const fallback = `${req.protocol}://${req.get("host")}`;
  if (process.env.NODE_ENV === "development") {
    console.warn(
      "[WARN] CLIENT_URL is not set. Reset links will point to the backend " +
      `(${fallback}) instead of the frontend.  Add CLIENT_URL=http://localhost:5173 ` +
      "to your .env file."
    );
  }
  return fallback;
};

const hashResetToken = (token) => crypto.createHash("sha256").update(token).digest("hex");

const USERNAME_REGEX = /^[a-z0-9_]{3,30}$/;

const trackUserActivity = async (req, userId, type, label, metadata = {}) => {
  try {
    const activity = await UserActivity.create({
      userId,
      type,
      label,
      metadata,
      ip: req.ip || req.headers["x-forwarded-for"] || "",
      userAgent: req.get?.("user-agent") || "",
    });
    emitUserActivityCreated(activity);
    return activity;
  } catch (error) {
    console.error("User activity log failed:", error.message);
    return null;
  }
};

const createUsernameCandidate = (fullName, email) => (
  (fullName || email.split("@")[0])
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 24) || "user"
);

const generateAvailableUsername = async (fullName, email) => {
  const base = createUsernameCandidate(fullName, email);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const suffix = attempt === 0 ? "" : String(Math.floor(1000 + Math.random() * 9000));
    const username = `${base}${suffix}`.slice(0, 30);
    const existing = await User.exists({ username });
    if (!existing) return username;
  }
  return `user_${Date.now().toString(36)}`.slice(0, 30);
};

const buildAuthUserResponse = (user) => ({
  _id: user._id,
  fullName: user.fullName,
  username: user.username,
  usernameConfirmed: !!user.usernameConfirmed,
  email: user.email,
  profilePic: user.profilePic,
  about: user.about,
  privacy: user.privacy,
  isVerified: user.isVerified,
  isAdmin: isConfiguredAdmin(user),
  isSuspended: !!user.isSuspended,
  createdAt: user.createdAt,
  lastOtpSentAt: user.lastOtpSentAt,
});

// ---------------------------------------------------------------------------
// POST /auth/signup
// ---------------------------------------------------------------------------
export const signup = async (req, res) => {
  const fullName = req.body.fullName?.trim();
  const email    = req.body.email?.trim().toLowerCase();
  const password = req.body.password != null ? String(req.body.password) : undefined;

  try {
    if (!fullName || !email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    if (fullName.length < MIN_NAME_LENGTH || fullName.length > MAX_NAME_LENGTH) {
      return res.status(400).json({
        message: `Full name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters`,
      });
    }
    if (!NAME_REGEX.test(fullName)) {
      return res.status(400).json({
        message: "Full name can only contain letters and single spaces between words",
      });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    const username = await generateAvailableUsername(fullName, email);
    const newUser        = new User({ fullName, username, usernameConfirmed: false, email, password: hashedPassword });

    assignNewOtp(newUser);
    await newUser.save();
    await trackUserActivity(req, newUser._id, "account.created", "Account created", { username });

    generateToken(newUser._id, res);

    let emailSent = true;
    try {
      await mailtrap.sendEmail(newUser.email, "send-otp", null, newUser.verificationToken);
    } catch (mailError) {
      emailSent = false;
      console.error("Failed to send verification email on signup:", mailError.message);
    }

    emitUserCreated(newUser);

    return res.status(201).json({
      ...buildAuthUserResponse(newUser),
      emailSent,
      ...(emailSent
        ? {}
        : { message: "Account created but verification email could not be sent. Please use Resend." }),
    });
  } catch (error) {
    console.error("Error in signup controller:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------
export const login = async (req, res) => {
  const email    = req.body.email?.trim().toLowerCase();
  const password = req.body.password != null ? String(req.body.password) : undefined;

  try {
    if (!email || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    if (user.isSuspended) {
      return res.status(403).json({ message: "This account has been suspended. Contact support for help." });
    }

    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    user.lastLogin = new Date();
    await user.save();
    await trackUserActivity(req, user._id, "auth.login", "Logged in");

    generateToken(user._id, res);

    return res.status(200).json(buildAuthUserResponse(user));
  } catch (error) {
    console.error("Error in login controller:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// ---------------------------------------------------------------------------
// POST /auth/forgot-password
// ---------------------------------------------------------------------------
export const forgotPassword = async (req, res) => {
  const email = req.body.email?.trim().toLowerCase();

  try {
    if (!email || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: "Enter a valid email address" });
    }

    const user = await User.findOne({ email });
    const genericMessage = "If that email belongs to an account, a secure reset link has been sent.";

    if (user) {
      const rawToken = crypto.randomBytes(RESET_PASSWORD_TOKEN_BYTES).toString("hex");
      user.resetPasswordToken = hashResetToken(rawToken);
      user.resetPasswordExpiresAt = new Date(Date.now() + RESET_PASSWORD_EXPIRY_MS);
      await user.save();

      try {
        await mailtrap.sendEmail(user.email, "reset", normalizeClientUrl(req), rawToken);
      } catch (mailError) {
        // BUG FIX: Previously the token was nullified here, which meant:
        //   1. The reset link could never be used even if the email arrived.
        //   2. The user sees "link sent" but clicking it always fails.
        // Now the token is preserved — it expires naturally via resetPasswordExpiresAt.
        console.error("Failed to send password reset email:", mailError.message);
      }
    }

    return res.status(200).json({ message: genericMessage });
  } catch (error) {
    console.error("Error in forgotPassword controller:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// ---------------------------------------------------------------------------
// POST /auth/reset-password/:token
// ---------------------------------------------------------------------------
export const resetPassword = async (req, res) => {
  const token = req.params.token;
  const password = req.body.password != null ? String(req.body.password) : undefined;

  try {
    if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
      return res.status(400).json({ message: "Invalid or expired reset link" });
    }

    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const hashedToken = hashResetToken(token);
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired reset link" });
    }

    user.password = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    user.resetPasswordToken = null;
    user.resetPasswordExpiresAt = null;
    user.lastLogin = new Date();
    await user.save();
    await trackUserActivity(req, user._id, "password.reset", "Password reset with email link");

    try {
      await mailtrap.sendEmail(user.email, "reset-confirmation", null, null);
    } catch (mailError) {
      console.error("Failed to send password reset confirmation:", mailError.message);
    }

    generateToken(user._id, res);
    return res.status(200).json(buildAuthUserResponse(user));
  } catch (error) {
    console.error("Error in resetPassword controller:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// ---------------------------------------------------------------------------
// PUT /auth/change-password
// ---------------------------------------------------------------------------
export const changePassword = async (req, res) => {
  const currentPassword = req.body.currentPassword != null ? String(req.body.currentPassword) : undefined;
  const newPassword = req.body.newPassword != null ? String(req.body.newPassword) : undefined;

  try {
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Current password and new password are required" });
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: "User not found" });

    const isPasswordCorrect = await bcrypt.compare(currentPassword, user.password);
    if (!isPasswordCorrect) {
      return res.status(403).json({ message: "Incorrect current password" });
    }

    const isSamePassword = await bcrypt.compare(newPassword, user.password);
    if (isSamePassword) {
      return res.status(400).json({ message: "New password must be different from the current password" });
    }

    user.password = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    user.resetPasswordToken = null;
    user.resetPasswordExpiresAt = null;
    await user.save();
    await trackUserActivity(req, user._id, "password.changed", "Password changed");

    try {
      await mailtrap.sendEmail(user.email, "reset-confirmation", null, null);
    } catch (mailError) {
      console.error("Failed to send password change confirmation:", mailError.message);
    }

    return res.status(200).json({ message: "Password changed successfully" });
  } catch (error) {
    console.error("Error in changePassword controller:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// ---------------------------------------------------------------------------
// POST /auth/verify-email
// ---------------------------------------------------------------------------
export const verifyEmail = async (req, res) => {
  const otp    = req.body.otp != null ? String(req.body.otp) : undefined;
  const userId = req.user?._id;

  try {
    if (!otp) {
      return res.status(400).json({ message: "Verification code is required" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: "Email is already verified" });
    }

    if (!user.verificationToken || user.verificationTokenExpiresAt < new Date()) {
      return res.status(400).json({ message: "Verification code has expired" });
    }

    if (!safeCompareOtp(user.verificationToken, otp)) {
      return res.status(400).json({ message: "Invalid verification code" });
    }

    user.isVerified                  = true;
    user.verificationToken           = null;
    user.verificationTokenExpiresAt  = null;
    user.lastOtpSentAt               = null;
    await user.save();

    return res.status(200).json(buildAuthUserResponse(user));
  } catch (error) {
    console.error("Error in verifyEmail controller:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// ---------------------------------------------------------------------------
// POST /auth/resend-otp
// ---------------------------------------------------------------------------
export const resendOtp = async (req, res) => {
  const userId = req.user?._id;

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isVerified) {
      return res.status(400).json({ message: "Email is already verified" });
    }

    if (isOnCooldown(user, res)) return;

    assignNewOtp(user);
    await user.save();

    let emailSent = true;
    try {
      await mailtrap.sendEmail(user.email, "send-otp", null, user.verificationToken);
    } catch (mailError) {
      emailSent = false;
      console.error("Failed to send OTP email on resend:", mailError.message);
    }

    if (!emailSent) {
      return res.status(502).json({
        message: "Verification code updated but email could not be sent. Please try again.",
        lastOtpSentAt: user.lastOtpSentAt,
      });
    }

    return res.status(200).json({
      message: "Verification code resent successfully",
      lastOtpSentAt: user.lastOtpSentAt,
    });
  } catch (error) {
    console.error("Error in resendOtp controller:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// ---------------------------------------------------------------------------
// PUT /auth/update-email
// ---------------------------------------------------------------------------
export const updateEmail = async (req, res) => {
  const email    = req.body.email?.trim().toLowerCase();
  const password = req.body.password != null ? String(req.body.password) : undefined;
  const userId   = req.user?._id;

  try {
    if (!email || !password) {
      return res.status(400).json({ message: "Email and current password are required" });
    }

    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ message: "Invalid email format" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.email === email) {
      return res.status(400).json({ message: "New email must be different from the current one" });
    }

    const emailTaken = await User.findOne({ email, _id: { $ne: userId } });
    if (emailTaken) {
      return res.status(400).json({ message: "Email already exists" });
    }

    if (user.isSuspended) {
      return res.status(403).json({ message: "This account has been suspended. Contact support for help." });
    }

    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      return res.status(403).json({ message: "Incorrect password" });
    }

    if (isOnCooldown(user, res)) return;

    user.email      = email;
    user.isVerified = false;
    assignNewOtp(user);
    await user.save();

    let emailSent = true;
    try {
      await mailtrap.sendEmail(user.email, "send-otp", null, user.verificationToken);
    } catch (mailError) {
      emailSent = false;
      console.error("Failed to send OTP email on updateEmail:", mailError.message);
    }

    return res.status(200).json({
      ...buildAuthUserResponse(user),
      emailSent,
      ...(emailSent
        ? {}
        : { message: "Email updated but verification email could not be sent. Please use Resend." }),
    });
  } catch (error) {
    console.error("Error in updateEmail controller:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// ---------------------------------------------------------------------------
// PUT /auth/update-profile
// ---------------------------------------------------------------------------
export const updateProfile = async (req, res) => {
  const { profilePic, fullName, about, username } = req.body;
  const userId = req.user._id;

  try {
    if (!profilePic && !fullName && about === undefined && username === undefined) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    const updateData = {};
    const activity = [];

    if (fullName) {
      const trimmedName = fullName.trim();

      if (trimmedName.length < MIN_NAME_LENGTH || trimmedName.length > MAX_NAME_LENGTH) {
        return res.status(400).json({
          message: `Full name must be between ${MIN_NAME_LENGTH} and ${MAX_NAME_LENGTH} characters`,
        });
      }
      if (!NAME_REGEX.test(trimmedName)) {
        return res.status(400).json({
          message: "Full name can only contain letters and single spaces between words",
        });
      }
      updateData.fullName = trimmedName;
      activity.push(["profile.name_changed", "Name updated", { fullName: trimmedName }]);
    }

    if (username !== undefined) {
      if (typeof username !== "string") return res.status(400).json({ message: "Username must be text" });
      const normalizedUsername = username.trim().toLowerCase().replace(/^@/, "");
      if (!USERNAME_REGEX.test(normalizedUsername)) {
        return res.status(400).json({ message: "Username must be 3-30 characters using letters, numbers, or underscores" });
      }
      const existingUsername = await User.findOne({ username: normalizedUsername, _id: { $ne: userId } }).select("_id");
      if (existingUsername) return res.status(409).json({ message: "Username is already taken" });
      updateData.username = normalizedUsername;
      updateData.usernameConfirmed = true;
      activity.push(["profile.username_changed", "Username changed", { username: normalizedUsername }]);
    }

    if (about !== undefined) {
      if (typeof about !== "string") {
        return res.status(400).json({ message: "About must be text" });
      }
      const trimmedAbout = about.trim();
      if (trimmedAbout.length > 139) {
        return res.status(400).json({ message: "About must be 139 characters or fewer" });
      }
      updateData.about = trimmedAbout || "Hey there! I am using Messenger.";
      activity.push(["profile.about_changed", "About updated"]);
    }

    if (profilePic) {
      const isBase64Image = /^data:image\/(jpeg|png|gif|webp);base64,/.test(profilePic);
      if (!isBase64Image) {
        return res.status(400).json({
          message: "Profile picture must be a valid base64-encoded image (jpeg, png, gif, or webp)",
        });
      }

      const currentUser    = await User.findById(userId).select("profilePic");
      const oldProfilePicUrl = currentUser?.profilePic;

      const uploadResponse     = await cloudinary.uploader.upload(profilePic);
      updateData.profilePic    = uploadResponse.secure_url;
      activity.push(["profile.photo_changed", "Profile photo updated"]);

      if (oldProfilePicUrl?.includes("cloudinary.com")) {
        const oldPublicId = extractCloudinaryPublicId(oldProfilePicUrl);
        if (oldPublicId) {
          try {
            await cloudinary.uploader.destroy(oldPublicId);
          } catch (cloudinaryError) {
            console.error("Failed to delete old Cloudinary asset:", cloudinaryError.message);
          }
        }
      }
    }

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { new: true, runValidators: true }
    ).select("-password -verificationToken -verificationTokenExpiresAt");

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    for (const [type, label, metadata] of activity) await trackUserActivity(req, updatedUser._id, type, label, metadata);
    emitUserProfileUpdated(updatedUser);

    return res.status(200).json(buildAuthUserResponse(updatedUser));
  } catch (error) {
    console.error("Error in updateProfile controller:", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ---------------------------------------------------------------------------
// DELETE /auth/delete-account
// ---------------------------------------------------------------------------
export const deleteAccount = async (req, res) => {
  const password = req.body.password != null ? String(req.body.password) : undefined;
  const userId   = req.user._id;

  try {
    if (!password) {
      return res.status(400).json({ message: "Password is required to delete your account" });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isSuspended) {
      return res.status(403).json({ message: "This account has been suspended. Contact support for help." });
    }

    const isPasswordCorrect = await bcrypt.compare(password, user.password);
    if (!isPasswordCorrect) {
      return res.status(403).json({ message: "Incorrect password" });
    }

    if (user.profilePic?.includes("cloudinary.com")) {
      const publicId = extractCloudinaryPublicId(user.profilePic);
      if (publicId) {
        try {
          await cloudinary.uploader.destroy(publicId);
        } catch (cloudinaryError) {
          console.error("Failed to delete Cloudinary asset:", cloudinaryError.message);
        }
      }
    }

    const accountMessages = await Message.find({
      $or: [
        { senderId: userId },
        { receiverId: userId },
      ],
    }).select("image voice");

    await Promise.allSettled(
      accountMessages.flatMap((message) => {
        const removals = [];
        if (message.image?.includes("cloudinary.com")) {
          const publicId = extractCloudinaryPublicId(message.image);
          if (publicId) removals.push(cloudinary.uploader.destroy(publicId, { resource_type: "image" }));
        }
        if (message.voice?.includes("cloudinary.com")) {
          const publicId = extractCloudinaryPublicId(message.voice);
          if (publicId) removals.push(cloudinary.uploader.destroy(publicId, { resource_type: "video" }));
        }
        return removals;
      })
    );

    await Message.deleteMany({
      $or: [
        { senderId: userId },
        { receiverId: userId },
      ],
    });

    await User.findByIdAndDelete(userId);
    emitAdminUserDeleted(userId);

    res.cookie("jwt", "", {
      maxAge: 0,
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV !== "development",
    });

    return res.status(200).json({ message: "Account deleted successfully" });
  } catch (error) {
    console.error("Error in deleteAccount controller:", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ---------------------------------------------------------------------------
// PUT /api/auth/public-key
// ---------------------------------------------------------------------------
export const savePublicKey = async (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) return res.status(400).json({ error: "publicKey is required" });

    await User.findByIdAndUpdate(req.user._id, { publicKey });
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("savePublicKey:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};

// ---------------------------------------------------------------------------
// GET /api/auth/public-key/:userId
// ---------------------------------------------------------------------------
export const getPublicKey = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select("publicKey");
    if (!user) return res.status(404).json({ error: "User not found" });
    res.status(200).json({ publicKey: user.publicKey });
  } catch (error) {
    console.error("getPublicKey:", error.message);
    res.status(500).json({ error: "Internal server error" });
  }
};


export const getPublicUserByUsername = async (req, res) => {
  try {
    const username = req.params.username?.trim().toLowerCase().replace(/^@/, "");
    if (!USERNAME_REGEX.test(username)) return res.status(400).json({ message: "Invalid username" });
    const user = await User.findOne({ username }).select("fullName username profilePic about isOnline lastSeen createdAt");
    if (!user) return res.status(404).json({ message: "User not found" });
    return res.status(200).json(user);
  } catch (error) {
    console.error("getPublicUserByUsername:", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------
export const logout = (req, res) => {
  try {
    res.cookie("jwt", "", { maxAge: 0 });
    return res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    console.error("Error in logout controller:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// ---------------------------------------------------------------------------
// GET /auth/check
// ---------------------------------------------------------------------------
export const checkAuth = (req, res) => {
  try {
    return res.status(200).json(buildAuthUserResponse(req.user));
  } catch (error) {
    console.error("Error in checkAuth controller:", error.message);
    res.status(500).json({ message: "Internal Server Error" });
  }
};

// ---------------------------------------------------------------------------
// PUT /auth/privacy
// ---------------------------------------------------------------------------
export const updatePrivacySettings = async (req, res) => {
  try {
    const current = req.user.privacy || {};
    const allowedAudience = new Set(["everyone", "contacts", "nobody"]);
    const next = { ...current };

    ["lastSeen", "profilePhoto", "groupInvites"].forEach((field) => {
      if (req.body[field] !== undefined) {
        if (!allowedAudience.has(req.body[field])) {
          throw new Error(`Invalid ${field} privacy value`);
        }
        next[field] = req.body[field];
      }
    });

    ["readReceipts", "allowCalls"].forEach((field) => {
      if (req.body[field] !== undefined) next[field] = !!req.body[field];
    });

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { privacy: next },
      { new: true, runValidators: true }
    ).select("-password");

    emitPrivacyUpdated(user);

    res.status(200).json(sanitizeUser(user));
  } catch (error) {
    console.error("updatePrivacySettings:", error.message);
    res.status(400).json({ message: error.message || "Invalid privacy settings" });
  }
};
