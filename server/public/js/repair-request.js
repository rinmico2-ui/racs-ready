/**
 * Enterprise Repair Request - Client-Side Logic
 * Handles the 6-step repair work order flow:
 *   Step 1: Login check
 *   Step 2: Unit information
 *   Step 3: Location
 *   Step 4: Preferred schedule (calendar + time slot)
 *   Step 5: Review & submit
 *   Step 6: Confirmation
 */

"use strict";

// ═══════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════

const RepairState = {
  unitType: '',
  brand: '',
  model: '',
  problemDescription: '',
  photos: [],
  location: { address: '', lat: null, lng: null },
  distanceKm: 0,
  travelFare: 0,
  diagnosticFee: 0,
  paymentMethod: 'gcash',
  gcashNumber: '',
  gcashProof: null,
  cashNumber: '',
  downpaymentAmount: 0,
  downpaymentPercentage: 10,
  preferredDate: null,
  preferredTime: '',
  quantity: 1,
  isProject: false,
  projectScheduling: null,
  serviceItems: [],
  currentStep: 1,
};

window.RepairState = RepairState;

function renderRepairGcashAccount() {
  const gcashNumber = (window.adminGcashNumber || '').trim();
  const numberDisplay = document.getElementById('repairGcashNumber');
  const cashNumberDisplay = document.getElementById('repairCashGcashNumber');
  const qrImage = document.getElementById('gcashQrImage');
  if (numberDisplay) numberDisplay.textContent = gcashNumber || 'Contact the store';
  if (cashNumberDisplay) cashNumberDisplay.textContent = gcashNumber || 'Contact the store';
  if (qrImage) {
    if (gcashNumber) qrImage.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent('GCash|' + gcashNumber);
    else qrImage.removeAttribute('src');
  }
}
renderRepairGcashAccount();

fetch('/api/services/payment-policy')
  .then(response => response.ok ? response.json() : Promise.reject(new Error('Payment policy unavailable')))
  .then(data => {
    const percentage = Number(data.downpaymentPercentage);
    if (Number.isFinite(percentage) && percentage >= 1 && percentage <= 100) {
      RepairState.downpaymentPercentage = percentage;
      updateCashDisplay();
    }
  })
  .catch(() => console.warn('Using the default 10% downpayment policy.'));

function currentRepairItem() {
  return {
    type: 'repair',
    unitType: (document.getElementById('unitType')?.value || '').trim(),
    applianceTypeName: (document.getElementById('unitType')?.value || '').trim(),
    brand: (document.getElementById('unitBrand')?.value || '').trim(),
    model: (document.getElementById('unitModel')?.value || '').trim(),
    problemDescription: (document.getElementById('problemDescription')?.value || '').trim(),
    repairIssue: (document.getElementById('problemDescription')?.value || '').trim(),
    quantity: Number(document.getElementById('unitQuantity')?.value || 1),
  };
}

function repairItemIsBlank(item) {
  return !item.unitType && !item.brand && !item.model && !item.problemDescription;
}

function repairItemIsComplete(item) {
  return Boolean(item.unitType && item.brand && item.problemDescription.length >= 10);
}

function repairItemsForSubmission() {
  return [...RepairState.serviceItems];
}

function totalRepairUnits() {
  return repairItemsForSubmission().reduce((sum, item) => sum + Math.max(1, Number(item.quantity) || 1), 0);
}

function resetCurrentRepairForm() {
  ['unitType', 'unitBrand', 'unitModel', 'problemDescription'].forEach(id => {
    const element = document.getElementById(id); if (element) element.value = '';
  });
  const qty = document.getElementById('unitQuantity'); if (qty) qty.value = 1;
  RepairState.unitType = ''; RepairState.brand = ''; RepairState.model = '';
  RepairState.problemDescription = ''; RepairState.quantity = 1;
  document.querySelectorAll('.unit-category-card,.sub-unit-chip,.symptom-chip').forEach(element => element.classList.remove('active'));
  const subSection = document.getElementById('subUnitSection'); if (subSection) subSection.classList.add('d-none');
  const chips = document.getElementById('subUnitChips'); if (chips) chips.innerHTML = '';
}

function renderRepairServiceItems() {
  const host = document.getElementById('repairServiceItems'); if (!host) return;
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  host.innerHTML = RepairState.serviceItems.length ? RepairState.serviceItems.map((item,index) => `<div class="d-flex justify-content-between gap-3 bg-white border rounded-3 p-3 mb-2"><div><strong>${index+1}. ${esc(item.brand)} ${esc(item.unitType)}</strong><div class="small text-muted">${esc(item.model || 'Model not specified')} · Qty ${item.quantity}</div><div class="small mt-1">${esc(item.problemDescription)}</div></div><div class="d-flex gap-1"><button type="button" class="btn btn-sm btn-outline-secondary" onclick="editRepairItem(${index})">Edit</button><button type="button" class="btn btn-sm btn-outline-danger" onclick="removeRepairItem(${index})">Remove</button></div></div>`).join('') : '<div class="small text-muted">The appliance currently in the form will be included automatically.</div>';
  if (!RepairState.serviceItems.length) {
    host.innerHTML = '<div class="text-center border border-2 rounded-3 p-4 bg-white"><i class="bi bi-plus-square fs-3 text-muted"></i><div class="fw-semibold mt-2">No repair service added</div><div class="small text-muted">Configure the appliance above, then click Add Repair Service.</div></div>';
  } else {
    host.querySelectorAll(':scope > div').forEach((slot, index) => {
      slot.classList.add('border-primary-subtle');
      const heading = document.createElement('div');
      heading.className = 'small fw-bold text-primary text-uppercase mb-1';
      heading.textContent = `Repair Service ${index + 1}`;
      slot.firstElementChild?.prepend(heading);
    });
  }
  const continueButton = document.getElementById('continueToLocationBtn');
  const continueHint = document.getElementById('continueHint');
  if (continueButton) {
    const hasItems = RepairState.serviceItems.length > 0;
    continueButton.disabled = !hasItems;
    if (continueHint) continueHint.style.display = hasItems ? 'none' : '';
    if (!hasItems) {
      continueButton.title = 'Add at least one repair service to continue';
    } else {
      continueButton.title = '';
    }
  }
  const count = document.getElementById('repairServiceCount');
  if (count) count.textContent = `${RepairState.serviceItems.length} service${RepairState.serviceItems.length === 1 ? '' : 's'} added`;
}

