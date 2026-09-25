import express from "express";
import { checkAuth, login, logout, signup, verifyEmail, updateEmail, resendOtp, deleteAccount, updateProfile, savePublicKey, getPublicKey, updatePrivacySettings, forgotPassword, resetPassword, changePassword, getPublicUserByUsername } from "../controllers/auth/auth.controller.js";
import { protectRoute } from "../middleware/auth.middleware.js";
import { createRateLimiter } from "../middleware/rateLimit.middleware.js";

const router = express.Router();

const authLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const otpLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 5, message: "Too many verification attempts, please wait before trying again" });

router.get("/public/:username", getPublicUserByUsername);
router.post("/signup", authLimiter, signup);
router.post("/login", authLimiter, login);
router.post("/logout", logout);
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/reset-password/:token", authLimiter, resetPassword);

router.post("/verify-email", otpLimiter, protectRoute, verifyEmail);
router.post("/resend-otp", otpLimiter, protectRoute, resendOtp);
router.put("/update-email", protectRoute, updateEmail); 
router.put("/update-profile", protectRoute, updateProfile);
router.put("/privacy", protectRoute, updatePrivacySettings);
router.put("/change-password", protectRoute, changePassword);
router.delete("/delete-account", protectRoute, deleteAccount);

router.put("/public-key", protectRoute, savePublicKey);
router.get("/public-key/:userId", protectRoute, getPublicKey);

router.get("/check", protectRoute, checkAuth);

export default router;
