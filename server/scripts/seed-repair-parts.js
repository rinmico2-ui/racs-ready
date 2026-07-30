/**
 * ══════════════════════════════════════════════════════════════════════════════
 * SEED SCRIPT: Repair Parts & Materials Catalog
 * ══════════════════════════════════════════════════════════════════════════════
 * Populates the Tool model with common repair parts for all appliance types.
 * 
 * Usage:
 *   node server/scripts/seed-repair-parts.js
 * 
 * Options:
 *   --clear    Clear existing parts before seeding
 *   --dry-run  Print parts without saving to database
 * ══════════════════════════════════════════════════════════════════════════════
 */

const mongoose = require('mongoose');
const path = require('path');

// ── Load env ────────────────────────────────────────────────────────────────
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

// ── Parts Data ──────────────────────────────────────────────────────────────
const PARTS = [
  // ══════════════════════════════════════════════════════════════════════════
  // REFRIGERATOR
  // ══════════════════════════════════════════════════════════════════════════
  { itemName: "Refrigerator Compressor", category: "Compressor", unit: "pcs", costPrice: 3500, sellingPrice: 5500, minStockLevel: 2, specification: "Universal / R134a / R600a", supplier: "HVAC Parts PH", description: "Sealed compressor unit for refrigerator cooling system" },
  { itemName: "Refrigerator Thermostat", category: "Electrical", unit: "pcs", costPrice: 350, sellingPrice: 650, minStockLevel: 5, specification: "Universal Adjustable", supplier: "HVAC Parts PH", description: "Temperature control thermostat for fridge/freezer" },
  { itemName: "Defrost Timer", category: "Electrical", unit: "pcs", costPrice: 280, sellingPrice: 500, minStockLevel: 5, specification: "Mechanical / Digital 4-8hr cycle", supplier: "HVAC Parts PH", description: "Defrost cycle timer for frost-free refrigerators" },
  { itemName: "Defrost Heater", category: "Electrical", unit: "pcs", costPrice: 450, sellingPrice: 850, minStockLevel: 3, specification: "Glass tube / Sheathed", supplier: "HVAC Parts PH", description: "Heating element for automatic defrost system" },
  { itemName: "Defrost Thermostat (Bimetal)", category: "Electrical", unit: "pcs", costPrice: 180, sellingPrice: 350, minStockLevel: 5, specification: "Auto-reset 35°C / 45°C", supplier: "HVAC Parts PH", description: "Temperature-sensitive switch for defrost cycle control" },
  { itemName: "Evaporator Fan Motor", category: "Fan Motor", unit: "pcs", costPrice: 650, sellingPrice: 1200, minStockLevel: 3, specification: "115V/230V 50/60Hz", supplier: "HVAC Parts PH", description: "Circulates cold air inside refrigerator compartment" },
  { itemName: "Condenser Fan Motor", category: "Fan Motor", unit: "pcs", costPrice: 550, sellingPrice: 1000, minStockLevel: 3, specification: "115V/230V 50/60Hz", supplier: "HVAC Parts PH", description: "Cools the condenser coils at the back/bottom of fridge" },
  { itemName: "Start Relay (PTC)", category: "Electrical", unit: "pcs", costPrice: 120, sellingPrice: 250, minStockLevel: 10, specification: "PTC Thermistor 2-pin/3-pin", supplier: "HVAC Parts PH", description: "Starting relay for compressor motor" },
  { itemName: "Overload Protector", category: "Electrical", unit: "pcs", costPrice: 150, sellingPrice: 300, minStockLevel: 10, specification: "Current/Temperature", supplier: "HVAC Parts PH", description: "Protects compressor from overheating and overcurrent" },
  { itemName: "Run Capacitor (Refrigerator)", category: "Capacitor", unit: "pcs", costPrice: 120, sellingPrice: 250, minStockLevel: 10, specification: "1-5µF 250VAC", supplier: "HVAC Parts PH", description: "Start/run capacitor for compressor motor" },
  { itemName: "Temperature Sensor (Thermistor)", category: "Electrical", unit: "pcs", costPrice: 180, sellingPrice: 380, minStockLevel: 5, specification: "NTC 10kΩ / 15kΩ", supplier: "HVAC Parts PH", description: "Digital temperature sensor for electronic control models" },
  { itemName: "Door Gasket (Refrigerator)", category: "Sealant", unit: "pcs", costPrice: 350, sellingPrice: 700, minStockLevel: 3, specification: "Universal / Model-specific", supplier: "Appliance Parts PH", description: "Magnetic door seal for refrigerator/freezer" },
  { itemName: "Water Inlet Valve (Fridge)", category: "Valve", unit: "pcs", costPrice: 450, sellingPrice: 850, minStockLevel: 3, specification: "1/2\" solenoid valve", supplier: "HVAC Parts PH", description: "Solenoid valve for ice maker/water dispenser" },
  { itemName: "Refrigerator Control Board", category: "Board", unit: "pcs", costPrice: 1200, sellingPrice: 2200, minStockLevel: 2, specification: "Model-specific", supplier: "Electronics Parts PH", description: "Main electronic control board for inverter/digital fridges" },
  { itemName: "Refrigerant R134a", category: "Refrigerant", unit: "bottles", costPrice: 450, sellingPrice: 800, minStockLevel: 5, specification: "340g can", supplier: "HVAC Parts PH", description: "HFC refrigerant for refrigerator systems" },
  { itemName: "Refrigerant R600a (Isobutane)", category: "Refrigerant", unit: "bottles", costPrice: 350, sellingPrice: 650, minStockLevel: 5, specification: "50g/60g can", supplier: "HVAC Parts PH", description: "Eco-friendly refrigerant for modern refrigerators" },
  { itemName: "Filter Drier (Refrigerator)", category: "Valve", unit: "pcs", costPrice: 120, sellingPrice: 250, minStockLevel: 10, specification: "1/4\" x 1/4\" / 3/16\"", supplier: "HVAC Parts PH", description: "Removes moisture and contaminants from refrigerant line" },
  { itemName: "Copper Tubing (Refrigerator)", category: "Copper Pipe", unit: "meters", costPrice: 80, sellingPrice: 150, minStockLevel: 20, specification: "1/4\" OD / 3/8\" OD", supplier: "Hardware Supplies PH", description: "Soft copper tubing for refrigerant lines" },

  // ══════════════════════════════════════════════════════════════════════════
  // FREEZER
  // ══════════════════════════════════════════════════════════════════════════
  { itemName: "Freezer Compressor", category: "Compressor", unit: "pcs", costPrice: 4000, sellingPrice: 6500, minStockLevel: 2, specification: "High-capacity R134a/R600a", supplier: "HVAC Parts PH", description: "Heavy-duty compressor for chest/stand-alone freezers" },
  { itemName: "Freezer Door Gasket", category: "Sealant", unit: "pcs", costPrice: 400, sellingPrice: 750, minStockLevel: 3, specification: "Universal / Model-specific", supplier: "Appliance Parts PH", description: "Magnetic door seal for freezers" },

  // ══════════════════════════════════════════════════════════════════════════
  // WASHING MACHINE
  // ══════════════════════════════════════════════════════════════════════════
  { itemName: "Water Inlet Valve (Washer)", category: "Valve", unit: "pcs", costPrice: 350, sellingPrice: 650, minStockLevel: 5, specification: "Single/Dual solenoid", supplier: "Appliance Parts PH", description: "Solenoid valve controlling water fill" },
  { itemName: "Drain Pump (Washer)", category: "General", unit: "pcs", costPrice: 800, sellingPrice: 1500, minStockLevel: 3, specification: "Universal 220V", supplier: "Appliance Parts PH", description: "Pumps out water during drain/spin cycle" },
  { itemName: "Drive Belt (Washer)", category: "General", unit: "pcs", costPrice: 150, sellingPrice: 350, minStockLevel: 10, specification: "Banded V-belt / Serpentine", supplier: "Appliance Parts PH", description: "Connects motor to drum/transmission" },
  { itemName: "Washing Machine Motor", category: "Fan Motor", unit: "pcs", costPrice: 1500, sellingPrice: 2800, minStockLevel: 2, specification: "1/2 HP 220V 50Hz", supplier: "Appliance Parts PH", description: "Main drive motor for washer" },
  { itemName: "Motor Capacitor (Washer)", category: "Capacitor", unit: "pcs", costPrice: 120, sellingPrice: 250, minStockLevel: 10, specification: "5-15µF 450VAC", supplier: "HVAC Parts PH", description: "Start/run capacitor for washer motor" },
  { itemName: "Transmission/Gearbox (Washer)", category: "General", unit: "pcs", costPrice: 2500, sellingPrice: 4500, minStockLevel: 1, specification: "Model-specific", supplier: "Appliance Parts PH", description: "Gearbox for agitator/spin basket drive" },
  { itemName: "Clutch Assembly (Washer)", category: "General", unit: "pcs", costPrice: 800, sellingPrice: 1500, minStockLevel: 2, specification: "Friction clutch", supplier: "Appliance Parts PH", description: "Engages/disengages spin cycle" },
  { itemName: "Suspension Rod (Washer)", category: "General", unit: "pcs", costPrice: 250, sellingPrice: 500, minStockLevel: 4, specification: "Set of 4", supplier: "Appliance Parts PH", description: "Supports drum and absorbs vibration" },
  { itemName: "Shock Absorber (Washer)", category: "General", unit: "pcs", costPrice: 350, sellingPrice: 650, minStockLevel: 4, specification: "Hydraulic damper", supplier: "Appliance Parts PH", description: "Dampens drum movement during spin" },
  { itemName: "Door Lock Switch (Washer)", category: "Electrical", unit: "pcs", costPrice: 280, sellingPrice: 500, minStockLevel: 5, specification: "Interlock switch", supplier: "Appliance Parts PH", description: "Safety lock preventing door opening during cycle" },
  { itemName: "Lid Switch (Top-load Washer)", category: "Electrical", unit: "pcs", costPrice: 180, sellingPrice: 350, minStockLevel: 5, specification: "Mechanical/Pressure", supplier: "Appliance Parts PH", description: "Detects lid closure for cycle operation" },
  { itemName: "Timer (Washer)", category: "Electrical", unit: "pcs", costPrice: 650, sellingPrice: 1200, minStockLevel: 2, specification: "Mechanical/Electronic", supplier: "Electronics Parts PH", description: "Cycle timer for wash/rinse/spin sequences" },
  { itemName: "Washer Control Board", category: "Board", unit: "pcs", costPrice: 1500, sellingPrice: 2800, minStockLevel: 2, specification: "Model-specific", supplier: "Electronics Parts PH", description: "Main electronic control board" },
  { itemName: "Pressure Switch (Washer)", category: "Electrical", unit: "pcs", costPrice: 250, sellingPrice: 480, minStockLevel: 5, specification: "Adjustable water level", supplier: "Appliance Parts PH", description: "Controls water fill level" },
  { itemName: "Tub Seal (Washer)", category: "Sealant", unit: "pcs", costPrice: 350, sellingPrice: 650, minStockLevel: 3, specification: "Sealed bearing type", supplier: "Appliance Parts PH", description: "Prevents water leakage around shaft" },
  { itemName: "Washer Bearings", category: "Bearing", unit: "set", costPrice: 450, sellingPrice: 850, minStockLevel: 3, specification: "Inner + Outer bearing", supplier: "Appliance Parts PH", description: "Supports drum rotation" },
  { itemName: "Agitator (Top-load Washer)", category: "General", unit: "pcs", costPrice: 600, sellingPrice: 1100, minStockLevel: 2, specification: "Model-specific", supplier: "Appliance Parts PH", description: "agitator for washing action" },

  // ══════════════════════════════════════════════════════════════════════════
  // DRYER
  // ══════════════════════════════════════════════════════════════════════════
  { itemName: "Heating Element (Dryer)", category: "General", unit: "pcs", costPrice: 650, sellingPrice: 1200, minStockLevel: 3, specification: "Coiled nichrome wire", supplier: "Appliance Parts PH", description: "Generates heat for drying" },
  { itemName: "Thermal Fuse (Dryer)", category: "Electrical", unit: "pcs", costPrice: 80, sellingPrice: 200, minStockLevel: 15, specification: "One-shot 185°F / 200°F", supplier: "Appliance Parts PH", description: "Safety fuse - cuts power if overheating" },
  { itemName: "Dryer Thermostat", category: "Electrical", unit: "pcs", costPrice: 250, sellingPrice: 480, minStockLevel: 5, specification: "High-limit / Cycling", supplier: "Appliance Parts PH", description: "Controls operating temperature" },
  { itemName: "Blower Wheel (Dryer)", category: "General", unit: "pcs", costPrice: 350, sellingPrice: 650, minStockLevel: 3, specification: "Squirrel cage type", supplier: "Appliance Parts PH", description: "Circulates hot air through drum" },
  { itemName: "Drum Belt (Dryer)", category: "General", unit: "pcs", costPrice: 150, sellingPrice: 350, minStockLevel: 10, specification: "V-belt / Ribbed", supplier: "Appliance Parts PH", description: "Turns the dryer drum" },
  { itemName: "Drum Roller (Dryer)", category: "Bearing", unit: "set", costPrice: 300, sellingPrice: 550, minStockLevel: 5, specification: "Set of 2 + axles", supplier: "Appliance Parts PH", description: "Supports drum rotation" },
  { itemName: "Idler Pulley (Dryer)", category: "Bearing", unit: "pcs", costPrice: 200, sellingPrice: 400, minStockLevel: 5, specification: "Spring-loaded", supplier: "Appliance Parts PH", description: "Tensions the drum belt" },
  { itemName: "Dryer Motor", category: "Fan Motor", unit: "pcs", costPrice: 1800, sellingPrice: 3200, minStockLevel: 1, specification: "1/4 HP 220V", supplier: "Appliance Parts PH", description: "Drives drum and blower" },
  { itemName: "Dryer Door Switch", category: "Electrical", unit: "pcs", costPrice: 180, sellingPrice: 350, minStockLevel: 5, specification: "Push-to-start / Momentary", supplier: "Appliance Parts PH", description: "Activates dryer when door closes" },
  { itemName: "Moisture Sensor (Dryer)", category: "Electrical", unit: "set", costPrice: 350, sellingPrice: 650, minStockLevel: 3, specification: "Strip sensor", supplier: "Electronics Parts PH", description: "Detects moisture level to auto-stop" },
  { itemName: "Igniter (Gas Dryer)", category: "Electrical", unit: "pcs", costPrice: 350, sellingPrice: 650, minStockLevel: 3, specification: "Hot surface igniter", supplier: "Appliance Parts PH", description: "Ignites gas burner" },
  { itemName: "Gas Valve Coils (Gas Dryer)", category: "Electrical", unit: "set", costPrice: 450, sellingPrice: 850, minStockLevel: 2, specification: "Dual coil set", supplier: "Appliance Parts PH", description: "Opens/closes gas valve" },

  // ══════════════════════════════════════════════════════════════════════════
  // MICROWAVE
  // ══════════════════════════════════════════════════════════════════════════
  { itemName: "Magnetron", category: "General", unit: "pcs", costPrice: 1200, sellingPrice: 2200, minStockLevel: 2, specification: "2M236 / 2M214", supplier: "Electronics Parts PH", description: "Generates microwave radiation" },
  { itemName: "High-Voltage Capacitor (Microwave)", category: "Capacitor", unit: "pcs", costPrice: 350, sellingPrice: 650, minStockLevel: 3, specification: "0.9-1.1µF 2100VAC", supplier: "Electronics Parts PH", description: "High-voltage capacitor for magnetron circuit" },
  { itemName: "High-Voltage Diode (Microwave)", category: "Electrical", unit: "pcs", costPrice: 120, sellingPrice: 250, minStockLevel: 10, specification: "15kV 350mA", supplier: "Electronics Parts PH", description: "Rectifier diode for high-voltage circuit" },
  { itemName: "Transformer (Microwave)", category: "General", unit: "pcs", costPrice: 800, sellingPrice: 1500, minStockLevel: 2, specification: "High-voltage 220V primary", supplier: "Electronics Parts PH", description: "Steps up voltage for magnetron" },
  { itemName: "Door Switch (Microwave)", category: "Electrical", unit: "pcs", costPrice: 80, sellingPrice: 200, minStockLevel: 10, specification: "Microswitch 3-terminal", supplier: "Electronics Parts PH", description: "Safety interlock switch (3 switches)" },
  { itemName: "Thermal Fuse (Microwave)", category: "Electrical", unit: "pcs", costPrice: 60, sellingPrice: 150, minStockLevel: 10, specification: "140°C / 160°C", supplier: "Electronics Parts PH", description: "Overheat protection" },
  { itemName: "Microwave Control Board", category: "Board", unit: "pcs", costPrice: 800, sellingPrice: 1500, minStockLevel: 2, specification: "Model-specific", supplier: "Electronics Parts PH", description: "Main control board with timer" },
  { itemName: "Touchpad/Keypad (Microwave)", category: "Board", unit: "pcs", costPrice: 350, sellingPrice: 650, minStockLevel: 3, specification: "Membrane/Metal dome", supplier: "Electronics Parts PH", description: "User input panel" },
  { itemName: "Turntable Motor", category: "Fan Motor", unit: "pcs", costPrice: 250, sellingPrice: 480, minStockLevel: 5, specification: "2-5 RPM synchronous", supplier: "Electronics Parts PH", description: "Rotates the glass turntable" },
  { itemName: "Cooling Fan Motor (Microwave)", category: "Fan Motor", unit: "pcs", costPrice: 350, sellingPrice: 650, minStockLevel: 3, specification: "Axial fan", supplier: "Electronics Parts PH", description: "Cools magnetron and electronics" },
  { itemName: "Waveguide Cover", category: "General", unit: "pcs", costPrice: 50, sellingPrice: 150, minStockLevel: 10, specification: "Mica sheet", supplier: "Electronics Parts PH", description: "Protects magnetron from food splatter" },

  // ══════════════════════════════════════════════════════════════════════════
  // ELECTRIC FAN
  // ══════════════════════════════════════════════════════════════════════════
  { itemName: "Fan Motor (Electric Fan)", category: "Fan Motor", unit: "pcs", costPrice: 450, sellingPrice: 850, minStockLevel: 5, specification: "1/4 HP 220V 50Hz", supplier: "Electronics Parts PH", description: "Shaded pole / PSC motor for electric fans" },
  { itemName: "Fan Capacitor", category: "Capacitor", unit: "pcs", costPrice: 60, sellingPrice: 150, minStockLevel: 20, specification: "1-3µF 450VAC", supplier: "HVAC Parts PH", description: "Run capacitor for fan motor" },
  { itemName: "Oscillation Gearbox", category: "General", unit: "pcs", costPrice: 150, sellingPrice: 350, minStockLevel: 5, specification: "Worm gear type", supplier: "Appliance Parts PH", description: "Makes fan oscillate left-right" },
  { itemName: "Oscillation Motor", category: "Fan Motor", unit: "pcs", costPrice: 200, sellingPrice: 400, minStockLevel: 5, specification: "Synchronous 3-5 RPM", supplier: "Electronics Parts PH", description: "Drives oscillation mechanism" },
  { itemName: "Fan Switch (Speed Selector)", category: "Electrical", unit: "pcs", costPrice: 80, sellingPrice: 200, minStockLevel: 10, specification: "3-speed / 4-speed rotary", supplier: "Electronics Parts PH", description: "Speed control switch" },
  { itemName: "Thermal Fuse (Fan)", category: "Electrical", unit: "pcs", costPrice: 40, sellingPrice: 120, minStockLevel: 20, specification: "130°C / 142°C", supplier: "Electronics Parts PH", description: "Overheat protection for motor" },
  { itemName: "Fan Blade", category: "General", unit: "pcs", costPrice: 80, sellingPrice: 200, minStockLevel: 10, specification: "16\" / 18\" / 20\"", supplier: "Appliance Parts PH", description: "Plastic/metal blade assembly" },
  { itemName: "Fan Bearings", category: "Bearing", unit: "set", costPrice: 60, sellingPrice: 150, minStockLevel: 10, specification: "Bronze bushing / Ball bearing", supplier: "Appliance Parts PH", description: "Supports motor shaft rotation" },

  // ══════════════════════════════════════════════════════════════════════════
  // RICE COOKER
  // ══════════════════════════════════════════════════════════════════════════
  { itemName: "Heating Plate (Rice Cooker)", category: "General", unit: "pcs", costPrice: 350, sellingPrice: 650, minStockLevel: 5, specification: "Round / Flat 400-700W", supplier: "Appliance Parts PH", description: "Main heating element" },
  { itemName: "Thermostat (Rice Cooker)", category: "Electrical", unit: "pcs", costPrice: 120, sellingPrice: 280, minStockLevel: 10, specification: "Magnetic 103°C", supplier: "Appliance Parts PH", description: "Auto switch from cook to warm" },
  { itemName: "Thermal Fuse (Rice Cooker)", category: "Electrical", unit: "pcs", costPrice: 40, sellingPrice: 120, minStockLevel: 20, specification: "184°C / 192°C", supplier: "Electronics Parts PH", description: "Safety cutoff if thermostat fails" },
  { itemName: "Magnetic Switch (Rice Cooker)", category: "Electrical", unit: "pcs", costPrice: 150, sellingPrice: 350, minStockLevel: 5, specification: "Center magnet type", supplier: "Appliance Parts PH", description: "Detects pot and triggers cook cycle" },
  { itemName: "Inner Pot (Rice Cooker)", category: "General", unit: "pcs", costPrice: 300, sellingPrice: 600, minStockLevel: 3, specification: "Non-stick / Aluminum", supplier: "Appliance Parts PH", description: "Cooking vessel" },
  { itemName: "Temperature Sensor (Rice Cooker)", category: "Electrical", unit: "pcs", costPrice: 120, sellingPrice: 280, minStockLevel: 5, specification: "NTC thermistor", supplier: "Electronics Parts PH", description: "Digital temperature sensing" },
  { itemName: "Rice Cooker Control Board", category: "Board", unit: "pcs", costPrice: 500, sellingPrice: 950, minStockLevel: 3, specification: "Digital Fuzzy logic", supplier: "Electronics Parts PH", description: "Electronic control for digital models" },
  { itemName: "Indicator Light (Rice Cooker)", category: "Electrical", unit: "pcs", costPrice: 20, sellingPrice: 80, minStockLevel: 20, specification: "LED / Neon", supplier: "Electronics Parts PH", description: "Cook/Warm status indicator" },

  // ══════════════════════════════════════════════════════════════════════════
  // WATER DISPENSER
  // ══════════════════════════════════════════════════════════════════════════
  { itemName: "Water Faucet/Spigot", category: "Valve", unit: "pcs", costPrice: 150, sellingPrice: 350, minStockLevel: 10, specification: "Push-type / Lever", supplier: "Appliance Parts PH", description: "Hot/cold water dispensing tap" },
  { itemName: "Water Pump (Dispenser)", category: "General", unit: "pcs", costPrice: 500, sellingPrice: 950, minStockLevel: 3, specification: "Diaphragm 220V", supplier: "Appliance Parts PH", description: "Pumps water from bottle to reservoir" },
  { itemName: "Dispenser Compressor", category: "Compressor", unit: "pcs", costPrice: 2500, sellingPrice: 4500, minStockLevel: 1, specification: "Small R134a", supplier: "HVAC Parts PH", description: "Cooling compressor for cold water" },
  { itemName: "Heating Element (Dispenser)", category: "General", unit: "pcs", costPrice: 350, sellingPrice: 650, minStockLevel: 5, specification: "500W 220V", supplier: "Appliance Parts PH", description: "Heats water for hot water function" },
  { itemName: "Dispenser Thermostat", category: "Electrical", unit: "pcs", costPrice: 200, sellingPrice: 400, minStockLevel: 5, specification: "Adjustable", supplier: "Appliance Parts PH", description: "Temperature control for hot/cold" },
  { itemName: "Float Switch (Dispenser)", category: "Electrical", unit: "pcs", costPrice: 150, sellingPrice: 350, minStockLevel: 5, specification: "Vertical mount", supplier: "Appliance Parts PH", description: "Detects water level" },
  { itemName: "Dispenser Control Board", category: "Board", unit: "pcs", costPrice: 600, sellingPrice: 1100, minStockLevel: 2, specification: "Model-specific", supplier: "Electronics Parts PH", description: "Electronic control for hot/cold/normal" },
  { itemName: "Condenser Fan (Dispenser)", category: "Fan Motor", unit: "pcs", costPrice: 400, sellingPrice: 750, minStockLevel: 3, specification: "Axial 220V", supplier: "HVAC Parts PH", description: "Cools condenser for cold water" },

  // ══════════════════════════════════════════════════════════════════════════
  // ELECTRIC KETTLE
  // ══════════════════════════════════════════════════════════════════════════
  { itemName: "Heating Element (Kettle)", category: "General", unit: "pcs", costPrice: 150, sellingPrice: 350, minStockLevel: 10, specification: "1500-2000W disc/tube", supplier: "Appliance Parts PH", description: "Immersed heating element" },
  { itemName: "Thermostat (Kettle)", category: "Electrical", unit: "pcs", costPrice: 80, sellingPrice: 200, minStockLevel: 15, specification: "Steam auto-off", supplier: "Appliance Parts PH", description: "Auto shut-off when boiling" },
  { itemName: "Thermal Fuse (Kettle)", category: "Electrical", unit: "pcs", costPrice: 30, sellingPrice: 100, minStockLevel: 20, specification: "142°C / 152°C", supplier: "Electronics Parts PH", description: "Boil-dry protection" },
  { itemName: "Power Base Connector", category: "Electrical", unit: "pcs", costPrice: 120, sellingPrice: 280, minStockLevel: 5, specification: "360° connector", supplier: "Appliance Parts PH", description: "Circular power connector for cordless kettles" },
  { itemName: "On/Off Switch (Kettle)", category: "Electrical", unit: "pcs", costPrice: 60, sellingPrice: 150, minStockLevel: 10, specification: "Rocker / Push-button", supplier: "Electronics Parts PH", description: "Manual power switch" },
  { itemName: "Temperature Controller (Kettle)", category: "Electrical", unit: "pcs", costPrice: 250, sellingPrice: 500, minStockLevel: 3, specification: "Adjustable 60-100°C", supplier: "Electronics Parts PH", description: "Variable temperature control for smart kettles" },
  { itemName: "Indicator Light (Kettle)", category: "Electrical", unit: "pcs", costPrice: 15, sellingPrice: 60, minStockLevel: 20, specification: "LED blue/red", supplier: "Electronics Parts PH", description: "Power on indicator" },

  // ══════════════════════════════════════════════════════════════════════════
  // COMMON / GENERAL PARTS
  // ══════════════════════════════════════════════════════════════════════════
  { itemName: "Refrigerant R22", category: "Refrigerant", unit: "bottles", costPrice: 800, sellingPrice: 1500, minStockLevel: 3, specification: "1kg can", supplier: "HVAC Parts PH", description: "HCFC refrigerant for older AC systems" },
  { itemName: "Refrigerant R410A", category: "Refrigerant", unit: "bottles", costPrice: 650, sellingPrice: 1200, minStockLevel: 3, specification: "1kg can", supplier: "HVAC Parts PH", description: "HFC refrigerant for split-type AC" },
  { itemName: "Refrigerant R32", category: "Refrigerant", unit: "bottles", costPrice: 550, sellingPrice: 1000, minStockLevel: 3, specification: "1kg can", supplier: "HVAC Parts PH", description: "Low-GWP refrigerant for modern AC" },
  { itemName: "Vacuum Pump Oil", category: "General", unit: "bottles", costPrice: 250, sellingPrice: 480, minStockLevel: 5, specification: "1 liter", supplier: "HVAC Parts PH", description: "Lubricant for vacuum pump" },
  { itemName: "Refrigerant Leak Sealer", category: "Sealant", unit: "tubes", costPrice: 350, sellingPrice: 650, minStockLevel: 5, specification: "UV dye + sealant", supplier: "HVAC Parts PH", description: "Seals minor refrigerant leaks" },
  { itemName: "Copper Pipe 1/4\"", category: "Copper Pipe", unit: "meters", costPrice: 60, sellingPrice: 120, minStockLevel: 30, specification: "Soft coil 1/4\" OD", supplier: "Hardware Supplies PH", description: "Copper tubing for refrigerant lines" },
  { itemName: "Copper Pipe 3/8\"", category: "Copper Pipe", unit: "meters", costPrice: 90, sellingPrice: 170, minStockLevel: 30, specification: "Soft coil 3/8\" OD", supplier: "Hardware Supplies PH", description: "Copper tubing for refrigerant lines" },
  { itemName: "Copper Pipe 1/2\"", category: "Copper Pipe", unit: "meters", costPrice: 120, sellingPrice: 220, minStockLevel: 20, specification: "Soft coil 1/2\" OD", supplier: "Hardware Supplies PH", description: "Copper tubing for refrigerant lines" },
  { itemName: "Insulation Tape", category: "Sealant", unit: "rolls", costPrice: 40, sellingPrice: 100, minStockLevel: 20, specification: "Self-fusing 1\" width", supplier: "Hardware Supplies PH", description: "Insulation for copper pipe joints" },
  { itemName: "Wire Nut Connectors", category: "Wire", unit: "rolls", costPrice: 30, sellingPrice: 80, minStockLevel: 20, specification: "Assorted sizes", supplier: "Hardware Supplies PH", description: "Wire connectors for electrical splicing" },
  { itemName: "Electrical Tape", category: "Wire", unit: "rolls", costPrice: 25, sellingPrice: 60, minStockLevel: 20, specification: "PVC 18mm x 20m", supplier: "Hardware Supplies PH", description: "Insulation tape for wiring" },
  { itemName: "Thermal Paste", category: "Sealant", unit: "tubes", costPrice: 150, sellingPrice: 350, minStockLevel: 10, specification: "Silver-based 3g", supplier: "Electronics Parts PH", description: "Heat transfer compound" },
  { itemName: "Contact Cleaner Spray", category: "General", unit: "bottles", costPrice: 250, sellingPrice: 480, minStockLevel: 5, specification: "400ml", supplier: "Electronics Parts PH", description: "Cleans electrical contacts and switches" },
  { itemName: "Flux (Soldering)", category: "General", unit: "bottles", costPrice: 80, sellingPrice: 200, minStockLevel: 10, specification: "Liquid/Rosin core", supplier: "Electronics Parts PH", description: "Soldering flux for copper pipe and electronics" },
  { itemName: "Silver Solder Rod", category: "General", unit: "sets", costPrice: 350, sellingPrice: 650, minStockLevel: 5, specification: "55% Silver", supplier: "HVAC Parts PH", description: "Brazing alloy for copper joints" },
  { itemName: "Nitrogen Gas (Regulator Set)", category: "General", unit: "sets", costPrice: 2500, sellingPrice: 4500, minStockLevel: 1, specification: "With regulator", supplier: "HVAC Parts PH", description: "For pressure testing copper lines" },
];

