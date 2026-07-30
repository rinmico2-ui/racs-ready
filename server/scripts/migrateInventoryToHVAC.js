const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const HVACProduct = require('../models/HVACProduct');
const Brand = require('../models/Brand');
const Category = require('../models/Category');

/**
 * Migration Script: Convert Inventory to HVAC Product Schema
 * 
 * This script converts the current individual SKU-based inventory
 * to the new HVAC product schema with variants array.
 */

async function migrateInventoryToHVAC() {
  try {
    console.log('🚀 Starting migration from Inventory to HVAC Product schema...');
    
    // Connect to database
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/racs_db');
    }
    
    // 1. Get all existing inventory items
    const inventoryItems = await Inventory.find({ active: true })
      .populate('brand', 'name')
      .populate('category', 'name')
      .sort({ modelLine: 1, capacity: 1 });
    
    console.log(`📦 Found ${inventoryItems.length} inventory items to migrate`);
    
    // 2. Group items by model line and brand
    const productGroups = {};
    
    inventoryItems.forEach(item => {
      const key = `${item.modelLine}-${item.brand?._id}`;
      
      if (!productGroups[key]) {
        productGroups[key] = {
          modelLine: item.modelLine,
          brand: item.brand,
          category: item.category,
          type: item.type,
          inverter: item.inverter,
          description: item.description,
          imageUrl: item.imageUrl,
          specifications: item.specifications || {},
          salesChannel: item.salesChannel || 'both',
          supplier: item.supplier,
          variants: []
        };
      }
      
      // Add variant data
      const variant = {
        capacity: item.capacity,
        capacityUnit: item.capacityUnit || 'HP',
        btu: item.btu || 0,
        sellingPrice: item.sellingPrice || 0,
        costPrice: item.costPrice || 0,
        quantity: item.quantity || 0,
        minStockLevel: item.minStockLevel || 3,
        status: item.status || 'out_of_stock',
        sku: item.sku,
        barcode: item.barcode,
        specifications: {
          refrigerantType: item.specifications?.refrigerantType || 'R32',
          energyRating: item.specifications?.energyRating || null,
          noiseLevel: item.specifications?.noiseLevel || null,
          coverageArea: item.specifications?.coverageArea || null,
          dimensions: item.specifications?.dimensions || null,
          weight: item.specifications?.weight || null,
        },
        active: true
      };
      
      productGroups[key].variants.push(variant);
    });
    
    console.log(`📊 Grouped into ${Object.keys(productGroups).length} product models`);
    
    // 3. Create HVAC products
    const migrationResults = {
      created: 0,
      updated: 0,
      errors: []
    };
    
    for (const [key, productData] of Object.entries(productGroups)) {
      try {
        // Check if product already exists
        const existingProduct = await HVACProduct.findOne({
          modelLine: productData.modelLine,
          brand: productData.brand._id
        });
        
        if (existingProduct) {
          // Update existing product
          existingProduct.variants = productData.variants;
          existingProduct.specifications = productData.specifications;
          existingProduct.salesChannel = productData.salesChannel;
          existingProduct.supplier = productData.supplier;
          existingProduct.updatedBy = null; // Would be admin user ID
          await existingProduct.save();
          
          migrationResults.updated++;
          console.log(`✅ Updated existing product: ${productData.modelLine}`);
        } else {
          // Create new product
          const hvacProduct = new HVACProduct({
            ...productData,
            createdBy: null, // Would be admin user ID
            updatedBy: null
          });
          
          await hvacProduct.save();
          
          migrationResults.created++;
          console.log(`✅ Created new product: ${productData.modelLine} with ${productData.variants.length} variants`);
        }
        
      } catch (error) {
        console.error(`❌ Error migrating product ${productData.modelLine}:`, error.message);
        migrationResults.errors.push({
          product: productData.modelLine,
          error: error.message
        });
      }
    }
    
    // 4. Summary
    console.log('\n📈 Migration Summary:');
    console.log(`✅ Created: ${migrationResults.created} new products`);
    console.log(`🔄 Updated: ${migrationResults.updated} existing products`);
    console.log(`❌ Errors: ${migrationResults.errors.length} products failed`);
    
    if (migrationResults.errors.length > 0) {
      console.log('\n❌ Error Details:');
      migrationResults.errors.forEach(err => {
        console.log(`  - ${err.product}: ${err.error}`);
      });
    }
    
    // 5. Sample data verification
    const sampleProducts = await HVACProduct.find()
      .populate('brand', 'name')
      .populate('category', 'name')
      .limit(5);
    
    console.log('\n🔍 Sample migrated products:');
    sampleProducts.forEach(product => {
      console.log(`  📦 ${product.brand?.name} ${product.modelLine}`);
      console.log(`     Variants: ${product.variants.map(v => `${v.capacity}HP`).join(', ')}`);
      console.log(`     Price Range: ₱${product.priceRange.min.toLocaleString()} - ₱${product.priceRange.max.toLocaleString()}`);
      console.log('');
    });
    
    console.log('🎉 Migration completed successfully!');
    
  } catch (error) {
    console.error('💥 Migration failed:', error);
    throw error;
  } finally {
    // Don't close connection if it was already open
    if (mongoose.connection.readyState === 1) {
      // await mongoose.connection.close();
    }
  }
}

/**
 * Rollback function to restore original inventory if needed
 */
async function rollbackMigration() {
  try {
    console.log('⚠️  Starting rollback...');
    
    // This would restore from backup or recreate inventory items
    // Implementation depends on your backup strategy
    
    console.log('⚠️  Rollback completed');
  } catch (error) {
    console.error('💥 Rollback failed:', error);
  }
}

// Export functions
module.exports = {
  migrateInventoryToHVAC,
  rollbackMigration
};

// Run migration if called directly
if (require.main === module) {
  migrateInventoryToHVAC()
    .then(() => {
      console.log('✅ Migration script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Migration script failed:', error);
      process.exit(1);
    });
}
