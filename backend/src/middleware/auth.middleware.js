import jwt from "jsonwebtoken";
import User from "../models/user.model.js";

/**
 * Guards routes that require an authenticated session.
 *
 * Security decisions:
 *
 * 1. JWT verification is isolated in its own try/catch so a malformed or
 *    expired token returns a specific 401 rather than falling through to the
 *    generic 500 handler.
 *
 * 2. `.select()` excludes the password hash AND the live OTP token/expiry.
 *    verificationToken is a security credential — if it were accessible on
 *    req.user, any controller that accidentally logged or serialised req.user
 *    would expose it.  Stripping it at the DB layer is the safest approach.
 *
 * 3. lastOtpSentAt IS kept on req.user because controllers that handle OTP
 *    resend do their own fresh DB fetch (where they need all OTP fields anyway),
 *    so leaving it here adds no risk and simplifies the middleware.
 */
export const protectRoute = async (req, res, next) => {
  try {
    const token = req.cookies.jwt;

    if (!token) {
      return res.status(401).json({ message: "Unauthorized - No Token Provided" });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      // Covers both TokenExpiredError and JsonWebTokenError
      return res.status(401).json({ message: "Unauthorized - Invalid or Expired Token" });
    }

    const user = await User.findById(decoded.userId).select(
      "-password -verificationToken -verificationTokenExpiresAt"
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.isSuspended) {
      return res.status(403).json({ message: "This account has been suspended. Contact support for help." });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error("Error in protectRoute middleware:", error.message);
    res.status(500).json({ message: "Internal server error" });
  }
};
