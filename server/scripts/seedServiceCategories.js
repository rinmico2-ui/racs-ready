/*
 * Seed ServiceCategory collection with default repair request categories.
 * Usage: NODE_ENV=development node server/scripts/seedServiceCategories.js
 */
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const ServiceCategory = require('../models/ServiceCategory');
const dns = require('dns');

dns.setServers(['8.8.8.8', '8.8.4.4']);
dotenv.config();
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/racs_db';

const defaults = [
  {
    name: 'Air Conditioning',
    slug: 'aircon',
    icon: 'bi-snow',
    iconColor: 'blue',
    order: 1,
    active: true,
    isCustom: false,
    unitTypes: [
      { value: 'Split Type Aircon', label: 'Split Type', icon: 'bi-window' },
      { value: 'Window Type Aircon', label: 'Window Type', icon: 'bi-window' },
      { value: 'Floor Mounted Aircon', label: 'Floor Mounted', icon: 'bi-arrows-expand' },
      { value: 'Cassette Type Aircon', label: 'Cassette Type', icon: 'bi-grid-3x3' },
      { value: 'Central Aircon', label: 'Central', icon: 'bi-buildings' }
    ]
  },
  {
    name: 'Home Appliances',
    slug: 'appliance',
    icon: 'bi-house-gear',
    iconColor: 'amber',
    order: 2,
    active: true,
    isCustom: false,
    unitTypes: [
      { value: 'Refrigerator', label: 'Refrigerator', icon: 'bi-reception-4' },
      { value: 'Freezer', label: 'Freezer', icon: 'bi-snow' },
      { value: 'Washing Machine', label: 'Washing Machine', icon: 'bi-droplet-half' },
      { value: 'Dryer', label: 'Dryer', icon: 'bi-wind' },
      { value: 'Microwave Oven', label: 'Microwave', icon: 'bi-circle' },
      { value: 'Electric Fan', label: 'Electric Fan', icon: 'bi-fan' },
      { value: 'Rice Cooker', label: 'Rice Cooker', icon: 'bi-fire' },
      { value: 'Water Dispenser', label: 'Water Dispenser', icon: 'bi-cup-straw' },
      { value: 'Electric Kettle', label: 'Electric Kettle', icon: 'bi-cup-hot' }
    ]
  },
  {
    name: 'Other',
    slug: 'other',
    icon: 'bi-plus-circle',
    iconColor: 'violet',
    order: 99,
    active: true,
    isCustom: true,
    unitTypes: [
      { value: 'Other', label: 'Other (specify in problem)', icon: 'bi-plus-circle' }
    ]
  }
];

async function seed() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('Connected to MongoDB');

    for (const cat of defaults) {
      const existing = await ServiceCategory.findOne({ slug: cat.slug });
      if (!existing) {
        await ServiceCategory.create(cat);
        console.log(`Created: ${cat.name}`);
      } else {
        console.log(`Exists:  ${cat.name} (skipped)`);
      }
    }

    console.log('ServiceCategory seed complete.');
    process.exit(0);
  } catch (err) {
    console.error('Seed failed:', err);
    process.exit(1);
  }
}

seed();
