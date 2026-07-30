/*
 * Seed CoreService and RepairService collections with richer demo data.
 * Usage: NODE_ENV=development node server/scripts/seedCoreServices.js
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const CoreService = require('../models/CoreService');
const RepairService = require('../models/RepairService');
const dns = require('dns');

// Set DNS servers to match main server
dns.setServers(['8.8.8.8', '8.8.4.4']);
dotenv.config();
const MONGODB_URI = process.env.MONGODB_URI ||  'mongodb://localhost:27017/racs_db';

const coreDefaults = [
  {
    name: 'Aircon Installation',
    slug: 'aircon-installation',
    category: 'service',
    description: 'Full air conditioning installation (indoor + outdoor). Includes mounting, piping, vacuuming and system test. Supports all aircon types.',
    features: ['Site survey', 'Mounting & securing', 'Refrigerant piping', 'Electrical hookup', 'System commissioning'],
    includedItems: ['Mounting brackets', 'Basic wiring', 'System vacuum & leak-check'],
    exclusions: ['High-rise rigging', 'Additional piping > 5m'],
    images: ['/images/servicesbg/tech.avif'],
    // Professional aircon types with HP pricing
    isAirconService: true,
    defaultAirconType: 'split',
    brands: ["Carrier","Daikin","LG","Samsung","Panasonic","Condura","Kolin","TCL","Midea","Fujidenzo","Gree","Sharp"],
    applianceTypes: [
      { type: 'split', name: 'Split Type' },
      { type: 'window', name: 'Window Type' },
      { type: 'cassette', name: 'Cassette' },
      { type: 'floor_standing', name: 'Floor Standing' }
    ],
    airconTypes: [
      {
        type: 'split',
        name: 'Split Type',
        description: 'Wall-mounted split type aircon',
        hpPricing: [
          { hp: 0.5, price: 2500, durationMinutes: 120, description: '0.5 HP - Small room/office' },
          { hp: 0.75, price: 3000, durationMinutes: 150, description: '0.75 HP - Medium room' },
          { hp: 1.0, price: 3500, durationMinutes: 180, description: '1.0 HP - Large room' },
          { hp: 1.5, price: 4500, durationMinutes: 210, description: '1.5 HP - Extra large room' },
          { hp: 2.0, price: 5500, durationMinutes: 240, description: '2.0 HP - Small commercial space' },
          { hp: 2.5, price: 6500, durationMinutes: 270, description: '2.5 HP - Medium commercial space' },
          { hp: 3.0, price: 7500, durationMinutes: 300, description: '3.0 HP - Large commercial space' }
        ],
        supportedHpRange: { min: 0.5, max: 3.0 }
      },
      {
        type: 'window',
        name: 'Window Type',
        description: 'Window-mounted aircon unit',
        hpPricing: [
          { hp: 0.5, price: 2000, durationMinutes: 90, description: '0.5 HP - Small window unit' },
          { hp: 0.75, price: 2500, durationMinutes: 120, description: '0.75 HP - Medium window unit' },
          { hp: 1.0, price: 3000, durationMinutes: 150, description: '1.0 HP - Standard window unit' },
          { hp: 1.5, price: 4000, durationMinutes: 180, description: '1.5 HP - Large window unit' },
          { hp: 2.0, price: 5000, durationMinutes: 210, description: '2.0 HP - Extra large window unit' }
        ],
        supportedHpRange: { min: 0.5, max: 2.0 }
      },
      {
        type: 'floor_standing',
        name: 'Floor Standing',
        description: 'Floor-standing aircon unit',
        hpPricing: [
          { hp: 1.0, price: 4000, durationMinutes: 180, description: '1.0 HP - Floor unit' },
          { hp: 1.5, price: 5000, durationMinutes: 210, description: '1.5 HP - Floor unit' },
          { hp: 2.0, price: 6000, durationMinutes: 240, description: '2.0 HP - Floor unit' },
          { hp: 2.5, price: 7000, durationMinutes: 270, description: '2.5 HP - Floor unit' },
          { hp: 3.0, price: 8000, durationMinutes: 300, description: '3.0 HP - Floor unit' }
        ],
        supportedHpRange: { min: 1.0, max: 3.0 }
      },
      {
        type: 'split_suspended',
        name: 'Split Suspended',
        description: 'Ceiling-suspended split type aircon',
        hpPricing: [
          { hp: 1.0, price: 4500, durationMinutes: 180, description: '1.0 HP - Suspended unit' },
          { hp: 1.5, price: 5500, durationMinutes: 210, description: '1.5 HP - Suspended unit' },
          { hp: 2.0, price: 6500, durationMinutes: 240, description: '2.0 HP - Suspended unit' },
          { hp: 2.5, price: 7500, durationMinutes: 270, description: '2.5 HP - Suspended unit' },
          { hp: 3.0, price: 8500, durationMinutes: 300, description: '3.0 HP - Suspended unit' }
        ],
        supportedHpRange: { min: 1.0, max: 3.0 }
      },
      {
        type: 'cassette',
        name: 'Cassette Type',
        description: 'Ceiling cassette aircon for commercial spaces',
        hpPricing: [
          { hp: 1.5, price: 6000, durationMinutes: 240, description: '1.5 HP - Cassette unit' },
          { hp: 2.0, price: 7000, durationMinutes: 270, description: '2.0 HP - Cassette unit' },
          { hp: 2.5, price: 8000, durationMinutes: 300, description: '2.5 HP - Cassette unit' },
          { hp: 3.0, price: 9000, durationMinutes: 330, description: '3.0 HP - Cassette unit' },
          { hp: 4.0, price: 11000, durationMinutes: 360, description: '4.0 HP - Cassette unit' },
          { hp: 5.0, price: 13000, durationMinutes: 420, description: '5.0 HP - Cassette unit' }
        ],
        supportedHpRange: { min: 1.5, max: 5.0 }
      }
    ],
    // Legacy HP pricing for backward compatibility
    hpPricing: [
      { hp: 0.5, price: 2500, durationMinutes: 120, description: '0.5 HP - Small room/office' },
      { hp: 0.75, price: 3000, durationMinutes: 150, description: '0.75 HP - Medium room' },
      { hp: 1.0, price: 3500, durationMinutes: 180, description: '1.0 HP - Large room' },
      { hp: 1.5, price: 4500, durationMinutes: 210, description: '1.5 HP - Extra large room' },
      { hp: 2.0, price: 5500, durationMinutes: 240, description: '2.0 HP - Small commercial space' },
      { hp: 2.5, price: 6500, durationMinutes: 270, description: '2.5 HP - Medium commercial space' },
      { hp: 3.0, price: 7500, durationMinutes: 300, description: '3.0 HP - Large commercial space' }
    ],
    supportedHpRange: { min: 0.5, max: 5.0 },
    tags: ['installation', 'split-type', 'window-type', 'floor-mounted', 'suspended', 'cassette', 'onsite'],
    active: true,
    meta: { title: 'Aircon Installation', description: 'Professional aircon installation for all types - split, window, floor, suspended, cassette.' }
  },
  {
    name: 'Aircon Cleaning',
    slug: 'aircon-cleaning',
    category: 'service',
    description: 'Thorough aircon chemical wash and filter cleanup for all aircon types.',
    features: ['Chemical coil wash', 'Filter cleaning', 'Performance check'],
    includedItems: ['Cleaning solution', 'Filter re-installation'],
    exclusions: ['Deep coil repair', 'Motor replacement'],
    images: ['/images/servicesbg/techs.avif'],
    // Professional aircon types with HP pricing
    isAirconService: true,
    defaultAirconType: 'split',
    brands: ["Carrier","Daikin","LG","Samsung","Panasonic","Condura","Kolin","TCL","Midea","Fujidenzo","Gree","Sharp"],
    applianceTypes: [
      { type: 'split', name: 'Split Type' },
      { type: 'window', name: 'Window Type' },
      { type: 'cassette', name: 'Cassette' },
      { type: 'floor_standing', name: 'Floor Standing' }
    ],
    airconTypes: [
      {
        type: 'split',
        name: 'Split Type',
        description: 'Wall-mounted split type cleaning',
        hpPricing: [
          { hp: 0.5, price: 800, durationMinutes: 60, description: '0.5 HP cleaning' },
          { hp: 0.75, price: 1000, durationMinutes: 75, description: '0.75 HP cleaning' },
          { hp: 1.0, price: 1200, durationMinutes: 90, description: '1.0 HP cleaning' },
          { hp: 1.5, price: 1500, durationMinutes: 105, description: '1.5 HP cleaning' },
          { hp: 2.0, price: 1800, durationMinutes: 120, description: '2.0 HP cleaning' },
          { hp: 2.5, price: 2200, durationMinutes: 135, description: '2.5 HP cleaning' },
          { hp: 3.0, price: 2500, durationMinutes: 150, description: '3.0 HP cleaning' }
        ],
        supportedHpRange: { min: 0.5, max: 3.0 }
      },
      {
        type: 'window',
        name: 'Window Type',
        description: 'Window-mounted unit cleaning',
        hpPricing: [
          { hp: 0.5, price: 700, durationMinutes: 50, description: '0.5 HP window cleaning' },
          { hp: 0.75, price: 900, durationMinutes: 65, description: '0.75 HP window cleaning' },
          { hp: 1.0, price: 1100, durationMinutes: 80, description: '1.0 HP window cleaning' },
          { hp: 1.5, price: 1400, durationMinutes: 95, description: '1.5 HP window cleaning' },
          { hp: 2.0, price: 1700, durationMinutes: 110, description: '2.0 HP window cleaning' }
        ],
        supportedHpRange: { min: 0.5, max: 2.0 }
      },
      {
        type: 'floor_standing',
        name: 'Floor Standing',
        description: 'Floor-standing unit cleaning',
        hpPricing: [
          { hp: 1.0, price: 1300, durationMinutes: 90, description: '1.0 HP floor cleaning' },
          { hp: 1.5, price: 1600, durationMinutes: 105, description: '1.5 HP floor cleaning' },
          { hp: 2.0, price: 1900, durationMinutes: 120, description: '2.0 HP floor cleaning' },
          { hp: 2.5, price: 2300, durationMinutes: 135, description: '2.5 HP floor cleaning' },
          { hp: 3.0, price: 2600, durationMinutes: 150, description: '3.0 HP floor cleaning' }
        ],
        supportedHpRange: { min: 1.0, max: 3.0 }
      },
      {
        type: 'cassette',
        name: 'Cassette Type',
        description: 'Ceiling cassette unit cleaning',
        hpPricing: [
          { hp: 1.5, price: 2000, durationMinutes: 120, description: '1.5 HP cassette cleaning' },
          { hp: 2.0, price: 2400, durationMinutes: 135, description: '2.0 HP cassette cleaning' },
          { hp: 2.5, price: 2800, durationMinutes: 150, description: '2.5 HP cassette cleaning' },
          { hp: 3.0, price: 3200, durationMinutes: 165, description: '3.0 HP cassette cleaning' }
        ],
        supportedHpRange: { min: 1.5, max: 3.0 }
      }
    ],
    // Legacy support
    hpPricing: [
      { hp: 0.5, price: 800, durationMinutes: 60, description: '0.5 HP - Small unit cleaning' },
      { hp: 0.75, price: 1000, durationMinutes: 75, description: '0.75 HP - Medium unit cleaning' },
      { hp: 1.0, price: 1200, durationMinutes: 90, description: '1.0 HP - Standard unit cleaning' },
      { hp: 1.5, price: 1500, durationMinutes: 105, description: '1.5 HP - Large unit cleaning' },
      { hp: 2.0, price: 1800, durationMinutes: 120, description: '2.0 HP - Extra large unit cleaning' },
      { hp: 2.5, price: 2200, durationMinutes: 135, description: '2.5 HP - Commercial unit cleaning' },
      { hp: 3.0, price: 2500, durationMinutes: 150, description: '3.0 HP - Large commercial unit cleaning' }
    ],
    supportedHpRange: { min: 0.5, max: 3.0 },
    tags: ['maintenance', 'cleaning', 'split-type', 'window-type', 'floor-mounted', 'cassette'],
    active: true,
    meta: { title: 'Aircon Cleaning', description: 'Professional cleaning for all aircon types - split, window, floor, cassette.' }
  },
  {
    name: 'Freon Recharging',
    slug: 'freon-recharging',
    category: 'service',
    description: 'Recharge refrigerant to restore cooling performance. Includes system pressure check and leak inspection.',
    features: ['Vacuum & refill', 'Pressure test', 'System performance check'],
    includedItems: ['Refrigerant (standard quantity)', 'System test report'],
    exclusions: ['Major leak repair', 'Compressor replacement'],
    images: [],
    // Aircon types with per-type HP pricing
    isAirconService: true,
    defaultAirconType: 'split',
    brands: ["Carrier","Daikin","LG","Samsung","Panasonic","Condura","Kolin","TCL","Midea","Fujidenzo","Gree","Sharp"],
    applianceTypes: [
      { type: 'split', name: 'Split Type' },
      { type: 'window', name: 'Window Type' },
      { type: 'cassette', name: 'Cassette' },
      { type: 'floor_standing', name: 'Floor Standing' }
    ],
    airconTypes: [
      {
        type: 'split',
        name: 'Split Type',
        description: 'Wall-mounted split type recharging',
        hpPricing: [
          { hp: 0.5, price: 500, durationMinutes: 45, description: '0.5 HP split recharging' },
          { hp: 0.75, price: 650, durationMinutes: 50, description: '0.75 HP split recharging' },
          { hp: 1.0, price: 800, durationMinutes: 60, description: '1.0 HP split recharging' },
          { hp: 1.5, price: 1000, durationMinutes: 70, description: '1.5 HP split recharging' },
          { hp: 2.0, price: 1200, durationMinutes: 80, description: '2.0 HP split recharging' },
          { hp: 2.5, price: 1500, durationMinutes: 90, description: '2.5 HP split recharging' },
          { hp: 3.0, price: 1800, durationMinutes: 100, description: '3.0 HP split recharging' }
        ],
        supportedHpRange: { min: 0.5, max: 3.0 }
      },
      {
        type: 'window',
        name: 'Window Type',
        description: 'Window-mounted unit recharging',
        hpPricing: [
          { hp: 0.5, price: 450, durationMinutes: 40, description: '0.5 HP window recharging' },
          { hp: 0.75, price: 600, durationMinutes: 45, description: '0.75 HP window recharging' },
          { hp: 1.0, price: 750, durationMinutes: 55, description: '1.0 HP window recharging' },
          { hp: 1.5, price: 950, durationMinutes: 65, description: '1.5 HP window recharging' },
          { hp: 2.0, price: 1150, durationMinutes: 75, description: '2.0 HP window recharging' }
        ],
        supportedHpRange: { min: 0.5, max: 2.0 }
      },
      {
        type: 'floor_standing',
        name: 'Floor Standing',
        description: 'Floor-standing unit recharging',
        hpPricing: [
          { hp: 1.0, price: 900, durationMinutes: 70, description: '1.0 HP floor recharging' },
          { hp: 1.5, price: 1100, durationMinutes: 80, description: '1.5 HP floor recharging' },
          { hp: 2.0, price: 1300, durationMinutes: 90, description: '2.0 HP floor recharging' },
          { hp: 2.5, price: 1600, durationMinutes: 100, description: '2.5 HP floor recharging' },
          { hp: 3.0, price: 1900, durationMinutes: 110, description: '3.0 HP floor recharging' }
        ],
        supportedHpRange: { min: 1.0, max: 3.0 }
      },
      {
        type: 'cassette',
        name: 'Cassette Type',
        description: 'Ceiling cassette recharging',
        hpPricing: [
          { hp: 1.5, price: 1500, durationMinutes: 90, description: '1.5 HP cassette recharging' },
          { hp: 2.0, price: 1800, durationMinutes: 100, description: '2.0 HP cassette recharging' },
          { hp: 2.5, price: 2200, durationMinutes: 110, description: '2.5 HP cassette recharging' },
          { hp: 3.0, price: 2600, durationMinutes: 120, description: '3.0 HP cassette recharging' }
        ],
        supportedHpRange: { min: 1.5, max: 3.0 }
      }
    ],
    // Legacy support
    hpPricing: [
      { hp: 0.5, price: 500, durationMinutes: 45, description: '0.5 HP - Small unit recharge' },
      { hp: 0.75, price: 650, durationMinutes: 50, description: '0.75 HP - Medium unit recharge' },
      { hp: 1.0, price: 800, durationMinutes: 60, description: '1.0 HP - Standard unit recharge' },
      { hp: 1.5, price: 1000, durationMinutes: 70, description: '1.5 HP - Large unit recharge' },
      { hp: 2.0, price: 1200, durationMinutes: 80, description: '2.0 HP - Extra large unit recharge' },
      { hp: 2.5, price: 1500, durationMinutes: 90, description: '2.5 HP - Commercial unit recharge' },
      { hp: 3.0, price: 1800, durationMinutes: 100, description: '3.0 HP - Large commercial unit recharge' }
    ],
    supportedHpRange: { min: 0.5, max: 3.0 },
    tags: ['maintenance', 'refrigerant'],
    active: true,
    meta: { title: 'Freon Recharging', description: 'Restore cooling by recharging refrigerant to manufacturer levels.' }
  },
  {
    name: 'Aircon Relocation',
    slug: 'aircon-relocation',
    category: 'service',
    description: 'Relocate an existing split-type unit to a new position within the same property. Includes dismantle, transport and reinstallation.',
    features: ['Dismantle & transport', 'Re-route piping', 'Re-install & test'],
    includedItems: ['Standard piping reroute', 'Basic mounting hardware'],
    exclusions: ['Long-distance transport', 'Additional piping > 5m'],
    images: [],
    // Aircon types with per-type HP pricing
    isAirconService: true,
    defaultAirconType: 'split',
    brands: ["Carrier","Daikin","LG","Samsung","Panasonic","Condura","Kolin","TCL","Midea","Fujidenzo","Gree","Sharp"],
    applianceTypes: [
      { type: 'split', name: 'Split Type' },
      { type: 'window', name: 'Window Type' },
      { type: 'cassette', name: 'Cassette' },
      { type: 'floor_standing', name: 'Floor Standing' }
    ],
    airconTypes: [
      {
        type: 'split',
        name: 'Split Type',
        description: 'Wall-mounted split type relocation',
        hpPricing: [
          { hp: 0.5, price: 1500, durationMinutes: 90, description: '0.5 HP split relocation' },
          { hp: 0.75, price: 1750, durationMinutes: 105, description: '0.75 HP split relocation' },
          { hp: 1.0, price: 2000, durationMinutes: 120, description: '1.0 HP split relocation' },
          { hp: 1.5, price: 2500, durationMinutes: 140, description: '1.5 HP split relocation' },
          { hp: 2.0, price: 3000, durationMinutes: 160, description: '2.0 HP split relocation' },
          { hp: 2.5, price: 3500, durationMinutes: 180, description: '2.5 HP split relocation' },
          { hp: 3.0, price: 4000, durationMinutes: 200, description: '3.0 HP split relocation' }
        ],
        supportedHpRange: { min: 0.5, max: 3.0 }
      },
      {
        type: 'window',
        name: 'Window Type',
        description: 'Window-mounted unit relocation',
        hpPricing: [
          { hp: 0.5, price: 1200, durationMinutes: 75, description: '0.5 HP window relocation' },
          { hp: 0.75, price: 1400, durationMinutes: 90, description: '0.75 HP window relocation' },
          { hp: 1.0, price: 1600, durationMinutes: 105, description: '1.0 HP window relocation' },
          { hp: 1.5, price: 2000, durationMinutes: 120, description: '1.5 HP window relocation' },
          { hp: 2.0, price: 2400, durationMinutes: 140, description: '2.0 HP window relocation' }
        ],
        supportedHpRange: { min: 0.5, max: 2.0 }
      },
      {
        type: 'floor_standing',
        name: 'Floor Standing',
        description: 'Floor-standing unit relocation',
        hpPricing: [
          { hp: 1.0, price: 2500, durationMinutes: 150, description: '1.0 HP floor relocation' },
          { hp: 1.5, price: 3000, durationMinutes: 170, description: '1.5 HP floor relocation' },
          { hp: 2.0, price: 3500, durationMinutes: 190, description: '2.0 HP floor relocation' },
          { hp: 2.5, price: 4000, durationMinutes: 210, description: '2.5 HP floor relocation' },
          { hp: 3.0, price: 4500, durationMinutes: 230, description: '3.0 HP floor relocation' }
        ],
        supportedHpRange: { min: 1.0, max: 3.0 }
      }
    ],
    // Legacy support
    hpPricing: [
      { hp: 0.5, price: 1500, durationMinutes: 90, description: '0.5 HP - Small unit relocation' },
      { hp: 0.75, price: 1750, durationMinutes: 105, description: '0.75 HP - Medium unit relocation' },
      { hp: 1.0, price: 2000, durationMinutes: 120, description: '1.0 HP - Standard unit relocation' },
      { hp: 1.5, price: 2500, durationMinutes: 140, description: '1.5 HP - Large unit relocation' },
      { hp: 2.0, price: 3000, durationMinutes: 160, description: '2.0 HP - Extra large unit relocation' },
      { hp: 2.5, price: 3500, durationMinutes: 180, description: '2.5 HP - Commercial unit relocation' },
      { hp: 3.0, price: 4000, durationMinutes: 200, description: '3.0 HP - Large commercial unit relocation' }
    ],
    supportedHpRange: { min: 0.5, max: 3.0 },
    tags: ['relocation', 'installation'],
    active: true,
    meta: { title: 'Aircon Relocation', description: 'Move your aircon unit safely and re-commission at the new location.' }
  },
  {
    name: 'Dismantling & Reinstall',
    slug: 'dismantling-reinstall',
    category: 'service',
    description: 'Dismantle existing unit and reinstall (same site). Useful for renovation or maintenance access.',
    features: ['Careful dismantling', 'Reinstallation & testing'],
    includedItems: ['Basic re-mounting'],
    exclusions: ['Parts replacement', 'High-rise rigging'],
    images: [],
    // Aircon types with per-type HP pricing
    isAirconService: true,
    defaultAirconType: 'split',
    brands: ["Carrier","Daikin","LG","Samsung","Panasonic","Condura","Kolin","TCL","Midea","Fujidenzo","Gree","Sharp"],
    applianceTypes: [
      { type: 'split', name: 'Split Type' },
      { type: 'window', name: 'Window Type' },
      { type: 'cassette', name: 'Cassette' },
      { type: 'floor_standing', name: 'Floor Standing' }
    ],
    airconTypes: [
      {
        type: 'split',
        name: 'Split Type',
        description: 'Wall-mounted split type dismantle & reinstall',
        hpPricing: [
          { hp: 0.5, price: 1500, durationMinutes: 90, description: '0.5 HP split dismantle/reinstall' },
          { hp: 0.75, price: 1750, durationMinutes: 105, description: '0.75 HP split dismantle/reinstall' },
          { hp: 1.0, price: 2000, durationMinutes: 120, description: '1.0 HP split dismantle/reinstall' },
          { hp: 1.5, price: 2500, durationMinutes: 140, description: '1.5 HP split dismantle/reinstall' },
          { hp: 2.0, price: 3000, durationMinutes: 160, description: '2.0 HP split dismantle/reinstall' },
          { hp: 2.5, price: 3500, durationMinutes: 180, description: '2.5 HP split dismantle/reinstall' },
          { hp: 3.0, price: 4000, durationMinutes: 200, description: '3.0 HP split dismantle/reinstall' }
        ],
        supportedHpRange: { min: 0.5, max: 3.0 }
      },
      {
        type: 'window',
        name: 'Window Type',
        description: 'Window-mounted unit dismantle & reinstall',
        hpPricing: [
          { hp: 0.5, price: 1200, durationMinutes: 75, description: '0.5 HP window dismantle/reinstall' },
          { hp: 0.75, price: 1400, durationMinutes: 90, description: '0.75 HP window dismantle/reinstall' },
          { hp: 1.0, price: 1600, durationMinutes: 105, description: '1.0 HP window dismantle/reinstall' },
          { hp: 1.5, price: 2000, durationMinutes: 120, description: '1.5 HP window dismantle/reinstall' },
          { hp: 2.0, price: 2400, durationMinutes: 140, description: '2.0 HP window dismantle/reinstall' }
        ],
        supportedHpRange: { min: 0.5, max: 2.0 }
      },
      {
        type: 'floor_standing',
        name: 'Floor Standing',
        description: 'Floor-standing unit dismantle & reinstall',
        hpPricing: [
          { hp: 1.0, price: 2200, durationMinutes: 140, description: '1.0 HP floor dismantle/reinstall' },
          { hp: 1.5, price: 2700, durationMinutes: 160, description: '1.5 HP floor dismantle/reinstall' },
          { hp: 2.0, price: 3200, durationMinutes: 180, description: '2.0 HP floor dismantle/reinstall' },
          { hp: 2.5, price: 3700, durationMinutes: 200, description: '2.5 HP floor dismantle/reinstall' },
          { hp: 3.0, price: 4200, durationMinutes: 220, description: '3.0 HP floor dismantle/reinstall' }
        ],
        supportedHpRange: { min: 1.0, max: 3.0 }
      }
    ],
    // Legacy support
    hpPricing: [
      { hp: 0.5, price: 1500, durationMinutes: 90, description: '0.5 HP - Small unit dismantle & reinstall' },
      { hp: 0.75, price: 1750, durationMinutes: 105, description: '0.75 HP - Medium unit dismantle & reinstall' },
      { hp: 1.0, price: 2000, durationMinutes: 120, description: '1.0 HP - Standard unit dismantle & reinstall' },
      { hp: 1.5, price: 2500, durationMinutes: 140, description: '1.5 HP - Large unit dismantle & reinstall' },
      { hp: 2.0, price: 3000, durationMinutes: 160, description: '2.0 HP - Extra large unit dismantle & reinstall' },
      { hp: 2.5, price: 3500, durationMinutes: 180, description: '2.5 HP - Commercial unit dismantle & reinstall' },
      { hp: 3.0, price: 4000, durationMinutes: 200, description: '3.0 HP - Large commercial unit dismantle & reinstall' }
    ],
    supportedHpRange: { min: 0.5, max: 3.0 },
    tags: ['dismantle', 'reinstall'],
    active: true,
    meta: { title: 'Dismantling & Reinstall', description: 'Safe dismantle and reinstall service for aircon units.' }
  },
  {
    name: 'System Reprocess',
    slug: 'system-reprocess',
    category: 'service',
    description: 'Quick system reprocess to address minor operational issues and recalibrate controls.',
    features: ['System flush', 'Control recalibration'],
    includedItems: [],
    exclusions: ['Major repairs'],
    images: [],
    // Aircon types with per-type HP pricing
    isAirconService: true,
    defaultAirconType: 'split',
    brands: ["Carrier","Daikin","LG","Samsung","Panasonic","Condura","Kolin","TCL","Midea","Fujidenzo","Gree","Sharp"],
    applianceTypes: [
      { type: 'split', name: 'Split Type' },
      { type: 'window', name: 'Window Type' },
      { type: 'cassette', name: 'Cassette' },
      { type: 'floor_standing', name: 'Floor Standing' }
    ],
    airconTypes: [
      {
        type: 'split',
        name: 'Split Type',
        description: 'Wall-mounted split type reprocess',
        hpPricing: [
          { hp: 0.5, price: 700, durationMinutes: 45, description: '0.5 HP split reprocess' },
          { hp: 0.75, price: 850, durationMinutes: 50, description: '0.75 HP split reprocess' },
          { hp: 1.0, price: 1000, durationMinutes: 60, description: '1.0 HP split reprocess' },
          { hp: 1.5, price: 1200, durationMinutes: 70, description: '1.5 HP split reprocess' },
          { hp: 2.0, price: 1400, durationMinutes: 80, description: '2.0 HP split reprocess' },
          { hp: 2.5, price: 1600, durationMinutes: 90, description: '2.5 HP split reprocess' },
          { hp: 3.0, price: 1800, durationMinutes: 100, description: '3.0 HP split reprocess' }
        ],
        supportedHpRange: { min: 0.5, max: 3.0 }
      },
      {
        type: 'window',
        name: 'Window Type',
        description: 'Window-mounted unit reprocess',
        hpPricing: [
          { hp: 0.5, price: 600, durationMinutes: 40, description: '0.5 HP window reprocess' },
          { hp: 0.75, price: 750, durationMinutes: 45, description: '0.75 HP window reprocess' },
          { hp: 1.0, price: 900, durationMinutes: 55, description: '1.0 HP window reprocess' },
          { hp: 1.5, price: 1100, durationMinutes: 65, description: '1.5 HP window reprocess' },
          { hp: 2.0, price: 1300, durationMinutes: 75, description: '2.0 HP window reprocess' }
        ],
        supportedHpRange: { min: 0.5, max: 2.0 }
      },
      {
        type: 'floor_standing',
        name: 'Floor Standing',
        description: 'Floor-standing unit reprocess',
        hpPricing: [
          { hp: 1.0, price: 1100, durationMinutes: 70, description: '1.0 HP floor reprocess' },
          { hp: 1.5, price: 1300, durationMinutes: 80, description: '1.5 HP floor reprocess' },
          { hp: 2.0, price: 1500, durationMinutes: 90, description: '2.0 HP floor reprocess' },
          { hp: 2.5, price: 1700, durationMinutes: 100, description: '2.5 HP floor reprocess' },
          { hp: 3.0, price: 1900, durationMinutes: 110, description: '3.0 HP floor reprocess' }
        ],
        supportedHpRange: { min: 1.0, max: 3.0 }
      }
    ],
    // Legacy support
    hpPricing: [
      { hp: 0.5, price: 700, durationMinutes: 45, description: '0.5 HP - Small unit reprocess' },
      { hp: 0.75, price: 850, durationMinutes: 50, description: '0.75 HP - Medium unit reprocess' },
      { hp: 1.0, price: 1000, durationMinutes: 60, description: '1.0 HP - Standard unit reprocess' },
      { hp: 1.5, price: 1200, durationMinutes: 70, description: '1.5 HP - Large unit reprocess' },
      { hp: 2.0, price: 1400, durationMinutes: 80, description: '2.0 HP - Extra large unit reprocess' },
      { hp: 2.5, price: 1600, durationMinutes: 90, description: '2.5 HP - Commercial unit reprocess' },
      { hp: 3.0, price: 1800, durationMinutes: 100, description: '3.0 HP - Large commercial unit reprocess' }
    ],
    supportedHpRange: { min: 0.5, max: 3.0 },
    tags: ['maintenance', 'diagnostic'],
    active: true,
    meta: { title: 'System Reprocess', description: 'Minor system servicing to restore expected operation.' }
  },
  {
    name: 'Pump Down',
    slug: 'pump-down',
    category: 'service',
    description: 'Pump-down procedure to safely store refrigerant and isolate the system for transport or repair.',
    features: ['Safe refrigerant isolation', 'Leak-check'],
    includedItems: [],
    exclusions: ['Compressor work'],
    images: [],
    // Aircon types with per-type HP pricing
    isAirconService: true,
    defaultAirconType: 'split',
    brands: ["Carrier","Daikin","LG","Samsung","Panasonic","Condura","Kolin","TCL","Midea","Fujidenzo","Gree","Sharp"],
    applianceTypes: [
      { type: 'split', name: 'Split Type' },
      { type: 'window', name: 'Window Type' },
      { type: 'cassette', name: 'Cassette' },
      { type: 'floor_standing', name: 'Floor Standing' }
    ],
    airconTypes: [
      {
        type: 'split',
        name: 'Split Type',
        description: 'Wall-mounted split type pump down',
        hpPricing: [
          { hp: 0.5, price: 500, durationMinutes: 30, description: '0.5 HP split pump down' },
          { hp: 0.75, price: 600, durationMinutes: 35, description: '0.75 HP split pump down' },
          { hp: 1.0, price: 700, durationMinutes: 45, description: '1.0 HP split pump down' },
          { hp: 1.5, price: 850, durationMinutes: 50, description: '1.5 HP split pump down' },
          { hp: 2.0, price: 1000, durationMinutes: 60, description: '2.0 HP split pump down' },
          { hp: 2.5, price: 1200, durationMinutes: 65, description: '2.5 HP split pump down' },
          { hp: 3.0, price: 1400, durationMinutes: 70, description: '3.0 HP split pump down' }
        ],
        supportedHpRange: { min: 0.5, max: 3.0 }
      },
      {
        type: 'window',
        name: 'Window Type',
        description: 'Window-mounted unit pump down',
        hpPricing: [
          { hp: 0.5, price: 450, durationMinutes: 25, description: '0.5 HP window pump down' },
          { hp: 0.75, price: 550, durationMinutes: 30, description: '0.75 HP window pump down' },
          { hp: 1.0, price: 650, durationMinutes: 40, description: '1.0 HP window pump down' },
          { hp: 1.5, price: 800, durationMinutes: 45, description: '1.5 HP window pump down' },
          { hp: 2.0, price: 950, durationMinutes: 55, description: '2.0 HP window pump down' }
        ],
        supportedHpRange: { min: 0.5, max: 2.0 }
      },
      {
        type: 'floor_standing',
        name: 'Floor Standing',
        description: 'Floor-standing unit pump down',
        hpPricing: [
          { hp: 1.0, price: 800, durationMinutes: 55, description: '1.0 HP floor pump down' },
          { hp: 1.5, price: 950, durationMinutes: 60, description: '1.5 HP floor pump down' },
          { hp: 2.0, price: 1100, durationMinutes: 70, description: '2.0 HP floor pump down' },
          { hp: 2.5, price: 1300, durationMinutes: 75, description: '2.5 HP floor pump down' },
          { hp: 3.0, price: 1500, durationMinutes: 85, description: '3.0 HP floor pump down' }
        ],
        supportedHpRange: { min: 1.0, max: 3.0 }
      }
    ],
    // Legacy support
    hpPricing: [
      { hp: 0.5, price: 500, durationMinutes: 30, description: '0.5 HP - Small unit pump down' },
      { hp: 0.75, price: 600, durationMinutes: 35, description: '0.75 HP - Medium unit pump down' },
      { hp: 1.0, price: 700, durationMinutes: 45, description: '1.0 HP - Standard unit pump down' },
      { hp: 1.5, price: 850, durationMinutes: 50, description: '1.5 HP - Large unit pump down' },
      { hp: 2.0, price: 1000, durationMinutes: 60, description: '2.0 HP - Extra large unit pump down' },
      { hp: 2.5, price: 1200, durationMinutes: 65, description: '2.5 HP - Commercial unit pump down' },
      { hp: 3.0, price: 1400, durationMinutes: 70, description: '3.0 HP - Large commercial unit pump down' }
    ],
    supportedHpRange: { min: 0.5, max: 3.0 },
    tags: ['maintenance'],
    active: true,
    meta: { title: 'Pump Down', description: 'Isolate and secure refrigerant for safe servicing or transport.' }
  },
  {
    name: 'Leak Testing',
    slug: 'leak-testing',
    category: 'service',
    description: 'Comprehensive leak testing and diagnostics for refrigerant systems.',
    features: ['Pressure testing', 'Electronic leak detection'],
    includedItems: [],
    exclusions: ['Major repairs', 'parts replacement'],
    images: [],
    // Aircon types with per-type HP pricing
    isAirconService: true,
    defaultAirconType: 'split',
    brands: ["Carrier","Daikin","LG","Samsung","Panasonic","Condura","Kolin","TCL","Midea","Fujidenzo","Gree","Sharp"],
    applianceTypes: [
      { type: 'split', name: 'Split Type' },
      { type: 'window', name: 'Window Type' },
      { type: 'cassette', name: 'Cassette' },
      { type: 'floor_standing', name: 'Floor Standing' }
    ],
    airconTypes: [
      {
        type: 'split',
        name: 'Split Type',
        description: 'Wall-mounted split type leak testing',
        hpPricing: [
          { hp: 0.5, price: 500, durationMinutes: 30, description: '0.5 HP split leak test' },
          { hp: 0.75, price: 600, durationMinutes: 35, description: '0.75 HP split leak test' },
          { hp: 1.0, price: 700, durationMinutes: 45, description: '1.0 HP split leak test' },
          { hp: 1.5, price: 850, durationMinutes: 50, description: '1.5 HP split leak test' },
          { hp: 2.0, price: 1000, durationMinutes: 60, description: '2.0 HP split leak test' },
          { hp: 2.5, price: 1200, durationMinutes: 65, description: '2.5 HP split leak test' },
          { hp: 3.0, price: 1400, durationMinutes: 70, description: '3.0 HP split leak test' }
        ],
        supportedHpRange: { min: 0.5, max: 3.0 }
      },
      {
        type: 'window',
        name: 'Window Type',
        description: 'Window-mounted unit leak testing',
        hpPricing: [
          { hp: 0.5, price: 450, durationMinutes: 25, description: '0.5 HP window leak test' },
          { hp: 0.75, price: 550, durationMinutes: 30, description: '0.75 HP window leak test' },
          { hp: 1.0, price: 650, durationMinutes: 40, description: '1.0 HP window leak test' },
          { hp: 1.5, price: 800, durationMinutes: 45, description: '1.5 HP window leak test' },
          { hp: 2.0, price: 950, durationMinutes: 55, description: '2.0 HP window leak test' }
        ],
        supportedHpRange: { min: 0.5, max: 2.0 }
      },
      {
        type: 'floor_standing',
        name: 'Floor Standing',
        description: 'Floor-standing unit leak testing',
        hpPricing: [
          { hp: 1.0, price: 800, durationMinutes: 50, description: '1.0 HP floor leak test' },
          { hp: 1.5, price: 950, durationMinutes: 55, description: '1.5 HP floor leak test' },
          { hp: 2.0, price: 1100, durationMinutes: 65, description: '2.0 HP floor leak test' },
          { hp: 2.5, price: 1300, durationMinutes: 70, description: '2.5 HP floor leak test' },
          { hp: 3.0, price: 1500, durationMinutes: 80, description: '3.0 HP floor leak test' }
        ],
        supportedHpRange: { min: 1.0, max: 3.0 }
      },
      {
        type: 'cassette',
        name: 'Cassette Type',
        description: 'Ceiling cassette leak testing',
        hpPricing: [
          { hp: 1.5, price: 1200, durationMinutes: 75, description: '1.5 HP cassette leak test' },
          { hp: 2.0, price: 1400, durationMinutes: 85, description: '2.0 HP cassette leak test' },
          { hp: 2.5, price: 1600, durationMinutes: 95, description: '2.5 HP cassette leak test' },
          { hp: 3.0, price: 1800, durationMinutes: 105, description: '3.0 HP cassette leak test' }
        ],
        supportedHpRange: { min: 1.5, max: 3.0 }
      }
    ],
    // Legacy support
    hpPricing: [
      { hp: 0.5, price: 500, durationMinutes: 30, description: '0.5 HP - Small unit leak testing' },
      { hp: 0.75, price: 600, durationMinutes: 35, description: '0.75 HP - Medium unit leak testing' },
      { hp: 1.0, price: 700, durationMinutes: 45, description: '1.0 HP - Standard unit leak testing' },
      { hp: 1.5, price: 850, durationMinutes: 50, description: '1.5 HP - Large unit leak testing' },
      { hp: 2.0, price: 1000, durationMinutes: 60, description: '2.0 HP - Extra large unit leak testing' },
      { hp: 2.5, price: 1200, durationMinutes: 65, description: '2.5 HP - Commercial unit leak testing' },
      { hp: 3.0, price: 1400, durationMinutes: 70, description: '3.0 HP - Large commercial unit leak testing' }
    ],
    supportedHpRange: { min: 0.5, max: 3.0 },
    tags: ['diagnostic', 'leak-test'],
    active: true,
    meta: { title: 'Leak Testing', description: 'Detect and locate leaks before recharging refrigerant.' }
  },
  {
    name: 'CCTV Installation',
    slug: 'cctv-installation',
    category: 'service',
    description: 'CCTV camera installation and configuration for single-site coverage.',
    features: ['Camera mounting', 'Wiring', 'NVR setup', 'Basic configuration'],
    includedItems: ['Standard camera mount', 'Basic wiring'],
    exclusions: ['Long distance cabling', 'Network-level firewall configuration'],
    images: [],
    // Non-aircon service - use traditional pricing
    isAirconService: false,
    basePrice: 1200,
    durationMinutes: 60,
    tags: ['security', 'installation'],
    active: true,
    meta: { title: 'CCTV Installation', description: 'Reliable CCTV installation for homes and small businesses.' }
  }
];

const repairDefaults = [
  {
    name: 'Aircon Repair',
    applianceType: 'aircon',
    commonFaults: ['Not cooling', 'Leaking water', 'Noisy compressor', 'Fan not working', 'Remote control issues'],
    parts: [ 
      { name: 'Compressor', price: 4500 }, 
      { name: 'Capacitor', price: 800 },
      { name: 'Thermostat', price: 1200 },
      { name: 'Fan Motor', price: 1800 },
      { name: 'Remote Control', price: 600 }
    ],
    
    // Initial pricing (before technician diagnosis)
    initialPrice: 500,
    pricingNote: 'Initial diagnostic fee of ₱500. Final repair cost will be determined by the technician after inspection and diagnosis.',
    
    // HP-based pricing for aircon repair
    isAirconService: true,
    supportedHpRange: { min: 0.5, max: 3.0 },
    hpPricing: [
      { hp: 0.5, price: 1000, laborPerHour: 800, estimatedDurationMinutes: 60, description: '0.5 HP - Small unit repair' },
      { hp: 0.75, price: 1200, laborPerHour: 800, estimatedDurationMinutes: 75, description: '0.75 HP - Medium unit repair' },
      { hp: 1.0, price: 1500, laborPerHour: 900, estimatedDurationMinutes: 90, description: '1.0 HP - Standard unit repair' },
      { hp: 1.5, price: 1800, laborPerHour: 1000, estimatedDurationMinutes: 105, description: '1.5 HP - Large unit repair' },
      { hp: 2.0, price: 2200, laborPerHour: 1100, estimatedDurationMinutes: 120, description: '2.0 HP - Extra large unit repair' },
      { hp: 2.5, price: 2600, laborPerHour: 1200, estimatedDurationMinutes: 135, description: '2.5 HP - Commercial unit repair' },
      { hp: 3.0, price: 3000, laborPerHour: 1300, estimatedDurationMinutes: 150, description: '3.0 HP - Large commercial unit repair' }
    ],
    
    warrantyDays: 30,
    availabilityLocations: [],
    active: true
  },
  {
    name: 'Aircon Compressor Replacement',
    applianceType: 'aircon',
    commonFaults: ['Compressor failure', 'Compressor noise', 'Low cooling efficiency'],
    parts: [ 
      { name: 'Compressor', price: 4500, required: true },
      { name: 'Refrigerant', price: 800, required: true },
      { name: 'Drier Filter', price: 300, required: true }
    ],
    
    // Initial pricing (before technician diagnosis)
    initialPrice: 800,
    pricingNote: 'Initial diagnostic fee of ₱800. Final compressor replacement cost will be determined after inspection.',
    
    // HP-based pricing for compressor replacement
    isAirconService: true,
    supportedHpRange: { min: 0.5, max: 3.0 },
    hpPricing: [
      { hp: 0.5, price: 3500, laborPerHour: 1000, estimatedDurationMinutes: 120, description: '0.5 HP compressor replacement' },
      { hp: 0.75, price: 4000, laborPerHour: 1100, estimatedDurationMinutes: 140, description: '0.75 HP compressor replacement' },
      { hp: 1.0, price: 4500, laborPerHour: 1200, estimatedDurationMinutes: 160, description: '1.0 HP compressor replacement' },
      { hp: 1.5, price: 5500, laborPerHour: 1300, estimatedDurationMinutes: 180, description: '1.5 HP compressor replacement' },
      { hp: 2.0, price: 6500, laborPerHour: 1400, estimatedDurationMinutes: 200, description: '2.0 HP compressor replacement' },
      { hp: 2.5, price: 7500, laborPerHour: 1500, estimatedDurationMinutes: 220, description: '2.5 HP compressor replacement' },
      { hp: 3.0, price: 8500, laborPerHour: 1600, estimatedDurationMinutes: 240, description: '3.0 HP compressor replacement' }
    ],
    
    warrantyDays: 90,
    availabilityLocations: [],
    active: true
  },
  {
    name: 'Refrigerator Repair',
    applianceType: 'refrigerator',
    commonFaults: ['Not cooling', 'Leaking', 'Noisy compressor'],
    parts: [ { name: 'Compressor', price: 4500 }, { name: 'Thermostat', price: 850 } ],
    
    // Non-aircon service - use initial pricing
    isAirconService: false,
    initialPrice: 500,
    basePrice: 1200,
    pricingNote: 'Initial service call fee of ₱500. Final repair cost will be determined by the technician after diagnosis.',
    estimatedDurationMinutes: 90,
    warrantyDays: 30,
    availabilityLocations: [],
    active: true
  },
  {
    name: 'Washing Machine Repair',
    applianceType: 'washing-machine',
    commonFaults: ['Not draining', 'Spin failure', 'Noise'],
    parts: [ { name: 'Drain Pump', price: 1200 } ],
    
    // Non-aircon service - use initial pricing
    isAirconService: false,
    initialPrice: 450,
    basePrice: 1200,
    pricingNote: 'Initial service call fee of ₱450. Final repair cost will be determined by the technician after diagnosis.',
    estimatedDurationMinutes: 90,
    warrantyDays: 14,
    availabilityLocations: [],
    active: true
  },
  {
    name: 'Microwave Oven Repair',
    applianceType: 'microwave',
    commonFaults: ['Not heating', 'Turntable not rotating', 'Sparking'],
    parts: [ { name: 'Magnetron', price: 2500 } ],
    
    // Non-aircon service - use initial pricing
    isAirconService: false,
    initialPrice: 400,
    basePrice: 800,
    pricingNote: 'Initial service call fee of ₱400. Final repair cost will be determined by the technician after diagnosis.',
    estimatedDurationMinutes: 60,
    warrantyDays: 14,
    availabilityLocations: [],
    active: true
  },
  {
    name: 'Freezer Service',
    applianceType: 'freezer',
    commonFaults: ['Not cooling', 'Frost build-up', 'Leaking'],
    parts: [],
    
    // Non-aircon service - use initial pricing
    isAirconService: false,
    initialPrice: 500,
    basePrice: 1200,
    pricingNote: 'Initial service call fee of ₱500. Final repair cost will be determined by the technician after diagnosis.',
    estimatedDurationMinutes: 90,
    warrantyDays: 30,
    availabilityLocations: [],
    active: true
  },
  {
    name: 'Dryer Repair',
    applianceType: 'dryer',
    commonFaults: ['Not heating', 'Drum not spinning', 'Vibration/noise'],
    parts: [],
    
    // Non-aircon service - use initial pricing
    isAirconService: false,
    initialPrice: 400,
    basePrice: 800,
    pricingNote: 'Initial service call fee of ₱400. Final repair cost will be determined by the technician after diagnosis.',
    estimatedDurationMinutes: 60,
    warrantyDays: 14,
    availabilityLocations: [],
    active: true
  },
  {
    name: 'Rice Cooker Repair',
    applianceType: 'rice-cooker',
    commonFaults: ['Not powering on', 'Overcooking', 'Switch failure'],
    parts: [],
    
    // Non-aircon service - use initial pricing
    isAirconService: false,
    initialPrice: 350,
    basePrice: 700,
    pricingNote: 'Initial service call fee of ₱350. Final repair cost will be determined by the technician after diagnosis.',
    estimatedDurationMinutes: 45,
    warrantyDays: 7,
    availabilityLocations: [],
    active: true
  },
  {
    name: 'Electric Fan Repair',
    applianceType: 'electric-fan',
    commonFaults: ['Wobbly motor', 'Noisy operation', 'Not oscillating'],
    parts: [],
    
    // Non-aircon service - use initial pricing
    isAirconService: false,
    initialPrice: 300,
    basePrice: 700,
    pricingNote: 'Initial service call fee of ₱300. Final repair cost will be determined by the technician after diagnosis.',
    estimatedDurationMinutes: 45,
    warrantyDays: 7,
    availabilityLocations: [],
    active: true
  },
  {
    name: 'Water Dispenser Repair',
    applianceType: 'water-dispenser',
    commonFaults: ['Not dispensing', 'Leaking', 'Cooling issue'],
    parts: [],
    
    // Non-aircon service - use initial pricing
    isAirconService: false,
    initialPrice: 400,
    basePrice: 800,
    pricingNote: 'Initial service call fee of ₱400. Final repair cost will be determined by the technician after diagnosis.',
    estimatedDurationMinutes: 60,
    warrantyDays: 14,
    availabilityLocations: [],
    active: true
  },
  {
    name: 'Electric Kettle Repair',
    applianceType: 'electric-kettle',
    commonFaults: ['Not heating', 'Auto-shutoff failure'],
    parts: [],
    
    // Non-aircon service - use initial pricing
    isAirconService: false,
    initialPrice: 250,
    basePrice: 500,
    pricingNote: 'Initial service call fee of ₱250. Final repair cost will be determined by the technician after diagnosis.',
    estimatedDurationMinutes: 30,
    warrantyDays: 7,
    availabilityLocations: [],
    active: true
  }
];

async function run() {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB');

  let created = 0;
  for (const svc of coreDefaults) {
    const existing = await CoreService.findOne({ slug: svc.slug });
    if (existing) {
      await CoreService.updateOne({ _id: existing._id }, { $set: svc });
    } else {
      await CoreService.create(svc);
      created += 1;
    }
  }

  for (const svc of repairDefaults) {
    const existing = await RepairService.findOne({ name: svc.name });
    if (existing) {
      await RepairService.updateOne({ _id: existing._id }, { $set: svc });
    } else {
      await RepairService.create(svc);
      created += 1;
    }
  }

  console.log(`Seeding CoreService/RepairService complete. New records created: ${created}`);
  await mongoose.disconnect();
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
