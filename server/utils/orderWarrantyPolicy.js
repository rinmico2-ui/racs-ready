const { buildWarrantyCoverage } = require("./warrantyLifecycle");

function manufacturerWarrantyDays(terms) {
  const text = String(terms || "").toLowerCase();
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(year|yr|month|mo|day)s?\b/g)];
  if (!matches.length) return 0;
  return Math.min(3650, Math.max(...matches.map(match => {
    const amount = Number(match[1]);
    if (match[2] === "year" || match[2] === "yr") return Math.round(amount * 365);
    if (match[2] === "month" || match[2] === "mo") return Math.round(amount * 30);
    return Math.round(amount);
  })));
}

function buildOrderWarrantySnapshot(order, completedAt, warrantyRule) {
  const sellerDays = Math.max(1, Number(warrantyRule?.days) || 30);
  const sellerEnabled = warrantyRule?.enabled !== false;
  const coverages = [];
  for (const [index, item] of (order.items || []).entries()) {
    const itemKey = String(item.inventoryId || index);
    const serviceName = [item.brand, item.modelLine, item.capacity ? `${item.capacity} ${item.capacityUnit || "HP"}` : ""].filter(Boolean).join(" ") || `Product ${index + 1}`;
    if (sellerEnabled) {
      const sellerDates = buildWarrantyCoverage(completedAt, sellerDays);
      coverages.push({
        coverageId: `seller-product:${itemKey}`,
        itemKey,
        serviceName: `${serviceName} - CALIDRO seller coverage`,
        coverageType: "product",
        days: sellerDates.days,
        startDate: sellerDates.startDate,
        endDate: sellerDates.endDate,
        status: "active",
        coveredItems: ["Seller assessment for a reported product defect", "Repair, replacement, refund review, or manufacturer referral based on inspection and applicable terms"],
        exclusions: ["Accidental damage, misuse, power irregularity, unauthorized alteration, and normal wear are subject to inspection"],
        termsVersion: 1,
      });
    }
    const manufacturerDays = manufacturerWarrantyDays(item.manufacturerWarranty);
    if (manufacturerDays > 0) {
      const manufacturerDates = buildWarrantyCoverage(completedAt, manufacturerDays);
      coverages.push({
        coverageId: `manufacturer:${itemKey}`,
        itemKey,
        serviceName: `${serviceName} - manufacturer warranty`,
        coverageType: "manufacturer_product",
        days: manufacturerDates.days,
        startDate: manufacturerDates.startDate,
        endDate: manufacturerDates.endDate,
        status: "active",
        coveredItems: ["Manufacturer warranty referral and claim assistance under the snapshotted product terms"],
        exclusions: ["Final coverage is subject to the manufacturer's written warranty terms and inspection"],
        manufacturerTerms: item.manufacturerWarranty,
        termsVersion: 1,
      });
    }
  }
  if (order.fulfillmentType === "delivery_installation") {
    const installationDates = buildWarrantyCoverage(completedAt, 180);
    coverages.push({
      coverageId: "order-installation",
      serviceName: "Delivery + installation workmanship",
      coverageType: "installation",
      days: installationDates.days,
      startDate: installationDates.startDate,
      endDate: installationDates.endDate,
      status: "active",
      coveredItems: ["Mounting, piping, drainage, wiring, vacuuming, commissioning, and documented installation workmanship"],
      exclusions: ["Manufacturer product defects are assessed separately", "Damage caused after handover by misuse or unauthorized third-party work"],
      termsVersion: 1,
    });
  }
  if (!coverages.length) return null;
  const days = Math.max(...coverages.map(item => item.days));
  return { ...buildWarrantyCoverage(completedAt, days), coverages };
}

module.exports = { manufacturerWarrantyDays, buildOrderWarrantySnapshot };
