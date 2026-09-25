import express from "express";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import cors from "cors";
import path from "path";
import cron from "node-cron";

import { connectDB } from "./lib/db.js";
import { deleteUnverifiedAccounts } from "./lib/cleanup.js";

import authRoutes from "./routes/auth/auth.route.js";
import messageRoutes from "./routes/chat-app/message.route.js";
import adminRoutes from "./routes/admin/admin.route.js";
import { app, clearStalePresence, server } from "./lib/socket.js";
import { corsOptions, applySecurityHeaders } from "./config/security.js";
import { attachRequestContext, errorHandler, notFoundHandler } from "./middleware/error.middleware.js";
import { maintenanceGate } from "./middleware/maintenance.middleware.js";

dotenv.config();

const PORT = process.env.PORT || 5001;
const __dirname = path.resolve();

app.disable("x-powered-by");
app.use(attachRequestContext);
app.use(applySecurityHeaders);
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "5mb", strict: true }));
app.use(cookieParser());
app.use(cors(corsOptions));
app.use((req, res, next) => {
  // Disable intermediary/proxy caching for API responses that may contain
  // profile, message, or admin data. Static assets keep their normal caching.
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    requestId: req.requestId,
  });
});

app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/messages", maintenanceGate, messageRoutes);
app.use("/api", notFoundHandler);

app.use(notFoundHandler);
app.use(errorHandler);

const startServer = async () => {
  await connectDB();

  await clearStalePresence();

  // Run an initial cleanup pass and then repeat it twice per day.
  deleteUnverifiedAccounts();
  cron.schedule("0 */12 * * *", deleteUnverifiedAccounts);

  server.listen(PORT, () => {
    console.log(`server is running on PORT:${PORT}`);
  });
};

startServer().catch((error) => {
  console.error("Failed to start server:", error.message);
  process.exit(1);
});
