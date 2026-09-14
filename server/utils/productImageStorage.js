const fs = require("fs");
const { v2: cloudinary } = require("cloudinary");
const {
  hasValidStoredImageSignature,
  imageMimeFromSignature,
} = require("./uploadSecurity");

function isCloudinaryConfigured() {
  return /^cloudinary:\/\/[^:]+:[^@]+@[^/\s]+/i.test(String(process.env.CLOUDINARY_URL || "").trim());
}

function cloudinaryFolder() {
  return String(process.env.CLOUDINARY_HVAC_FOLDER || "racs-ready/hvac").trim() || "racs-ready/hvac";
}

async function validateProductImage(file) {
  if (!file) throw Object.assign(new Error("Product image is required."), { status: 400 });
  if (file.buffer) {
    const detectedMime = imageMimeFromSignature(file.buffer);
    if (!detectedMime || detectedMime !== String(file.mimetype || "").toLowerCase()) {
      throw Object.assign(new Error("The uploaded product image is invalid."), { status: 400 });
    }
    return;
  }
  if (!(await hasValidStoredImageSignature(file))) {
    if (file.path) await fs.promises.unlink(file.path).catch(() => {});
    throw Object.assign(new Error("The uploaded product image is invalid."), { status: 400 });
  }
}

async function uploadProductImage(file, options = {}) {
  await validateProductImage(file);

  if (!isCloudinaryConfigured()) {
    return {
      imageUrl: `/uploads/hvac/${file.filename}`,
      imagePublicId: null,
      storage: "local",
    };
  }

  if (!file.buffer) throw new Error("Cloudinary uploads require in-memory image data.");
  const uploadOptions = {
    resource_type: "image",
    folder: cloudinaryFolder(),
    use_filename: false,
    unique_filename: !options.publicId,
    overwrite: Boolean(options.publicId),
  };
  if (options.publicId) uploadOptions.public_id = String(options.publicId);

  const result = await new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, uploaded) => {
      if (error) return reject(error);
      resolve(uploaded);
    });
    stream.end(file.buffer);
  });

  if (!result?.secure_url || !result?.public_id) {
    throw new Error("Cloudinary did not return a valid product image URL.");
  }
  return {
    imageUrl: result.secure_url,
    imagePublicId: result.public_id,
    storage: "cloudinary",
  };
}

async function deleteProductImage(imagePublicId) {
  if (!imagePublicId || !isCloudinaryConfigured()) return;
  await cloudinary.uploader.destroy(String(imagePublicId), {
    resource_type: "image",
    invalidate: true,
  });
}

module.exports = {
  deleteProductImage,
  isCloudinaryConfigured,
  uploadProductImage,
};
