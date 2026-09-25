import crypto from "crypto";
import {
  SENSITIVE_FIELDS,
  OTP_COOLDOWN_MS,
  OTP_EXPIRY_MS,
} from "../constants/auth.constants.js";

// ---------------------------------------------------------------------------
// OTP generation & comparison
// ---------------------------------------------------------------------------

/**
 * Generates a cryptographically secure 6-digit OTP string.
 *
 * Math.random() is a PRNG and MUST NOT be used for security-sensitive tokens.
 * crypto.randomInt(min, max) uses the OS CSPRNG and produces a uniformly
 * distributed integer in [min, max), so the result is always exactly 6 digits.
 *
 * @returns {string} e.g. "482917"
 */
export const generateOtp = () =>
  crypto.randomInt(100_000, 1_000_000).toString();

/**
 * Constant-time OTP comparison to prevent timing-based enumeration.
 *
 * A naive `a !== b` short-circuits on the first mismatched byte, leaking
 * partial-match information through response timing.  timingSafeEqual takes
 * the same amount of time regardless of how many characters match.
 *
 * @param {string} a - Stored OTP  (server-side)
 * @param {string} b - User-supplied OTP (client-side)
 * @returns {boolean}
 */
export const safeCompareOtp = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
};

// ---------------------------------------------------------------------------
// Cloudinary
// ---------------------------------------------------------------------------

/**
 * Extracts the full Cloudinary public ID (including any folder prefix) from a
 * secure URL.
 *
 * The naive approach of `.split("/").pop().split(".")[0]` discards the folder
 * path, so images stored under a folder (e.g. "avatars/user_abc") are never
 * actually deleted because Cloudinary requires the full "folder/name" ID.
 *
 * Regex breakdown:
 *   \/upload\/       – literal segment always present before the public ID
 *   (?:v\d+\/)?      – optional version token, e.g. "v1714000000/"
 *   (.+)             – capture group: full public ID (may contain slashes)
 *   \.[a-zA-Z0-9]+$ – file extension to strip
 *
 * @param {string} url - Full Cloudinary secure URL
 * @returns {string|null}
 */
export const extractCloudinaryPublicId = (url) => {
  try {
    const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Response sanitization
// ---------------------------------------------------------------------------

/**
 * Strips SENSITIVE_FIELDS from a Mongoose document before sending to the
 * client.  Works with both plain objects and Mongoose documents.
 *
 * Why not just `.select("-password")` everywhere?  Because verificationToken
 * is a live security credential — intercepting it lets an attacker verify an
 * account without ever receiving the email.
 *
 * @param {object} userDoc - Mongoose document or plain object
 * @returns {object} Safe plain object
 */
export const sanitizeUser = (userDoc) => {
  const plain = userDoc.toObject ? userDoc.toObject() : { ...userDoc };
  SENSITIVE_FIELDS.forEach((field) => delete plain[field]);
  return plain;
};

// ---------------------------------------------------------------------------
// OTP lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Enforces a OTP_COOLDOWN_MS gap between sends.
 *
 * Sends a 429 response and returns true when the cooldown is active, so
 * callers can do an early return:
 *   `if (isOnCooldown(user, res)) return;`
 *
 * @param {object} user - Mongoose user document (must have lastOtpSentAt)
 * @param {object} res  - Express response object
 * @returns {boolean} true = cooldown active (response already sent)
 */
export const isOnCooldown = (user, res) => {
  // null / undefined means no OTP has ever been sent → no cooldown
  if (user.lastOtpSentAt == null) return false;

  // Clamp to 0: if the server clock steps backward (NTP sync), elapsed can be
  // negative.  Without the clamp, remainingSeconds becomes a huge wrong value
  // like 90 seconds (Math.ceil((60000 - (-30000)) / 1000)).
  const elapsed = Math.max(0, Date.now() - new Date(user.lastOtpSentAt).getTime());

  if (elapsed < OTP_COOLDOWN_MS) {
    const remainingSeconds = Math.ceil((OTP_COOLDOWN_MS - elapsed) / 1_000);
    res.status(429).json({
      message: `Please wait ${remainingSeconds} seconds before requesting a new code.`,
    });
    return true;
  }

  return false;
};

/**
 * Stamps a fresh OTP and related timestamps onto a user document.
 * Does NOT call save() — the caller is responsible for persisting.
 *
 * Centralising OTP generation here ensures signup, resendOtp, and updateEmail
 * all apply identical expiry windows and never drift apart.
 *
 * @param {object} user - Mongoose user document (mutated in place)
 */
export const assignNewOtp = (user) => {
  user.verificationToken         = generateOtp();
  user.verificationTokenExpiresAt = new Date(Date.now() + OTP_EXPIRY_MS);
  user.lastOtpSentAt             = new Date();
};
