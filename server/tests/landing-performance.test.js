"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ejs = require("ejs");

const viewsDirectory = path.join(__dirname, "..", "views");
const optimizedImageDirectory = path.join(
  __dirname,
  "..",
  "public",
  "images",
  "technicianWork",
  "optimized",
);

function publicPageData() {
  return {
    title: "CALIDRO RACS",
    user: null,
    companyName: "CALIDRO RACS",
    companyTagline: "Service",
    companyPhone: "123",
    companyEmail: "service@example.com",
    companyAddress: "Nueva Ecija",
    publicStats: {
      servicesCompleted: 1,
      satisfactionPercentage: 100,
      activeTechnicians: 2,
      yearsExperience: 3,
      averageRating: 5,
      ratingCount: 1,
    },
    displayRating: 5,
    displayCount: 1,
    businessHours: { summary: "Mon-Sat" },
    companyLocation: { lat: 15.5, lng: 121 },
    lightweightPublicPage: true,
  };
}

test("landing page uses bounded responsive technician images", () => {
  const expectedImages = [
    "tech1-640.jpg",
    "tech1-1280.jpg",
    "tech2-640.jpg",
    "tech2-1280.jpg",
    "tech3-640.jpg",
    "tech3-1280.jpg",
  ];

  for (const imageName of expectedImages) {
    const stats = fs.statSync(path.join(optimizedImageDirectory, imageName));
    assert.ok(stats.size < 250 * 1024, `${imageName} must stay below 250 KB`);
  }
});

test("lightweight landing layout omits unrelated global libraries", async () => {
  const data = publicPageData();
  const body = await ejs.renderFile(
    path.join(viewsDirectory, "pages", "landing.ejs"),
    data,
  );
  const html = await ejs.renderFile(
    path.join(viewsDirectory, "layouts", "main.ejs"),
    { ...data, body },
  );

  assert.match(html, /optimized\/tech1-640\.jpg/);
  for (const unrelatedAsset of [
    "leaflet.js",
    "aos.js",
    "gsap.min.js",
    "register.js",
    "sweetalert2.min.css",
    "booking-policy",
  ]) {
    assert.doesNotMatch(html, new RegExp(unrelatedAsset.replace(".", "\\.")));
  }
});
