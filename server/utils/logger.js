const { createLogger, format, transports } = require("winston");
const path = require("path");
const fs = require("fs");

const logsDir = path.join(__dirname, "..", "logs");
const useFileLogs = process.env.NODE_ENV !== "production";
// Hosted production filesystems are often ephemeral. Production logs go to
// stdout for the platform log drain; local development retains files.
if (useFileLogs && !fs.existsSync(logsDir)) {
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

const configuredTransports = [
  new transports.Console({
    format: process.env.NODE_ENV === "production"
      ? format.combine(format.uncolorize(), logFormat)
      : format.combine(format.colorize(), logFormat),
  }),
];
if (useFileLogs) {
  configuredTransports.push(
    new transports.File({
      filename: path.join(logsDir, "error.log"),
      level: "error",
      format: logFormat,
    }),
    new transports.File({
      filename: path.join(logsDir, "combined.log"),
      format: logFormat,
    }),
  );
}

const logger = createLogger({
  level: level(),
  levels,
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.splat(),
    logFormat, // use readable printf output instead of JSON
  ),
  transports: configuredTransports,
  exitOnError: false,
});

// helper to create a child logger with a label (category/module)
logger.create = (label) => {
  return logger.child({ label });
};

module.exports = logger;
