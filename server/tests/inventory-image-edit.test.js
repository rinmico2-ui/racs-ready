const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");

const serverRoot = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(serverRoot, relativePath), "utf8");

test("inventory edit submits the original image and supports explicit removal", async () => {
  const page = read("views/pages/admin/Inventory/InventoryList.ejs");
  const html = await ejs.renderFile(
    path.join(serverRoot, "views/pages/admin/Inventory/InventoryList.ejs"),
    { inventoryApiBase: "/api/admin/hvac" },
  );

  assert.match(page, /formData\.append\('image', selectedImageFile, selectedImageFile\.name\)/);
  assert.match(page, /removeImageRequested[\s\S]*?data\.imageUrl = '\/images\/products\/default\.png'/);
  assert.match(page, /variantRow\.dataset\.variantId/);
  assert.doesNotMatch(page, /uploadedImageData|dataURLtoBlob/);

  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});

test("HVAC API persists image edits and cleans replaced storage", () => {
  const api = read("routes/hvacApi.js");
  const storage = read("utils/productImageStorage.js");

  assert.match(api, /router\.patch\("\/hvac\/:id", productImageUpload/);
  assert.match(api, /previousImageUrl = product\.imageUrl/);
  assert.match(api, /deleteProductImage\(previousImagePublicId, previousImageUrl\)/);
  assert.match(api, /status,[\s\S]*?warranty,[\s\S]*?description/);
  assert.match(storage, /async function deleteProductImage\(imagePublicId, imageUrl = ""\)/);
  assert.match(storage, /\^\\\/uploads\\\/hvac\\\//);
});
