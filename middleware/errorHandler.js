/**
 * Centralized error handler. Controllers can call next(err) or throw inside
 * an asyncHandler-wrapped function and this will turn it into a consistent
 * JSON response instead of leaking stack traces or crashing the process.
 */
function errorHandler(err, req, res, next) {
  console.error('[error]', err.message);

  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error.';

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    statusCode = 400;
    message = 'Invalid resource id.';
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = Object.values(err.errors).map((e) => e.message).join(', ');
  }

  // Mongo duplicate key
  if (err.code === 11000) {
    statusCode = 409;
    message = 'A record with that value already exists.';
  }

  res.status(statusCode).json({
    message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
}

function notFound(req, res) {
  res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
}

module.exports = { errorHandler, notFound };
