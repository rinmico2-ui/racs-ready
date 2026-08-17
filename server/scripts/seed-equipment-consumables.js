/**
 * ══════════════════════════════════════════════════════════════════════════════
 * SEED SCRIPT: Equipment & Consumables Catalog
 * ══════════════════════════════════════════════════════════════════════════════
 * Populates the Tool model with reusable equipment and consumable materials
 * that technicians actually use on the job.
 *
 * Usage:
 *   node server/scripts/seed-equipment-consumables.js
 *
 * Options:
 *   --clear    Clear existing equipment/consumables before seeding
 *   --dry-run  Print items without saving to database
 * ══════════════════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose');
const path = require('path');

// ── Load env ────────────────────────────────────────────────────────────────
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// ── Equipment (Reusable company assets) ─────────────────────────────────────
const EQUIPMENT = [
  { itemName: "Digital Multimeter", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 1200, sellingPrice: 0, minStockLevel: 3, specification: "Auto-ranging LCD", supplier: "Tool Supply PH", description: "Measures voltage, current, and resistance" },
  { itemName: "Manifold Gauge Set", category: "Equipment", type: "equipment", unit: "sets", costPrice: 1800, sellingPrice: 0, minStockLevel: 3, specification: "R410A/R22 compatible", supplier: "HVAC Parts PH", description: "For checking refrigerant pressure" },
  { itemName: "Vacuum Pump", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 4500, sellingPrice: 0, minStockLevel: 2, specification: "2-stage 3 CFM", supplier: "HVAC Parts PH", description: "Evacuates air from refrigerant lines" },
  { itemName: "Refrigerant Recovery Machine", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 12000, sellingPrice: 0, minStockLevel: 1, specification: "Portable 1/3 HP", supplier: "HVAC Parts PH", description: "Recovers refrigerant from systems" },
  { itemName: "Torque Wrench", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 1500, sellingPrice: 0, minStockLevel: 2, specification: "1/4\" & 3/8\" drive", supplier: "Tool Supply PH", description: "Precision tightening of nuts and bolts" },
  { itemName: "Tube Cutter", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 350, sellingPrice: 0, minStockLevel: 5, specification: "Mini to standard size", supplier: "Tool Supply PH", description: "Clean cuts on copper tubing" },
  { itemName: "Flaring Tool Kit", category: "Equipment", type: "equipment", unit: "sets", costPrice: 800, sellingPrice: 0, minStockLevel: 3, specification: "45° flare", supplier: "Tool Supply PH", description: "Creates flare fittings on copper pipe" },
  { itemName: "Swaging Tool Kit", category: "Equipment", type: "equipment", unit: "sets", costPrice: 900, sellingPrice: 0, minStockLevel: 3, specification: "Manual punch type", supplier: "Tool Supply PH", description: "Expands copper pipe for joint connections" },
  { itemName: "Brazing Torch Kit", category: "Equipment", type: "equipment", unit: "sets", costPrice: 1200, sellingPrice: 0, minStockLevel: 3, specification: "Oxy-acetylene or MAPP gas", supplier: "HVAC Parts PH", description: "For brazing copper joints" },
  { itemName: "Leak Detector (Electronic)", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 3500, sellingPrice: 0, minStockLevel: 2, specification: "Heated diode sensor", supplier: "HVAC Parts PH", description: "Detects refrigerant gas leaks" },
  { itemName: "Clamp Meter", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 1800, sellingPrice: 0, minStockLevel: 2, specification: "AC/DC 600A", supplier: "Tool Supply PH", description: "Measures current without disconnecting wires" },
  { itemName: "Insulation Resistance Tester", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 2500, sellingPrice: 0, minStockLevel: 1, specification: "Megger 500V/1000V", supplier: "Tool Supply PH", description: "Tests motor winding insulation" },
  { itemName: "Step Ladder 6ft", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 2500, sellingPrice: 0, minStockLevel: 2, specification: "Foldable aluminum 6ft", supplier: "Hardware Supplies PH", description: "For reaching indoor/outdoor AC units" },
  { itemName: "Extension Ladder 12ft", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 4500, sellingPrice: 0, minStockLevel: 1, specification: "Aluminum telescoping", supplier: "Hardware Supplies PH", description: "For high wall and outdoor AC access" },
  { itemName: "Pressure Washer", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 6500, sellingPrice: 0, minStockLevel: 1, specification: "Portable 1500 PSI", supplier: "Tool Supply PH", description: "High-pressure rinse for condenser coils" },
  { itemName: "Coil Cleaning Pump Sprayer", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 1200, sellingPrice: 0, minStockLevel: 2, specification: "2-gallon hand pump", supplier: "HVAC Parts PH", description: "Applies foaming cleaner on coils" },
  { itemName: "Fin Comb Set", category: "Equipment", type: "equipment", unit: "sets", costPrice: 350, sellingPrice: 0, minStockLevel: 5, specification: "Universal 8-20 fins/inch", supplier: "HVAC Parts PH", description: "Straightens damaged condenser fins" },
  { itemName: "Cordless Drill Driver", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 2800, sellingPrice: 0, minStockLevel: 2, specification: "18V with bits", supplier: "Tool Supply PH", description: "For mounting brackets and panels" },
  { itemName: "Hole Saw Set", category: "Equipment", type: "equipment", unit: "sets", costPrice: 1200, sellingPrice: 0, minStockLevel: 2, specification: "Bi-metal 16-76mm", supplier: "Tool Supply PH", description: "Cuts holes for AC piping through walls" },
  { itemName: "Spirit Level", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 350, sellingPrice: 0, minStockLevel: 5, specification: "12-inch aluminum", supplier: "Hardware Supplies PH", description: "Levels wall brackets and units" },
  { itemName: "Tape Measure 5m", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 250, sellingPrice: 0, minStockLevel: 5, specification: "Steel 5m x 19mm", supplier: "Hardware Supplies PH", description: "Measures pipe runs and clearances" },
  { itemName: "Screwdriver Set", category: "Equipment", type: "equipment", unit: "sets", costPrice: 650, sellingPrice: 0, minStockLevel: 3, specification: "Phillips/flat/specialty", supplier: "Tool Supply PH", description: "For panel and terminal screws" },
  { itemName: "Wrench Set (Metric)", category: "Equipment", type: "equipment", unit: "sets", costPrice: 1200, sellingPrice: 0, minStockLevel: 3, specification: "8-22mm combination", supplier: "Tool Supply PH", description: "Tightens flare nuts and brackets" },
  { itemName: "Pliers Set", category: "Equipment", type: "equipment", unit: "sets", costPrice: 800, sellingPrice: 0, minStockLevel: 3, specification: "Needle, lineman, slip-joint", supplier: "Tool Supply PH", description: "Grips, twists, and pulls wires" },
  { itemName: "Wire Stripper", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 250, sellingPrice: 0, minStockLevel: 5, specification: "Automatic 10-24 AWG", supplier: "Tool Supply PH", description: "Strips insulation from wires" },
  { itemName: "Work Light", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 800, sellingPrice: 0, minStockLevel: 3, specification: "LED rechargeable", supplier: "Tool Supply PH", description: "Illuminates tight or dark spaces" },
  { itemName: "Extension Cord 15m", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 650, sellingPrice: 0, minStockLevel: 3, specification: "Heavy-duty 14AWG", supplier: "Hardware Supplies PH", description: "Powers tools on site" },
  { itemName: "Tool Box (Field Kit)", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 1200, sellingPrice: 0, minStockLevel: 3, specification: "Waterproof 20-inch", supplier: "Tool Supply PH", description: "Carries hand tools and small parts" },
  { itemName: "Vacuum Hose Set", category: "Equipment", type: "equipment", unit: "sets", costPrice: 650, sellingPrice: 0, minStockLevel: 3, specification: "1/4\", 3/8\", 1/2\" hoses", supplier: "HVAC Parts PH", description: "Connects vacuum pump to manifold" },
  { itemName: "Nitrogen Regulator", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 1800, sellingPrice: 0, minStockLevel: 2, specification: "0-500 PSI", supplier: "HVAC Parts PH", description: "Regulates nitrogen for pressure testing" },
  { itemName: "Safety Harness", category: "Equipment", type: "equipment", unit: "pcs", costPrice: 1500, sellingPrice: 0, minStockLevel: 2, specification: "Full body with lanyard", supplier: "Safety Gear PH", description: "Fall protection for high installations" },
];

// ── Consumables (Used up during service) ────────────────────────────────────
const CONSUMABLES = [
  { itemName: "Foaming Cleaner", category: "Consumable", type: "consumable", unit: "bottles", costPrice: 120, sellingPrice: 0, minStockLevel: 10, specification: "1L coil foaming cleaner", supplier: "HVAC Parts PH", description: "Cleans evaporator and condenser coils" },
  { itemName: "Condenser Cleaner", category: "Consumable", type: "consumable", unit: "bottles", costPrice: 180, sellingPrice: 0, minStockLevel: 10, specification: "1L heavy-duty", supplier: "HVAC Parts PH", description: "Degreaser for outdoor condenser coils" },
  { itemName: "Fin Cleaner Spray", category: "Consumable", type: "consumable", unit: "cans", costPrice: 150, sellingPrice: 0, minStockLevel: 10, specification: "500ml foaming spray", supplier: "HVAC Parts PH", description: "Foaming cleaner for tight fin packs" },
  { itemName: "Nylon Brush", category: "Consumable", type: "consumable", unit: "pcs", costPrice: 45, sellingPrice: 0, minStockLevel: 20, specification: "Soft bristle cleaning brush", supplier: "HVAC Parts PH", description: "For scrubbing coils and fan blades" },
  { itemName: "Pipe Insulation (Armaflex)", category: "Consumable", type: "consumable", unit: "meters", costPrice: 80, sellingPrice: 0, minStockLevel: 30, specification: "3/8\" ID x 9mm", supplier: "Hardware Supplies PH", description: "Insulates refrigerant suction lines" },
  { itemName: "PVC Electrical Tape", category: "Consumable", type: "consumable", unit: "rolls", costPrice: 25, sellingPrice: 0, minStockLevel: 30, specification: "18mm x 20m black", supplier: "Electronics Parts PH", description: "Insulates wire splices" },
  { itemName: "Cable Ties", category: "Consumable", type: "consumable", unit: "packs", costPrice: 60, sellingPrice: 0, minStockLevel: 20, specification: "100pcs 8-inch", supplier: "Electronics Parts PH", description: "Secures wires and hoses" },
  { itemName: "Silicone Sealant", category: "Consumable", type: "consumable", unit: "tubes", costPrice: 120, sellingPrice: 0, minStockLevel: 15, specification: "Clear 300ml", supplier: "Hardware Supplies PH", description: "Seals gaps and penetrations" },
  { itemName: "Teflon Tape", category: "Consumable", type: "consumable", unit: "rolls", costPrice: 25, sellingPrice: 0, minStockLevel: 30, specification: "12mm x 10m", supplier: "Hardware Supplies PH", description: "Seals threaded pipe joints" },
  { itemName: "Solder Wire", category: "Consumable", type: "consumable", unit: "rolls", costPrice: 150, sellingPrice: 0, minStockLevel: 10, specification: "60/40 0.8mm 250g", supplier: "Electronics Parts PH", description: "For electrical and copper brazing work" },
  { itemName: "Flux Paste", category: "Consumable", type: "consumable", unit: "bottles", costPrice: 90, sellingPrice: 0, minStockLevel: 10, specification: "Rosin 100g", supplier: "Electronics Parts PH", description: "Cleans and wets metal for soldering" },
  { itemName: "Brazing Rod", category: "Consumable", type: "consumable", unit: "pcs", costPrice: 80, sellingPrice: 0, minStockLevel: 20, specification: "5% silver 2.0mm", supplier: "HVAC Parts PH", description: "Joins copper refrigerant lines" },
  { itemName: "Vacuum Pump Oil", category: "Consumable", type: "consumable", unit: "bottles", costPrice: 250, sellingPrice: 0, minStockLevel: 5, specification: "1 liter", supplier: "HVAC Parts PH", description: "Lubricates and seals vacuum pump" },
  { itemName: "Refrigerant Gas R410A", category: "Consumable", type: "consumable", unit: "bottles", costPrice: 650, sellingPrice: 1200, minStockLevel: 3, specification: "1kg can", supplier: "HVAC Parts PH", description: "For topping up split-type AC systems" },
  { itemName: "Leak Detection Dye", category: "Consumable", type: "consumable", unit: "bottles", costPrice: 350, sellingPrice: 0, minStockLevel: 5, specification: "UV fluorescent 30ml", supplier: "HVAC Parts PH", description: "Finds refrigerant leaks" },
  { itemName: "Shop Rags", category: "Consumable", type: "consumable", unit: "packs", costPrice: 120, sellingPrice: 0, minStockLevel: 10, specification: "1kg pack", supplier: "Hardware Supplies PH", description: "For cleaning and wiping" },
  { itemName: "Dust Masks", category: "Consumable", type: "consumable", unit: "boxes", costPrice: 150, sellingPrice: 0, minStockLevel: 10, specification: "50pcs N95", supplier: "Safety Gear PH", description: "Protects technician during coil cleaning" },
  { itemName: "Disposable Gloves", category: "Consumable", type: "consumable", unit: "boxes", costPrice: 120, sellingPrice: 0, minStockLevel: 10, specification: "100pcs nitrile", supplier: "Safety Gear PH", description: "Hand protection during service" },
  { itemName: "Cable Marker", category: "Consumable", type: "consumable", unit: "packs", costPrice: 80, sellingPrice: 0, minStockLevel: 10, specification: "Assorted colors 100pcs", supplier: "Electronics Parts PH", description: "Labels wires after repair" },
];

const ALL_ITEMS = [...EQUIPMENT, ...CONSUMABLES];

// ── Main Script ─────────────────────────────────────────────────────────────
async function seed() {
  const args = process.argv.slice(2);
  const clearAll = args.includes('--clear');
  const dryRun = args.includes('--dry-run');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  EQUIPMENT & CONSUMABLES SEED SCRIPT');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Items to seed: ${ALL_ITEMS.length}`);
  console.log(`  Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will write to DB)'}`);
  if (clearAll) console.log('  ⚠️  Will CLEAR existing equipment/consumables first');
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (dryRun) {
    const byType = {};
    ALL_ITEMS.forEach(p => {
      if (!byType[p.type]) byType[p.type] = [];
      byType[p.type].push(p);
    });

    Object.keys(byType).sort().forEach(type => {
      console.log(`\n📂 ${type.toUpperCase()} (${byType[type].length})`);
      console.log('─'.repeat(60));
      byType[type].forEach(p => {
        console.log(`  ${p.itemName}`);
        console.log(`    Category: ${p.category}`);
        console.log(`    Unit: ${p.unit}`);
        console.log(`    Min Stock: ${p.minStockLevel}`);
        console.log(`    Supplier: ${p.supplier || 'N/A'}`);
        if (p.description) console.log(`    ${p.description}`);
      });
    });

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`  Total: ${ALL_ITEMS.length} items`);
    console.log('═══════════════════════════════════════════════════════════════');
    return;
  }

  // Connect to MongoDB
  try {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/racs';
    console.log(`Connecting to MongoDB...`);
    await mongoose.connect(mongoUri);
    console.log('✓ Connected to MongoDB\n');
  } catch (err) {
    console.error('✗ Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }

  const Tool = require('../models/Tool');

  // Clear existing if requested (only equipment/consumables)
  if (clearAll) {
    const result = await Tool.deleteMany({ type: { $in: ['equipment', 'consumable', 'tool'] } });
    console.log(`✓ Cleared ${result.deletedCount} existing equipment/consumables\n`);
  }

  // Insert items
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const item of ALL_ITEMS) {
    try {
      const existing = await Tool.findOne({ itemName: item.itemName });
      if (existing) {
        console.log(`  ⏭️  SKIP: ${item.itemName} (already exists)`);
        skipped++;
        continue;
      }

      const sellingPrice = (item.sellingPrice && item.sellingPrice > 0)
        ? item.sellingPrice
        : Math.max(1, Math.round(item.costPrice * 1.35));
      const tool = new Tool({
        itemName: item.itemName,
        category: item.category,
        type: item.type,
        unit: item.unit,
        quantity: Math.max(3, item.minStockLevel * 3),
        minStockLevel: item.minStockLevel,
        costPrice: item.costPrice,
        sellingPrice,
        specification: item.specification,
        description: item.description,
        supplier: item.supplier,
        isStockItem: true,
        active: true,
      });

      await tool.save();
      console.log(`  ✓ Created: ${item.itemName} (${item.type}, qty ${tool.quantity})`);
      created++;
    } catch (err) {
      console.error(`  ✗ Error: ${item.itemName} — ${err.message}`);
      errors++;
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log(`  SEED COMPLETE`);
  console.log(`  ✓ Created: ${created}`);
  console.log(`  ⏭️  Skipped: ${skipped}`);
  if (errors > 0) console.log(`  ✗ Errors: ${errors}`);
  console.log('═══════════════════════════════════════════════════════════════');

  await mongoose.disconnect();
  console.log('\nDone.');
}

seed().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