function addCurrentRepairItem() {
  const item = currentRepairItem();
  if (!item.unitType || !item.brand || item.problemDescription.length < 10) return showAlert('Complete the unit type, brand, and a problem description of at least 10 characters before adding the repair service.', 'warning');
  RepairState.serviceItems.push(item); renderRepairServiceItems();
  resetCurrentRepairForm();
  showAlert('Repair service added. Configure another appliance or continue to location.', 'success');
}
function editRepairItem(index) {
  const item = RepairState.serviceItems.splice(index, 1)[0]; if (!item) return;
  const category = Object.keys(unitTypesByCategory).find(key => unitTypesByCategory[key].some(type => type.value === item.unitType));
  if (category) {
    selectUnitCategory(category);
    const chip = [...document.querySelectorAll('.sub-unit-chip')].find(element => element.dataset.value === item.unitType);
    if (chip) selectSubUnit(item.unitType, chip);
  } else {
    document.getElementById('unitType').value = item.unitType; RepairState.unitType = item.unitType;
  }
  document.getElementById('unitBrand').value = item.brand; document.getElementById('unitModel').value = item.model || ''; document.getElementById('problemDescription').value = item.problemDescription;
  const qty = document.getElementById('unitQuantity'); if (qty) qty.value = item.quantity || 1;
  renderRepairServiceItems();
}
function removeRepairItem(index) { RepairState.serviceItems.splice(index, 1); renderRepairServiceItems(); }
window.addCurrentRepairItem = addCurrentRepairItem; window.editRepairItem = editRepairItem; window.removeRepairItem = removeRepairItem;

// ═══════════════════════════════════════════════════════════════════════════
// Map Variables
// ═══════════════════════════════════════════════════════════════════════════

let map = null;
let customerMarker = null;
let companyMarker = null;
let routeLine = null;
let geocodeTimeout = null;

// ═══════════════════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', function () {
  // Auto-show step 1 (login check is handled server-side)
  // Step 2 is shown when user clicks "Continue"
  setupPhotoPreview();
  setupDragAndDrop();
  setupLocationAutocomplete();
  setupCharCounter();
  setupCashProofPreview();
  setupQuantityControls();
  renderRepairServiceItems();
});

// Quantity stepper for multi-unit repair requests
function setupQuantityControls() {
  const qtyInput = document.getElementById('unitQuantity');
  const minus = document.getElementById('repairQtyMinus');
  const plus = document.getElementById('repairQtyPlus');
  if (!qtyInput) return;
  const clamp = () => {
    let v = parseInt(qtyInput.value, 10);
    if (isNaN(v) || v < 1) v = 1;
    if (v > 999) v = 999;
    qtyInput.value = v;
    RepairState.quantity = v;
  };
  minus?.addEventListener('click', () => { qtyInput.value = Math.max(1, (parseInt(qtyInput.value, 10) || 1) - 1); clamp(); });
  plus?.addEventListener('click', () => { qtyInput.value = Math.min(999, (parseInt(qtyInput.value, 10) || 1) + 1); clamp(); });
  qtyInput.addEventListener('change', clamp);
}

// ═══════════════════════════════════════════════════════════════════════════
// Unit Category Selection (Enterprise Step 2)
// ═══════════════════════════════════════════════════════════════════════════

// Build unitTypesByCategory dynamically from server-provided data
const unitTypesByCategory = {};
(window._serviceCategories || []).forEach(cat => {
  unitTypesByCategory[cat.slug] = (cat.unitTypes || []).map(ut => ({
    value: ut.value, icon: ut.icon || 'bi-circle', label: ut.label
  }));
});
// Fallback if no categories loaded from DB
if (!Object.keys(unitTypesByCategory).length) {
  unitTypesByCategory.aircon = [
    { value: 'Split Type Aircon', icon: 'bi-window', label: 'Split Type' },
    { value: 'Window Type Aircon', icon: 'bi-window', label: 'Window Type' },
    { value: 'Floor Mounted Aircon', icon: 'bi-arrows-expand', label: 'Floor Mounted' },
    { value: 'Cassette Type Aircon', icon: 'bi-grid-3x3', label: 'Cassette Type' },
    { value: 'Central Aircon', icon: 'bi-buildings', label: 'Central' },
  ];
  unitTypesByCategory.appliance = [
    { value: 'Refrigerator', icon: 'bi-reception-4', label: 'Refrigerator' },
    { value: 'Freezer', icon: 'bi-snow', label: 'Freezer' },
    { value: 'Washing Machine', icon: 'bi-droplet-half', label: 'Washing Machine' },
    { value: 'Dryer', icon: 'bi-wind', label: 'Dryer' },
    { value: 'Microwave Oven', icon: 'bi-circle', label: 'Microwave' },
    { value: 'Electric Fan', icon: 'bi-fan', label: 'Electric Fan' },
    { value: 'Rice Cooker', icon: 'bi-fire', label: 'Rice Cooker' },
    { value: 'Water Dispenser', icon: 'bi-cup-straw', label: 'Water Dispenser' },
    { value: 'Electric Kettle', icon: 'bi-cup-hot', label: 'Electric Kettle' },
  ];
  unitTypesByCategory.other = [
    { value: 'Other', icon: 'bi-plus-circle', label: 'Other (specify in problem)' },
  ];
}

function selectUnitCategory(category) {
  // Update active card
  document.querySelectorAll('.unit-category-card').forEach(card => {
    card.classList.toggle('active', card.dataset.category === category);
  });

  // Set hidden input
  const unitTypeInput = document.getElementById('unitType');
  unitTypeInput.value = '';
  RepairState.unitType = '';

  // Show sub-unit chips
  const subSection = document.getElementById('subUnitSection');
  const chipsContainer = document.getElementById('subUnitChips');
  chipsContainer.innerHTML = '';

  const types = unitTypesByCategory[category] || [];
  types.forEach(type => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'sub-unit-chip';
    chip.innerHTML = `<i class="bi ${type.icon}"></i>${type.label}`;
    chip.dataset.value = type.value;
    chip.onclick = function () { selectSubUnit(type.value, this); };
    chipsContainer.appendChild(chip);
  });

  subSection.classList.remove('d-none');
  subSection.classList.add('step-reveal');
}
window.selectUnitCategory = selectUnitCategory;

