(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProjectBookingDetails = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const text = value => String(value ?? '').trim();
  const id = value => text(value?._id || value);
  const useful = value => text(value) && !/^(unknown|service|unit|appliance|—)$/i.test(text(value));
  const choose = (...values) => text(values.find(useful));
  const safe = value => text(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const array = value => Array.isArray(value) ? value : [];
  const statusLabels = { pending: 'Waiting for inspection', staff_review: 'Waiting for staff review', customer_review: 'Waiting for customer', approved: 'Repair approved', declined: 'Repair declined', completed: 'Repair completed' };

  function savedLocation(value) {
    const coordinate = (input, limit) => input !== null && input !== undefined && text(input) !== '' &&
      Number.isFinite(Number(input)) && Math.abs(Number(input)) <= limit ? Number(input) : null;
    const point = value?.coordinates?.type === 'Point' ? array(value.coordinates.coordinates) : [];
    const lat = coordinate(value?.lat ?? point[1], 90), lng = coordinate(value?.lng ?? point[0], 180);
    return { address: text(value?.address), lat, lng, hasPin: lat !== null && lng !== null };
  }

  function serviceLocation(project, booking) {
    const site = savedLocation(project.location), original = savedLocation(booking.location);
    if (!site.address && !site.hasPin) return original;
    // Only combine an incomplete project location with the original booking
    // when the same address or pin identifies the same site.
    const sameAddress = site.address && original.address && site.address.toLowerCase() === original.address.toLowerCase();
    const samePin = site.hasPin && original.hasPin && Math.abs(site.lat - original.lat) < 0.000001 && Math.abs(site.lng - original.lng) < 0.000001;
    if (sameAddress || samePin) return { address: site.address || original.address,
      lat: site.hasPin ? site.lat : original.lat, lng: site.hasPin ? site.lng : original.lng,
      hasPin: site.hasPin || original.hasPin };
    return site;
  }

  function read(data) {
    const p = data.project || {};
    const candidate = data.booking;
    const booking = candidate && id(candidate._id) === id(p.bookingId) &&
      (!p.customerId || !candidate.customerId || id(p.customerId) === id(candidate.customerId)) ? candidate : {};
    const sourceServices = array(booking.services);
    const persistedGroups = array(p.unitGroups);
    const legacyProject = p.repair?.unitInfo || {}, legacyBooking = booking.unitInfo || {};
    const legacy = Object.fromEntries(['unitType', 'brand', 'model', 'problemDescription'].map(key =>
      [key, choose(legacyProject[key], legacyBooking[key])]));
    let groups = persistedGroups.length ? persistedGroups : sourceServices;
    if (!groups.length && (p.service?.name || p.repair?.serviceType === 'repair' || booking.service?.name)) {
      groups = [{ ...legacy, name: p.service?.name || booking.service?.name,
        type: p.repair?.serviceType || booking.serviceType || 'core', quantity: p.requestedUnitCount || p.totalUnits || booking.quantity || 1,
        problemDescription: legacy.problemDescription || booking.issueDescription }];
    }
    const services = groups.map((group, index) => {
      const groupIndex = Number.isInteger(Number(group.groupIndex)) ? Number(group.groupIndex) : index;
      const direct = sourceServices[groupIndex];
      const matches = item => item && (!group.serviceId || id(item.serviceId) === id(group.serviceId)) &&
        (item.type || 'core') === (group.serviceType || group.type || 'core');
      const byId = group.serviceId ? sourceServices.filter(item => matches(item)) : [];
      const original = !persistedGroups.length ? group : matches(direct) ? direct : byId.length === 1 ? byId[0] : {};
      const quantity = Number(group.quantity || original.quantity) || 1;
      const repair = (group.serviceType || group.type || original.type) === 'repair';
      const problem = choose(group.problemDescription, group.repairIssue, original.problemDescription, original.repairIssue);
      const units = array(group.units).length ? array(group.units) : array(original.units);
      return {
        applianceGroupId: text(group.applianceGroupId || original.applianceGroupId),
        groupIndex, name: choose(group.serviceName, group.name, original.name, p.service?.name) || 'Service',
        type: repair ? 'repair' : 'core', quantity,
        unitType: choose(group.unitType, group.applianceTypeName, group.airconTypeName, original.unitType, original.applianceTypeName, original.airconTypeName),
        brand: choose(group.brand, original.brand), model: choose(group.model, original.model),
        hp: Number(group.hp || original.hp) || null, hpDescription: choose(group.hpDescription, original.hpDescription), problem,
        units: units.map((unit, unitOffset) => {
          const unitIndex = Number(unit.unitIndex) || unitOffset + 1;
          const originalUnit = array(original.units).find(item => Number(item.unitIndex) === unitIndex) || {};
          return { unitIndex, label: choose(unit.label, originalUnit.label) || 'Appliance ' + unitIndex,
            problem: choose(unit.problemDescription, originalUnit.problemDescription, problem),
            findings: choose(unit.inspection?.findings), diagnosis: choose(unit.diagnosis?.summary, unit.diagnosis?.diagnosisSummary),
            state: text(unit.repairReview?.state), status: text(unit.status),
            repairPrice: unit.quotation?.totalCost != null && (unit.inspection?.completedAt || unit.inspection?.findings)
              ? Number(unit.quotation.totalCost) : null };
        }),
      };
    });
    const preferences = booking.projectScheduling || {};
    return { reference: text(booking.bookingReference), services, hasRepair: services.some(item => item.type === 'repair'),
      location: serviceLocation(p, booking),
      startDate: preferences.preferredStartDate || preferences.startDate || p.preferredStartDate,
      endDate: preferences.preferredCompletionDeadline || preferences.endDate || preferences.preferences?.completionDeadline || p.preferredCompletionDeadline,
      workingDays: array(preferences.preferredWorkingDays || preferences.preferences?.workingDays || p.preferredWorkingDays),
      arrival: preferences.preferredWorkingHours || preferences.preferences?.preferredWorkingHours || p.preferredWorkingHours,
    };
  }

  function dateLabel(value) {
    if (!value) return 'Not recorded';
    const key = String(value);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(key) ? new Date(key + 'T12:00:00+08:00') : new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'Asia/Manila' });
  }
  function arrivalLabel(value) {
    const start = text(typeof value === 'string' ? value : value?.start);
    if (start === 'morning') return 'Morning (8:00 AM–12:00 PM)';
    if (start === 'afternoon') return 'Afternoon (12:00 PM–5:00 PM)';
    return start ? start + (value?.end ? '–' + text(value.end) : '') : 'No preference';
  }
  function dayLabel(value) {
    const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return typeof value === 'number' ? names[value % 7] || text(value) : text(value).replace(/^./, char => char.toUpperCase());
  }
  const field = (label, value, full) => `<div class="sd-item${full ? ' sd-full' : ''}"><div class="sd-k">${safe(label)}</div><div class="sd-v">${safe(value || 'Not recorded')}</div></div>`;
  function renderLocation(location) {
    const site = location || {};
    const mapQuery = site.hasPin ? site.lat + ',' + site.lng : site.address;
    return `<section class="pd-card pd-service-location" data-stage="review planning ready active completed">
      <div class="pd-head"><h3><i class="bi bi-geo-alt me-2" aria-hidden="true"></i>Service location</h3></div>
      <div class="pd-body"><p class="pd-request-note">Where the work will take place</p>
        <div class="pd-site-details"><div class="pd-site-address"><strong>${safe(site.address || (site.hasPin ? 'Address not recorded' : 'No service location was recorded with this request.'))}</strong>
          ${site.hasPin ? `<p>Saved map pin · ${site.lat.toFixed(6)}, ${site.lng.toFixed(6)}</p>` : site.address ? '<p>No map pin was saved for this address.</p>' : ''}</div>
          ${mapQuery ? `<a class="pd-btn success" href="https://www.google.com/maps/search/?api=1&amp;query=${safe(encodeURIComponent(mapQuery))}" target="_blank" rel="noopener noreferrer">${site.hasPin ? 'View map pin' : 'View address on map'}<i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></a>` : ''}
        </div>
      </div></section>`;
  }
  function render(details, projectId) {
    const site = renderLocation(details.location);
    if (!details.services.length) return site + '<div class="pd-card"><div class="pd-body text-muted">No service details were recorded with this project.</div></div>';
    const repairOnly = details.services.every(item => item.type === 'repair');
    const review = details.hasRepair && /^[a-f\d]{24}$/i.test(text(projectId))
      ? `<button type="button" class="pd-btn success" onclick="openRepairUnits('project','${safe(projectId)}')">Review appliances and prices</button>` : '';
    return site + `<div class="pd-card pd-booking-details" data-stage="review planning ready active completed">
      <div class="pd-head"><h3>${repairOnly ? 'Repair Summary' : 'Requested services and units'}</h3>${review}</div>
      <div class="pd-body">${details.reference ? `<p class="pd-request-reference">Booking ${safe(details.reference)}</p>` : ''}
        ${details.services.map(group => `<section class="pd-booking-group">
          <div class="pd-booking-group-head"><strong>${safe(group.name)}</strong><span class="cap-pill">${group.quantity} ${group.quantity === 1 ? 'unit' : 'units'}</span></div>
          ${group.applianceGroupId && details.services.filter(item => item.applianceGroupId === group.applianceGroupId).length > 1 ? `<p class="pd-request-reference">These same ${group.quantity} appliance${group.quantity === 1 ? '' : 's'} also receive: ${safe(details.services.filter(item => item.applianceGroupId === group.applianceGroupId && item !== group).map(item => item.name).join(', '))}. Counted once in project progress.</p>` : ''}
          <div class="sd-grid">${field('Type', group.unitType)}${field('Brand', group.brand)}${field('Model', group.model)}${group.hp || group.hpDescription ? field('HP', group.hpDescription || group.hp + ' HP') : ''}${group.type === 'repair' ? field('Reported problem', group.problem, true) : ''}</div>
          ${group.type === 'repair' && group.units.length ? `<details class="pd-appliance-list"><summary>View ${group.units.length} ${group.units.length === 1 ? 'appliance' : 'appliances'} and reported problems</summary><ol>${group.units.map(unit => `<li><div class="pd-appliance-head"><strong>${safe(unit.label)}</strong><small>${safe(statusLabels[unit.state] || unit.status.replace(/_/g, ' ') || 'Not yet inspected')}</small></div><p>${safe(unit.problem || 'No problem description was recorded.')}</p>${unit.findings ? `<p><b>Inspection:</b> ${safe(unit.findings)}</p>` : ''}${unit.diagnosis ? `<p><b>Diagnosis:</b> ${safe(unit.diagnosis)}</p>` : ''}${Number.isFinite(unit.repairPrice) ? `<p><b>Repair price:</b> ₱${unit.repairPrice.toLocaleString()}</p>` : ''}</li>`).join('')}</ol></details>` : ''}
        </section>`).join('')}
        <section class="sd-section pd-customer-preferences"><div class="sd-section-title">Customer scheduling preferences</div><div class="sd-grid">${field('Preferred start', dateLabel(details.startDate))}${field('Finish by', dateLabel(details.endDate))}${field('Preferred arrival', arrivalLabel(details.arrival))}${field('Preferred working days', details.workingDays.map(dayLabel).join(', ') || 'No preference')}</div><p class="pd-request-note">These are the customer’s requested dates. Staff will confirm the final work schedule.</p></section>
      </div></div>`;
  }
  return { read, render, arrivalLabel, dateLabel };
});
