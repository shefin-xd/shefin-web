// ---------------------------------------------------------------------------
// Validation patterns
// ---------------------------------------------------------------------------

/**
 * Allows Unicode letters with single spaces between words only.
 * Rejects leading/trailing spaces and consecutive spaces.
 */
export const NAME_REGEX = /^[\p{L}]+(?: [\p{L}]+)*$/u;

/**
 * Lightweight structural email check (local@domain.tld).
 * Definitive validity is confirmed when the OTP actually reaches the inbox.
 */
export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Field constraints
// ---------------------------------------------------------------------------

export const MIN_NAME_LENGTH     = 2;
export const MAX_NAME_LENGTH     = 50;
export const MIN_PASSWORD_LENGTH = 6;
export const RESET_PASSWORD_TOKEN_BYTES = 32;
export const RESET_PASSWORD_EXPIRY_MS = 15 * 60 * 1_000; // 15 minutes

// ---------------------------------------------------------------------------
// OTP timing
// ---------------------------------------------------------------------------

/** Minimum gap between OTP sends — prevents email flooding. */
export const OTP_COOLDOWN_MS = 60 * 1_000;       // 60 seconds

/** Window within which a received OTP remains valid. */
export const OTP_EXPIRY_MS   = 10 * 60 * 1_000;  // 10 minutes

// ---------------------------------------------------------------------------
// Bcrypt
// ---------------------------------------------------------------------------

/** Cost factor. Each increment roughly doubles hashing time. */
export const BCRYPT_SALT_ROUNDS = 10;

// ---------------------------------------------------------------------------
// Response sanitization
// ---------------------------------------------------------------------------

/**
 * Fields that must never appear in any API response.
 *
 * - password              : obvious
 * - verificationToken     : live security credential; possession alone lets an
 *                           attacker verify an account without receiving the email
 * - verificationTokenExpiresAt : leaks token lifetime, no client need for it
 *
 * NOTE: lastOtpSentAt is NOT listed here — unverified clients need it to
 * render the resend countdown timer.  It is cleared server-side on
 * verification, so it never appears for verified users.
 */
export const SENSITIVE_FIELDS = [
  "password",
  "verificationToken",
  "verificationTokenExpiresAt",
  "resetPasswordToken",
  "resetPasswordExpiresAt",
];
