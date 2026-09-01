const IMAGE_EXTENSIONS = Object.freeze({
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
});

const fs = require("fs");

function imageExtensionFor(file) {
  return IMAGE_EXTENSIONS[String(file && file.mimetype || "").toLowerCase()] || null;
}

function isAllowedImage(file) {
  return Boolean(imageExtensionFor(file));
}

function imageMimeFromSignature(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

async function hasValidStoredImageSignature(file) {
  if (!file?.path || !isAllowedImage(file)) return false;
  const handle = await fs.promises.open(file.path, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const detectedMime = imageMimeFromSignature(header.subarray(0, bytesRead));
    return detectedMime === String(file.mimetype || "").toLowerCase();
  } finally {
    await handle.close();
  }
}

module.exports = {
  IMAGE_EXTENSIONS,
  hasValidStoredImageSignature,
  imageExtensionFor,
  imageMimeFromSignature,
  isAllowedImage,
};
