"use strict";

const appliance = require('../public/js/appliance-services');
const { validateRepairModel } = require('./repairModelPolicy');
const { unknownBrand } = require('./repairIdentificationPolicy');
const { customerUnits } = require('./repairUnitWorkflow');

function resolveWalkInRepairSelection(requested, pricing, inspectionDuration) {
  try {
    const brand = typeof requested.brand === 'string' ? requested.brand.trim() : '';
    if (brand.length > 80 || unknownBrand(brand)) throw new Error('Confirm the repair appliance brand before booking.');
    const model = validateRepairModel(requested.model);
    if (!model.valid) throw new Error(model.error);
    const problemDescription = String(requested.problemDescription || requested.repairIssue || '').trim();
    if (problemDescription.length < 10 || problemDescription.length > 2000) throw new Error('Describe the appliance problem using 10 to 2000 characters.');
    const unitType = pricing.unitType || requested.unitType || requested.applianceType;
    const unitCategory = pricing.categorySlug || requested.unitCategory;
    const details = appliance.repairDetails({ ...requested, unitType, unitCategory });
    const row = {
      serviceId: pricing.serviceId || null, type: 'repair', phase: 'repair_phase_1',
      name: `${brand} ${pricing.unitLabel || requested.applianceTypeName || unitType} Repair`,
      ...details, brand, model: model.value, unitType, unitCategory,
      applianceType: unitType, applianceTypeName: pricing.unitLabel || requested.applianceTypeName || unitType,
      isAirconService: appliance.isRepairAircon({ unitType, unitCategory }),
      unitPrice: pricing.fee, initialCost: pricing.fee, totalPrice: pricing.fee * details.quantity,
      duration: inspectionDuration, problemDescription, repairIssue: problemDescription,
      photos: Array.isArray(requested.photos) ? requested.photos.slice(0, 5).filter(url => typeof url === 'string' && /^\/uploads\/repairs\/[\w.-]+$/.test(url)) : [],
    };
    row.units = customerUnits({ ...row, units: requested.units });
    return row;
  } catch (error) {
    error.status = 400;
    throw error;
  }
}

module.exports = { resolveWalkInRepairSelection };
