import jwt from "jsonwebtoken";
import User from "../models/user.model.js";
import { isConfiguredAdmin } from "./admin.middleware.js";
import { getSystemSettings } from "../lib/systemSettings.js";

export const maintenanceGate = async (req, res, next) => {
  try {
    const settings = await getSystemSettings();
    if (!settings.maintenanceMode) return next();

    const token = req.cookies.jwt;
    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.userId).select("email isAdmin");
        if (isConfiguredAdmin(user)) return next();
      } catch {
        // Fall through to maintenance response for invalid sessions.
      }
    }

    return res.status(503).json({
      message: settings.maintenanceMessage || "Messenger is temporarily in maintenance mode. Please check back soon.",
      maintenanceMode: true,
    });
  } catch (error) {
    next(error);
  }
};