function selectSubUnit(value, element) {
  // Update active chip
  document.querySelectorAll('.sub-unit-chip').forEach(c => c.classList.remove('active'));
  element.classList.add('active');

  // Update state and hidden input
  RepairState.unitType = value;
  document.getElementById('unitType').value = value;
}
window.selectSubUnit = selectSubUnit;

// ═══════════════════════════════════════════════════════════════════════════
// Symptom Quick-Tap Chips
// ═══════════════════════════════════════════════════════════════════════════

function toggleSymptom(element, symptom) {
  element.classList.toggle('active');

  const textarea = document.getElementById('problemDescription');
  if (!textarea) return;

  const current = textarea.value.trim();

  if (element.classList.contains('active')) {
    // Add symptom to textarea if not already present
    if (!current.includes(symptom)) {
      textarea.value = current ? current + ', ' + symptom : symptom;
    }
  } else {
    // Remove symptom from textarea
    let updated = current.replace(new RegExp(',?\\s*' + symptom.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '').trim();
    if (updated.startsWith(', ')) updated = updated.substring(2);
    if (updated.startsWith(',')) updated = updated.substring(1);
    textarea.value = updated;
  }

  updateCharCount();
}
window.toggleSymptom = toggleSymptom;

// ═══════════════════════════════════════════════════════════════════════════
// Character Counter
// ═══════════════════════════════════════════════════════════════════════════

function setupCharCounter() {
  const textarea = document.getElementById('problemDescription');
  if (!textarea) return;
  textarea.addEventListener('input', updateCharCount);
}

function updateCharCount() {
  const textarea = document.getElementById('problemDescription');
  const counter = document.getElementById('charCount');
  if (!textarea || !counter) return;
  const len = textarea.value.length;
  counter.textContent = `${len} / 500`;
  counter.style.color = len > 500 ? 'var(--color-danger)' : 'var(--gray-400)';
}

// ═══════════════════════════════════════════════════════════════════════════
// Step Navigation
// ═══════════════════════════════════════════════════════════════════════════

function showStep(step) {
  const prevStep = RepairState.currentStep || 1;
  RepairState.currentStep = step;

  // Track highest step reached (never decreases)
  if (!RepairState._maxReachedStep || step > RepairState._maxReachedStep) {
    RepairState._maxReachedStep = step;
  }

  // Sync the ent-stepper if available
  if (typeof updateEntStepper === 'function') {
    updateEntStepper(step);
  }

  // Hide all steps
  document.querySelectorAll('.booking-step').forEach(el => el.classList.add('d-none'));

  // Show target step
  const stepMap = {
    1: '[data-step="1"]',
    2: '#unitInfoStep',
    3: '#locationStep',
    4: '#scheduleStep',
    5: '#reviewStep',
    6: '#paymentStep',
    7: '#confirmationStep',
  };

  const target = document.querySelector(stepMap[step]);
  if (target) {
    target.classList.remove('d-none');
    target.classList.add('step-reveal');
  }

  // If showing step 3, initialize map after DOM settles
  if (step === 3) {
    requestAnimationFrame(() => {
      setTimeout(initMap, 300);
      setTimeout(() => { try { if (map) map.invalidateSize(); } catch(e) {} }, 600);
      setTimeout(() => { try { if (map) map.invalidateSize(); } catch(e) {} }, 1200);
      setTimeout(() => { try { if (map) map.invalidateSize(); } catch(e) {} }, 2500);
      // Restore location input text when navigating back
      if (RepairState.location.address) {
        const locInput = document.getElementById('locationInput');
        if (locInput && !locInput.value) locInput.value = RepairState.location.address;
      }
    });
  }

  // If showing step 4, initialize enterprise calendar
  if (step === 4) {
    requestAnimationFrame(() => {
      setTimeout(initScheduleCalendar, 350);
    });
  }

  // If showing step 5, populate review
  if (step === 5) {
    populateReview();
  }

  // If showing step 6, populate payment summary
  if (step === 6) {
    populateReview();
    prefillCustomerContact();
    if (RepairState.paymentMethod === 'cod') updateCashDisplay();
  }

  // Scroll the target step card into the center of the viewport
  const targetEl = document.querySelector(stepMap[step]);
  if (targetEl) {
    targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
window.showStep = showStep;

// ═══════════════════════════════════════════════════════════════════════════
// Schedule Calendar (Enterprise Calendar for Step 4)
// ═══════════════════════════════════════════════════════════════════════════

let _scheduleCalendarInitialized = false;

async function initScheduleCalendar() {
  // EnterpriseCalendar is loaded via enterprise-calendar.js from the layout
  if (typeof EnterpriseCalendar === 'undefined') {
    console.warn('EnterpriseCalendar not loaded — calendar will not render');
    return;
  }

  if (_scheduleCalendarInitialized) {
    // Already initialized — just re-render in case container was hidden
    EnterpriseCalendar.render();
    return;
  }

  // Estimate total work minutes from quantity. Inspection default 90 min/unit;
  // for larger quantities the work spans multiple days → project mode.
  const qty = Math.max(1, totalRepairUnits());
  RepairState.quantity = qty;
  const perUnitMinutes = 90; // inspection/diagnosis baseline per unit
  const totalEstimatedMinutes = perUnitMinutes * qty;

  await EnterpriseCalendar.init({
    duration: 90,
    quantity: qty,
    totalEstimatedMinutes: totalEstimatedMinutes,
    onSelect(selection) {
      if (EnterpriseCalendar.isProjectMode && EnterpriseCalendar.isProjectMode()) {
        // selection is a project scheduling object (no time slot)
        RepairState.isProject = true;
        RepairState.preferredDate = selection.preferredStartDate || selection.date;
        RepairState.preferredTime = '';
        RepairState.projectScheduling = selection;
        // Large-scale: advance to review after a brief moment for prefs to render
        setTimeout(() => {
          showStep(5);
          if (typeof updateStepper === 'function') updateStepper(5);
        }, 300);
      } else {
        RepairState.preferredDate = selection.date;
        RepairState.preferredTime = selection.slot ? selection.slot.label : '';
        showStep(5);
        if (typeof updateStepper === 'function') updateStepper(5);
      }
    }
  });

  _scheduleCalendarInitialized = true;
}
window.initScheduleCalendar = initScheduleCalendar;

// ═══════════════════════════════════════════════════════════════════════════
// Validation & Continue
// ═══════════════════════════════════════════════════════════════════════════

function validateAndContinue(fromStep) {
  if (fromStep === 2) {
    // Validate unit info
    const unitType = document.getElementById('unitType');
    const brand = document.getElementById('unitBrand');
    const problem = document.getElementById('problemDescription');
    const current = currentRepairItem();

    if (RepairState.serviceItems.length === 0) {
      showAlert('Configure the appliance and click Add Repair Service before continuing.', 'warning');
      return;
    }
    if (!repairItemIsBlank(current)) {
      showAlert('You have appliance details that have not been added. Click Add Repair Service before continuing.', 'warning');
      return;
    }

    // "Add Another Appliance" persists the previous form and intentionally
    // opens a blank form. A blank next form must not block valid saved items.
    if (repairItemIsBlank(current) && RepairState.serviceItems.length > 0) {
      const representative = RepairState.serviceItems[0];
      RepairState.unitType = representative.unitType;
      RepairState.brand = representative.brand;
      RepairState.model = representative.model || '';
      RepairState.problemDescription = representative.problemDescription;
      RepairState.quantity = representative.quantity || 1;
      showStep(3);
      return;
    }

    if (!current.unitType) {
      showAlert('Please select a unit category and type.', 'warning');
      return;
    }
    if (!current.brand) {
      showAlert('Please enter the brand name.', 'warning');
      brand.focus();
      return;
    }
    if (current.problemDescription.length < 10) {
      showAlert('Please describe the problem in at least 10 characters.', 'warning');
      problem.focus();
      return;
    }

    RepairState.unitType = current.unitType;
    RepairState.brand = current.brand;
    RepairState.model = current.model;
    RepairState.problemDescription = current.problemDescription;
    RepairState.quantity = current.quantity;

    showStep(3);
  } else if (fromStep === 3) {
    // Validate location
    if (!RepairState.location.address) {
      showAlert('Please enter your service address.', 'warning');
      document.getElementById('locationInput').focus();
      return;
    }
    if (!RepairState.location.lat || !RepairState.location.lng) {
      showAlert('Please select a valid location from the suggestions or use the map.', 'warning');
      return;
    }

    showStep(4);
  } else if (fromStep === 4) {
    // Validate schedule selection
    if (!RepairState.preferredDate || !RepairState.preferredTime) {
      const errEl = document.getElementById('scheduleError');
      if (errEl) errEl.classList.remove('d-none');
      showAlert('Please select a preferred date and time slot.', 'warning');
      return;
    }
    const errEl = document.getElementById('scheduleError');
    if (errEl) errEl.classList.add('d-none');
    showStep(5);
  }
}
window.validateAndContinue = validateAndContinue;

// ═══════════════════════════════════════════════════════════════════════════
// Photo Preview (Enhanced with drag-and-drop)
// ═══════════════════════════════════════════════════════════════════════════

function setupPhotoPreview() {
  const input = document.getElementById('unitPhotos');
  const preview = document.getElementById('photoPreview');
  if (!input || !preview) return;

  input.addEventListener('change', function () {
    handlePhotoFiles(Array.from(this.files));
  });
}

function setupCashProofPreview() {
  const input = document.getElementById('cashProof');
  const preview = document.getElementById('cashProofPreview');
  if (!input) return;

  input.addEventListener('change', function () {
    const file = this.files[0];
    if (!file) {
      if (preview) { preview.src = ''; preview.classList.add('d-none'); }
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showAlert('Image must be 5MB or smaller.', 'warning');
      this.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
      if (preview) { preview.src = e.target.result; preview.classList.remove('d-none'); }
    };
    reader.readAsDataURL(file);
  });
}

function setupDragAndDrop() {
  const zone = document.getElementById('photoUploadZone');
  const input = document.getElementById('unitPhotos');
  if (!zone || !input) return;

  ['dragenter', 'dragover'].forEach(evt => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach(evt => {
    zone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('dragover');
    });
  });

  zone.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    if (files.length > 0) {
      handlePhotoFiles(files);
    }
  });
}

