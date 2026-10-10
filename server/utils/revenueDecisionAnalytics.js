function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
}

function serviceAction(row) {
  if (row.costEvidenceCoverage < 50) {
    return { tone: "warning", label: "Save missing costs", detail: "Save labor, parts, and job supply costs before changing a price or offer." };
  }
  if (row.grossProfit < 0) {
    return { tone: "danger", label: "Check service prices and costs", detail: "Check prices, discounts, repeat jobs, and saved costs before taking more bookings." };
  }
  if (row.grossProfitMargin < 15) {
    return { tone: "danger", label: "Check the price or lower costs", detail: "Profit is too low to cover other expenses or extra job costs." };
  }
  if (row.grossProfitMargin >= 40 && row.jobs <= 2) {
    return { tone: "success", label: "Try a small special offer", detail: "Profit looks good, but there are only a few jobs. Try a small offer and check that enough technicians are available." };
  }
  if (row.rank === 1) {
    return { tone: "success", label: "Keep staff and times available", detail: "Keep enough technicians and open times for this service, and keep checking job quality." };
  }
  return { tone: "info", label: "Keep checking sales and costs", detail: "Keep the current price. Watch sales, profit %, and missing costs." };
}

function buildServiceProfitability(serviceCostRows = [], options = {}) {
  const startDate = new Date(options.startDate || 0);
  const endDate = new Date(options.endDate || Date.now());
  const halfStart = new Date(startDate.getTime() + Math.max(0, endDate - startDate) / 2);
  const groups = new Map();

  serviceCostRows.forEach((booking) => {
    const lines = Array.isArray(booking.serviceLines) && booking.serviceLines.length
      ? booking.serviceLines
      : [{
        serviceName: booking.serviceName || "Service",
        serviceCategory: booking.serviceCategory || "core",
        quantity: 1,
        revenue: booking.revenue,
        partsCost: booking.partsCost,
        consumablesCost: booking.consumablesCost,
        laborCost: booking.laborCost,
        localPurchaseCost: booking.localPurchaseCost,
        grossProfit: booking.grossProfit,
      }];

    lines.forEach((line) => {
      const name = String(line.serviceName || "Service").trim() || "Service";
      const category = ["core", "repair", "mix"].includes(line.serviceCategory) ? line.serviceCategory : "core";
      const key = `${category}:${name.toLocaleLowerCase("en-PH")}`;
      if (!groups.has(key)) {
        groups.set(key, {
          serviceName: name,
          serviceCategory: category,
          jobs: 0,
          units: 0,
          revenue: 0,
          partsCost: 0,
          consumablesCost: 0,
          laborCost: 0,
          localPurchaseCost: 0,
          directCost: 0,
          grossProfit: 0,
          refunds: 0,
          costEvidenceJobs: 0,
          firstHalfProfit: 0,
          secondHalfProfit: 0,
          records: [],
        });
      }
      const row = groups.get(key);
      const partsCost = number(line.partsCost);
      const consumablesCost = number(line.consumablesCost);
      const laborCost = number(line.laborCost);
      const localPurchaseCost = number(line.localPurchaseCost);
      const directCost = partsCost + consumablesCost + laborCost + localPurchaseCost;
      const revenue = number(line.revenue);
      const grossProfit = Number.isFinite(Number(line.grossProfit)) ? number(line.grossProfit) : revenue - directCost;
      const refunds = number(line.refundAmount);
      const completedAt = line.completedAt || booking.completedAt;

      row.jobs += 1;
      row.units += Math.max(1, number(line.quantity) || 1);
      row.revenue += revenue;
      row.partsCost += partsCost;
      row.consumablesCost += consumablesCost;
      row.laborCost += laborCost;
      row.localPurchaseCost += localPurchaseCost;
      row.directCost += directCost;
      row.grossProfit += grossProfit;
      row.refunds += refunds;
      if (directCost > 0) row.costEvidenceJobs += 1;
      if (new Date(completedAt) < halfStart) row.firstHalfProfit += grossProfit;
      else row.secondHalfProfit += grossProfit;
      row.records.push({
        bookingId: booking.bookingId,
        reference: booking.reference,
        customer: booking.customer,
        technician: booking.technician,
        completedAt,
        quantity: Math.max(1, number(line.quantity) || 1),
        revenue,
        directCost,
        grossProfit,
        refunds,
      });
    });
  });

  const rows = [...groups.values()].map((row) => {
    const grossProfitMargin = row.revenue > 0 ? (row.grossProfit / row.revenue) * 100 : 0;
    const first = row.firstHalfProfit;
    const momentumPercent = Math.abs(first) > 0.01
      ? ((row.secondHalfProfit - first) / Math.abs(first)) * 100
      : null;
    return {
      ...row,
      grossProfitMargin,
      averageRevenue: row.jobs ? row.revenue / row.jobs : 0,
      averageProfit: row.jobs ? row.grossProfit / row.jobs : 0,
      costEvidenceCoverage: row.jobs ? (row.costEvidenceJobs / row.jobs) * 100 : 0,
      momentumPercent,
      records: row.records.sort((left, right) => new Date(right.completedAt) - new Date(left.completedAt)),
    };
  }).sort((left, right) => right.grossProfit - left.grossProfit);

  rows.forEach((row, index) => { row.rank = index + 1; });
  const positiveProfit = rows.reduce((sum, row) => sum + Math.max(0, row.grossProfit), 0);
  rows.forEach((row) => {
    row.profitContribution = positiveProfit > 0 ? (Math.max(0, row.grossProfit) / positiveProfit) * 100 : 0;
    row.action = serviceAction(row);
  });

  const mostProfitable = rows[0] || null;
  const leastProfitable = rows.length ? rows[rows.length - 1] : null;
  const highestMargin = rows.filter((row) => row.revenue > 0 && row.costEvidenceCoverage >= 50)
    .sort((left, right) => right.grossProfitMargin - left.grossProfitMargin)[0] || null;
  const atRiskCount = rows.filter((row) => row.grossProfit < 0 || (row.revenue > 0 && row.grossProfitMargin < 15)).length;
  const insights = [];
  if (mostProfitable) insights.push({
    tone: "success",
    title: `${mostProfitable.serviceName} leads profit`,
    text: `${mostProfitable.jobs} completed job${mostProfitable.jobs === 1 ? "" : "s"} generated ${mostProfitable.grossProfit.toLocaleString("en-PH", { style: "currency", currency: "PHP" })} in profit based on saved costs at ${mostProfitable.grossProfitMargin.toFixed(1)}% profit.`,
    action: mostProfitable.action.label,
  });
  if (leastProfitable && leastProfitable !== mostProfitable) insights.push({
    tone: leastProfitable.grossProfit < 0 || leastProfitable.grossProfitMargin < 15 ? "danger" : "warning",
    title: `${leastProfitable.serviceName} needs review`,
    text: `${leastProfitable.grossProfit.toLocaleString("en-PH", { style: "currency", currency: "PHP" })} profit based on saved costs at ${leastProfitable.grossProfitMargin.toFixed(1)}% of sales. This is the lowest recorded profit for these dates.`,
    action: leastProfitable.action.label,
  });
  const weakCoverage = rows.filter((row) => row.costEvidenceCoverage < 50);
  if (weakCoverage.length) insights.push({
    tone: "warning",
    title: "Some job costs are missing",
    text: `${weakCoverage.length} service${weakCoverage.length === 1 ? " has" : "s have"} saved cost details for fewer than half of finished jobs. Treat the profit % as an estimate.`,
    action: "Save missing job costs",
  });

  return { rows, mostProfitable, leastProfitable, highestMargin, atRiskCount, insights };
}

