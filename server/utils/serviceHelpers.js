function findDurationForHpAndType(service, hp, airconType) {
  if (!service) return null;

  if (service.airconTypes && Array.isArray(service.airconTypes) && airconType) {
    const typeConfig = service.airconTypes.find(
      (t) => t.type === airconType || t.name === airconType
    );
    if (typeConfig && typeConfig.hpPricing && Array.isArray(typeConfig.hpPricing) && hp) {
      const hpEntry = typeConfig.hpPricing.find((p) => Number(p.hp) === Number(hp));
      if (hpEntry && hpEntry.durationMinutes) return hpEntry.durationMinutes;
    }
  }

  if (service.hpPricing && Array.isArray(service.hpPricing) && hp) {
    const hpEntry = service.hpPricing.find((p) => Number(p.hp) === Number(hp));
    if (hpEntry && hpEntry.durationMinutes) return hpEntry.durationMinutes;
  }

  if (service.durationMinutes) return service.durationMinutes;
  if (service.durationRange) return service.durationRange.min || service.durationRange.max || 60;

  return 60;
}

function findPriceForHpAndType(service, hp, airconType) {
  if (!service) return null;

  if (service.airconTypes && Array.isArray(service.airconTypes) && airconType) {
    const typeConfig = service.airconTypes.find(
      (t) => t.type === airconType || t.name === airconType
    );
    if (typeConfig && typeConfig.hpPricing && Array.isArray(typeConfig.hpPricing) && hp) {
      const hpEntry = typeConfig.hpPricing.find((p) => Number(p.hp) === Number(hp));
      if (hpEntry && hpEntry.price) return hpEntry.price;
    }
  }

  if (service.hpPricing && Array.isArray(service.hpPricing) && hp) {
    const hpEntry = service.hpPricing.find((p) => Number(p.hp) === Number(hp));
    if (hpEntry && hpEntry.price) return hpEntry.price;
  }

  return service.basePrice || 0;
}

module.exports = {
  findDurationForHpAndType,
  findPriceForHpAndType,
};