function handlePhotoFiles(files) {
  const preview = document.getElementById('photoPreview');
  if (!preview) return;

  // Limit to 5 total
  const existing = RepairState.photos.length;
  const allowed = 5 - existing;
  const toAdd = files.slice(0, allowed);

  RepairState.photos = [...RepairState.photos, ...toAdd];
  renderPhotoPreview();
}

function renderPhotoPreview() {
  const preview = document.getElementById('photoPreview');
  if (!preview) return;
  preview.innerHTML = '';

  RepairState.photos.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'photo-preview-item';

    const reader = new FileReader();
    reader.onload = function (e) {
      const img = document.createElement('img');
      img.src = e.target.result;
      img.alt = `Photo ${index + 1}`;
      item.appendChild(img);
    };
    reader.readAsDataURL(file);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'photo-preview-remove';
    removeBtn.innerHTML = '<i class="bi bi-x"></i>';
    removeBtn.onclick = function (e) {
      e.stopPropagation();
      RepairState.photos.splice(index, 1);
      renderPhotoPreview();
    };
    item.appendChild(removeBtn);

    preview.appendChild(item);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Location & Map
// ═══════════════════════════════════════════════════════════════════════════

function getCompanyLocation() {
  // Use dynamically fetched company location, fall back to defaults
  if (window._companyBaseLocation && window._companyBaseLocation.lat && window._companyBaseLocation.lng) {
    return { lat: window._companyBaseLocation.lat, lng: window._companyBaseLocation.lng };
  }
  return { lat: 14.676049, lng: 121.043731 };
}

function initMap() {
  if (map) {
    // Already initialized — just invalidate size in case container was hidden
    setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 200);
    return;
  }

  const mapEl = document.getElementById('technicianMap');
  if (!mapEl) return;

  // Check Leaflet is available
  if (typeof L === 'undefined') {
    console.warn('Leaflet not loaded yet, retrying...');
    setTimeout(initMap, 500);
    return;
  }

  // Use the admin-configured company location
  const companyLoc = getCompanyLocation();

  map = L.map('technicianMap', { zoomControl: false }).setView([companyLoc.lat, companyLoc.lng], 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  // Company marker
  const companyIcon = L.divIcon({
    html: '<div style="background:#2b7de9;width:28px;height:28px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:bold;">&#9650;</div>',
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  companyMarker = L.marker([companyLoc.lat, companyLoc.lng], { icon: companyIcon }).addTo(map);

  // Click on map to set location
  map.on('click', async function (e) {
    const { lat, lng } = e.latlng;
    setCustomerLocation(lat, lng);

    // Reverse geocode via the correct endpoint
    try {
      const resp = await fetch(`/api/geocoding/reverse?lat=${lat}&lon=${lng}`);
      const data = await resp.json();
      if (data && data.display_name) {
        document.getElementById('locationInput').value = data.display_name;
        RepairState.location.address = data.display_name;
      }
    } catch (err) {
      console.warn('Reverse geocode failed:', err);
    }
  });

  // Locate company button
  document.getElementById('locateCompanyBtn')?.addEventListener('click', () => {
    const loc = getCompanyLocation();
    map.setView([loc.lat, loc.lng], 15);
  });

  // Focus customer button
  document.getElementById('focusCustomerBtn')?.addEventListener('click', () => {
    if (RepairState.location.lat && RepairState.location.lng) {
      map.setView([RepairState.location.lat, RepairState.location.lng], 15);
    }
  });

  // Locate customer button (browser geolocation)
  document.getElementById('locateCustomerBtn')?.addEventListener('click', () => {
    if (!navigator.geolocation) {
      showAlert('Geolocation is not supported by your browser.', 'warning');
      return;
    }
    const statusEl = document.getElementById('locationStatus');
    if (statusEl) statusEl.innerHTML = '<i class="bi bi-hourglass-split me-1"></i>Locating...';
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        setCustomerLocation(lat, lng);
        map.setView([lat, lng], 15);

        // Reverse geocode
        try {
          const resp = await fetch(`/api/geocoding/reverse?lat=${lat}&lon=${lng}`);
          const data = await resp.json();
          if (data && data.display_name) {
            document.getElementById('locationInput').value = data.display_name;
            RepairState.location.address = data.display_name;
          }
        } catch (err) {
          console.warn('Reverse geocode failed:', err);
        }
        if (statusEl) statusEl.innerHTML = '<i class="bi bi-check-circle-fill me-1 text-success"></i>Location detected.';
      },
      (err) => {
        console.warn('Geolocation error:', err);
        if (statusEl) {
          let msg = 'Could not detect location.';
          if (err.code === 1) msg = 'Location permission denied. Please allow location access or type your address.';
          else if (err.code === 2) msg = 'Location unavailable. Please type your address.';
          else if (err.code === 3) msg = 'Location request timed out. Please try again or type your address.';
          else msg = 'Could not detect location. Please type your address.';
          statusEl.innerHTML = '<i class="bi bi-exclamation-triangle me-1 text-warning"></i>' + msg;
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });

  // Fix map rendering after container becomes visible
  // Multiple invalidateSize calls to handle slow renders and CSS transitions
  setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 100);
  setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 500);
  setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 1500);
  setTimeout(() => { try { map.invalidateSize(); } catch (e) {} }, 3000);

  // Restore customer marker if location was already set (navigating back to step 3)
  if (RepairState.location.lat && RepairState.location.lng) {
    setTimeout(() => { setCustomerLocation(RepairState.location.lat, RepairState.location.lng); }, 400);
  }
}

function setCustomerLocation(lat, lng) {
  RepairState.location.lat = lat;
  RepairState.location.lng = lng;

  const companyLoc = getCompanyLocation();

  // Update or create customer marker
  const customerIcon = L.divIcon({
    html: '<div style="background:#4ecda4;width:28px;height:28px;border-radius:50%;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;">&#128205;</div>',
    className: '',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });

  if (customerMarker) {
    customerMarker.setLatLng([lat, lng]);
  } else {
    customerMarker = L.marker([lat, lng], { icon: customerIcon }).addTo(map);
  }

  // Fit map to show both markers
  const bounds = L.latLngBounds([
    [companyLoc.lat, companyLoc.lng],
    [lat, lng]
  ]);
  map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });

  // Draw route and calculate distance
  drawRoute(companyLoc.lat, companyLoc.lng, lat, lng);
}

