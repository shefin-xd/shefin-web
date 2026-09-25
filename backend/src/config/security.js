export const getAllowedOrigins = () => (process.env.CLIENT_URL || "http://localhost:5173,https://chat.shefin.dev")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const isLocalDevelopmentOrigin = (origin) => {
  try {
    const { hostname, protocol } = new URL(origin);
    return ["http:", "https:"].includes(protocol) && ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
};

export const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (getAllowedOrigins().includes(origin) || isLocalDevelopmentOrigin(origin)) {
      return callback(null, true);
    }

    const error = new Error("Not allowed by CORS");
    error.statusCode = 403;
    callback(error);
  },
  credentials: true,
};

export const applySecurityHeaders = (req, res, next) => {
  // Lightweight production security headers without adding another runtime
  // dependency. Keep CSP report-only in development-friendly shape because the
  // chat UI legitimately needs data/blob media previews and websocket traffic.
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(self), geolocation=()");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
};