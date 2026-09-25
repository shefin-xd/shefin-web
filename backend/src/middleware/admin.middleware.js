const ADMIN_EMAIL_ENV_KEYS = [
  "ADMIN_EMAILS",
  "ADMIN_EMAIL",
  "ADMIN_USERS",
  "ADMIN_USER",
  "ADMINS",
  "ADMIN",
  "VITE_ADMIN_EMAILS",
];

export const configuredAdminEmails = () => {
  const raw = ADMIN_EMAIL_ENV_KEYS.map((key) => process.env[key] || "").join(",");
  return new Set(
    raw
      .split(/[;,\s]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
};

export const isConfiguredAdmin = (user) => {
  if (!user) return false;
  const email = user.email?.trim().toLowerCase();
  return !!user.isAdmin || (!!email && configuredAdminEmails().has(email));
};

export const requireAdmin = (req, res, next) => {
  if (!isConfiguredAdmin(req.user)) {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};