// ═══════════════════════════════════════════════════════════════════════════
// Route & Distance
// ═══════════════════════════════════════════════════════════════════════════

async function drawRoute(fromLat, fromLng, toLat, toLng) {
  // Remove existing route line
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }

  try {
    // OSRM expects coords in "lng,lat;lng,lat" format
    const coords = `${fromLng},${fromLat};${toLng},${toLat}`;
    const resp = await fetch(`/api/services/osrm-route?coords=${encodeURIComponent(coords)}`);
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.routes && data.routes.length > 0) {
        const route = data.routes[0];
        const geom = route.geometry;
        if (geom && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
          const pts = geom.coordinates.map(function(c) { return L.latLng(c[1], c[0]); });
          routeLine = L.polyline(pts, {
            color: '#2b7de9',
            weight: 4,
            opacity: 0.85,
            smoothFactor: 1.2,
            className: 'actual-route',
          }).addTo(map);
        }
        updateDistanceInfo(route.distance / 1000, Math.round(route.duration / 60));
        return;
      }
    }
  } catch (err) {
    console.warn('OSRM route failed, using fallback:', err);
  }

  // Fallback: straight-line dashed route
  const pts = [L.latLng(fromLat, fromLng), L.latLng(toLat, toLng)];
  routeLine = L.polyline(pts, {
    color: '#2b7de9',
    weight: 3,
    opacity: 0.6,
    dashArray: '10, 10',
  }).addTo(map);

  // Fallback: haversine straight-line distance
  const R = 6371;
  const dLat = (toLat - fromLat) * Math.PI / 180;
  const dLng = (toLng - fromLng) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(fromLat * Math.PI / 180) * Math.cos(toLat * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  const distance = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  updateDistanceInfo(distance, Math.round(distance * 2));
}