function buildRevenueForecast(dailyRevenue = [], options = {}) {
  const horizonDays = clamp(number(options.horizonDays) || 30, 7, 90);
  const history = dailyRevenue
    .map((row) => ({ date: dateKey(row.date), booked: Math.max(0, number(row.booked)) }))
    .filter((row) => row.date)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-84);
  const anchor = new Date(options.anchorDate || (history.length ? `${history[history.length - 1].date}T12:00:00` : Date.now()));
  const recent = history.slice(-28);
  const prior = history.slice(-56, -28);
  const recentTotal = recent.reduce((sum, row) => sum + row.booked, 0);
  const priorTotal = prior.reduce((sum, row) => sum + row.booked, 0);
  const rawTrend = priorTotal > 0 ? (recentTotal - priorTotal) / priorTotal : 0;
  const trendAdjustment = clamp(rawTrend, -0.3, 0.3);
  const byWeekday = Array.from({ length: 7 }, () => []);
  history.forEach((row, index) => {
    const day = new Date(`${row.date}T12:00:00`).getDay();
    byWeekday[day].push({ value: row.booked, weight: 1 + (index / Math.max(1, history.length - 1)) });
  });
  const weekdayAverage = byWeekday.map((samples) => {
    const weight = samples.reduce((sum, sample) => sum + sample.weight, 0);
    return weight ? samples.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / weight : 0;
  });
  const values = history.map((row) => row.booked);
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const variance = values.length ? values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length : 0;
  const coefficientOfVariation = mean > 0 ? Math.sqrt(variance) / mean : 2;
  const activeDays = values.filter((value) => value > 0).length;
  const confidence = history.length >= 70 && activeDays >= 20 && coefficientOfVariation <= 1.5
    ? "high"
    : history.length >= 28 && activeDays >= 7 ? "medium" : "low";
  const uncertainty = confidence === "high" ? 0.15 : confidence === "medium" ? 0.25 : 0.4;
  const forecast = [];
  for (let offset = 1; offset <= horizonDays; offset += 1) {
    const date = new Date(anchor);
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    const base = weekdayAverage[date.getDay()] || mean;
    const value = Math.max(0, base * (1 + trendAdjustment));
    forecast.push({
      date: dateKey(date),
      value,
      lower: Math.max(0, value * (1 - uncertainty)),
      upper: value * (1 + uncertainty),
    });
  }
  const total = forecast.reduce((sum, row) => sum + row.value, 0);
  const lower = forecast.reduce((sum, row) => sum + row.lower, 0);
  const upper = forecast.reduce((sum, row) => sum + row.upper, 0);
  const comparisonDays = history.slice(-horizonDays);
  const comparisonTotal = comparisonDays.reduce((sum, row) => sum + row.booked, 0);
  const projectedGrowthPercent = comparisonTotal > 0 ? ((total - comparisonTotal) / comparisonTotal) * 100 : null;
  return {
    horizonDays,
    total,
    lower,
    upper,
    dailyAverage: horizonDays ? total / horizonDays : 0,
    comparisonTotal,
    projectedGrowthPercent,
    confidence,
    basisDays: history.length,
    activeDays,
    cappedTrendPercent: trendAdjustment * 100,
    actual: history.slice(-30).map((row) => ({ date: row.date, value: row.booked })),
    forecast,
    method: "Recency-weighted weekday averages adjusted by the capped change between the latest and previous 28-day periods.",
    caveat: "An estimate based on approved booking value. It does not promise future sales or money received.",
  };
}

module.exports = { buildRevenueForecast, buildServiceProfitability };
