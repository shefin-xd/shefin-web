import User from "../../models/user.model.js";
import { Chat } from "../../models/chat.model.js";
import Message from "../../models/message.model.js";
import SystemSettings from "../../models/systemSettings.model.js";
import AdminLog from "../../models/adminLog.model.js";
import UserActivity from "../../models/userActivity.model.js";
import { configuredAdminEmails, isConfiguredAdmin } from "../../middleware/admin.middleware.js";
import { SETTINGS_KEY, getSystemSettings } from "../../lib/systemSettings.js";
import { emitAdminAnnouncement, emitAdminLogCreated, emitAdminUserDeleted, emitAdminUserUpdated, emitGroupUpdated, emitMaintenanceUpdated } from "../../lib/socket.js";
import mailtrap from "../../services/mailtrap.js";

const USERNAME_REGEX = /^[a-z0-9_]{3,30}$/;

const writeAdminLog = async (req, action, targetType, target, metadata = {}) => {
  try {
    const log = await AdminLog.create({
      actorId: req.user?._id || null,
      actorName: req.user?.fullName || req.user?.username || "Admin",
      action,
      targetType,
      targetId: target?._id || target || null,
      targetName: target?.fullName || target?.chatName || target?.username || "",
      metadata,
    });
    emitAdminLogCreated(log);
    return log;
  } catch (error) {
    console.error("Admin log failed:", error.message);
    return null;
  }
};


const publicGroup = (chat) => {
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
    unreadCount: 0,
  };
};

const publicUser = (user) => ({
  _id: user._id,
  fullName: user.fullName,
  username: user.username,
  email: user.email,
  profilePic: user.profilePic,
  about: user.about,
  isVerified: !!user.isVerified,
  isOnline: !!user.isOnline,
  isAdmin: isConfiguredAdmin(user),
  isSuspended: !!user.isSuspended,
  lastLogin: user.lastLogin,
  lastActiveAt: user.lastActiveAt,
  lastAdminActionAt: user.lastAdminActionAt,
  lastSeen: user.lastSeen,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  activity: user.activity || [],
});

export const getAdminDashboard = async (req, res) => {
  try {
    const [users, totalUsers, onlineUsers, verifiedUsers, suspendedUsers, admins, settings, logs, activities] = await Promise.all([
      User.find({}).select("fullName username email profilePic about isVerified isOnline isAdmin isSuspended lastLogin lastActiveAt lastAdminActionAt lastSeen createdAt updatedAt").sort({ createdAt: -1 }).limit(250),
      User.countDocuments(),
      User.countDocuments({ isOnline: true }),
      User.countDocuments({ isVerified: true }),
      User.countDocuments({ isSuspended: true }),
      User.countDocuments({ $or: [{ isAdmin: true }, { email: { $in: Array.from(configuredAdminEmails()) } }] }),
      getSystemSettings(),
      AdminLog.find({}).sort({ createdAt: -1 }).limit(80).lean(),
      UserActivity.find({}).sort({ createdAt: -1 }).limit(600).lean(),
    ]);

    const activitiesByUser = activities.reduce((acc, activity) => {
      const key = activity.userId?.toString();
      if (!key) return acc;
      acc[key] ||= [];
      if (acc[key].length < 12) acc[key].push(activity);
      return acc;
    }, {});

    res.status(200).json({
      stats: { totalUsers, onlineUsers, verifiedUsers, suspendedUsers, admins },
      settings: {
        maintenanceMode: !!settings.maintenanceMode,
        maintenanceMessage: settings.maintenanceMessage,
        updatedAt: settings.updatedAt,
      },
      users: users.map((user) => publicUser({ ...user.toObject(), activity: activitiesByUser[user._id.toString()] || [] })),
      logs,
    });
  } catch (error) {
    console.error("Error loading admin dashboard:", error.message);
    res.status(500).json({ message: "Unable to load admin dashboard" });
  }
};

export const updateUserByAdmin = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user._id.equals(req.user._id) && req.body.isSuspended === true) {
      return res.status(400).json({ message: "Admins cannot suspend their own account" });
    }

    const envAdminEmails = configuredAdminEmails();
    const isEnvAdmin = envAdminEmails.has(user.email?.trim().toLowerCase());
    if (isEnvAdmin && (req.body.isAdmin === false || req.body.isSuspended === true || req.body.isVerified === false)) {
      return res.status(403).json({ message: "Environment-configured admins cannot be demoted, suspended, or unverified by another admin" });
    }

    ["isVerified", "isSuspended", "isAdmin"].forEach((field) => {
      if (typeof req.body[field] === "boolean") user[field] = req.body[field];
    });

    if (typeof req.body.fullName === "string") {
      const fullName = req.body.fullName.trim();
      if (fullName.length < 2 || fullName.length > 50) return res.status(400).json({ message: "Name must be 2-50 characters" });
      user.fullName = fullName;
    }

    if (typeof req.body.username === "string") {
      const username = req.body.username.trim().toLowerCase().replace(/^@/, "");
      if (!USERNAME_REGEX.test(username)) return res.status(400).json({ message: "Username must be 3-30 lowercase letters, numbers, or underscores" });
      const existing = await User.findOne({ username, _id: { $ne: user._id } }).select("_id");
      if (existing) return res.status(409).json({ message: "Username is already taken" });
      user.username = username;
      user.usernameConfirmed = true;
    }

    if (typeof req.body.profilePic === "string") {
      user.profilePic = req.body.profilePic.trim();
    }

    user.lastAdminActionAt = new Date();
    const changedFields = Object.keys(req.body).filter((field) => ["isVerified", "isSuspended", "isAdmin", "fullName", "username", "profilePic"].includes(field));
    await user.save();
    await writeAdminLog(req, "user.updated", "user", user, { changedFields });
    emitAdminUserUpdated(user);
    res.status(200).json(publicUser(user));
  } catch (error) {
    console.error("Error updating admin user:", error.message);
    res.status(500).json({ message: "Unable to update user" });
  }
};

