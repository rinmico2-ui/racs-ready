'use strict';

// These rankings describe observed activity in the selected report cohort.
// Catalog entries with no transaction are a separate question: a filtered
// payment/source report cannot establish that they are genuinely unsold.
function leastSoldProducts(products, limit = 8) {
  return [...(products || [])]
    .filter(row => Number(row.quantity) > 0)
    .sort((a, b) => Number(a.quantity) - Number(b.quantity)
      || Number(a.revenue) - Number(b.revenue)
      || String(a.name || '').localeCompare(String(b.name || '')))
    .slice(0, limit);
}

function leastBookedServices(services, limit = 5) {
  return [...(services || [])]
    .filter(row => Number(row.bookings) > 0)
    .sort((a, b) => Number(a.bookings) - Number(b.bookings)
      || Number(a.completed) - Number(b.completed)
      || Number(a.revenue) - Number(b.revenue)
      || String(a.name || '').localeCompare(String(b.name || '')))
    .slice(0, limit);
}

function servicePortfolioDecision(service, { periodDays = 0, portfolioBookings = 0, portfolioComplete = true } = {}) {
  const bookings = Number(service.bookings) || 0;
  const completed = Number(service.completed) || 0;
  const recent = Number(service.recentBookings) || 0;
  const prior = Number(service.priorBookings) || 0;
  const share = portfolioBookings ? (bookings / portfolioBookings) * 100 : 0;
  if (!portfolioComplete) return {
    label: 'Review in full portfolio',
    reason: 'Filtered or historical bookings cannot establish the current service mix; compare all services in a recent period.',
  };
  if (periodDays < 14 || portfolioBookings < 10) return {
    label: 'Collect more evidence',
    reason: `${bookings} bookings in scope; this window is too small for a service mix decision.`,
  };
  if (bookings >= 5 && completed / bookings < 0.6) return {
    label: 'Review delivery pipeline',
    reason: `${completed} of ${bookings} bookings are currently completed; inspect open jobs, cancellation reasons, and timing before promoting.`,
  };
  if (periodDays >= 30 && prior >= 3 && recent === 0) return {
    label: 'Investigate demand drop',
    reason: `${prior} bookings in the first half and none in the second; check visibility, pricing, and seasonality.`,
  };
  if (bookings >= 5 && share >= 20 && completed / bookings >= 0.6) return {
    label: 'Protect capacity',
    reason: `${bookings} bookings represent ${share.toFixed(0)}% of service demand; keep qualified staff and appointment slots available.`,
  };
  if (periodDays >= 30 && bookings <= 2) return {
    label: 'Test demand before expanding',
    reason: `Only ${bookings} booking${bookings === 1 ? '' : 's'} in this period; test placement or an offer before assigning more capacity.`,
  };
  return { label: 'Monitor service', reason: `${bookings} bookings, ${completed} completed; keep tracking demand and completion.` };
}

module.exports = { leastSoldProducts, leastBookedServices, servicePortfolioDecision };
