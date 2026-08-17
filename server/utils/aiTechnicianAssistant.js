/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * AI TECHNICIAN ASSISTANT
 *
 * Decision-support tool for field technicians. Provides probable causes,
 * inspection checklists, suggested tools, possible parts, repair complexity,
 * and safety reminders based on customer-reported symptoms.
 *
 * The AI does NOT perform final diagnosis. Final diagnosis remains the
 * responsibility of the technician after on-site inspection.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';

// ── Groq LLM (free fallback when Gemini quota is exceeded) ──────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ── Tavily Web Search (real-time diagnostic augmentation) ────────────────────
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const TAVILY_API_URL = 'https://api.tavily.com/search';

// ── Knowledge Base: Common Appliance Faults & Troubleshooting ────────────────
const TROUBLESHOOTING_KB = {
  aircon: {
    symptoms: {
      'not_cooling': {
        probableCauses: [
          { cause: 'Dirty air filter restricting airflow', likelihood: 'high' },
          { cause: 'Low refrigerant charge (possible leak)', likelihood: 'high' },
          { cause: 'Faulty compressor capacitor', likelihood: 'medium' },
          { cause: 'Dirty condenser coil reducing heat dissipation', likelihood: 'medium' },
          { cause: 'Malfunctioning thermostat sensor', likelihood: 'low' },
          { cause: 'Failed compressor', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Check air filter condition and cleanliness',
          'Measure refrigerant pressure with gauge manifold',
          'Test compressor capacitor with multimeter',
          'Inspect condenser coil for dirt/debris',
          'Verify thermostat calibration',
          'Check compressor amp draw',
        ],
        suggestedTools: ['Multimeter', 'Refrigerant Gauge Manifold', 'Fin Comb', 'Coil Cleaner', 'Screwdriver Set'],
        possibleParts: ['Air Filter', 'Capacitor (run/start)', 'Refrigerant R-410A/R-22', 'Condenser Coil Cleaner'],
        complexity: 'medium',
        safetyReminders: [
          'Disconnect power before opening unit panels',
          'Use caution around refrigerant — can cause frostbite',
          'Wear safety glasses when cleaning coils',
        ],
      },
      'water_leaking': {
        probableCauses: [
          { cause: 'Clogged condensate drain line', likelihood: 'high' },
          { cause: 'Cracked or displaced drain pan', likelihood: 'medium' },
          { cause: 'Improper installation angle (unit not tilted back)', likelihood: 'medium' },
          { cause: 'Frozen evaporator coil thawing excessively', likelihood: 'low' },
          { cause: 'Disconnected drain hose', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Inspect drain line for blockages',
          'Check drain pan condition and seating',
          'Verify unit installation angle (should tilt toward drain)',
          'Check for ice on evaporator coil',
          'Inspect drain hose connections',
        ],
        suggestedTools: ['Wet/Dry Vacuum', 'Drain Line Brush', 'Level Tool', 'Flashlight', 'Screwdriver Set'],
        possibleParts: ['Drain Hose', 'Drain Pan', 'PVC Elbow/Connector', 'Drain Line Cleanout Valve'],
        complexity: 'low',
        safetyReminders: [
          'Turn off unit before inspecting drain components',
          'Use caution — standing water may be contaminated',
          'Wear gloves when handling drain components',
        ],
      },
      'strange_noise': {
        probableCauses: [
          { cause: 'Loose fan blade or mounting screws', likelihood: 'high' },
          { cause: 'Worn motor bearings', likelihood: 'high' },
          { cause: 'Debris in indoor/outdoor unit', likelihood: 'medium' },
          { cause: 'Loose sheet metal panels', likelihood: 'medium' },
          { cause: 'Failing compressor (knocking sound)', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Listen to unit and identify noise source (indoor/outdoor)',
          'Check fan blade tightness and balance',
          'Inspect motor mounting and bearings',
          'Open panels and check for loose screws or debris',
          'Check compressor mounting rubbers',
        ],
        suggestedTools: ['Screwdriver Set', 'Nut Driver Set', 'Flashlight', 'Stethoscope (mechanical)'],
        possibleParts: ['Fan Blade', 'Motor Bearing Kit', 'Mounting Rubber Grommets', 'Sheet Metal Screws'],
        complexity: 'medium',
        safetyReminders: [
          'Disconnect power before opening any panels',
          'Do not touch rotating fan blades',
          'Support fan blade before loosening set screw',
        ],
      },
      'not_turning_on': {
        probableCauses: [
          { cause: 'Tripped circuit breaker or blown fuse', likelihood: 'high' },
          { cause: 'Faulty start/run capacitor', likelihood: 'high' },
          { cause: 'Broken thermostat wiring', likelihood: 'medium' },
          { cause: 'Failed control board', likelihood: 'medium' },
          { cause: 'Defective compressor (locked rotor)', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Verify power supply at outlet/breaker',
          'Test voltage at unit disconnect',
          'Check capacitor with multimeter',
          'Inspect thermostat wiring connections',
          'Test control board LED indicators',
          'Check compressor windings resistance',
        ],
        suggestedTools: ['Multimeter', 'Clamp Meter', 'Screwdriver Set', 'Voltage Tester'],
        possibleParts: ['Capacitor (run/start)', 'Fuse', 'Thermostat Wire', 'Control Board'],
        complexity: 'medium',
        safetyReminders: [
          'Verify power is OFF before touching electrical components',
          'Capacitors can hold charge even when power is off — discharge before handling',
          'Use insulated tools when working on electrical connections',
        ],
      },
      'bad_smell': {
        probableCauses: [
          { cause: 'Mold or mildew buildup on evaporator coil/filter', likelihood: 'high' },
          { cause: 'Dirty or clogged air filter', likelihood: 'high' },
          { cause: 'Stagnant water in drain pan', likelihood: 'medium' },
          { cause: 'Burning electrical component', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Remove and inspect air filter',
          'Inspect evaporator coil for mold/mildew',
          'Check drain pan for standing water or residue',
          'Smell around electrical components for burning odor',
          'Check ductwork if accessible',
        ],
        suggestedTools: ['Flashlight', 'Coil Cleaner (antimicrobial)', 'Screwdriver Set'],
        possibleParts: ['Air Filter', 'Drain Pan', 'Anti-Mold Treatment Spray'],
        complexity: 'low',
        safetyReminders: [
          'Wear mask when dealing with mold',
          'Ensure ventilation during cleaning',
          'Disconnect power before removing panels',
        ],
      },
      'ice_formation': {
        probableCauses: [
          { cause: 'Low refrigerant causing evaporator to freeze', likelihood: 'high' },
          { cause: 'Dirty air filter restricting airflow', likelihood: 'high' },
          { cause: 'Faulty blower motor not moving air', likelihood: 'medium' },
          { cause: 'Dirty evaporator coil', likelihood: 'medium' },
          { cause: 'Thermostat malfunction', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Check air filter condition',
          'Measure refrigerant pressure',
          'Test blower motor operation and airflow',
          'Inspect evaporator coil for ice buildup',
          'Verify thermostat settings and sensor',
        ],
        suggestedTools: ['Refrigerant Gauge Manifold', 'Multimeter', 'Thermometer', 'Flashlight'],
        possibleParts: ['Air Filter', 'Refrigerant R-410A/R-22', 'Blower Motor Capacitor'],
        complexity: 'medium',
        safetyReminders: [
          'Do not attempt to chip ice — let it thaw naturally',
          'Disconnect power before inspection',
          'Wear gloves — ice and refrigerant lines are extremely cold',
        ],
      },
      'weak_airflow': {
        probableCauses: [
          { cause: 'Dirty or clogged air filter', likelihood: 'high' },
          { cause: 'Dirty evaporator coil', likelihood: 'high' },
          { cause: 'Blower motor running slow (capacitor issue)', likelihood: 'medium' },
          { cause: 'Ductwork obstruction or disconnection', likelihood: 'low' },
          { cause: 'Frozen evaporator coil', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Check and replace air filter if dirty',
          'Inspect evaporator coil for dirt buildup',
          'Test blower motor capacitor',
          'Check blower wheel for dirt accumulation',
          'Inspect accessible ductwork',
        ],
        suggestedTools: ['Multimeter', 'Manometer (static pressure)', 'Flashlight', 'Screwdriver Set'],
        possibleParts: ['Air Filter', 'Blower Motor Capacitor', 'Coil Cleaner'],
        complexity: 'low',
        safetyReminders: [
          'Disconnect power before removing panels',
          'Handle filter carefully if moldy',
        ],
      },
    },
  },

  refrigerator: {
    symptoms: {
      'not_cooling': {
        probableCauses: [
          { cause: 'Dirty condenser coils reducing heat dissipation', likelihood: 'high' },
          { cause: 'Faulty evaporator fan motor not circulating cold air', likelihood: 'high' },
          { cause: 'Compressor not running or running inefficiently', likelihood: 'medium' },
          { cause: 'Low refrigerant charge', likelihood: 'medium' },
          { cause: 'Defective temperature control thermostat', likelihood: 'low' },
          { cause: 'Faulty start relay on compressor', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Clean condenser coils and check for dust buildup',
          'Listen for evaporator fan operation',
          'Check if compressor is running (vibration/sound/heat)',
          'Test thermostat continuity',
          'Measure internal temperature with thermometer',
          'Test compressor start relay by shaking (rattling = faulty)',
        ],
        suggestedTools: ['Multimeter', 'Coil Brush', 'Vacuum Cleaner', 'Thermometer'],
        possibleParts: ['Evaporator Fan Motor', 'Condenser Fan Motor', 'Thermostat', 'Start Relay', 'Compressor'],
        complexity: 'medium',
        safetyReminders: [
          'Unplug refrigerator before any internal inspection',
          'Be careful with sharp metal edges on coils',
          'Refrigerant is under pressure — do not puncture lines',
        ],
      },
      'not_freezing': {
        probableCauses: [
          { cause: 'Defrost timer malfunction causing ice buildup', likelihood: 'high' },
          { cause: 'Faulty defrost heater not melting frost', likelihood: 'high' },
          { cause: 'Broken defrost thermostat/bimetal limiting heater operation', likelihood: 'medium' },
          { cause: 'Ice buildup blocking evaporator airflow', likelihood: 'medium' },
          { cause: 'Low refrigerant', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Check for excessive ice on evaporator — manually defrost if needed',
          'Test defrost timer with multimeter',
          'Test defrost heater continuity',
          'Check defrost thermostat/bimetal',
          'Inspect evaporator fan operation after defrost',
        ],
        suggestedTools: ['Multimeter', 'Screwdriver Set', 'Hair Dryer (for thawing)', 'Thermometer'],
        possibleParts: ['Defrost Timer', 'Defrost Heater', 'Defrost Thermostat/Bimetal'],
        complexity: 'medium',
        safetyReminders: [
          'Unplug unit before inspection',
          'Use caution around defrost heater — hot surface',
          'Dry hands before touching electrical components',
          'Do not use sharp tools to chip ice — may puncture refrigerant lines',
        ],
      },
      'water_leaking': {
        probableCauses: [
          { cause: 'Clogged defrost drain tube', likelihood: 'high' },
          { cause: 'Cracked or overflowing drain pan', likelihood: 'medium' },
          { cause: 'Door gasket not sealing — condensation forming inside', likelihood: 'medium' },
          { cause: 'Ice maker water supply line leaking', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Inspect and clear defrost drain tube with warm water',
          'Check drain pan condition and position',
          'Inspect door gasket seal (paper test)',
          'Check ice maker water inlet valve if applicable',
        ],
        suggestedTools: ['Flashlight', 'Turkey Baster or Syringe (for drain flushing)', 'Screwdriver Set'],
        possibleParts: ['Drain Tube', 'Door Gasket', 'Drain Pan', 'Water Inlet Valve'],
        complexity: 'low',
        safetyReminders: [
          'Unplug refrigerator before internal inspection',
          'Clean up water to prevent slipping',
        ],
      },
    },
  },

  washing_machine: {
    symptoms: {
      'not_draining': {
        probableCauses: [
          { cause: 'Clogged drain pump impeller', likelihood: 'high' },
          { cause: 'Kinked or blocked drain hose', likelihood: 'high' },
          { cause: 'Faulty drain pump motor (burned coil)', likelihood: 'medium' },
          { cause: 'Clogged coin trap/lint filter', likelihood: 'medium' },
          { cause: 'Control board relay failure', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Check drain hose for kinks, obstructions, or improper routing',
          'Clean coin trap/lint filter (front-loading units)',
          'Test drain pump with multimeter for continuity',
          'Check for debris in pump impeller',
          'Verify drain hose height (max 90cm from floor)',
        ],
        suggestedTools: ['Pliers', 'Bucket (to catch water)', 'Multimeter', 'Screwdriver Set'],
        possibleParts: ['Drain Pump', 'Drain Hose', 'Coin Trap Filter'],
        complexity: 'low',
        safetyReminders: [
          'Unplug washer before inspection',
          'Drain water manually before removing pump',
          'Place towels around base to catch residual water',
        ],
      },
      'not_spinning': {
        probableCauses: [
          { cause: 'Worn or broken drive belt', likelihood: 'high' },
          { cause: 'Faulty lid switch/door lock', likelihood: 'high' },
          { cause: 'Broken motor coupling', likelihood: 'medium' },
          { cause: 'Worn clutch assembly (top-loading)', likelihood: 'medium' },
          { cause: 'Unbalanced load triggering safety sensor', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Check drive belt tension and condition',
          'Test lid switch/door lock with multimeter',
          'Inspect motor coupling for cracks',
          'Check clutch assembly (top-loading units)',
          'Verify load is balanced and drum spins freely by hand',
        ],
        suggestedTools: ['Multimeter', 'Socket Set', 'Screwdriver Set', 'Flashlight'],
        possibleParts: ['Drive Belt', 'Lid Switch', 'Motor Coupling', 'Clutch Assembly'],
        complexity: 'medium',
        safetyReminders: [
          'Unplug washer before working underneath',
          'Support drum when removing drive components',
          'Do not operate with lid open',
        ],
      },
      'not_washing': {
        probableCauses: [
          { cause: 'Faulty water inlet valve not filling', likelihood: 'high' },
          { cause: 'Broken agitator or wash plate', likelihood: 'medium' },
          { cause: 'Faulty motor or motor capacitor', likelihood: 'medium' },
          { cause: 'Control board failure', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Check water supply valves are fully open',
          'Test water inlet valve with multimeter',
          'Inspect agitator/wash plate for damage',
          'Test motor capacitor',
          'Check control board for error codes',
        ],
        suggestedTools: ['Multimeter', 'Screwdriver Set', 'Pliers'],
        possibleParts: ['Water Inlet Valve', 'Agitator', 'Wash Plate', 'Motor Capacitor'],
        complexity: 'medium',
        safetyReminders: [
          'Unplug before opening any panels',
          'Check for standing water before working',
        ],
      },
    },
  },

  water_heater: {
    symptoms: {
      'not_heating': {
        probableCauses: [
          { cause: 'Faulty heating element (burned out)', likelihood: 'high' },
          { cause: 'Tripped thermal cutout/thermostat', likelihood: 'high' },
          { cause: 'Broken temperature thermostat not triggering element', likelihood: 'medium' },
          { cause: 'Scale/mineral buildup on heating element', likelihood: 'medium' },
          { cause: 'Faulty control board or relay', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Check power supply and circuit breaker',
          'Test heating element continuity with multimeter',
          'Reset thermal cutout (red button on thermostat if present)',
          'Test thermostat resistance/continuity',
          'Inspect element for limescale buildup',
        ],
        suggestedTools: ['Multimeter', 'Screwdriver Set', 'Element Wrench', 'Thermometer'],
        possibleParts: ['Heating Element', 'Thermostat', 'Thermal Cutout', 'Anode Rod'],
        complexity: 'medium',
        safetyReminders: [
          'ALWAYS disconnect power before opening unit',
          'Drain tank before removing heating element',
          'Water and electricity are extremely dangerous — double-check power is OFF',
          'Hot water scalding risk — relieve pressure before opening fittings',
        ],
      },
      'leaking': {
        probableCauses: [
          { cause: 'Corroded or failing anode rod causing tank perforation', likelihood: 'high' },
          { cause: 'Loose or corroded pipe fittings', likelihood: 'high' },
          { cause: 'Faulty pressure relief valve (T&P valve) discharging', likelihood: 'medium' },
          { cause: 'Cracked tank (requires full replacement)', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Identify leak source — fittings, T&P valve, or tank itself',
          'Tighten or replace loose fittings',
          'Test T&P relief valve operation',
          'Inspect anode rod condition',
          'Check tank exterior for rust or damage',
        ],
        suggestedTools: ['Pipe Wrench', 'Teflon Tape', 'Screwdriver Set', 'Flashlight'],
        possibleParts: ['Anode Rod', 'T&P Relief Valve', 'Pipe Fittings', 'Teflon Tape'],
        complexity: 'medium',
        safetyReminders: [
          'Turn off power AND water supply before working',
          'Relieve pressure before opening any connections',
          'Scalding hot water risk — drain carefully',
          'A cracked tank cannot be repaired — advise replacement',
        ],
      },
      'low_pressure': {
        probableCauses: [
          { cause: 'Clogged inlet filter/strainer', likelihood: 'high' },
          { cause: 'Partially closed inlet valve', likelihood: 'medium' },
          { cause: 'Scale buildup inside tank reducing flow', likelihood: 'medium' },
          { cause: 'Low water supply pressure at source', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Check and clean inlet strainer',
          'Verify all water valves are fully open',
          'Flush tank to remove scale sediment',
          'Measure incoming water pressure',
        ],
        suggestedTools: ['Pressure Gauge', 'Screwdriver Set', 'Bucket'],
        possibleParts: ['Inlet Strainer', 'Pressure Reducing Valve'],
        complexity: 'low',
        safetyReminders: [
          'Turn off power before working on water connections',
          'Careful of hot water during flushing',
        ],
      },
    },
  },

  electric_fan: {
    symptoms: {
      'not_turning_on': {
        probableCauses: [
          { cause: 'Burned out motor winding', likelihood: 'high' },
          { cause: 'Faulty capacitor (for oscillating/speed control)', likelihood: 'high' },
          { cause: 'Broken speed selector switch', likelihood: 'medium' },
          { cause: 'Broken power cord or plug', likelihood: 'medium' },
          { cause: 'Faulty thermal fuse due to overheating', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Test outlet with another device to verify power',
          'Inspect power cord and plug for damage',
          'Test motor winding resistance with multimeter',
          'Test capacitor with multimeter',
          'Check speed selector switch continuity',
          'Locate and test thermal fuse if present',
        ],
        suggestedTools: ['Multimeter', 'Screwdriver Set', 'Soldering Iron (for wire repair)'],
        possibleParts: ['Motor Capacitor', 'Speed Selector Switch', 'Power Cord', 'Thermal Fuse', 'Motor Assembly'],
        complexity: 'low',
        safetyReminders: [
          'Unplug fan before disassembly',
          'Capacitor may hold charge — discharge before touching',
          'Keep fingers away from blade during testing',
        ],
      },
      'weak_airflow': {
        probableCauses: [
          { cause: 'Dust-clogged blade and grill reducing airflow', likelihood: 'high' },
          { cause: 'Worn motor bearings causing slow rotation', likelihood: 'high' },
          { cause: 'Weak or failing capacitor reducing motor torque', likelihood: 'medium' },
          { cause: 'Fan blade bent or damaged', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Clean fan blade and grill — remove dust buildup',
          'Listen for bearing noise (grinding/humming)',
          'Lubricate motor bearings if accessible',
          'Test capacitor rating',
          'Check blade for bends or cracks',
        ],
        suggestedTools: ['Screwdriver Set', 'Cleaning Brush', 'Motor Oil (light)', 'Multimeter'],
        possibleParts: ['Motor Capacitor', 'Fan Blade', 'Motor Bearing Kit'],
        complexity: 'low',
        safetyReminders: [
          'Unplug before cleaning or disassembly',
          'Allow motor to cool before lubrication',
        ],
      },
      'strange_noise': {
        probableCauses: [
          { cause: 'Loose fan blade on motor shaft', likelihood: 'high' },
          { cause: 'Worn motor bearings (grinding/whining)', likelihood: 'high' },
          { cause: 'Debris caught in grill or blade', likelihood: 'medium' },
          { cause: 'Loose oscillation mechanism', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Unplug and check blade tightness on shaft',
          'Remove grill and inspect for debris',
          'Listen to identify noise source (motor vs. blade)',
          'Check oscillation gear and pin',
          'Lubricate motor shaft bearings',
        ],
        suggestedTools: ['Screwdriver Set', 'Flashlight', 'Motor Oil', 'Pliers'],
        possibleParts: ['Fan Blade', 'Motor Bearing Kit', 'Oscillation Gear/Pin'],
        complexity: 'low',
        safetyReminders: [
          'Unplug before opening',
          'Do not run unit without blade guard',
        ],
      },
    },
  },

  microwave: {
    symptoms: {
      'not_heating': {
        probableCauses: [
          { cause: 'Faulty magnetron tube (main heating component)', likelihood: 'high' },
          { cause: 'Blown high-voltage fuse', likelihood: 'high' },
          { cause: 'Faulty high-voltage diode', likelihood: 'medium' },
          { cause: 'Failing high-voltage capacitor', likelihood: 'medium' },
          { cause: 'Door interlock switch not fully engaging', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Test door interlock switches with multimeter',
          'Check and test high-voltage fuse',
          'Test high-voltage diode for shorts',
          'Test magnetron for continuity and shorts',
          'Discharge capacitor BEFORE any testing',
        ],
        suggestedTools: ['Multimeter', 'Screwdriver Set', 'Insulated Discharge Tool', 'Safety Gloves'],
        possibleParts: ['Magnetron', 'High-Voltage Fuse', 'High-Voltage Diode', 'High-Voltage Capacitor', 'Door Interlock Switch'],
        complexity: 'high',
        safetyReminders: [
          '⚠️ HIGH VOLTAGE HAZARD — capacitor can store 2,000+ volts even unplugged',
          'ALWAYS discharge the capacitor before touching any internal components',
          'Do not operate microwave with door open or damaged door',
          'Magnetron emits radiation — do not operate with damaged magnetron',
          'Let a specialist handle HV capacitor and magnetron work if unsure',
        ],
      },
      'sparking': {
        probableCauses: [
          { cause: 'Damaged or burned waveguide cover', likelihood: 'high' },
          { cause: 'Metal object left inside microwave', likelihood: 'high' },
          { cause: 'Grease/food buildup on waveguide or walls', likelihood: 'medium' },
          { cause: 'Failing or cracked rack support', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Inspect waveguide cover for burns/holes',
          'Check interior walls and ceiling for food residue',
          'Look for any metallic debris inside',
          'Inspect turntable and rack supports',
        ],
        suggestedTools: ['Flashlight', 'Screwdriver Set'],
        possibleParts: ['Waveguide Cover', 'Turntable Ring', 'Turntable Coupler'],
        complexity: 'low',
        safetyReminders: [
          'Unplug before inspection',
          'Do not use until sparking cause is found and resolved',
          'Clean interior thoroughly before testing',
        ],
      },
      'turntable_not_working': {
        probableCauses: [
          { cause: 'Broken turntable motor', likelihood: 'high' },
          { cause: 'Cracked turntable coupler/bushing', likelihood: 'high' },
          { cause: 'Turntable ring wheels broken', likelihood: 'medium' },
          { cause: 'Food debris obstructing rotation', likelihood: 'medium' },
        ],
        inspectionChecklist: [
          'Remove turntable plate and ring — clean thoroughly',
          'Test turntable motor with multimeter',
          'Inspect coupler for cracks',
          'Check ring wheels for damage',
        ],
        suggestedTools: ['Multimeter', 'Screwdriver Set'],
        possibleParts: ['Turntable Motor', 'Turntable Coupler', 'Turntable Ring', 'Turntable Plate'],
        complexity: 'low',
        safetyReminders: [
          'Unplug before accessing turntable motor',
          'Clean interior to prevent further issues',
        ],
      },
    },
  },

  rice_cooker: {
    symptoms: {
      'not_cooking': {
        probableCauses: [
          { cause: 'Faulty thermostat (bimetal) not maintaining cooking mode', likelihood: 'high' },
          { cause: 'Burned heating plate or element', likelihood: 'high' },
          { cause: 'Damaged or dirty thermal sensor on base', likelihood: 'medium' },
          { cause: 'Faulty switch assembly', likelihood: 'medium' },
          { cause: 'Broken power cord or internal wiring', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Test power cord and check outlet',
          'Clean thermal sensor on inner pot base — remove any scale',
          'Test heating plate resistance (should be 20–80 ohms)',
          'Test thermostat/bimetal continuity',
          'Inspect and test cook switch',
        ],
        suggestedTools: ['Multimeter', 'Screwdriver Set', 'Cleaning Cloth'],
        possibleParts: ['Thermostat/Bimetal', 'Heating Plate', 'Cook Switch', 'Power Cord'],
        complexity: 'low',
        safetyReminders: [
          'Unplug before disassembly',
          'Allow unit to cool completely before working on heating plate',
          'Do not operate without inner pot — overheating risk',
        ],
      },
      'burning_rice': {
        probableCauses: [
          { cause: 'Faulty thermostat switching to warm too late', likelihood: 'high' },
          { cause: 'Sensor dirty causing inaccurate temperature reading', likelihood: 'high' },
          { cause: 'Wrong rice-to-water ratio (user error)', likelihood: 'medium' },
          { cause: 'Damaged inner pot with uneven heat distribution', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Clean thermal sensor thoroughly',
          'Test thermostat calibration — should switch at ~103°C',
          'Inspect inner pot for damage or warping',
          'Advise customer on correct rice-to-water ratio',
        ],
        suggestedTools: ['Multimeter with temperature probe', 'Screwdriver Set', 'Cleaning Cloth'],
        possibleParts: ['Thermostat', 'Inner Pot'],
        complexity: 'low',
        safetyReminders: [
          'Unplug and cool completely before inspection',
          'Handle inner pot carefully — edges may be sharp',
        ],
      },
    },
  },

  oven_toaster: {
    symptoms: {
      'not_heating': {
        probableCauses: [
          { cause: 'Burned out heating element (top or bottom)', likelihood: 'high' },
          { cause: 'Faulty thermostat not enabling elements', likelihood: 'high' },
          { cause: 'Blown thermal fuse (safety cutout)', likelihood: 'medium' },
          { cause: 'Faulty power switch or timer', likelihood: 'medium' },
          { cause: 'Broken power cord', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Test power at outlet',
          'Visually inspect heating elements for breaks or burns',
          'Test element continuity with multimeter',
          'Test thermostat continuity',
          'Locate and test thermal fuse',
          'Test timer and selector switch',
        ],
        suggestedTools: ['Multimeter', 'Screwdriver Set', 'Flashlight'],
        possibleParts: ['Heating Element (upper)', 'Heating Element (lower)', 'Thermostat', 'Thermal Fuse', 'Timer Switch'],
        complexity: 'low',
        safetyReminders: [
          'Unplug before opening — elements retain heat',
          'Allow to cool completely before testing elements',
          'Sharp edges inside — wear gloves',
        ],
      },
      'uneven_heating': {
        probableCauses: [
          { cause: 'One heating element not working (partial failure)', likelihood: 'high' },
          { cause: 'Faulty thermostat cycling unevenly', likelihood: 'medium' },
          { cause: 'Incorrect rack position or overcrowding', likelihood: 'medium' },
          { cause: 'Damaged oven walls reducing heat reflection', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Test all heating elements individually',
          'Check thermostat accuracy with oven thermometer',
          'Inspect oven cavity for damage',
          'Advise correct rack positioning to customer',
        ],
        suggestedTools: ['Multimeter', 'Oven Thermometer', 'Screwdriver Set'],
        possibleParts: ['Heating Element', 'Thermostat'],
        complexity: 'low',
        safetyReminders: [
          'Unplug and cool fully before inspection',
          'Test elements only at room temperature with multimeter — never live',
        ],
      },
    },
  },

  dryer: {
    symptoms: {
      'not_drying': {
        probableCauses: [
          { cause: 'Clogged lint trap severely restricting airflow', likelihood: 'high' },
          { cause: 'Blocked or kinked exhaust vent duct', likelihood: 'high' },
          { cause: 'Burned out heating element', likelihood: 'medium' },
          { cause: 'Faulty thermal fuse blown by overheating', likelihood: 'medium' },
          { cause: 'Malfunctioning cycling thermostat', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Clean lint trap completely',
          'Inspect and clear exhaust vent duct',
          'Test heating element continuity',
          'Test thermal fuse continuity',
          'Test cycling thermostat',
          'Measure air temperature at exhaust (should be 49–71°C)',
        ],
        suggestedTools: ['Multimeter', 'Duct Cleaning Brush', 'Thermometer', 'Screwdriver Set'],
        possibleParts: ['Heating Element', 'Thermal Fuse', 'Cycling Thermostat', 'High-Limit Thermostat'],
        complexity: 'medium',
        safetyReminders: [
          'Unplug before inspection — dryer uses 220V',
          'Lint is highly flammable — clean thoroughly',
          'Ensure exhaust duct is not obstructed before returning to service',
        ],
      },
      'not_tumbling': {
        probableCauses: [
          { cause: 'Broken drive belt', likelihood: 'high' },
          { cause: 'Worn drum bearing or support rollers', likelihood: 'high' },
          { cause: 'Faulty drive motor', likelihood: 'medium' },
          { cause: 'Broken idler pulley', likelihood: 'medium' },
        ],
        inspectionChecklist: [
          'Check drive belt condition — often snapped or worn',
          'Spin drum manually — check for resistance or grinding',
          'Inspect drum rollers for flat spots',
          'Test drive motor windings',
          'Check idler pulley for wear',
        ],
        suggestedTools: ['Multimeter', 'Screwdriver Set', 'Socket Set'],
        possibleParts: ['Drive Belt', 'Drum Roller', 'Idler Pulley', 'Drive Motor'],
        complexity: 'medium',
        safetyReminders: [
          'Unplug before working on mechanical components',
          '220V appliance — always verify power is off',
        ],
      },
    },
  },

  water_pump: {
    symptoms: {
      'no_pressure': {
        probableCauses: [
          { cause: 'Pump not primed — air lock in system', likelihood: 'high' },
          { cause: 'Clogged impeller or inlet strainer', likelihood: 'high' },
          { cause: 'Failed pressure switch not activating pump', likelihood: 'medium' },
          { cause: 'Worn impeller vanes reducing efficiency', likelihood: 'medium' },
          { cause: 'Pressure tank waterlogged (no air cushion)', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Prime the pump — fill priming port with water',
          'Check inlet strainer for blockage',
          'Test pressure switch contacts with multimeter',
          'Verify pressure tank air charge (should be 2 PSI below cut-in)',
          'Test motor capacitor',
          'Inspect impeller for damage',
        ],
        suggestedTools: ['Multimeter', 'Pressure Gauge', 'Screwdriver Set', 'Pliers', 'Pump Wrench'],
        possibleParts: ['Pressure Switch', 'Motor Capacitor', 'Impeller', 'Inlet Strainer', 'Pressure Tank Bladder'],
        complexity: 'medium',
        safetyReminders: [
          'Disconnect power before opening pump casing',
          'Relieve system pressure before disconnecting any fittings',
          'Wear eye protection when working on pressurized systems',
        ],
      },
      'not_starting': {
        probableCauses: [
          { cause: 'Faulty motor capacitor', likelihood: 'high' },
          { cause: 'Failed pressure switch', likelihood: 'high' },
          { cause: 'Seized motor bearings (locked rotor)', likelihood: 'medium' },
          { cause: 'Burned motor winding', likelihood: 'medium' },
          { cause: 'No power supply to pump', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Verify power supply at pump',
          'Test capacitor with multimeter',
          'Check pressure switch set points',
          'Attempt to spin motor manually (feel for stiffness)',
          'Test motor winding resistance',
        ],
        suggestedTools: ['Multimeter', 'Clamp Meter', 'Screwdriver Set'],
        possibleParts: ['Motor Capacitor', 'Pressure Switch', 'Motor Assembly'],
        complexity: 'medium',
        safetyReminders: [
          'Disconnect power before touching motor components',
          'Capacitor can hold dangerous charge — discharge first',
          'Pressurized water risk when opening casings',
        ],
      },
      'excessive_noise': {
        probableCauses: [
          { cause: 'Cavitation — insufficient water flow to pump inlet', likelihood: 'high' },
          { cause: 'Worn motor or pump bearings', likelihood: 'high' },
          { cause: 'Loose mounting bolts causing vibration', likelihood: 'medium' },
          { cause: 'Debris in impeller', likelihood: 'medium' },
        ],
        inspectionChecklist: [
          'Check water supply — ensure adequate flow at inlet',
          'Tighten all mounting bolts',
          'Listen for bearing noise vs. cavitation (gurgling)',
          'Open pump casing and inspect impeller for debris',
        ],
        suggestedTools: ['Screwdriver Set', 'Wrench Set', 'Flashlight'],
        possibleParts: ['Bearing Kit', 'Impeller', 'Mechanical Seal'],
        complexity: 'medium',
        safetyReminders: [
          'Disconnect power before opening pump',
          'Release pressure before loosening fittings',
        ],
      },
    },
  },

  air_purifier: {
    symptoms: {
      'not_working': {
        probableCauses: [
          { cause: 'Clogged HEPA filter severely restricting airflow (auto-shutdown)', likelihood: 'high' },
          { cause: 'Faulty fan motor', likelihood: 'medium' },
          { cause: 'Failed control board', likelihood: 'medium' },
          { cause: 'Tripped thermal protection due to overheating', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Remove and inspect HEPA filter — replace if heavily soiled',
          'Check pre-filter for blockage',
          'Test fan motor operation',
          'Check for error indicators on display',
          'Allow unit to cool before restarting (thermal protection)',
        ],
        suggestedTools: ['Screwdriver Set', 'Multimeter', 'Flashlight'],
        possibleParts: ['HEPA Filter', 'Pre-Filter', 'Fan Motor', 'Activated Carbon Filter'],
        complexity: 'low',
        safetyReminders: [
          'Unplug before opening',
          'Wear a dust mask when handling HEPA filters — contains trapped pollutants',
          'Do not reuse a severely clogged HEPA filter',
        ],
      },
      'bad_smell_from_unit': {
        probableCauses: [
          { cause: 'Saturated activated carbon filter releasing absorbed odors', likelihood: 'high' },
          { cause: 'Mold growing on damp HEPA filter', likelihood: 'high' },
          { cause: 'Ozone plate or ionizer needs cleaning', likelihood: 'medium' },
          { cause: 'Burning electrical component', likelihood: 'low' },
        ],
        inspectionChecklist: [
          'Remove all filters and inspect for mold or discoloration',
          'Replace activated carbon filter',
          'Clean ionizer plates with dry cloth if applicable',
          'Inspect interior for burning smell — check motor and board',
        ],
        suggestedTools: ['Screwdriver Set', 'Dry Cloth', 'Cleaning Brush'],
        possibleParts: ['HEPA Filter', 'Activated Carbon Filter', 'Ionizer/Ozone Plate'],
        complexity: 'low',
        safetyReminders: [
          'Unplug before filter access',
          'Mask and gloves when handling dirty filters',
        ],
      },
    },
  },
};

// ── Priority Classification ──────────────────────────────────────────────────
const PRIORITY_KEYWORDS = {
  critical: ['burning', 'smoke', 'fire', 'electrical', 'spark', 'gas leak', 'flooding', 'no power', 'completely dead', 'emergency', 'urgent', 'hindi gumagana', 'nasira na', 'sira na', 'sunog', 'umuusok', 'kumukuryente', 'nagkukuryente', 'nag-aapoy', 'baha', 'nagbabaha', 'delikado', 'panganib', 'kuryente', 'nasusunog', 'nagse-short'],
  high: ['not working', 'not cooling', 'not turning on', 'no cold', 'hindi lumalamig', 'mainit', 'broken', 'leaking', 'tumutulo', 'noise', 'ingay', 'grinding', 'hissing', 'patay', 'hindi umaandar', 'nagtutubig', 'lumalabas ang tubig', 'umuulan sa loob', 'hindi umaabot ang lamig', 'sira', 'nasira', 'nag-iingay', 'umuugong', 'nagbabago ang tunog', 'hindi nagpapainit', 'hindi nagpapasok ng tubig', 'hindi gumagana', 'hindi umiikot'],
  medium: ['slow', 'weak', 'intermittent', 'sometimes', 'paminsan-minsan', 'unusual', 'kakaiba', 'smell', 'amoy', 'vibration', 'pagalog', 'matagal mag-start', 'nag-ooff', 'nag-re restart', 'nag-iice', 'nag-yeyelo', 'mahina ang hanging', 'hindi umiikot', 'hindi nagd-drain', 'hindi nag-spinspin', 'error code', 'tumatulo', 'maingay', 'hindi mabilis', 'mahina ang apoy', 'hindi maayos ang pagluluto'],
  low: ['maintenance', 'checkup', 'cleaning', 'pangangalaga', 'minor', 'adjustment', 'calibration', 'inspection', 'tipid sa kuryente', 'high bill', 'paayos', 'pa-check', 'pa-ayos', 'linis', 'lilinisin', 'palinis', 'regular check', 'annual service'],
};

function classifyPriority(problemDescription, unitType) {
  const lower = (problemDescription || '').toLowerCase();
  const scores = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const [priority, keywords] of Object.entries(PRIORITY_KEYWORDS)) {
    for (const keyword of keywords) {
      if (lower.includes(keyword)) scores[priority] += 1;
    }
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (sorted[0][1] > 0) return sorted[0][0];
  return 'medium';
}

function getSLATargets(priority) {
  const targets = {
    critical: { responseHours: 2, resolutionHours: 24, escalationHours: 4 },
    high: { responseHours: 4, resolutionHours: 48, escalationHours: 8 },
    medium: { responseHours: 8, resolutionHours: 72, escalationHours: 24 },
    low: { responseHours: 24, resolutionHours: 168, escalationHours: 48 },
  };
  return targets[priority] || targets.medium;
}

// ── Tavily Web Search: Real-Time Diagnostic Augmentation ─────────────────────
/**
 * Searches the web for real-time diagnostic data to augment AI recommendations.
 * Returns structured context that gets injected into the Gemini prompt.
 *
 * @param {Object} unitInfo - { unitType, brand, model, problemDescription }
 * @returns {Object} - { webContext: string, sources: string[], searchUsed: boolean }
 */
async function tavilyDiagnosticSearch(unitInfo) {
  const defaultResult = { webContext: '', sources: [], searchUsed: false };

  if (!TAVILY_API_KEY) {
    console.warn('[Tavily] No API key configured — skipping web research');
    return defaultResult;
  }

  const { unitType, brand, model, problemDescription } = unitInfo;

  // Build targeted search queries
  const queries = [];

  // Primary: brand + symptom troubleshooting
  if (brand && unitType && problemDescription) {
    const symptomClean = problemDescription.replace(/[^\w\s]/g, '').split(' ').slice(0, 6).join(' ');
    queries.push(`${brand} ${unitType} ${symptomClean} troubleshooting repair`);
  }

  // Secondary: brand-specific known issues
  if (brand && unitType) {
    queries.push(`${brand} ${unitType} common problems error codes Philippines`);
  }

  // Tertiary: parts and pricing
  if (unitType && brand) {
    queries.push(`${brand} ${unitType} replacement parts price Philippines ${new Date().getFullYear()}`);
  }

  if (queries.length === 0) {
    // Fallback generic query
    queries.push(`${unitType || 'appliance'} ${problemDescription || 'repair'} troubleshooting`);
  }

  try {
    const allResults = [];
    const allSources = [];

    // Execute searches in parallel (max 3)
    const searchPromises = queries.slice(0, 3).map(async (query) => {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(TAVILY_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: TAVILY_API_KEY,
            query,
            search_depth: 'advanced',
            max_results: 4,
            include_answer: true,
            include_raw_content: false,
          }),
          signal: controller.signal,
        }).finally(() => clearTimeout(timeout));

        if (!response.ok) {
          console.warn(`[Tavily] Search failed for query: ${query} (${response.status})`);
          return null;
        }

        const data = await response.json();
        return data;
      } catch (err) {
        console.warn(`[Tavily] Search error for query: ${query}`, err.message);
        return null;
      }
    });

    const results = await Promise.all(searchPromises);

    for (const data of results) {
      if (!data) continue;

      // Collect answer snippet
      if (data.answer) {
        allResults.push(data.answer);
      }

      // Collect top results
      if (data.results && Array.isArray(data.results)) {
        for (const item of data.results) {
          if (item.content) {
            allResults.push(item.content);
          }
          if (item.url) {
            allSources.push(item.url);
          }
        }
      }
    }

    if (allResults.length === 0) return defaultResult;

    // Deduplicate sources
    const uniqueSources = [...new Set(allSources)].slice(0, 5);

    // Build context string (truncate to avoid prompt bloat)
    const webContext = allResults
      .join('\n\n')
      .replace(/\s+/g, ' ')
      .slice(0, 2000);

    return {
      webContext: `\n\n## WEB RESEARCH (real-time diagnostic data)\nThe following information was gathered from the web to supplement your analysis. Use it to provide more accurate, up-to-date recommendations:\n\n${webContext}`,
      sources: uniqueSources,
      searchUsed: true,
    };
  } catch (error) {
    console.error('[Tavily] Unexpected error:', error.message);
    return defaultResult;
  }
}

/**
 * Tavily search specifically for inspection refinement — looks up real-time
 * data for specific readings (e.g., refrigerant pressure ranges, capacitor specs).
 */
async function tavilyInspectionSearch(unitInfo, inspectionData) {
  const defaultResult = { webContext: '', sources: [], searchUsed: false };

  if (!TAVILY_API_KEY) return defaultResult;

  const { unitType, brand, model } = unitInfo;
  const queries = [];

  // Search for specification data based on inspection readings
  if (inspectionData.refrigerantPressure) {
    queries.push(`${brand || ''} ${unitType || ''} normal refrigerant pressure R410A R22 specifications`);
  }
  if (inspectionData.capacitorReading) {
    queries.push(`${brand || ''} ${unitType || ''} capacitor specifications microfarad range`);
  }
  if (inspectionData.ampDraw) {
    queries.push(`${brand || ''} ${unitType || ''} compressor amp draw normal range specifications`);
  }

  if (queries.length === 0) return defaultResult;

  try {
    const allResults = [];
    const allSources = [];

    const searchPromises = queries.slice(0, 2).map(async (query) => {
      try {
        const response = await fetch(TAVILY_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: TAVILY_API_KEY,
            query,
            search_depth: 'basic',
            max_results: 2,
            include_answer: true,
          }),
        });
        if (!response.ok) return null;
        return await response.json();
      } catch { return null; }
    });

    const results = await Promise.all(searchPromises);
    for (const data of results) {
      if (!data) continue;
      if (data.answer) allResults.push(data.answer);
      if (data.results) {
        for (const item of data.results) {
          if (item.content) allResults.push(item.content);
          if (item.url) allSources.push(item.url);
        }
      }
    }

    if (allResults.length === 0) return defaultResult;

    const webContext = allResults.join('\n ').replace(/\s+/g, ' ').slice(0, 1500);
    return {
      webContext: `\n\n## WEB RESEARCH (specification data)\n${webContext}`,
      sources: [...new Set(allSources)].slice(0, 5),
      searchUsed: true,
    };
  } catch (error) {
    console.error('[Tavily] Inspection search error:', error.message);
    return defaultResult;
  }
}

/**
 * Tavily search for parts pricing — used by quotation generation and project planning.
 * @param {Array<string>} partNames - List of part names to search
 * @param {string} brand - Optional brand for more accurate pricing
 * @returns {Object} - { pricingData: string, sources: string[], searchUsed: boolean }
 */
async function tavilyPartsPricingSearch(partNames, brand = '') {
  const defaultResult = { pricingData: '', sources: [], searchUsed: false };

  if (!TAVILY_API_KEY || !partNames || partNames.length === 0) return defaultResult;

  try {
    // Search for top 3 parts (avoid excessive API calls)
    const partsToSearch = partNames.slice(0, 3);
    const allResults = [];
    const allSources = [];

    const queries = partsToSearch.map(part => {
      const partClean = (typeof part === 'string' ? part : part.name || '').replace(/[^\w\s]/g, '');
      return `${brand ? brand + ' ' : ''}${partClean} price Philippines 2024 2025 buy`;
    });

    const searchPromises = queries.map(async (query) => {
      try {
        const response = await fetch(TAVILY_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: TAVILY_API_KEY,
            query,
            search_depth: 'basic',
            max_results: 2,
            include_answer: true,
          }),
        });
        if (!response.ok) return null;
        return await response.json();
      } catch { return null; }
    });

    const results = await Promise.all(searchPromises);
    for (const data of results) {
      if (!data) continue;
      if (data.answer) allResults.push(data.answer);
      if (data.results) {
        for (const item of data.results) {
          if (item.content) allResults.push(item.content);
          if (item.url) allSources.push(item.url);
        }
      }
    }

    if (allResults.length === 0) return defaultResult;

    const pricingData = allResults.join('\n ').replace(/\s+/g, ' ').slice(0, 1500);
    return {
      pricingData: `\n\n## WEB RESEARCH (current parts pricing in Philippines)\n${pricingData}`,
      sources: [...new Set(allSources)].slice(0, 5),
      searchUsed: true,
    };
  } catch (error) {
    console.error('[Tavily] Parts pricing search error:', error.message);
    return defaultResult;
  }
}

/**
 * Tavily search for project resource planning — tools, equipment, best practices.
 * @param {Object} projectInfo - { projectType, totalUnits, serviceName, description }
 * @returns {Object} - { webContext: string, sources: string[], searchUsed: boolean }
 */
async function tavilyProjectResourceSearch(projectInfo) {
  const defaultResult = { webContext: '', sources: [], searchUsed: false };

  if (!TAVILY_API_KEY) return defaultResult;

  const { serviceName, totalUnits, description } = projectInfo;

  try {
    const allResults = [];
    const allSources = [];

    const queries = [];

    // Search for best tools/equipment for this type of project
    if (serviceName) {
      queries.push(`${serviceName} tools equipment needed professional HVAC Philippines`);
    }

    // Search for parts/consumables at scale
    if (serviceName && totalUnits) {
      queries.push(`${serviceName} ${totalUnits} units bulk parts supplies price Philippines`);
    }

    // Search for project best practices
    if (description || serviceName) {
      queries.push(`${serviceName || description} best practices commercial project maintenance checklist`);
    }

    if (queries.length === 0) return defaultResult;

    const searchPromises = queries.slice(0, 3).map(async (query) => {
      try {
        const response = await fetch(TAVILY_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: TAVILY_API_KEY,
            query,
            search_depth: 'basic',
            max_results: 2,
            include_answer: true,
          }),
        });
        if (!response.ok) return null;
        return await response.json();
      } catch { return null; }
    });

    const results = await Promise.all(searchPromises);
    for (const data of results) {
      if (!data) continue;
      if (data.answer) allResults.push(data.answer);
      if (data.results) {
        for (const item of data.results) {
          if (item.content) allResults.push(item.content);
          if (item.url) allSources.push(item.url);
        }
      }
    }

    if (allResults.length === 0) return defaultResult;

    const webContext = allResults.join('\n ').replace(/\s+/g, ' ').slice(0, 2000);
    return {
      webContext: `\n\n## WEB RESEARCH (project resource planning)\nThe following real-time data was gathered to help plan resources for this project:\n\n${webContext}`,
      sources: [...new Set(allSources)].slice(0, 5),
      searchUsed: true,
    };
  } catch (error) {
    console.error('[Tavily] Project resource search error:', error.message);
    return defaultResult;
  }
}

/**
 * Tavily search for maintenance best practices.
 * @param {Object} unitInfo - { unitType, brand, problem }
 * @returns {Object} - { webContext: string, searchUsed: boolean }
 */
async function tavilyMaintenanceSearch(unitInfo) {
  const defaultResult = { webContext: '', searchUsed: false };

  if (!TAVILY_API_KEY) return defaultResult;

  const { unitType, brand, problem } = unitInfo;

  try {
    const query = `${brand || ''} ${unitType || ''} preventive maintenance tips schedule best practices`;
    const response = await fetch(TAVILY_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: 3,
        include_answer: true,
      }),
    });

    if (!response.ok) return defaultResult;

    const data = await response.json();
    const allResults = [];
    if (data.answer) allResults.push(data.answer);
    if (data.results) {
      for (const item of data.results) {
        if (item.content) allResults.push(item.content);
      }
    }

    if (allResults.length === 0) return defaultResult;

    const webContext = allResults.join('\n ').replace(/\s+/g, ' ').slice(0, 1500);
    return {
      webContext: `\n\n## WEB RESEARCH (maintenance best practices)\n${webContext}`,
      searchUsed: true,
    };
  } catch (error) {
    console.error('[Tavily] Maintenance search error:', error.message);
    return defaultResult;
  }
}

// ── AI Prompt Builder ────────────────────────────────────────────────────────
function buildAssistantPrompt(unitInfo, serviceHistory, webResearchContext = '') {
  const { unitType, brand, model, problemDescription, photos } = unitInfo;

  const photoNote = photos?.length
    ? `\nThe customer has uploaded ${photos.length} photo(s) for reference.`
    : '';

  const historyNote = serviceHistory?.length
    ? `\n\nService History:\n${serviceHistory.map(h => `- ${h.date}: ${h.description} (${h.technician || 'Unknown'})`).join('\n')}`
    : '';

  // Brand-specific guidance notes
  const brandNotes = {
    'carrier': 'Carrier units often use R-410A refrigerant. Check for inverter models which have variable-speed compressors. Common issues: control board errors, drain blockages on Xpower series.',
    'daikin': 'Daikin inverter units display error codes on the indoor unit display. Consult Daikin error code chart. R-32 refrigerant is common on newer models. Common issues: thermistor failures, PCB faults.',
    'panasonic': 'Panasonic Econavi models have multiple sensors — check sensor readings first. ECONAVI and INVERTER modes may mask issues. R-410A common.',
    'lg': 'LG inverter compressors use BLDC technology — test with LG service tool if available. Common issues: inverter PCB failure, drain pump issues on dual-cool series.',
    'samsung': 'Samsung Wind-Free models require careful airflow panel inspection. Common issues: Wi-Fi board faults, digital inverter compressor errors (E1, E2 codes).',
    'fujitsu': 'Fujitsu units are known for reliability. Self-diagnosis via LED blink codes on indoor unit. Check both indoor and outdoor error codes.',
    'kolin': 'Kolin is a Philippine brand — spare parts available locally. Standard rotary compressors on most models. Common issues: capacitor failure, drain clogs.',
    'condura': 'Condura is a Philippine brand (subsidiary of Concepcion). Parts availability is good locally. Common issues: capacitor failure, fan motor wear.',
    'whirlpool': 'Whirlpool appliances — check model-specific error codes. Common refrigerator issues: defrost system failure. Washing machine: lid switch, water inlet valve.',
    'haier': 'Haier units are budget-friendly — check for counterfeit or substandard replacement parts. Common issues: PCB failures, drain pump clogs.',
    'electrolux': 'Electrolux units often have diagnostic modes. Refrigerators: common defrost issues. Washing machines: door lock problems, drain pump failures.',
    'sharp': 'Sharp Plasmacluster units — check plasma ion generator if smell persists after cleaning. Common A/C issues: thermistor failure, capacitor problems.',
    'tcl': 'TCL is a newer brand in PH — OEM parts may be harder to source. Check local distributor. Common issues: PCB faults, fan motor noise.',
    'midea': 'Midea is a common budget brand in PH. Reliable but check quality of replacement parts. Common issues: capacitor failure, drain blockages.',
  };

  const brandLower = (brand || '').toLowerCase();
  let brandGuidance = '';
  for (const [b, note] of Object.entries(brandNotes)) {
    if (brandLower.includes(b)) {
      brandGuidance = `\n\n## BRAND-SPECIFIC NOTES (${brand})\n${note}`;
      break;
    }
  }

  return `You are an expert AI Technician Assistant for **RACS (Repair and Appliance Care Services)**, a professional home appliance and HVAC repair company operating in the Philippines. Your role is to help field technicians prepare for on-site inspection by providing intelligent, accurate preliminary analysis based on customer-reported symptoms.

LANGUAGE: The customer complaint may be in English, Tagalog/Filipino, or Taglish (mixed). You MUST understand appliance terminology, spelling variations, and conversational descriptions in all three forms. Preserve standard English technical component names when they are clearer. If the complaint is Filipino or Taglish, write ALL user-facing descriptive fields (summary, probable-cause explanations, checklist actions, parts purposes, safety reminders, preventive-maintenance advice, and additionalNotes) in clear Filipino/Taglish matching the input style. If the complaint is English, respond in English. Never reject or weaken an analysis merely because the input is Filipino or mixed-language.

IMPORTANT: You are providing decision-support recommendations, NOT a final diagnosis. The technician performs the final diagnosis on-site.

## RACS SUPPORTED APPLIANCES
Air Conditioner (Window-Type, Split-Type, Inverter, Portable) | Refrigerator/Freezer | Washing Machine (Top-Load, Front-Load) | Dryer | Water Heater (Electric, Storage Tank) | Microwave Oven | Rice Cooker | Oven Toaster / Electric Oven | Electric Fan (Stand Fan, Desk Fan, Ceiling Fan, Exhaust Fan) | Water Pump / Pressure Pump | Air Purifier / Dehumidifier | Dishwasher

## APPLIANCE INFORMATION
- **Unit Type:** ${unitType || 'Unknown'}
- **Brand:** ${brand || 'Unknown'}
- **Model:** ${model || 'Not specified'}
- **Customer Complaint:** ${problemDescription || 'No description provided'}
${photoNote}${historyNote}${brandGuidance}

## COMMON TAGALOG/ENGLISH APPLIANCE TERMS:
- "hindi gumagana" / "hindi umaandar" / "patay" = not working / not turning on
- "hindi lumalamig" / "mainit" = not cooling / running hot
- "tumutulo" / "nagtutubig" / "lumalabas ang tubig" = leaking water
- "umuulan sa loob" = water dripping inside (leaking)
- "may amoy" / "bumabaho" / "nangangamoy" = has smell / bad odor
- "maingay" / "nag-iingay" / "umuugong" = noisy / making noise / humming
- "nag-iice" / "nag-yeyelo" / "nag-i-freeze" = forming ice / freezing up
- "mahina ang hanging" / "mahina ang ihip" = weak airflow / weak air
- "hindi umaikot" / "hindi umiikot" = not spinning / not rotating
- "hindi nagd-drain" / "hindi nag-e-empty" = not draining
- "hindi nag-spinspin" = not spinning (washer)
- "matagal mag-start" = slow to start
- "nag-ooff" / "nag-re-restart" = keeps turning off / restarting
- "error code" / "may error" = showing error code
- "hindi nagpapainit" / "hindi nag-iinit" = not heating up
- "sunog ang amoy" / "nasusunog" = burning smell
- "umuusok" = smoking
- "kumukuryente" / "nagkukuryente" / "kuryente" = electrical shock / electric discharge
- "sira" / "nasira" = broken / damaged
- "hindi nagtatanggal ng tubig" = not removing water (washing machine)
- "hindi nagluluto ng maayos" = not cooking properly (rice cooker / oven)

## PARTS COST GUIDANCE (Philippine Market)
Provide realistic PHP cost estimates based on common part prices in the Philippines:
- Capacitors (A/C run/start): ₱200–800
- A/C Refrigerant R-410A (per kg): ₱800–1,500
- A/C Fan Motor: ₱800–2,500
- A/C Compressor: ₱4,000–15,000
- Refrigerator Start Relay: ₱200–500
- Refrigerator Evaporator Fan Motor: ₱500–1,500
- Refrigerator Defrost Heater: ₱300–800
- Washing Machine Drain Pump: ₱400–1,200
- Washing Machine Drive Belt: ₱150–400
- Washing Machine Lid Switch: ₱200–600
- Water Heater Heating Element: ₱300–800
- Water Pump Capacitor: ₱150–500
- Fan Motor (electric fan): ₱200–700
- Microwave Magnetron: ₱800–2,500
- Oven Heating Element: ₱300–700
- Rice Cooker Thermostat: ₱100–350

## OUTPUT REQUIREMENTS

Return ONLY a valid JSON object (no markdown, no code blocks) with this structure:

{
  "technicianAssistant": {
    "summary": "Brief overview of the likely issue using the language style required above",

    "probableCauses": [
      {
        "cause": "Clear description of the probable cause",
        "likelihood": "high|medium|low",
        "explanation": "Why this is a probable cause based on the reported symptoms"
      }
    ],

    "inspectionChecklist": [
      {
        "step": 1,
        "action": "Specific, actionable inspection step",
        "whatToLookFor": "What the technician should observe or measure",
        "expectedTool": "Tool needed for this step"
      }
    ],

    "suggestedTools": [
      {
        "name": "Tool name",
        "purpose": "Specific reason this tool is needed for this job"
      }
    ],

    "possibleParts": [
      {
        "name": "Part name (be specific to the unit type and brand if known)",
        "estimatedCostPHP": 500,
        "purpose": "Why this part may need replacement",
        "likelihood": "high|medium|low"
      }
    ],

    "repairComplexity": "low|medium|high|specialist_required",

    "repairApproach": "immediate|scheduled",

    "estimatedDurationMinutes": 60,

    "safetyReminders": [
      "Specific safety instruction for this appliance and symptom using the required language style"
    ],

    "additionalNotes": "Any additional preparation tips, brand-specific observations, or customer advisory using the required language style",

    "preventiveMaintenance": [
      "Specific maintenance recommendation to prevent this issue from recurring"
    ]
  }
}

RULES:
- Be SPECIFIC to the unit type, brand, and model when provided
- List probable causes in descending order of likelihood (highest first)
- Inspection checklist must be sequential — each step logically follows the last
- Tools must directly match the inspection steps listed
- Parts must be realistic for the appliance type and symptom described
- All costs in Philippine Pesos (PHP) — use realistic local market prices
- Safety reminders must be specific to this appliance type — not generic
- repairApproach: "immediate" if parts are commonly in stock and repair is straightforward; "scheduled" if specialist parts or skills needed
- Include at least 3 preventive maintenance recommendations
- If the complaint is in Tagalog/Taglish, still return properly structured JSON and keep every required JSON key in English
- Do NOT wrap response in markdown code blocks — return raw JSON only
${webResearchContext}`;
}

// ── Gemini API Call ──────────────────────────────────────────────────────────
async function callGeminiAPI(prompt) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const response = await fetch(`${GEMINI_API_URL}?key=${GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 3000,
        responseMimeType: 'application/json',
      },
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini API');

  return JSON.parse(text);
}

/**
 * Call Groq API (free LLM fallback when Gemini quota is exceeded).
 * Uses llama-3.3-70b-versatile via OpenAI-compatible endpoint.
 */
async function callGroqAPI(prompt) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('Empty response from Groq API');

  return JSON.parse(text);
}

// ── Fallback: Local Knowledge Base ───────────────────────────────────────────
function fallbackAssistant(unitInfo) {
  const { unitType, problemDescription } = unitInfo;
  const lower = (problemDescription || '').toLowerCase();
  const unitLower = (unitType || '').toLowerCase();

  // Determine appliance category from unit type
  let category = 'aircon';
  if (unitLower.includes('refrigerator') || unitLower.includes('fridge') || unitLower.includes('ref')) {
    category = 'refrigerator';
  } else if (unitLower.includes('washing') || unitLower.includes('washer') || unitLower.includes('laundry')) {
    category = 'washing_machine';
  } else if (unitLower.includes('water heater') || unitLower.includes('heater') || unitLower.includes('thermos')) {
    category = 'water_heater';
  } else if (unitLower.includes('electric fan') || unitLower.includes('fan') || unitLower.includes('stand fan') || unitLower.includes('desk fan') || unitLower.includes('ceiling fan')) {
    category = 'electric_fan';
  } else if (unitLower.includes('microwave') || unitLower.includes('microwave oven')) {
    category = 'microwave';
  } else if (unitLower.includes('rice cooker') || unitLower.includes('rice') || unitLower.includes('kaldero') || unitLower.includes('cooker')) {
    category = 'rice_cooker';
  } else if (unitLower.includes('oven') || unitLower.includes('toaster') || unitLower.includes('oven toaster')) {
    category = 'oven_toaster';
  } else if (unitLower.includes('dryer') || unitLower.includes('clothes dryer')) {
    category = 'dryer';
  } else if (unitLower.includes('pump') || unitLower.includes('water pump') || unitLower.includes('pressure pump')) {
    category = 'water_pump';
  } else if (unitLower.includes('air purifier') || unitLower.includes('purifier') || unitLower.includes('dehumidifier') || unitLower.includes('humidifier')) {
    category = 'air_purifier';
  }

  const symptoms = TROUBLESHOOTING_KB[category]?.symptoms || {};

  // Tagalog to English symptom mapping for fallback matching
  const tagalogSymptomMap = {
    'hindi lumalamig': 'not_cooling',
    'hindi nagco-cold': 'not_cooling',
    'mainit': 'not_cooling',
    'hindi umaabot ang lamig': 'not_cooling',
    'tumutulo': 'water_leaking',
    'nagtutubig': 'water_leaking',
    'lumalabas ang tubig': 'water_leaking',
    'umuulan sa loob': 'water_leaking',
    'nag-leleak': 'water_leaking',
    'maingay': 'strange_noise',
    'nag-iingay': 'strange_noise',
    'umuugong': 'strange_noise',
    'ingay': 'strange_noise',
    'nag-iice': 'ice_formation',
    'nag-yeyelo': 'ice_formation',
    'nag-i-freeze': 'ice_formation',
    'hindi gumagana': 'not_turning_on',
    'hindi umaandar': 'not_turning_on',
    'patay': 'not_turning_on',
    'sira': 'not_turning_on',
    'nasira': 'not_turning_on',
    'hindi nag-on': 'not_turning_on',
    'hindi nagpe-press': 'not_turning_on',
    'may amoy': 'bad_smell',
    'bumabaho': 'bad_smell',
    'nangangamoy': 'bad_smell',
    'amoy sunog': 'bad_smell',
    'mahina ang hanging': 'weak_airflow',
    'mahina ang ihip': 'weak_airflow',
    'hindi umaikot': 'not_spinning',
    'hindi umiikot': 'not_spinning',
    'hindi nagd-drain': 'not_draining',
    'hindi nag-e-empty': 'not_draining',
    'hindi nagpapainit': 'not_heating',
    'hindi nag-iinit': 'not_heating',
    'hindi nagluluto': 'not_cooking',
    'hindi naglaluto': 'not_cooking',
    'nasusunog': 'burning_rice',
    'sinusunog ang luto': 'burning_rice',
    'mababa ang pressure': 'no_pressure',
    'walang pressure': 'no_pressure',
    'hindi nag-iikot': 'not_tumbling',
  };

  // Try Tagalog mapping first
  let bestMatch = null;
  let bestScore = 0;

  for (const [tagalog, symptomKey] of Object.entries(tagalogSymptomMap)) {
    if (lower.includes(tagalog) && symptoms[symptomKey]) {
      bestMatch = { key: symptomKey, data: symptoms[symptomKey] };
      bestScore = 10;
      break;
    }
  }

  // If no Tagalog match, try English keyword matching
  if (!bestMatch) {
    for (const [key, data] of Object.entries(symptoms)) {
      const keywords = key.replace(/_/g, ' ').split(' ');
      let score = 0;
      for (const kw of keywords) {
        if (lower.includes(kw)) score += 2;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { key, data };
      }
    }
  }

  // Default to first symptom if nothing matched
  if (!bestMatch && Object.keys(symptoms).length > 0) {
    const firstKey = Object.keys(symptoms)[0];
    bestMatch = { key: firstKey, data: symptoms[firstKey] };
  }

  if (!bestMatch || !bestMatch.data) {
    return {
      technicianAssistant: {
        summary: `Based on the reported symptoms for the ${unitType || 'appliance'}, the technician should perform a general on-site inspection. / Batay sa iniulat na sintomas, dapat magsagawa ng on-site inspection ang technician.`,
        probableCauses: [{ cause: 'Requires on-site inspection for accurate assessment', likelihood: 'high', explanation: 'Insufficient information for remote analysis — physical inspection needed' }],
        inspectionChecklist: [
          { step: 1, action: 'Perform general unit inspection', whatToLookFor: 'Visible damage, error codes, unusual sounds or smells', expectedTool: 'Flashlight' },
          { step: 2, action: 'Test power supply and connections', whatToLookFor: 'Correct voltage at unit, no loose wiring', expectedTool: 'Multimeter' },
        ],
        suggestedTools: [{ name: 'Multimeter', purpose: 'Electrical testing' }, { name: 'Flashlight', purpose: 'Visual inspection' }],
        possibleParts: [],
        repairComplexity: 'medium',
        repairApproach: 'scheduled',
        estimatedDurationMinutes: 60,
        safetyReminders: ['Disconnect power before inspection', 'Use insulated tools', 'Wear safety glasses and gloves'],
        additionalNotes: 'This is an automated preliminary assessment. Technician must verify all findings on-site. / Ito ay automated na pagsusuri. Dapat i-verify ng technician ang lahat ng natuklasan sa site.',
        preventiveMaintenance: ['Schedule regular maintenance every 6 months', 'Keep unit clean and free from dust', 'Monitor unit performance after repair'],
        _source: 'fallback',
      },
    };
  }

  const symptomLabel = bestMatch.key.replace(/_/g, ' ');
  return {
    technicianAssistant: {
      summary: `Based on the customer report, the likely issue is: **${symptomLabel}** on the ${unitType || 'appliance'}. Technician should proceed with the inspection checklist below. / Batay sa ulat ng customer, ang posibleng problema ay: **${symptomLabel}** sa ${unitType || 'appliance'}.`,
      probableCauses: bestMatch.data.probableCauses,
      inspectionChecklist: bestMatch.data.inspectionChecklist.map((item, i) => ({
        step: i + 1,
        action: item,
        whatToLookFor: 'Check for abnormal readings, damage, or wear',
        expectedTool: bestMatch.data.suggestedTools[i % bestMatch.data.suggestedTools.length] || 'Multimeter',
      })),
      suggestedTools: bestMatch.data.suggestedTools.map(t => ({ name: t, purpose: 'Required for this inspection' })),
      possibleParts: bestMatch.data.possibleParts.map(p => ({
        name: p,
        estimatedCostPHP: 500,
        purpose: 'May need replacement if confirmed faulty during inspection',
        likelihood: 'medium',
      })),
      repairComplexity: bestMatch.data.complexity || 'medium',
      repairApproach: bestMatch.data.complexity === 'low' ? 'immediate' : 'scheduled',
      estimatedDurationMinutes: bestMatch.data.complexity === 'high' ? 120 : bestMatch.data.complexity === 'low' ? 45 : 60,
      safetyReminders: bestMatch.data.safetyReminders,
      additionalNotes: `This is an automated preliminary assessment using the RACS knowledge base. The technician should verify all findings during on-site inspection. Final diagnosis is the technician's responsibility. / Ito ay automated na pagsusuri gamit ang RACS knowledge base. Dapat i-verify ng technician ang lahat ng natuklasan on-site.`,
      preventiveMaintenance: [
        'Schedule regular maintenance every 6 months',
        'Keep the unit clean and free from dust and debris',
        'Monitor performance after repair and advise customer on proper use',
      ],
      _source: 'fallback',
    },
  };
}

// ── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Generate AI Technician Assistant recommendations
 * Enhanced with Tavily web research for real-time diagnostic data.
 * @param {Object} unitInfo - { unitType, brand, model, problemDescription, photos }
 * @param {Array} serviceHistory - Optional previous service records
 * @returns {Object} technician assistant report
 */
async function generateAssistantReport(unitInfo, serviceHistory = null) {
  let webResearch = { webContext: '', sources: [], searchUsed: false };
  try {
    // Step 1: Augment with real-time web research via Tavily
    try {
      webResearch = await tavilyDiagnosticSearch(unitInfo);
      if (webResearch.searchUsed) {
        console.log(`[Tavily] Web research complete — ${webResearch.sources.length} sources found`);
      }
    } catch (err) {
      console.warn('[Tavily] Search failed, continuing without web data:', err.message);
    }

    // Step 2: Build augmented prompt
    const prompt = buildAssistantPrompt(unitInfo, serviceHistory, webResearch.webContext);

    // Step 3: Try Gemini first, then Groq as fallback
    let result = null;
    let aiSource = 'ai';
    try {
      result = await callGeminiAPI(prompt);
      console.log('[AI] Gemini responded successfully');
    } catch (geminiErr) {
      console.warn(`[AI] Gemini failed (${geminiErr.message}), trying Groq...`);
      try {
        result = await callGroqAPI(prompt);
        aiSource = 'ai-groq';
        console.log('[AI] Groq responded successfully');
      } catch (groqErr) {
        console.error(`[AI] Groq also failed (${groqErr.message}), using local KB fallback`);
        throw new Error('All AI APIs unavailable');
      }
    }

    if (!result.technicianAssistant) {
      throw new Error('Invalid response structure from AI');
    }

    // Step 4: Attach metadata
    return {
      ...result,
      technicianAssistant: {
        ...result.technicianAssistant,
        _source: aiSource,
        _webResearchUsed: webResearch.searchUsed,
        _webSources: webResearch.sources,
      },
    };
  } catch (error) {
    console.error('[AI Technician Assistant] All AI APIs failed, using fallback:', error.message);
    const fallback = fallbackAssistant(unitInfo);
    if (fallback?.technicianAssistant) {
      fallback.technicianAssistant._webResearchUsed = webResearch.searchUsed;
      fallback.technicianAssistant._webSources = webResearch.sources;
    }
    return fallback;
  }
}

/**
 * Get troubleshooting guide for quick reference
 */
function getTroubleshootingGuide(unitType, symptom) {
  const lower = (symptom || '').toLowerCase();
  const unitLower = (unitType || '').toLowerCase();

  let category = 'aircon';
  if (unitLower.includes('refrigerator') || unitLower.includes('fridge') || unitLower.includes('ref')) category = 'refrigerator';
  else if (unitLower.includes('washing') || unitLower.includes('washer')) category = 'washing_machine';
  else if (unitLower.includes('water heater') || unitLower.includes('heater')) category = 'water_heater';
  else if (unitLower.includes('fan')) category = 'electric_fan';
  else if (unitLower.includes('microwave')) category = 'microwave';
  else if (unitLower.includes('rice cooker') || unitLower.includes('cooker')) category = 'rice_cooker';
  else if (unitLower.includes('oven') || unitLower.includes('toaster')) category = 'oven_toaster';
  else if (unitLower.includes('dryer')) category = 'dryer';
  else if (unitLower.includes('pump')) category = 'water_pump';
  else if (unitLower.includes('purifier') || unitLower.includes('dehumidifier')) category = 'air_purifier';

  const symptoms = TROUBLESHOOTING_KB[category]?.symptoms || {};
  for (const [key, data] of Object.entries(symptoms)) {
    const keywords = key.replace(/_/g, ' ').split(' ');
    if (keywords.some(kw => lower.includes(kw))) {
      return { symptom: key.replace(/_/g, ' '), ...data };
    }
  }
  return null;
}

module.exports = {
  generateAssistantReport,
  classifyPriority,
  getSLATargets,
  getTroubleshootingGuide,
  fallbackAssistant,
  callGeminiAPI,
  tavilyDiagnosticSearch,
  tavilyInspectionSearch,
  tavilyPartsPricingSearch,
  tavilyProjectResourceSearch,
  tavilyMaintenanceSearch,
  TROUBLESHOOTING_KB,
};