export const exportUserDataByAdmin = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select("-password -resetPasswordToken -verificationToken");
    if (!user) return res.status(404).json({ message: "User not found" });
    const [sentMessages, receivedMessages, groups] = await Promise.all([
      Message.find({ senderId: user._id }).lean(),
      Message.find({ receiverId: user._id }).lean(),
      Chat.find({ users: user._id }).lean(),
    ]);
    res.status(200).json({ exportedAt: new Date().toISOString(), user, sentMessages, receivedMessages, groups });
  } catch (error) {
    console.error("Error exporting user data:", error.message);
    res.status(500).json({ message: "Unable to export user data" });
  }
};

export const deleteUserByAdmin = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user._id.equals(req.user._id)) return res.status(400).json({ message: "Admins cannot delete their own account" });
    if (configuredAdminEmails().has(user.email?.trim().toLowerCase())) {
      return res.status(403).json({ message: "Environment-configured admins cannot be deleted by another admin" });
    }

    const affectedGroups = await Chat.find({ isGroupChat: true, users: user._id }).select("users groupAdmin");
    const previousMembersByGroup = new Map(affectedGroups.map((group) => [group._id.toString(), group.users.map((id) => id.toString())]));

    await Promise.all([
      Message.deleteMany({ $or: [{ senderId: user._id }, { receiverId: user._id }] }),
      Chat.updateMany({ users: user._id }, { $pull: { users: user._id, groupAdmin: user._id, mutedBy: user._id } }),
      User.deleteOne({ _id: user._id }),
    ]);

    const orphanedGroups = await Chat.find({ isGroupChat: true, users: { $size: 0 } }).select("_id");
    await Chat.deleteMany({ _id: { $in: orphanedGroups.map((group) => group._id) } });
    const groupsWithoutAdmin = await Chat.find({ isGroupChat: true, groupAdmin: { $size: 0 }, users: { $ne: [] } });
    await Promise.all(groupsWithoutAdmin.map((group) => {
      group.groupAdmin = [group.users[0]];
      return group.save();
    }));

    const updatedGroups = await Chat.find({ _id: { $in: Array.from(previousMembersByGroup.keys()) } })
      .populate("latestMessage")
      .populate("users", "fullName profilePic isOnline lastSeen");
    updatedGroups.forEach((group) => {
      emitGroupUpdated(group, publicGroup(group), previousMembersByGroup.get(group._id.toString()) || []);
    });
    orphanedGroups.forEach((group) => {
      const previousMembers = previousMembersByGroup.get(group._id.toString()) || [];
      emitGroupUpdated({ _id: group._id, users: [] }, { _id: group._id.toString(), left: true }, previousMembers);
    });

    await writeAdminLog(req, "user.deleted", "user", user, { email: user.email, username: user.username });
    emitAdminUserDeleted(req.params.userId);
    res.status(200).json({ deleted: true, userId: req.params.userId });
  } catch (error) {
    console.error("Error deleting admin user:", error.message);
    res.status(500).json({ message: "Unable to delete user" });
  }
};

export const updateMaintenance = async (req, res) => {
  try {
    const maintenanceMessage = String(req.body.maintenanceMessage || "Messenger is temporarily in maintenance mode. Please check back soon.").slice(0, 240);
    const settings = await SystemSettings.findOneAndUpdate(
      { key: SETTINGS_KEY },
      { maintenanceMode: !!req.body.maintenanceMode, maintenanceMessage, updatedBy: req.user._id },
      { new: true, upsert: true }
    );
    const payload = { maintenanceMode: settings.maintenanceMode, maintenanceMessage: settings.maintenanceMessage, updatedAt: settings.updatedAt };
    await writeAdminLog(req, "maintenance.updated", "system", null, payload);
    emitMaintenanceUpdated(payload);
    res.status(200).json(payload);
  } catch (error) {
    console.error("Error updating maintenance:", error.message);
    res.status(500).json({ message: "Unable to update maintenance mode" });
  }
};


export const sendAnnouncementByAdmin = async (req, res) => {
  try {
    const subject = String(req.body.subject || "Messenger announcement").trim().slice(0, 120);
    const message = String(req.body.message || "").trim().slice(0, 2000);
    const target = req.body.target || "all";
    if (!message) return res.status(400).json({ message: "Announcement message is required" });

    const query = target === "verified" ? { isVerified: true } : target === "online" ? { isOnline: true } : {};
    const users = await User.find(query).select("email fullName").lean();
    const results = await Promise.allSettled(users.map((user) => mailtrap.sendEmail(user.email, "announcement", null, { subject, message, fullName: user.fullName })));
    const sent = results.filter((result) => result.status === "fulfilled").length;
    const failed = results.length - sent;
    const payload = { subject, message, sentAt: new Date() };
    await writeAdminLog(req, "announcement.sent", "system", null, { subject, target, totalRecipients: users.length, sent, failed });
    emitAdminAnnouncement(payload);
    res.status(200).json({ ...payload, totalRecipients: users.length, sent, failed });
  } catch (error) {
    console.error("Error sending announcement:", error.message);
    res.status(500).json({ message: error.message || "Unable to send announcement" });
  }
};