// ── Main Script ─────────────────────────────────────────────────────────────
async function seed() {
  const args = process.argv.slice(2);
  const clearAll = args.includes('--clear');
  const dryRun = args.includes('--dry-run');

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  REPAIR PARTS & MATERIALS SEED SCRIPT');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Parts to seed: ${PARTS.length}`);
  console.log(`  Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will write to DB)'}`);
  if (clearAll) console.log('  ⚠️  Will CLEAR all existing parts first');
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (dryRun) {
    // Print all parts grouped by category
    const byCategory = {};
    PARTS.forEach(p => {
      if (!byCategory[p.category]) byCategory[p.category] = [];
      byCategory[p.category].push(p);
    });

    Object.keys(byCategory).sort().forEach(cat => {
      console.log(`\n📂 ${cat} (${byCategory[cat].length})`);
      console.log('─'.repeat(60));
      byCategory[cat].forEach(p => {
        const margin = p.sellingPrice > 0 ? Math.round(((p.sellingPrice - p.costPrice) / p.sellingPrice) * 100) : 0;
        console.log(`  ${p.itemName}`);
        console.log(`    Spec: ${p.specification || 'N/A'}`);
        console.log(`    Price: ₱${p.costPrice.toLocaleString()} → ₱${p.sellingPrice.toLocaleString()} (${margin}% margin)`);
        console.log(`    Stock: ${p.minStockLevel} min | Unit: ${p.unit}`);
        console.log(`    Supplier: ${p.supplier || 'N/A'}`);
        if (p.description) console.log(`    ${p.description}`);
      });
    });

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log(`  Total: ${PARTS.length} parts across ${Object.keys(byCategory).length} categories`);
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

  // Clear existing if requested
  if (clearAll) {
    const result = await Tool.deleteMany({});
    console.log(`✓ Cleared ${result.deletedCount} existing parts\n`);
  }

  // Insert parts
  let created = 0;
  let skipped = 0;
  let errors = 0;

  for (const part of PARTS) {
    try {
      // Check if already exists (by name)
      const existing = await Tool.findOne({ itemName: part.itemName });
      if (existing) {
        console.log(`  ⏭️  SKIP: ${part.itemName} (already exists)`);
        skipped++;
        continue;
      }

      const tool = new Tool({
        itemName: part.itemName,
        category: part.category,
        unit: part.unit,
        quantity: part.minStockLevel * 3,
        minStockLevel: part.minStockLevel,
        costPrice: part.costPrice,
        sellingPrice: part.sellingPrice,
        specification: part.specification,
        description: part.description,
        supplier: part.supplier,
        isStockItem: true,
        active: true,
      });

      await tool.save();
      const margin = part.sellingPrice > 0 ? Math.round(((part.sellingPrice - part.costPrice) / part.sellingPrice) * 100) : 0;
      console.log(`  ✓ Created: ${part.itemName} (₱${part.sellingPrice.toLocaleString()} | ${margin}% margin)`);
      created++;
    } catch (err) {
      console.error(`  ✗ Error: ${part.itemName} — ${err.message}`);
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
