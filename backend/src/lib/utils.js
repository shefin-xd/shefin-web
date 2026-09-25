import jwt from "jsonwebtoken";

export const generateToken = (userId, res) => {
  const token = jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: "7d",
  });

  const cookieDomain = process.env.COOKIE_DOMAIN?.trim();

  res.cookie("jwt", token, {
    maxAge: 7 * 24 * 60 * 60 * 1000, // MS
    httpOnly: true, // prevent XSS attacks cross-site scripting attacks
    // auth.shefin.dev, chat.shefin.dev, and api.shefin.dev are same-site, so
    // Lax preserves the CSRF protection of a first-party session while also
    // allowing normal top-level navigation back into an application.
    sameSite: "lax",
    secure: process.env.NODE_ENV !== "development",
    // Leave this unset unless every subdomain is trusted. The browser sends
    // the API cookie to api.shefin.dev, where all product APIs are centralized.
    ...(cookieDomain ? { domain: cookieDomain } : {}),
  });

  return token;
};
