import express from "express";
import { deleteUserByAdmin, exportUserDataByAdmin, getAdminDashboard, sendAnnouncementByAdmin, updateMaintenance, updateUserByAdmin } from "../controllers/admin/admin.controller.js";
import { protectRoute } from "../middleware/auth.middleware.js";
import { requireAdmin } from "../middleware/admin.middleware.js";

const router = express.Router();

router.use(protectRoute, requireAdmin);
router.get("/dashboard", getAdminDashboard);
router.patch("/maintenance", updateMaintenance);
router.post("/announcements", sendAnnouncementByAdmin);
router.get("/users/:userId/export", exportUserDataByAdmin);
router.patch("/users/:userId", updateUserByAdmin);
router.delete("/users/:userId", deleteUserByAdmin);

export default router;