function updateDistanceInfo(distanceKm, durationMin) {
  RepairState.distanceKm = distanceKm;

  const farePerKm = window._farePerKm || 40;
  const fare = Math.round(distanceKm * farePerKm);
  RepairState.travelFare = fare;

  document.getElementById('mapInfoDistance').textContent = `\u{1F4CD} ${distanceKm.toFixed(1)} km away`;
  document.getElementById('mapInfoFare').textContent = `\u20B1${fare.toLocaleString()} (travel fee)`;
  document.getElementById('mapDistanceInfo').textContent = `${distanceKm.toFixed(1)} km \u2022 ~${durationMin || Math.round(distanceKm * 2)} min`;

  var durEl = document.getElementById('mapInfoDuration');
  if (durEl) {
    var mins = durationMin || Math.round(distanceKm * 2);
    if (mins < 60) {
      durEl.textContent = '~' + mins + ' min travel';
    } else {
      var h = Math.floor(mins / 60);
      var m = mins % 60;
      durEl.textContent = '~' + h + 'h ' + m + 'm travel';
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Address Autocomplete
// ═══════════════════════════════════════════════════════════════════════════

function setupLocationAutocomplete() {
  const input = document.getElementById('locationInput');
  const suggest = document.getElementById('locationSuggest');
  if (!input || !suggest) return;

  input.addEventListener('input', function () {
    clearTimeout(geocodeTimeout);
    const query = this.value.trim();
    if (query.length < 3) {
      suggest.classList.add('d-none');
      return;
    }
    geocodeTimeout = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/services/geocode-suggest?q=${encodeURIComponent(query)}`);
        const data = await resp.json();
        const results = data.suggestions || data || [];
        suggest.innerHTML = '';
        if (!results || !results.length) {
          suggest.classList.add('d-none');
          return;
        }
        results.slice(0, 5).forEach(item => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'list-group-item list-group-item-action';
          btn.textContent = item.display_name || item.label || item.address || '';
          btn.addEventListener('click', () => {
            input.value = btn.textContent;
            RepairState.location.address = btn.textContent;
            suggest.classList.add('d-none');
            if (item.lat && item.lon) {
              setCustomerLocation(parseFloat(item.lat), parseFloat(item.lon));
              if (map) map.setView([parseFloat(item.lat), parseFloat(item.lon)], 15);
            }
          });
          suggest.appendChild(btn);
        });
        suggest.classList.remove('d-none');
      } catch (err) {
        console.warn('Geocode suggest failed:', err);
      }
    }, 400);
  });

  // Close suggestions on outside click
  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !suggest.contains(e.target)) {
      suggest.classList.add('d-none');
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Payment Method
// ═══════════════════════════════════════════════════════════════════════════

function selectPaymentMethod(method) {
  RepairState.paymentMethod = method;
  document.getElementById('selectedPaymentMethod').value = method;

  // Update tab active states
  document.querySelectorAll('.payment-tab, .ent-payment-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.method === method);
  });

  // Toggle fields
  document.getElementById('gcashFields').classList.toggle('d-none', method !== 'gcash');
  document.getElementById('cashFields').classList.toggle('d-none', method !== 'cod');

  // Populate cash display when switching to cash
  if (method === 'cod') updateCashDisplay();
}
window.selectPaymentMethod = selectPaymentMethod;

// Auto-fill customer mobile number from profile
function prefillCustomerContact() {
  var phone = (window.currentUser && window.currentUser.phone) || '';
  if (!phone) return;
  ['gcashNumber', 'cashNumber'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el && !el.value) { el.value = phone; }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Downpayment Calculation
// ═══════════════════════════════════════════════════════════════════════════

function getTotalInitialFee() {
  return ((RepairState.diagnosticFee || 500) * Math.max(1, totalRepairUnits())) + (RepairState.travelFare || 0);
}

function getMinDownpayment() {
  return Math.round(getTotalInitialFee() * (RepairState.downpaymentPercentage || 10) / 100);
}

function updateCashDisplay() {
  const dp = getMinDownpayment();
  const total = getTotalInitialFee();
  const balance = Math.max(0, total - dp);

  // Update downpayment display
  const dpDisplay = document.getElementById('cashDownpaymentDisplay');
  if (dpDisplay) dpDisplay.textContent = `\u20B1${dp.toLocaleString()}`;

  // Update hidden input
  const dpInput = document.getElementById('cashDownpayment');
  if (dpInput) dpInput.value = dp;
  RepairState.downpaymentAmount = dp;

  // Update balance
  const balDisplay = document.getElementById('balanceAmountDisplay');
  if (balDisplay) balDisplay.textContent = `\u20B1${balance.toLocaleString()}`;
  const policyLabel = document.getElementById('repairDownpaymentPolicyLabel');
  if (policyLabel) policyLabel.textContent = `Downpayment (${RepairState.downpaymentPercentage || 10}% of inspection total)`;

  // Update QR code with amount
  const qrImg = document.getElementById('cashQrImage');
  if (qrImg) {
    const gcashNumber = (window.adminGcashNumber || '').trim();
    if (gcashNumber) qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(`GCash|${gcashNumber}|Amount:${dp}`);
    else qrImg.removeAttribute('src');
  }

  RepairState.downpaymentAmount = dp;
}
window.updateCashDisplay = updateCashDisplay;

// ═══════════════════════════════════════════════════════════════════════════
// Review Population
// ═══════════════════════════════════════════════════════════════════════════

function populateReview() {
  // Sync state from the current form fields (unsaved edits in the form)
  const unitType = document.getElementById('unitType');
  const brand = document.getElementById('unitBrand');
  const model = document.getElementById('unitModel');
  const problem = document.getElementById('problemDescription');
  if (unitType && unitType.value) RepairState.unitType = unitType.value;
  if (brand && brand.value.trim()) RepairState.brand = brand.value.trim();
  if (model) RepairState.model = model.value.trim();
  if (problem) RepairState.problemDescription = problem.value.trim();

  // Merge the in-progress (unsaved) form into serviceItems if it has valid data
  const current = currentRepairItem();
  let allItems = [...RepairState.serviceItems];
  if (repairItemIsComplete(current)) {
    // If the current form matches an existing item (was edited), don't double-add
    const alreadySaved = allItems.some(item =>
      item.unitType === current.unitType && item.brand === current.brand && item.problemDescription === current.problemDescription
    );
    if (!alreadySaved) {
      allItems = [...allItems, current];
    }
  }

  // ── Unit Information ──
  const esc = value => String(value || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  if (allItems.length > 0) {
    // Show all items (multi-appliance support)
    if (allItems.length === 1) {
      const item = allItems[0];
      document.getElementById('reviewUnitType').textContent = item.unitType || '-';
      document.getElementById('reviewBrand').textContent = item.brand || '-';
      document.getElementById('reviewModel').textContent = item.model || 'N/A';
      document.getElementById('reviewProblem').textContent = item.problemDescription || '-';
    } else {
      // Multiple items: show summary + details
      const unitTypes = [...new Set(allItems.map(i => i.unitType).filter(Boolean))];
      const brands = [...new Set(allItems.map(i => i.brand).filter(Boolean))];
      document.getElementById('reviewUnitType').textContent = unitTypes.join(', ') || '-';
      document.getElementById('reviewBrand').textContent = brands.join(', ') || '-';
      document.getElementById('reviewModel').textContent = allItems.length + ' appliances';
      document.getElementById('reviewProblem').textContent = allItems.map((item, i) =>
        `${i + 1}. ${esc(item.unitType)} ${esc(item.brand)}: ${esc(item.problemDescription)}`
      ).join(' | ');
    }
  } else {
    document.getElementById('reviewUnitType').textContent = RepairState.unitType || '-';
    document.getElementById('reviewBrand').textContent = RepairState.brand || '-';
    document.getElementById('reviewModel').textContent = RepairState.model || 'N/A';
    document.getElementById('reviewProblem').textContent = RepairState.problemDescription || '-';
  }

  document.getElementById('reviewAddress').textContent = RepairState.location.address || '-';
  document.getElementById('reviewDistance').textContent = RepairState.distanceKm > 0
    ? `${RepairState.distanceKm.toFixed(1)} km from company location`
    : '';

  // Schedule
  const schedEl = document.getElementById('reviewSchedule');
  if (schedEl) {
    if (RepairState.preferredDate && RepairState.preferredTime) {
      const d = new Date(RepairState.preferredDate);
      const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      schedEl.textContent = `${dateStr} at ${RepairState.preferredTime}`;
    } else {
      schedEl.textContent = 'Not selected';
    }
  }

  // Calculate fees
  const diagnosticFee = RepairState.diagnosticFee || 500;
  RepairState.diagnosticFee = diagnosticFee;
  const unitCount = Math.max(1, totalRepairUnits());
  const diagnosticTotal = diagnosticFee * unitCount;
  const total = diagnosticTotal + (RepairState.travelFare || 0);

  document.getElementById('reviewDiagnosticFee').textContent = unitCount > 1
    ? `\u20B1${diagnosticTotal.toLocaleString()} (${unitCount} units)`
    : `\u20B1${diagnosticTotal.toLocaleString()}`;
  document.getElementById('reviewTravelFare').textContent = `\u20B1${(RepairState.travelFare || 0).toLocaleString()}`;
  document.getElementById('reviewTotalFee').textContent = `\u20B1${total.toLocaleString()}`;

  // Downpayment breakdown (cash only)
  const dpSection = document.getElementById('reviewDownpaymentSection');
  if (RepairState.paymentMethod === 'cod') {
    dpSection.classList.remove('d-none');
    const dp = RepairState.downpaymentAmount || getMinDownpayment();
    const balance = Math.max(0, total - dp);
    document.getElementById('reviewDownpayment').textContent = `\u20B1${dp.toLocaleString()}`;
    document.getElementById('reviewBalance').textContent = `\u20B1${balance.toLocaleString()}`;
  } else {
    dpSection.classList.add('d-none');
  }

  // Also populate step 6 payment summary
  const paySvcEl = document.getElementById('paymentServicesSummary');
  const payTotalEl = document.getElementById('paymentTotalFee');
  if (paySvcEl) {
    if (allItems.length > 1) {
      const totalUnits = allItems.reduce((s, i) => s + Math.max(1, Number(i.quantity) || 1), 0);
      paySvcEl.textContent = `${allItems.length} repair appliances (${totalUnits} units)`;
    } else {
      const parts = [RepairState.unitType, RepairState.brand].filter(Boolean);
      paySvcEl.textContent = parts.length ? parts.join(' - ') : (RepairState.problemDescription || 'Repair Service');
    }
  }
  if (payTotalEl) payTotalEl.textContent = `\u20B1${total.toLocaleString()}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Submit Repair Request
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Show repair loading animation modal
 */
function showRepairLoadingModal() {
  try {
    const modal = document.getElementById('repairLoadingModal');
    if (!modal) return;

    if (typeof bootstrap !== 'undefined') {
      const existing = bootstrap.Modal.getInstance(modal);
      if (existing) existing.dispose();

      const bsModal = new bootstrap.Modal(modal, {
        backdrop: 'static',
        keyboard: false
      });
      bsModal.show();
    } else {
      // Fallback
      modal.classList.add('show');
      modal.style.display = 'block';
    }
  } catch (err) {
    console.error('Error showing loading modal:', err);
  }
}

/**
 * Hide repair loading animation modal safely
 */
function hideRepairLoadingModal() {
  try {
    const modal = document.getElementById('repairLoadingModal');
    if (!modal) return;

    // Move focus out of the modal BEFORE hiding to prevent aria-hidden conflict
    if (document.activeElement && modal.contains(document.activeElement)) {
      document.activeElement.blur();
    }

    if (typeof bootstrap !== 'undefined') {
      const bsModal = bootstrap.Modal.getInstance(modal);
      if (bsModal) {
        bsModal.hide();
        // Bootstrap handles aria-hidden, aria-modal, and backdrop cleanup
        return;
      }
    }
    
    // Manual fallback only when Bootstrap is unavailable
    modal.classList.remove('show');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    modal.removeAttribute('aria-modal');
    document.body.classList.remove('modal-open');
    document.querySelectorAll('.modal-backdrop').forEach(bd => bd.remove());
  } catch (err) {
    console.error('Error hiding loading modal:', err);
    document.querySelectorAll('.modal-backdrop').forEach(bd => bd.remove());
    document.body.classList.remove('modal-open');
  }
}

async function submitRepairRequest() {
  const submitBtn = document.getElementById('submitRepairBtn');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = 'Submitting request...';
  }

  // Show loading modal
  showRepairLoadingModal();

  // Safety timeout in case backend hangs
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 seconds

  try {
    // Build FormData for file uploads
    const formData = new FormData();

    // Unit info
    const repairItems = repairItemsForSubmission();
    if (!repairItems.length || repairItems.some(item => !repairItemIsComplete(item))) throw new Error('Every repair appliance must include a unit type, brand, and detailed problem.');
    const representative = repairItems[0];
    formData.append('unitType', representative.unitType);
    formData.append('brand', representative.brand);
    formData.append('model', representative.model || '');
    formData.append('problemDescription', representative.problemDescription);
    formData.append('serviceItems', JSON.stringify(repairItems));

    // Location
    formData.append('address', RepairState.location.address || '');
    formData.append('lat', RepairState.location.lat ?? '');
    formData.append('lng', RepairState.location.lng ?? '');
    formData.append('distanceKm', RepairState.distanceKm || '');
    formData.append('travelFare', RepairState.travelFare || '');

    // Preferred schedule
    if (RepairState.preferredDate) {
      const d = new Date(RepairState.preferredDate);
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      formData.append('preferredDate', `${year}-${month}-${day}`);
    }
    formData.append('preferredTime', RepairState.preferredTime || '');

    // Quantity (multi-unit) + large-scale project
    const submittedUnitCount = repairItems.reduce((sum, item) => sum + Math.max(1, Number(item.quantity) || 1), 0);
    formData.append('quantity', submittedUnitCount);
    if (RepairState.isProject && RepairState.projectScheduling) {
      formData.append('isProject', 'true');
      const ps = RepairState.projectScheduling;
      const psPayload = {
        preferredStartDate: ps.preferredStartDate ? EnterpriseCalendar.formatDateKey(new Date(ps.preferredStartDate)) : null,
        preferredWorkingDays: (ps.preferences && ps.preferences.workingDays) || [],
        preferredWorkingHours: ps.preferences ? { start: ps.preferences.preferredWorkingHours || 'morning', end: '' } : { start: 'morning' },
        preferredCompletionDeadline: (ps.preferences && ps.preferences.completionDeadline) ? EnterpriseCalendar.formatDateKey(new Date(ps.preferences.completionDeadline)) : null,
        estimatedTotalHours: Math.round((90 * submittedUnitCount / 60) * 10) / 10,
        totalUnits: submittedUnitCount,
      };
      formData.append('projectScheduling', JSON.stringify(psPayload));
    }

    // Fees
    formData.append('diagnosticFee', RepairState.diagnosticFee || 500);

    // Payment
    formData.append('paymentMethod', RepairState.paymentMethod);
    if (RepairState.paymentMethod === 'gcash') {
      formData.append('gcashNumber', document.getElementById('gcashNumber')?.value || '');
      const proofFile = document.getElementById('gcashProof')?.files[0];
      if (proofFile) formData.append('gcashProof', proofFile);
    } else {
      // Cash: require downpayment and mobile number
      const dpInput = document.getElementById('cashDownpayment');
      const dpVal = parseFloat(dpInput?.value) || 0;
      const minDp = getMinDownpayment();
      if (dpVal < minDp) {
        showAlert(`The required ${RepairState.downpaymentPercentage || 10}% downpayment is \u20B1${minDp.toLocaleString()}.`, 'warning');
        return;
      }
      const cashNum = document.getElementById('cashNumber')?.value?.trim();
      if (!cashNum) {
        showAlert('Please enter your mobile number for cash bookings.', 'warning');
        return;
      }
      const cashProofFile = document.getElementById('cashProof')?.files[0];
      if (!cashProofFile) {
        showAlert('Please upload a proof of payment for your downpayment.', 'warning');
        return;
      }
      formData.append('cashNumber', cashNum);
      formData.append('downpaymentAmount', dpVal);
      formData.append('cashProof', cashProofFile);
    }

    // Photos
    RepairState.photos.forEach(photo => {
      formData.append('photos', photo);
    });

    const response = await fetch('/api/bookings/create-repair', {
      method: 'POST',
      body: formData,
      credentials: 'same-origin',
      signal: controller.signal
    });

    const result = await response.json();

    if (response.ok && result.success) {
      // Show confirmation
      document.getElementById('confirmationWorkOrder').textContent = result.workOrderNumber || 'WO-XXXXXX';
      
      // Hide modal BEFORE showing step to prevent UI state issues
      hideRepairLoadingModal();
      showStep(7);

      // Show enterprise receipt modal
      var receiptModalEl = document.getElementById('repairReceiptModal');
      if (receiptModalEl) {
        document.getElementById('receiptWorkOrder').textContent = result.workOrderNumber || 'WO-XXXXXX';
        document.getElementById('receiptServiceType').textContent = result.serviceName || 'Repair Service';
        document.getElementById('receiptUnitType').textContent = repairItems.length > 1
          ? `${repairItems.length} repair appliances (${submittedUnitCount} units)`
          : representative.unitType + (representative.brand ? ' - ' + representative.brand : '');
        const receiptDiagnosticTotal = (RepairState.diagnosticFee || 500) * submittedUnitCount;
        document.getElementById('receiptDiagnosticFee').textContent = '\u20B1' + receiptDiagnosticTotal.toLocaleString();
        document.getElementById('receiptTravelFare').textContent = '\u20B1' + (RepairState.travelFare || 0).toLocaleString();
        document.getElementById('receiptTotalFee').textContent = '\u20B1' + (receiptDiagnosticTotal + (RepairState.travelFare || 0)).toLocaleString();
        document.getElementById('receiptDate').textContent = result.createdAt ? new Date(result.createdAt).toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' }) : new Date().toLocaleDateString('en-PH', { year:'numeric', month:'long', day:'numeric' });
        document.getElementById('receiptTime').textContent = RepairState.preferredTime || '—';
        document.getElementById('receiptPayment').textContent = RepairState.paymentMethod === 'gcash' ? 'GCash' : 'Cash';
        // Ensure modal is in body
        if (receiptModalEl.parentElement !== document.body) document.body.appendChild(receiptModalEl);
        receiptModalEl.addEventListener('hidden.bs.modal', () => { window.location.reload(); }, { once: true });
        new bootstrap.Modal(receiptModalEl, { backdrop: 'static' }).show();
      }
    } else {
      let msg = result.message || 'Failed to submit repair request. Please try again.';
      if (result.errors && result.errors.length > 0) {
        msg += '\n• ' + result.errors.join('\n• ');
      }
      hideRepairLoadingModal();
      showAlert(msg, 'error');
    }
  } catch (err) {
    console.error('Repair request submission failed:', err);
    if (err.name === 'AbortError') {
      showAlert('Request timed out. Please try again.', 'error');
    } else {
      showAlert('An error occurred. Please try again.', 'error');
    }
  } finally {
    clearTimeout(timeoutId);
    hideRepairLoadingModal();
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i class="bi bi-check-circle me-2"></i>Submit Repair Request';
    }
  }
}
window.submitRepairRequest = submitRepairRequest;

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

function showAlert(message, type) {
  if (typeof Swal !== 'undefined') {
    const iconMap = { warning: 'warning', error: 'error', success: 'success', info: 'info' };
    Swal.fire({
      icon: iconMap[type] || 'info',
      title: type === 'error' ? 'Error' : type === 'warning' ? 'Attention' : 'Notice',
      text: message,
      confirmButtonColor: '#3b82f6',
    });
  } else {
    alert(message);
  }
}
