/**
 * ─────────────────────────────────────────────────────────────────────────────
 * seedInventory.js   — Seed the Inventory collection with Split-Type Aircons
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   node server/scripts/seedInventory.js              # full seed
 *   node server/scripts/seedInventory.js --dry-run    # preview only, no DB write
 *   node server/scripts/seedInventory.js --force      # drop existing inventory first
 *
 * All 7 model lines × 5 HP variants = 35 products.
 * Prices with 0 are marked as "coming_soon".
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const mongoose = require("mongoose");
const path = require("path");

// ─── Models ─────────────────────────────────────────────────────────────────
const Inventory = require(path.resolve(__dirname, "../models/Inventory"));
const Brand = require(path.resolve(__dirname, "../models/Brand"));
const Category = require(path.resolve(__dirname, "../models/Category"));

// ─── CLI flags ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");

// ─── BTU Mapping (per HP) ───────────────────────────────────────────────────
const BTU_MAP = {
  "1.0": 9000,
  "1.5": 12000,
  "2.0": 18000,
  "2.5": 24000,
  "3.0": 30000,
};

// ─── Product Catalog Definition ─────────────────────────────────────────────
// Each entry: { modelLine, brandName, inverter, features, warranty, refrigerant, variants }
// variants: { capacity: sellingPrice } — 0 means price TBA / coming_soon

const AIRCON_CATALOG = [
  {
    modelLine: "AUX QCDI Inverter",
    brandName: "AUX",
    inverter: true,
    refrigerant: "R32",
    warranty: "5 Years Compressor, 1 Year Parts",
    features: [
      "Full DC Inverter",
      "Self-Clean Function",
      "Turbo Cooling",
      "Sleep Mode",
      "Auto Restart",
      "WiFi Ready",
    ],
    variants: {
      "1.0": 0,
      "1.5": 25500,
      "2.0": 0,
      "2.5": 37500,
      "3.0": 45500,
    },
  },
  {
    modelLine: "Condura Prima",
    brandName: "Condura",
    inverter: false,
    refrigerant: "R32",
    warranty: "3 Years Compressor, 1 Year Parts",
    features: [
      "Anti-Bacterial Filter",
      "Auto Swing",
      "Sleep Mode",
      "Timer Function",
      "Self-Diagnosis",
    ],
    variants: {
      "1.0": 0,
      "1.5": 25500,
      "2.0": 0,
      "2.5": 37500,
      "3.0": 45500,
    },
  },
  {
    modelLine: "Carrier Nexus Inverter",
    brandName: "Carrier",
    inverter: true,
    refrigerant: "R32",
    warranty: "10 Years Compressor, 2 Years Parts",
    features: [
      "Energy Star Certified",
      "Smart Cool Technology",
      "4-Way Airflow",
      "Nano Filtration",
      "Silent Operation",
      "WiFi Control",
    ],
    variants: {
      "1.0": 0,
      "1.5": 25500,
      "2.0": 0,
      "2.5": 37500,
      "3.0": 45500,
    },
  },
  {
    modelLine: "Carrier Aura Inverter",
    brandName: "Carrier",
    inverter: true,
    refrigerant: "R32",
    warranty: "10 Years Compressor, 2 Years Parts",
    features: [
      "Full DC Inverter",
      "PM 2.5 Filter",
      "Smart Diagnosis",
      "Cold Catalyst Filter",
      "Follow Me Function",
      "Auto Clean",
    ],
    variants: {
      "1.0": 0,
      "1.5": 25500,
      "2.0": 0,
      "2.5": 37500,
      "3.0": 45500,
    },
  },
  {
    modelLine: "Carrier XPOWERGOLD3 Inverter",
    brandName: "Carrier",
    inverter: true,
    refrigerant: "R32",
    warranty: "10 Years Compressor, 2 Years Parts",
    features: [
      "Gold Fin Condenser",
      "Triple Inverter Compressor",
      "Real-Time Energy Monitor",
      "I-Feel Sensor Remote",
      "6-Step Filtration",
      "Voice Control Ready",
    ],
    variants: {
      "1.0": 0,
      "1.5": 25500,
      "2.0": 0,
      "2.5": 37500,
      "3.0": 45500,
    },
  },
  {
    modelLine: "TCL MEI Full DC",
    brandName: "TCL",
    inverter: true,
    refrigerant: "R32",
    warranty: "5 Years Compressor, 1 Year Parts",
    features: [
      "Full DC Inverter",
      "Titan Gold Evaporator",
      "Gentle Cool Mode",
      "Eco Mode",
      "Anti-Corrosion Coating",
      "Smart Connectivity",
    ],
    variants: {
      "1.0": 0,
      "1.5": 25500,
      "2.0": 0,
      "2.5": 37500,
      "3.0": 45500,
    },
  },
  {
    modelLine: "Midea CLEST",
    brandName: "Midea",
    inverter: false,
    refrigerant: "R32",
    warranty: "5 Years Compressor, 1 Year Parts",
    features: [
      "iECO Mode",
      "Comfort Sleep Curve",
      "Cold Catalyst Filtration",
      "Follow Me Function",
      "Quick Cool & Heat",
      "Anti-Mildew",
    ],
    variants: {
      "1.0": 0,
      "1.5": 25500,
      "2.0": 0,
      "2.5": 37500,
      "3.0": 45500,
    },
  },
];

// ─── Seed Logic ─────────────────────────────────────────────────────────────

async function seed() {
  const dbUri =
    process.env.MONGO_URI ||
    process.env.MONGODB_URI ||
    "mongodb://127.0.0.1:27017/racs";

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  RACS Inventory Seeder — Split-Type Aircon Catalog");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Mode     : ${DRY_RUN ? "DRY RUN (no DB writes)" : "LIVE"}`);
  console.log(`  Force    : ${FORCE ? "YES (will clear existing)" : "NO"}`);
  console.log(`  Database : ${dbUri.replace(/\/\/.*@/, "//***@")}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  if (DRY_RUN) {
    console.log("🔍 DRY RUN — previewing products to be created:\n");
    let count = 0;
    for (const model of AIRCON_CATALOG) {
      for (const [cap, price] of Object.entries(model.variants)) {
        count++;
        const status = price > 0 ? "out_of_stock" : "coming_soon";
        console.log(
          `  ${String(count).padStart(2, " ")}. ${model.modelLine} ${cap} HP` +
            `  — ₱${price.toLocaleString().padStart(7, " ")}` +
            `  [${status}]` +
            `  (${model.brandName})`
        );
      }
    }
    console.log(`\n✅ Total: ${count} products would be created.`);
    process.exit(0);
  }

  // Connect to MongoDB
  await mongoose.connect(dbUri);
  console.log("✅ Connected to MongoDB\n");

  try {
    // ── Step 1: Ensure brands exist ──────────────────────────────────────
    const brandNames = [...new Set(AIRCON_CATALOG.map((m) => m.brandName))];
    const brandMap = {};

    for (const name of brandNames) {
      let brand = await Brand.findOne({ name });
      if (!brand) {
        brand = await Brand.create({ name });
        console.log(`  🏷️  Created brand: ${name}`);
      } else {
        console.log(`  🏷️  Brand exists:  ${name}`);
      }
      brandMap[name] = brand._id;
    }

    // ── Step 2: Ensure category exists ───────────────────────────────────
    const CATEGORY_NAME = "Split Type Aircon";
    let category = await Category.findOne({ name: CATEGORY_NAME });
    if (!category) {
      category = await Category.create({
        name: CATEGORY_NAME,
        description: "Wall-mounted split-type air conditioning units",
      });
      console.log(`  📂 Created category: ${CATEGORY_NAME}`);
    } else {
      console.log(`  📂 Category exists:  ${CATEGORY_NAME}`);
    }

    // ── Step 3: Clear existing aircon inventory if --force ────────────────
    if (FORCE) {
      const deleted = await Inventory.deleteMany({ category: category._id });
      console.log(
        `\n  🗑️  Cleared ${deleted.deletedCount} existing aircon entries`
      );
    }

    // ── Step 4: Create inventory items ───────────────────────────────────
    console.log("\n  📦 Creating inventory items...\n");
    let created = 0;
    let skipped = 0;

    for (const model of AIRCON_CATALOG) {
      for (const [cap, price] of Object.entries(model.variants)) {
        // Check for existing item (avoid duplicates)
        const existing = await Inventory.findOne({
          brand: brandMap[model.brandName],
          modelLine: model.modelLine,
          capacity: cap,
        });

        if (existing) {
          skipped++;
          console.log(
            `     ⏭️  SKIP  ${model.modelLine} ${cap} HP (already exists)`
          );
          continue;
        }

        const status = price > 0 ? "out_of_stock" : "coming_soon";
        const btu = BTU_MAP[cap] || 0;

        const item = new Inventory({
          modelLine: model.modelLine,
          brand: brandMap[model.brandName],
          category: category._id,
          type: "split",
          capacity: cap,
          capacityUnit: "HP",
          btu,
          inverter: model.inverter,
          sellingPrice: price,
          costPrice: Math.round(price * 0.7), // estimated 30% margin
          quantity: 0,
          minStockLevel: 3,
          status,
          rating: 0,
          ratingCount: 0,
          description: `${model.modelLine} ${cap} HP Split Type Air Conditioner. ${model.inverter ? "Inverter technology for energy-efficient cooling." : "Reliable and affordable cooling solution."} ${btu.toLocaleString()} BTU capacity.`,
          features: model.features,
          warranty: model.warranty,
          imageUrl: "/images/products/default.png",
          specifications: {
            refrigerantType: model.refrigerant,
            energyRating: model.inverter ? "Inverter Class" : "Standard",
            voltage: "220-240V / 60Hz",
          },
          salesChannel: "both",
          active: true,
          isStockItem: true,
          unit: "unit",
        });

        await item.save();
        created++;

        const priceStr =
          price > 0 ? `₱${price.toLocaleString()}` : "Price TBA";
        console.log(
          `     ✅ ${String(created).padStart(2, " ")}. ${model.modelLine} ${cap} HP` +
            `  — ${priceStr.padStart(9, " ")}` +
            `  [${status}]` +
            `  SKU: ${item.sku}`
        );
      }
    }

    // ── Summary ──────────────────────────────────────────────────────────
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`  ✅ Created : ${created} products`);
    console.log(`  ⏭️  Skipped : ${skipped} (already existed)`);
    console.log(`  📊 Total   : ${created + skipped} processed`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  } catch (err) {
    console.error("\n❌ Seed failed:", err.message);
    console.error(err.stack);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("🔌 Disconnected from MongoDB");
  }
}

seed();
