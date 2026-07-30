const mongoose = require('mongoose');
const HVACProduct = require('../models/HVACProduct');
const Brand = require('../models/Brand');
const Category = require('../models/Category');

// Load environment variables
require('dotenv').config();

/**
 * Seed Script: HVAC Products with Professional Data
 * 
 * This script creates sample HVAC products based on the user's requirements:
 * - Each model line has multiple HP variants
 * - Professional pricing structure
 * - Complete specifications
 */

async function seedHVACProducts() {
  try {
    console.log('🌱 Starting HVAC products seeding...');
    
    // Debug: Check environment variables
    console.log('🔍 Environment check:');
    console.log('  MONGODB_URI:', process.env.MONGODB_URI ? '✅ Set' : '❌ Not set');
    
    // Connect to database
    if (mongoose.connection.readyState === 0) {
      const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://racs_ready:tOwE7F0fwflbzuzD@cluster0.zg3zjgk.mongodb.net/?appName=Cluster0';
      console.log('🔌 Connecting to MongoDB...');
      console.log('  URI:', mongoUri.replace(/\/\/([^:]+):([^@]+)@/, '//***:***@')); // Hide credentials
      
      await mongoose.connect(mongoUri, {
        serverSelectionTimeoutMS: 5000, // Timeout after 5s
      });
      
      console.log('✅ Connected to MongoDB successfully');
    }
    
    // 1. Ensure brands exist
    const brands = await ensureBrands();
    
    // 2. Ensure category exists
    const category = await ensureCategory();
    
    // 3. Product data based on user's examples
    const productsData = [
      {
        modelLine: "AUX QCDI Inverter",
        brand: brands.AUX,
        category: category,
        type: "split",
        inverter: true,
        description: "High-efficiency inverter air conditioner with advanced cooling technology",
        imageUrl: "/images/products/default.png",
        variants: [
          { capacity: "1.0", btu: 9000, sellingPrice: 25500, costPrice: 20400, quantity: 15, minStockLevel: 5 },
          { capacity: "1.5", btu: 12000, sellingPrice: 25500, costPrice: 20400, quantity: 20, minStockLevel: 5 },
          { capacity: "2.0", btu: 18000, sellingPrice: 37500, costPrice: 30000, quantity: 10, minStockLevel: 3 },
          { capacity: "2.5", btu: 24000, sellingPrice: 37500, costPrice: 30000, quantity: 12, minStockLevel: 3 },
          { capacity: "3.0", btu: 30000, sellingPrice: 45500, costPrice: 36400, quantity: 8, minStockLevel: 2 }
        ],
        specifications: {
          voltage: "220-240V / 60Hz",
          features: ["Inverter Technology", "Turbo Cooling", "Auto Restart", "Sleep Mode", "Anti-corrosion"],
          installationRequirements: "Standard split type installation with outdoor unit",
          warranty: "1 Year Compressor, 1 Year Parts, 5 Years Compressor Warranty"
        }
      },
      {
        modelLine: "Condura Prima",
        brand: brands.Condura,
        category: category,
        type: "split",
        inverter: false,
        description: "Reliable non-inverter air conditioner with consistent performance",
        imageUrl: "/images/products/default.png",
        variants: [
          { capacity: "1.0", btu: 9000, sellingPrice: 25500, costPrice: 20400, quantity: 18, minStockLevel: 5 },
          { capacity: "1.5", btu: 12000, sellingPrice: 25500, costPrice: 20400, quantity: 22, minStockLevel: 5 },
          { capacity: "2.0", btu: 18000, sellingPrice: 37500, costPrice: 30000, quantity: 14, minStockLevel: 3 },
          { capacity: "2.5", btu: 24000, sellingPrice: 37500, costPrice: 30000, quantity: 15, minStockLevel: 3 },
          { capacity: "3.0", btu: 30000, sellingPrice: 45500, costPrice: 36400, quantity: 10, minStockLevel: 2 }
        ],
        specifications: {
          voltage: "220-240V / 60Hz",
          features: ["Quick Cooling", "Auto Clean", "Anti-bacterial Filter", "LED Display", "Quiet Operation"],
          installationRequirements: "Standard split type installation",
          warranty: "1 Year Compressor, 1 Year Parts"
        }
      },
      {
        modelLine: "Carrier Nexus Inverter",
        brand: brands.Carrier,
        category: category,
        type: "split",
        inverter: true,
        description: "Premium inverter air conditioner with energy-efficient performance",
        imageUrl: "/images/products/default.png",
        variants: [
          { capacity: "1.0", btu: 9000, sellingPrice: 25500, costPrice: 20400, quantity: 12, minStockLevel: 4 },
          { capacity: "1.5", btu: 12000, sellingPrice: 25500, costPrice: 20400, quantity: 16, minStockLevel: 4 },
          { capacity: "2.0", btu: 18000, sellingPrice: 37500, costPrice: 30000, quantity: 10, minStockLevel: 3 },
          { capacity: "2.5", btu: 24000, sellingPrice: 37500, costPrice: 30000, quantity: 11, minStockLevel: 3 },
          { capacity: "3.0", btu: 30000, sellingPrice: 45500, costPrice: 36400, quantity: 8, minStockLevel: 2 }
        ],
        specifications: {
          voltage: "220-240V / 60Hz",
          features: ["Inverter Technology", "Eco Mode", "Follow Me", "Auto Swing", "Smart Control"],
          installationRequirements: "Standard split type installation with smart features",
          warranty: "2 Years Compressor, 1 Year Parts"
        }
      },
      {
        modelLine: "Carrier Aura Inverter",
        brand: brands.Carrier,
        category: category,
        type: "split",
        inverter: true,
        description: "Elegant design with advanced inverter technology",
        imageUrl: "/images/products/default.png",
        variants: [
          { capacity: "1.0", btu: 9000, sellingPrice: 25500, costPrice: 20400, quantity: 14, minStockLevel: 4 },
          { capacity: "1.5", btu: 12000, sellingPrice: 25500, costPrice: 20400, quantity: 18, minStockLevel: 4 },
          { capacity: "2.0", btu: 18000, sellingPrice: 37500, costPrice: 30000, quantity: 12, minStockLevel: 3 },
          { capacity: "2.5", btu: 24000, sellingPrice: 37500, costPrice: 30000, quantity: 13, minStockLevel: 3 },
          { capacity: "3.0", btu: 30000, sellingPrice: 45500, costPrice: 36400, quantity: 9, minStockLevel: 2 }
        ],
        specifications: {
          voltage: "220-240V / 60Hz",
          features: ["Inverter Technology", "Aura Design", "Quiet Operation", "Auto Clean", "Wi-Fi Ready"],
          installationRequirements: "Standard split type installation",
          warranty: "2 Years Compressor, 1 Year Parts"
        }
      },
      {
        modelLine: "Carrier XPOWERGOLD3 Inverter",
        brand: brands.Carrier,
        category: category,
        type: "split",
        inverter: true,
        description: "Heavy-duty inverter air conditioner for maximum performance",
        imageUrl: "/images/products/default.png",
        variants: [
          { capacity: "1.0", btu: 9000, sellingPrice: 25500, costPrice: 20400, quantity: 10, minStockLevel: 3 },
          { capacity: "1.5", btu: 12000, sellingPrice: 25500, costPrice: 20400, quantity: 14, minStockLevel: 3 },
          { capacity: "2.0", btu: 18000, sellingPrice: 37500, costPrice: 30000, quantity: 8, minStockLevel: 2 },
          { capacity: "2.5", btu: 24000, sellingPrice: 37500, costPrice: 30000, quantity: 9, minStockLevel: 2 },
          { capacity: "3.0", btu: 30000, sellingPrice: 45500, costPrice: 36400, quantity: 6, minStockLevel: 2 }
        ],
        specifications: {
          voltage: "220-240V / 60Hz",
          features: ["XPower Technology", "Gold Fin", "Turbo Mode", "All Weather Operation", "Durable Design"],
          installationRequirements: "Heavy-duty installation recommended",
          warranty: "3 Years Compressor, 1 Year Parts"
        }
      },
      {
        modelLine: "TCL MEI Full DC",
        brand: brands.TCL,
        category: category,
        type: "split",
        inverter: true,
        description: "Full DC inverter technology with superior energy efficiency",
        imageUrl: "/images/products/default.png",
        variants: [
          { capacity: "1.0", btu: 9000, sellingPrice: 25500, costPrice: 20400, quantity: 16, minStockLevel: 4 },
          { capacity: "1.5", btu: 12000, sellingPrice: 25500, costPrice: 20400, quantity: 20, minStockLevel: 4 },
          { capacity: "2.0", btu: 18000, sellingPrice: 37500, costPrice: 30000, quantity: 14, minStockLevel: 3 },
          { capacity: "2.5", btu: 24000, sellingPrice: 37500, costPrice: 30000, quantity: 15, minStockLevel: 3 },
          { capacity: "3.0", btu: 30000, sellingPrice: 45500, costPrice: 36400, quantity: 11, minStockLevel: 2 }
        ],
        specifications: {
          voltage: "220-240V / 60Hz",
          features: ["Full DC Inverter", "MEI Technology", "Smart Control", "Ultra Quiet", "Energy Saving"],
          installationRequirements: "Standard split type installation",
          warranty: "2 Years Compressor, 1 Year Parts"
        }
      },
      {
        modelLine: "Midea CLEST",
        brand: brands.Midea,
        category: category,
        type: "split",
        inverter: false,
        description: "Affordable and reliable air conditioning solution",
        imageUrl: "/images/products/default.png",
        variants: [
          { capacity: "1.0", btu: 9000, sellingPrice: 25500, costPrice: 20400, quantity: 20, minStockLevel: 5 },
          { capacity: "1.5", btu: 12000, sellingPrice: 25500, costPrice: 20400, quantity: 25, minStockLevel: 5 },
          { capacity: "2.0", btu: 18000, sellingPrice: 37500, costPrice: 30000, quantity: 16, minStockLevel: 3 },
          { capacity: "2.5", btu: 24000, sellingPrice: 37500, costPrice: 30000, quantity: 18, minStockLevel: 3 },
          { capacity: "3.0", btu: 30000, sellingPrice: 45500, costPrice: 36400, quantity: 12, minStockLevel: 2 }
        ],
        specifications: {
          voltage: "220-240V / 60Hz",
          features: ["Quick Cool", "Sleep Mode", "Auto Restart", "Washable Filter", "LED Display"],
          installationRequirements: "Standard split type installation",
          warranty: "1 Year Compressor, 1 Year Parts"
        }
      }
    ];
    
    // 4. Clear existing products (optional)
    await HVACProduct.deleteMany({});
    console.log('🧹 Cleared existing HVAC products');
    
    // 5. Create products
    const createdProducts = [];
    
    for (const productData of productsData) {
      // Set variant statuses based on quantity
      productData.variants = productData.variants.map(variant => ({
        ...variant,
        status: variant.quantity > 0 ? 'in_stock' : 'out_of_stock',
        specifications: {
          refrigerantType: 'R32',
          energyRating: '5-Star',
          noiseLevel: variant.capacity === '1.0' ? '26 dB(A)' : 
                      variant.capacity === '1.5' ? '28 dB(A)' : 
                      variant.capacity === '2.0' ? '30 dB(A)' : 
                      variant.capacity === '2.5' ? '32 dB(A)' : '34 dB(A)',
          coverageArea: variant.capacity === '1.0' ? '15-20 sqm' : 
                        variant.capacity === '1.5' ? '20-25 sqm' : 
                        variant.capacity === '2.0' ? '25-30 sqm' : 
                        variant.capacity === '2.5' ? '30-35 sqm' : '35-40 sqm',
          dimensions: variant.capacity === '1.0' ? 'Indoor: 800x275x200mm, Outdoor: 700x530x240mm' : 
                       variant.capacity === '1.5' ? 'Indoor: 900x300x220mm, Outdoor: 750x550x260mm' : 
                       variant.capacity === '2.0' ? 'Indoor: 1000x320x240mm, Outdoor: 800x570x280mm' : 
                       variant.capacity === '2.5' ? 'Indoor: 1100x340x260mm, Outdoor: 850x590x300mm' : 
                       'Indoor: 1200x360x280mm, Outdoor: 900x610x320mm',
          weight: variant.capacity === '1.0' ? 'Indoor: 9kg, Outdoor: 28kg' : 
                    variant.capacity === '1.5' ? 'Indoor: 11kg, Outdoor: 32kg' : 
                    variant.capacity === '2.0' ? 'Indoor: 13kg, Outdoor: 36kg' : 
                    variant.capacity === '2.5' ? 'Indoor: 15kg, Outdoor: 40kg' : 
                    'Indoor: 17kg, Outdoor: 44kg'
        }
      }));
      
      const product = new HVACProduct(productData);
      await product.save();
      createdProducts.push(product);
      
      console.log(`✅ Created: ${product.brand.name} ${product.modelLine} with ${product.variants.length} HP variants`);
    }
    
    // 6. Summary
    console.log('\n📊 Seeding Summary:');
    console.log(`✅ Created ${createdProducts.length} HVAC products`);
    
    let totalVariants = 0;
    createdProducts.forEach(product => {
      totalVariants += product.variants.length;
      console.log(`  📦 ${product.brand.name} ${product.modelLine}: ${product.variants.length} variants (₱${product.priceRange.min.toLocaleString()} - ₱${product.priceRange.max.toLocaleString()})`);
    });
    
    console.log(`🔢 Total HP variants: ${totalVariants}`);
    
    // 7. Sample query demonstration
    console.log('\n🔍 Sample queries:');
    
    // Find products with 1.5 HP variants
    const onePointFiveHP = await HVACProduct.find({
      "variants.capacity": "1.5",
      active: true
    }).populate('brand', 'name');
    
    console.log(`📋 Products with 1.5 HP variants: ${onePointFiveHP.length}`);
    
    // Find inverter products
    const inverterProducts = await HVACProduct.find({
      inverter: true,
      active: true
    }).populate('brand', 'name');
    
    console.log(`⚡ Inverter products: ${inverterProducts.length}`);
    
    console.log('\n🎉 HVAC products seeding completed successfully!');
    
  } catch (error) {
    console.error('💥 Seeding failed:', error);
    throw error;
  } finally {
    // Don't close connection if it was already open
    if (mongoose.connection.readyState === 1) {
      // await mongoose.connection.close();
    }
  }
}

/**
 * Ensure required brands exist
 */
async function ensureBrands() {
  const brands = {};
  
  const brandNames = ['AUX', 'Condura', 'Carrier', 'TCL', 'Midea'];
  
  for (const brandName of brandNames) {
    let brand = await Brand.findOne({ name: brandName });
    
    if (!brand) {
      brand = new Brand({
        name: brandName,
        description: `${brandName} air conditioning products`,
        active: true
      });
      await brand.save();
      console.log(`✅ Created brand: ${brandName}`);
    }
    
    brands[brandName] = brand;
  }
  
  return brands;
}

/**
 * Ensure category exists
 */
async function ensureCategory() {
  let category = await Category.findOne({ name: 'Split Type Aircon' });
  
  if (!category) {
    category = new Category({
      name: 'Split Type Aircon',
      description: 'Split type air conditioning systems',
      active: true
    });
    await category.save();
    console.log('✅ Created category: Split Type Aircon');
  }
  
  return category;
}

// Export function
module.exports = { seedHVACProducts };

// Run seeding if called directly
if (require.main === module) {
  seedHVACProducts()
    .then(() => {
      console.log('✅ Seeding script completed');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 Seeding script failed:', error);
      process.exit(1);
    });
}
