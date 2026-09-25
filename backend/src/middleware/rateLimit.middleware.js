const buckets = new Map();

const getClientKey = (req) => req.user?._id?.toString() || req.ip;
const getRouteKey = (req) => `${req.baseUrl || ""}${req.route?.path || req.path}`;

export const createRateLimiter = ({ windowMs = 60_000, max = 60, message = "Too many requests, please try again later" } = {}) => {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${getClientKey(req)}:${req.method}:${getRouteKey(req)}`;
    const current = buckets.get(key);

    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      res.setHeader("RateLimit-Limit", max);
      res.setHeader("RateLimit-Remaining", max - 1);
      return next();
    }

    current.count += 1;
    const remaining = Math.max(max - current.count, 0);
    res.setHeader("RateLimit-Limit", max);
    res.setHeader("RateLimit-Remaining", remaining);
    res.setHeader("RateLimit-Reset", Math.ceil(current.resetAt / 1000));

    if (current.count > max) {
      return res.status(429).json({
        success: false,
        message,
        retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000),
        requestId: req.requestId,
      });
    }

    next();
  };
};

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, 60_000);

cleanupTimer.unref?.();
