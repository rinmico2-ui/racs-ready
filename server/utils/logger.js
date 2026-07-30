const { createLogger, format, transports } = require("winston");
const path = require("path");
const fs = require("fs");

// ensure logs directory exists so winston can write files
const logsDir = path.join(__dirname, "..", "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define custom log levels if desired (info, warn, error are default).
// We can also add `debug` for verbose output and `http` for request logging.
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

const level = () => {
  const env = process.env.NODE_ENV || "development";
  return env === "production" ? "info" : "debug";
};

const logFormat = format.printf(
  ({ timestamp, level, message, label, ...meta }) => {
    let msg = `${timestamp} [${label || "app"}] ${level}: ${message}`;
    const keys = Object.keys(meta);
    if (keys.length) {
      const parts = keys.map((k) => {
        const val = meta[k];
        if (typeof val === "object") return `${k}=${JSON.stringify(val)}`;
        return `${k}=${val}`;
      });
      msg += " " + parts.join(" ");
    }
    return msg;
  },
);

const logger = createLogger({
  level: level(),
  levels,
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.splat(),
    logFormat, // use readable printf output instead of JSON
  ),
  transports: [
    new transports.Console({
      format: format.combine(format.colorize(), logFormat),
    }),
    new transports.File({
      filename: path.join("logs", "error.log"),
      level: "error",
      format: logFormat,
    }),
    new transports.File({
      filename: path.join("logs", "combined.log"),
      format: logFormat,
    }),
  ],
  exitOnError: false,
});

// helper to create a child logger with a label (category/module)
logger.create = (label) => {
  return logger.child({ label });
};

module.exports = logger;
