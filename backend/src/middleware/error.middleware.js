import crypto from "crypto";

export const attachRequestContext = (req, res, next) => {
  const requestId = req.headers["x-request-id"] || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
};

const getStatusCode = (error) => {
  if (error.statusCode) return error.statusCode;
  if (error.status) return error.status;
  if (error.name === "ValidationError") return 400;
  if (error.name === "CastError") return 400;
  if (error.type === "entity.too.large") return 413;
  if (error instanceof SyntaxError && "body" in error) return 400;
  return 500;
};

const getClientMessage = (error, statusCode) => {
  if (statusCode >= 500) return "Internal server error";
  if (error.name === "CastError") return "Invalid resource id";
  if (error.type === "entity.too.large") return "Request payload is too large";
  if (error instanceof SyntaxError && "body" in error) return "Malformed JSON request body";
  return error.message || "Request failed";
};

export const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
    requestId: req.requestId,
  });
};

export const errorHandler = (error, req, res, next) => {
  if (res.headersSent) return next(error);

  const statusCode = getStatusCode(error);
  const payload = {
    success: false,
    message: getClientMessage(error, statusCode),
    requestId: req.requestId,
  };

  if (process.env.NODE_ENV !== "production") {
    payload.stack = error.stack;
  }

  console.error(`[${req.requestId || "no-request-id"}] ${req.method} ${req.originalUrl}:`, error);
  res.status(statusCode).json(payload);
};
