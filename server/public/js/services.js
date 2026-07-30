"use strict";







// catalog will be populated from server; fallback array kept empty to avoid render errors.



// `loaded` tracks whether the network request has completed (success or failure).



const servicesCatalog = {



  services: [],



  repairs: [],



  loaded: false,



};







// if the page rendered with preloaded data we can populate the catalog immediately



if (window.initialCatalog) {



  const normalize = (arr, cat) =>



    (arr || []).map((svc) => ({



      icon:



        svc.icon ||



        svc.iconClass ||



        (cat === "repairs" ? "bi-tools" : "bi-gear-fill"),



      name: svc.name || "",



      // support estimatedDurationMinutes for repair services



      duration:



        svc.duration ||



        svc.durationMinutes ||



        svc.estimatedDurationMinutes ||



        0,



      price:



        svc.price ||



        svc.basePrice ||



        (svc.priceRange && svc.priceRange.min) ||



        0,



      _id: svc._id,



      slug: svc.slug,



      ...svc,



    }));



  servicesCatalog.services = normalize(



    window.initialCatalog.coreServices,



    "services",



  );



  servicesCatalog.repairs = normalize(window.initialCatalog.repairs, "repairs");



  servicesCatalog.loaded = true;



}







// network-loaded content lives here; we keep the previous hardcoded entries in



// source control for reference / fallback but the UI will use the server data.







// fetch categories from backend and update `servicesCatalog` accordingly.



// called during initialization and again if the page already has a category



// selected when the data arrives.



async function loadServiceCatalog() {



  try {



    const resp = await fetch("/api/services");



    if (!resp.ok) throw new Error(`status=${resp.status}`);



    const json = await resp.json();



    const normalize = (arr, cat) =>



      (arr || []).map((svc) => ({



        icon:



          svc.icon ||



          svc.iconClass ||



          (cat === "repairs" ? "bi-tools" : "bi-gear-fill"),



        name: svc.name || "",



        // repair services use estimatedDurationMinutes field



        duration:



          svc.duration ||



          svc.durationMinutes ||



          svc.estimatedDurationMinutes ||



          0,



        price:



          svc.price ||



          svc.basePrice ||



          (svc.priceRange && svc.priceRange.min) ||



          0,



        _id: svc._id,



        slug: svc.slug,



        ...svc,



      }));



    servicesCatalog.services = normalize(json.coreServices, "services");



    servicesCatalog.repairs = normalize(json.repairs, "repairs");



  } catch (err) {



    console.warn("Failed to load service catalog", err);



  } finally {



    servicesCatalog.loaded = true;



    // re-render cards if user already chose a category



    if (state.category) {



      renderServiceCards();



    }



  }



}







const TOTAL_STEPS = 7;







const currencyFormatter = new Intl.NumberFormat("en-PH", {



  style: "currency",



  currency: "PHP",



  maximumFractionDigits: 0,



});







const calendarConfig = buildCalendarConfig();



const suggestionTimeSlots = ["08:00 AM", "10:30 AM", "01:30 PM", "03:30 PM"];



const friendlyDateFormatter = new Intl.DateTimeFormat("en-US", {



  weekday: "short",



  month: "short",



  day: "numeric",



});



const calendarStatusLabels = {



  available: "Available slot",



  booked: "Reserved or already booked",



  blocked: "Non-working date",



  public: "Public holiday",



  past: "Past date",



};



const calendarCellFormatter = new Intl.DateTimeFormat("en-US", {



  weekday: "short",



  month: "long",



  day: "numeric",



});



const dom = {};



const state = {



  category: null,



  service: null,



  mode: "manual",



  slot: null,



  suggestion: null,



  issueDescription: "",



  // travel fare (â‚±) computed from distance meter; used when calculating total



  travelFare: 0,



  // base64 data url for proof screenshot file selected by user



  paymentProof: null,



  calendar: {



    activeMonth: startOfMonth(new Date()),



    selectedDate: null,



  },



};







const mapState = {



  element: null,



  map: null,



  markers: {



    technician: null,



    user: null,



  },



  technicianCoords: { lat: 14.676049, lng: 121.043731 },



  // map polyline connecting tech + customer



  route: null,



  // timestamp (ms) of last route calculation (OSRM) to debounce requests



  lastRouteAt: 0,



  // leaflet map readiness not required; map will be created when needed



  apiReady: true,



  mounted: false,



  hasAutoGeolocated: false,



};







const locationState = {



  userCoords: null,



  _initialized: false, // prevents repeat GPS ticks from re-triggering scroll/mode logic



};







// schedule information for the currently selected technician (or global fallback)



const scheduleState = {



  workingDays: [], // array of { dayOfWeek, startMinutes, endMinutes }



  nonWorkingWeekdays: [],



  restDates: new Set(),



};







function resetUserLocationState() {



  locationState.userCoords = null;



  locationState._initialized = false;



  if (dom.locationInput) dom.locationInput.value = "";



  if (dom.locationStatus)



    dom.locationStatus.textContent =



      "We will never store your location without consent.";



  if (mapState.markers?.user) {



    try {



      mapState.markers.user.setMap(null);



    } catch (e) {}



    mapState.markers.user = null;



  }



  // clear travel fare whenever user location is reset



  state.travelFare = 0;



  updateEstimatedFee();



}







if (document.readyState === "loading") {



  document.addEventListener("DOMContentLoaded", initializeServicesPage);



} else {



  initializeServicesPage();



}







function initializeServicesPage() {



  dom.bookingContainer = document.querySelector(".booking-container");



  if (!dom.bookingContainer) {



    return;



  }







  cacheDom();



  // kick off catalog download immediately



  loadServiceCatalog();

  // fetch booking policy (minimum advance notice) for calendar config
  fetchBookingPolicy();







  // sanity-check stepper â†” booking blocks mapping (warn in dev if mismatch)



  try {



    validateStepperMapping();



  } catch (e) {}



  hideAdvancedSteps();



  hydrateTechnicianCoords();



  bindCategoryButtons();



  bindModeButtons();



  bindCalendarNavigation();



  renderCalendarDays();



  // load technician schedule (non-working weekdays & rest dates) and



  // refresh the calendar once the data arrives



  loadTechnicianSchedule();



  ensureInitialDate();



  attachLocationHandlers();



  bindPaymentHandlers();



  bindConfirmHandler();



  try {



    initStepperNav();



  } catch (e) {}



  try {



    updateStepIndicators();



  } catch (e) {}



  // if the location step is already exposed (e.g. returning via back



  // button) make sure the map initializes and starts polling



  try {



    handleLocationStepVisible();



  } catch (e) {}







  try {



    // Resize -> update stepper placement (debounced via requestAnimationFrame inside syncFloatingStepper)



    window.addEventListener("resize", () => {



      try {



        updateStepperVisibility(getCurrentBookingStep());



      } catch (err) {}



      try {



        syncFloatingStepper();



      } catch (err) {}



    });







    // Ensure correct placement after first paint and after page resources load



    requestAnimationFrame(syncFloatingStepper);



    window.addEventListener("load", syncFloatingStepper);







    // Watch booking content for size/structure changes and re-sync (images, dynamic content, expanding panels)



    try {



      const bookingBodyNode = document.querySelector(".booking-body");



      if (bookingBodyNode && window.MutationObserver) {



        const mo = new MutationObserver(() => {



          if (syncFloatingStepper._deb) clearTimeout(syncFloatingStepper._deb);



          syncFloatingStepper._deb = setTimeout(syncFloatingStepper, 80);



        });



        mo.observe(bookingBodyNode, {



          attributes: true,



          childList: true,



          subtree: true,



        });



        // keep reference so we can disconnect later if needed



        syncFloatingStepper._observer = mo;



      }



    } catch (err) {}



  } catch (e) {}



}







function cacheDom() {



  dom.serviceCardsWrapper = document.getElementById("serviceCards");



  dom.serviceSelection = document.getElementById("serviceSelection");



  dom.repairIssueContainer = document.getElementById("repairIssueContainer");



  dom.repairIssue = document.getElementById("repairIssue");



  dom.modeSelection = document.getElementById("modeSelection");



  dom.technicianStep = document.getElementById("technicianStep");



  dom.manualCalendar = document.getElementById("manualCalendar");



  dom.suggestedWrapper = document.getElementById("suggestedDates");



  dom.suggestedCards = document.getElementById("suggestedCards");



  dom.locationStep = document.getElementById("locationStep");



  dom.locationInput = document.getElementById("locationInput");



  dom.locationSuggest = document.getElementById("locationSuggest");



  dom.feeStep = document.getElementById("feeStep");

  dom.servicesTotalDisplay = document.getElementById("servicesTotalDisplay");

  dom.travelFareDisplay = document.getElementById("travelFareDisplay");

  dom.totalFeeDisplay = document.getElementById("totalFeeDisplay");



  dom.paymentStep = document.getElementById("paymentStep");



  dom.confirmStep = document.getElementById("confirmStep");



  dom.timeRangeInfo = document.getElementById("timeRangeInfo");



  dom.categoryButtons = Array.from(document.querySelectorAll(".category-btn"));



  dom.modeButtons = Array.from(document.querySelectorAll(".mode-btn"));



  // toggle mode buttons when tech selection changes



  function updateModeButtonState() {



    if (!dom.modeButtons || dom.modeButtons.length === 0) return;



    dom.modeButtons.forEach((btn) => {



      if (state.technicianId) {



        btn.disabled = false;



        btn.classList.remove("disabled");



      } else {



        btn.disabled = true;



        btn.classList.add("disabled");



      }



    });



  }



  // expose globally if needed



  window.updateModeButtonState = updateModeButtonState;



  dom.estimatedFee = document.getElementById("estimatedFee");



  // technician selector (populated when Step 3 becomes visible)



  dom.technicianSelect = document.getElementById("technicianSelect");



  if (dom.technicianSelect) {



    dom.technicianSelect.addEventListener("change", (e) => {



      state.technicianId = e.target.value || null;



      // enable/disable mode buttons based on choice



      updateModeButtonState();







      // hide scheduling controls and reset any chosen mode/date



      state.mode = null;



      state.calendar.selectedDate = null;



      state.suggestion = null;



      state.slot = null;



      dom.modeSelection?.classList.add("d-none");



      dom.suggestedWrapper?.classList.add("d-none");



      dom.manualCalendar?.classList.add("d-none");



      dom.feeStep?.classList.add("d-none");



      dom.paymentStep?.classList.add("d-none");



      dom.confirmStep?.classList.add("d-none");







      // once a tech is picked we can show the location step right away



      dom.locationStep?.classList.remove("d-none");



      try {



        dom.locationStep?.scrollIntoView({ behavior: "smooth", block: "start" });



      } catch (e) {}



      try { updateStepIndicators(); } catch (e) {}



      // mount the map now that the container is visible â€” deferred so the



      // scroll animation completes before Leaflet measures the container size



      // (stepReveal animation is 380ms; use 650ms to guarantee it finishes)



      setTimeout(() => {



        try { handleLocationStepVisible(); } catch (e) {}



      }, 650);







      // clear any previously cached schedule while the new data loads



      scheduleState.workingDays = [];



      scheduleState.nonWorkingWeekdays = [];



      scheduleState.restDates = new Set();



      calendarConfig.nonWorkingWeekdays = [0];



      calendarConfig.maintenanceDates = new Set();



      renderCalendarDays();







      // refresh availability calendar/slots for selected technician



      try {



        if (state.calendar.selectedDate || state.suggestion) {



          const d = state.calendar.selectedDate || state.suggestion.date;



          renderTimeSlotsForDate(d);



        }



      } catch (err) {}



      // update schedule and map



      try {



        loadTechnicianSchedule();



      } catch (e) {}



      try {



        fetchTechLocation();



      } catch (e) {}



      // if a service already chosen, refresh calendar bookings



      try {



        if (state.service) {



          const monthStart = startOfMonth(state.calendar.activeMonth);



          const monthEnd = addMonths(monthStart, 1);



          loadServiceCalendar(state.service._id, monthStart, monthEnd);



        }



      } catch (e) {}



    });



  }



  dom.timeSelection = document.getElementById("timeSelection");
  dom.timeSelectionDate = document.getElementById("timeSelectionDate");



  dom.timeSlots = document.getElementById("timeSlots");



  dom.timeNotice = document.getElementById("timeNotice");



  dom.calendarGrid = document.getElementById("calendarGrid");



  dom.calendarLabel = document.querySelector("[data-calendar-label]");



  dom.calendarNavButtons = Array.from(



    document.querySelectorAll("[data-calendar-nav]"),



  );



  dom.locationInput = document.getElementById("locationInput");



  dom.locationStatus = document.getElementById("locationStatus");



  dom.detectLocationBtn = document.getElementById("detectLocationBtn");







  // Payment DOM  â€” manual GCash and Cash



  dom.paymentMethodInputs = Array.from(



    document.querySelectorAll('input[name="paymentMethod"]'),



  );



  dom.paymentTabs = Array.from(document.querySelectorAll(".payment-tab")) || [];



  dom.gcashFields = document.getElementById("gcashFields");



  dom.cashFields  = document.getElementById("cashFields");



  dom.gcashNumber = document.getElementById("gcashNumber");



  dom.gcashProof = document.getElementById("gcashProof");



  dom.gcashProofPreview = document.getElementById("gcashProofPreview");



  dom.gcashAmountDisplay = document.getElementById("gcashAmountDisplay");



  dom.cashNumber = document.getElementById("cashNumber");



  dom.cashReference = document.getElementById("cashReference");



  dom.cashProof = document.getElementById("cashProof");



  dom.cashProofPreview = document.getElementById("cashProofPreview");



  dom.cashNotes   = document.getElementById("cashNotes");



  dom.downpaymentAmt = document.getElementById("downpaymentAmt");



  dom.cashBreakdown  = document.getElementById("cashBreakdown");



  dom.cashTotalDisplay   = document.getElementById("cashTotalDisplay");



  dom.cashDownDisplay    = document.getElementById("cashDownDisplay");



  dom.cashBalanceDisplay = document.getElementById("cashBalanceDisplay");



  dom.paymentError  = document.getElementById("paymentError");



  dom.confirmButton = document.getElementById("confirmBooking");







  mapState.element = document.getElementById("technicianMap");



}







function hydrateTechnicianCoords() {



  if (!mapState.element) {



    return;



  }



  const { technicianLat, technicianLng } = mapState.element.dataset;



  const lat = parseFloat(technicianLat);



  const lng = parseFloat(technicianLng);



  if (!Number.isNaN(lat) && !Number.isNaN(lng)) {



    mapState.technicianCoords = { lat, lng };



  }



}







// ---------- step indicator helpers ----------



function getCurrentBookingStep() {



  // derive which logical step the user is currently on (1..7)



  if (!state.category) return 1;



  if (!state.service) return 2;



  if (!state.mode) return 3;



  // picking a mode now happens after location; ensure they have provided



  // coords first (step 4) before allowing mode buttons.



  if (!locationState.userCoords) return 4;



  // once we have coordinates, the next logical step is scheduling (step 5)



  if (!state.calendar.selectedDate && !state.suggestion && !state.slot) return 5;



  if (!state.slot && !state.suggestion) return 5;



  if (!document.querySelector('input[name="paymentMethod"]:checked')) return 6;



  return 7;



}







function updateStepIndicators() {



  // only reveal indicators once the user has proceeded past Step 1



  const current = getCurrentBookingStep();



  const nodes = Array.from(



    document.querySelectorAll(".step-indicator[data-step]"),



  );



  nodes.forEach((el) => {



    const step = Number(el.dataset.step || 0);



    if (current === 1) {



      el.classList.remove("visible", "active", "completed");



      return;



    }



    if (step < current) {



      el.classList.add("visible", "completed");



      el.classList.remove("active");



    } else if (step === current) {



      el.classList.add("visible", "active");



      el.classList.remove("completed");



    } else {



      el.classList.remove("visible", "active", "completed");



    }



  });







  // update horizontal timeline (show only after the user proceeds)



  try {



    updateStepper(current);



  } catch (e) {}



}







function validateStepperMapping() {



  const stepButtons = Array.from(



    document.querySelectorAll("#bookingStepper .stepper-step"),



  );



  const buttonSteps = stepButtons



    .map((b) => Number(b.dataset.step || 0))



    .filter(Boolean);



  const bookingEls = Array.from(



    document.querySelectorAll(".booking-step[data-step]"),



  );



  // only consider visible elements when computing step numbers and duplicates



  const visibleBookingEls = bookingEls.filter(



    (el) => !el.classList.contains("d-none") && el.offsetParent !== null,



  );



  const bookingStepNums = Array.from(



    new Set(



      visibleBookingEls



        .map((el) => Number(el.dataset.step || 0))



        .filter(Boolean),



    ),



  );







  // detect duplicate visible booking-step elements for the same logical step



  const duplicates = visibleBookingEls.reduce((acc, el) => {



    const n = Number(el.dataset.step || 0);



    if (!n) return acc;



    (acc[n] = acc[n] || []).push(el);



    return acc;



  }, {});



  const duplicateEntries = Object.entries(duplicates)



    .filter(([, arr]) => arr.length > 1)



    .map(([k, v]) => ({ step: Number(k), count: v.length }));







  // If multiple booking-step elements for same step are visible, hide extras (keeps UI consistent)



  Object.entries(duplicates).forEach(([stepNum, els]) => {



    const visibleEls = els.filter(



      (el) => !el.classList.contains("d-none") && el.offsetParent !== null,



    );



    if (visibleEls.length > 1) {



      console.warn(



        `Multiple visible booking-step elements for step ${stepNum} â€” hiding duplicates.`,



      );



      // keep the first visible and hide the rest



      visibleEls.slice(1).forEach((el) => el.classList.add("d-none"));



    }



  });







  // When page first loads we may only have a subset of steps visible.  Instead



  // of warning about every later step being "missing" we only care if the



  // visible steps are out-of-order or duplicated.  That means we can bail early



  // as long as the current booking steps form a contiguous prefix of the



  // button list and there are no duplicates.



  if (bookingStepNums.length) {



    const maxVisible = Math.max(...bookingStepNums);



    const expectedPrefix = buttonSteps.filter((s) => s <= maxVisible);



    const prefixOk = expectedPrefix.every((s) => bookingStepNums.includes(s));



    if (prefixOk && duplicateEntries.length === 0) {



      // Nothing worth logging yet



      return;



    }



  }







  const missing = buttonSteps.filter((s) => !bookingStepNums.includes(s));



  const extras = bookingStepNums.filter((s) => !buttonSteps.includes(s));







  if (missing.length || extras.length || duplicateEntries.length) {



    console.warn("Stepper â†” booking-step mapping issues:", {



      buttonSteps,



      bookingStepNums,



      missing,



      extras,



      duplicateEntries,



    });



  } else {



    console.info(



      "Stepper mapping OK â€” steps are sequential and present:",



      buttonSteps,



    );



  }



}







function initTimeline() {



  const tl = document.getElementById("bookingTimeline");



  if (!tl) return;



  const steps = Array.from(tl.querySelectorAll(".tl-step"));



  steps.forEach((btn) => {



    btn.addEventListener("click", () => {



      const step = Number(btn.dataset.step || 0);



      // scroll to the corresponding booking section



      scrollToBookingStep(step);



    });



    btn.addEventListener("keydown", (ev) => {



      if (ev.key === "Enter" || ev.key === " ") {



        ev.preventDefault();



        btn.click();



      }



    });



  });



}







function initStepperNav() {



  const nav = document.getElementById("bookingStepper");



  if (!nav) return;



  const steps = Array.from(nav.querySelectorAll(".stepper-step"));



  steps.forEach((btn) => {



    btn.addEventListener("click", () => {



      const step = Number(btn.dataset.step || 0);



      // scroll to the booking block



      scrollToBookingStep(step);



      // visually update the floating stepper to show steps up to 'step'



      try {



        updateStepper(step);



      } catch (e) {}



    });



    btn.addEventListener("keydown", (ev) => {



      if (ev.key === "Enter" || ev.key === " ") {



        ev.preventDefault();



        btn.click();



      }



    });



  });



}







// Position floating stepper icons so they align with corresponding booking-step blocks (uses data-step mapping)



function syncFloatingStepper() {



  const nav = document.getElementById("bookingStepper");



  if (!nav || !nav.classList.contains("floating")) return;



  const list = nav.querySelector(".stepper-list");



  const steps = Array.from(nav.querySelectorAll(".stepper-step"));



  if (!list || !steps.length) return;







  const bookingBody = document.querySelector(".booking-body");



  if (!bookingBody) return;







  // debounce with requestAnimationFrame for smoothness



  if (syncFloatingStepper._raf) cancelAnimationFrame(syncFloatingStepper._raf);



  syncFloatingStepper._raf = requestAnimationFrame(() => {



    syncFloatingStepper._raf = null;







    const container =



      nav.closest(".booking-container") ||



      document.querySelector(".booking-container");



    try {



      const bodyRect = bookingBody.getBoundingClientRect();



      const containerRect = container.getBoundingClientRect();



      nav.style.top =



        Math.max(0, Math.round(bodyRect.top - containerRect.top)) + "px";



    } catch (e) {}







    // size the stepper-list to the booking content height so the vertical line spans the same area



    const listHeight = Math.max(



      bookingBody.getBoundingClientRect().height,



      bookingBody.scrollHeight,



      360,



    );



    list.style.height = listHeight + "px";



    const listRect = list.getBoundingClientRect();







    const computed = getComputedStyle(nav);



    const iconSize =



      parseFloat(computed.getPropertyValue("--stepper-icon-size")) || 32;







    // logical current step (1..N)



    const current = getCurrentBookingStep();







    // fallback spacing when a matching booking-step can't be found



    const reachedStepsCount = Math.max(



      1,



      steps.filter((b) => Number(b.dataset.step || 0) <= current).length,



    );



    const fallbackGap =



      (listHeight - iconSize) / Math.max(1, reachedStepsCount - 1);







    // ensure a minimum vertical spacing between icons to avoid overlap



    let lastAssignedY = -Infinity;



    const minDistance = Math.round(iconSize + 8);







    steps.forEach((btn, idx) => {



      const li = btn.closest("li");



      if (!li) return;







      // step number from the stepper button (explicit mapping)



      const stepNum = Number(btn.dataset.step || idx + 1);



      // sanitize unexpected step numbers



      if (!Number.isFinite(stepNum) || stepNum < 1) return;







      const reached = stepNum <= current;







      // prefer a visible booking-step for this data-step; if none is visible use fallback spacing



      const target = document.querySelector(



        `.booking-step[data-step="${stepNum}"]:not(.d-none)`,



      );







      // always participate in layout



      li.style.display = "block";







      let translateY;



      if (reached && target) {



        // align to the center of the *visible* booking-step block; if it has no height fall back



        const tRect = target.getBoundingClientRect();



        if (tRect.height > 0) {



          const stepCenter = tRect.top + tRect.height / 2;



          const relCenter = stepCenter - listRect.top; // center relative to stepper-list



          translateY = relCenter - btn.offsetHeight / 2;



        } else {



          // visible target but zero height -> use fallback spacing



          translateY = (stepNum - 1) * fallbackGap;



        }



        li.style.opacity = "1";



      } else if (reached) {



        // reached but no visible booking-step (fallback spacing)



        translateY = (stepNum - 1) * fallbackGap;



        li.style.opacity = "1";



      } else {



        // future steps: place them below the list (out of view)



        translateY =



          listHeight + 24 + (stepNum - current - 1) * (iconSize + 12);



        li.style.opacity = "0";



      }







      // clamp and enforce minimum spacing to avoid visual overlap



      const minY = 4;



      const maxY = Math.max(4, listHeight - iconSize - 4);



      translateY = Math.round(Math.max(minY, Math.min(maxY, translateY)));



      if (



        lastAssignedY !== -Infinity &&



        translateY < lastAssignedY + minDistance



      ) {



        translateY = Math.min(maxY, lastAssignedY + minDistance);



      }



      lastAssignedY = translateY;







      li.style.transform = `translateY(${translateY}px)`;







      // make active step highest in stack so it cannot be visually occluded



      if (stepNum === current) {



        li.style.zIndex = 30;



        btn.classList.add("active");



      } else if (reached) {



        li.style.zIndex = 20;



        btn.classList.remove("active");



      } else {



        li.style.zIndex = 10;



        btn.classList.remove("active");



      }







      // explicit visible / future toggles (keeps CSS classes in sync)



      btn.classList.toggle("visible", reached);



      btn.classList.toggle("future", !reached);







      // accessibility & focus handling



      if (!reached) {



        btn.setAttribute("aria-hidden", "true");



        try {



          btn.tabIndex = -1;



        } catch (e) {}



      } else {



        btn.removeAttribute("aria-hidden");



        try {



          btn.tabIndex = 0;



        } catch (e) {}



      }



    });







    // ensure stepper classes updated for visual parity



    try {



      updateStepperVisibility(current);



    } catch (e) {}



  });



}







function updateTimeline(current) {



  const tl = document.getElementById("bookingTimeline");



  if (!tl) return;



  const fill = tl.querySelector(".tl-fill");



  const steps = Array.from(tl.querySelectorAll(".tl-step"));



  const pct =



    TOTAL_STEPS > 1



      ? ((Math.max(1, Math.min(TOTAL_STEPS, current)) - 1) /



          (TOTAL_STEPS - 1)) *



        100



      : 0;



  if (fill) fill.style.width = pct + "%";



  steps.forEach((btn) => {



    const s = Number(btn.dataset.step || 0);



    btn.classList.toggle("completed", s < current);



    btn.classList.toggle("active", s === current);



    btn.classList.toggle("visible", current > 1);



    btn.setAttribute("aria-current", s === current ? "step" : "false");



  });



  if (current > 1) {



    tl.classList.remove("d-none");



    tl.setAttribute("aria-hidden", "false");



  } else {



    tl.classList.add("d-none");



    tl.setAttribute("aria-hidden", "true");



    if (fill) fill.style.width = "0%";



  }



  try {



    tl.setAttribute("aria-valuenow", String(current));



  } catch (e) {}



}







function updateStepper(current) {



  const nav = document.getElementById("bookingStepper");



  if (!nav) return;



  const steps = Array.from(nav.querySelectorAll(".stepper-step"));







  steps.forEach((btn) => {



    const s = Number(btn.dataset.step || 0);







    // completed / active styling



    btn.classList.toggle("completed", s < current);



    btn.classList.toggle("active", s === current);



    btn.setAttribute("aria-current", s === current ? "step" : "false");







    // visibility rules for floating stepper:



    // - show steps the user has reached (s <= current)



    // - hide future steps (s > current)



    if (nav.classList.contains("floating")) {



      // toggle on the .stepper-step itself so CSS selectors match



      if (s <= current) {



        btn.classList.add("visible");



        btn.classList.remove("future");



        btn.removeAttribute("aria-hidden");



        try {



          btn.tabIndex = 0;



        } catch (e) {}



      } else {



        btn.classList.remove("visible");



        btn.classList.add("future");



        btn.setAttribute("aria-hidden", "true");



        try {



          btn.tabIndex = -1;



        } catch (e) {}



      }



    }



  });







  const list = nav.querySelector(".stepper-list");



  if (!list || !steps.length) return;







  // ensure floating icons are positioned first so getBoundingClientRect() reflects transforms



  try {



    syncFloatingStepper();



  } catch (e) {}







  const firstIcon = steps[0]?.querySelector(".stepper-icon");



  const targetIdx = Math.max(1, Math.min(TOTAL_STEPS, current)) - 1;



  const target = steps[targetIdx];



  const targetIcon = target?.querySelector(".stepper-icon");



  const lastIcon = steps[steps.length - 1]?.querySelector(".stepper-icon");



  if (!firstIcon || !targetIcon || !lastIcon) return;







  const listRect = list.getBoundingClientRect();



  const center = (el) => {



    const r = el.getBoundingClientRect();



    return r.top + r.height / 2 - listRect.top;



  };



  const start = center(firstIcon);



  const end = center(targetIcon);



  const maxEnd = center(lastIcon);



  const height = Math.max(end - start, 0);



  const fullHeight = Math.max(maxEnd - start, 0);







  nav.style.setProperty("--stepper-progress-start", `${start}px`);



  nav.style.setProperty("--stepper-progress", `${height}px`);



  nav.style.setProperty("--stepper-progress-full", `${fullHeight}px`);







  // small "teleport" pop on the active icon to improve perceived motion



  try {



    // remove lingering pop classes



    nav



      .querySelectorAll(".stepper-icon.teleport-pop")



      .forEach((el) => el.classList.remove("teleport-pop"));



    if (targetIcon) {



      targetIcon.classList.add("teleport-pop");



      targetIcon.addEventListener(



        "animationend",



        () => targetIcon.classList.remove("teleport-pop"),



        { once: true },



      );



    }



  } catch (e) {}



}







// Update visibility (show completed + active) without advancing the active indicator



function updateStepperVisibility(current) {



  const nav = document.getElementById("bookingStepper");



  if (!nav) return;







  // hide the long stepper line when the user is still on Step 1 (no category/service chosen)



  if (current === 1) {



    nav.classList.add("no-line");



  } else {



    nav.classList.remove("no-line");



  }







  const steps = Array.from(nav.querySelectorAll(".stepper-step"));



  steps.forEach((btn) => {



    const s = Number(btn.dataset.step || 0);



    btn.classList.toggle("completed", s < current);



    // show only reached steps when floating



    if (nav.classList.contains("floating")) {



      if (s <= current) {



        btn.classList.add("visible");



        btn.classList.remove("future");



        btn.removeAttribute("aria-hidden");



        try {



          btn.tabIndex = 0;



        } catch (e) {}



      } else {



        btn.classList.remove("visible");



        btn.classList.add("future");



        btn.setAttribute("aria-hidden", "true");



        try {



          btn.tabIndex = -1;



        } catch (e) {}



      }



    } else {



      // non-floating: keep everything visible



      btn.classList.add("visible");



      btn.removeAttribute("aria-hidden");



      try {



        btn.tabIndex = 0;



      } catch (e) {}



    }



  });



  try {



    syncFloatingStepper();



  } catch (e) {}



}







function scrollToBookingStep(step) {



  let node = null;



  const allSteps = Array.from(document.querySelectorAll(".booking-step"));



  switch (step) {



    case 1:



      node = allSteps[0] || null;



      break;



    case 2:



      node = document.getElementById("serviceSelection") || allSteps[1] || null;



      break;



    case 3:



      node = document.getElementById("technicianStep") || null;



      break;



    case 4:



      node = document.getElementById("locationStep") || null;



      break;



    case 5:



      // schedule step: prefer to scroll to the active scheduling panel rather



      // than the mode buttons so the user lands straight on the calendar or



      // AI suggestions.  If no panel is visible we fall back to the mode



      // selector.



      const manual = document.getElementById("manualCalendar");



      const suggested = document.getElementById("suggestedDates");



      if (manual && !manual.classList.contains("d-none")) {



        node = manual;



      } else if (suggested && !suggested.classList.contains("d-none")) {



        node = suggested;



      } else {



        node = document.getElementById("modeSelection");



      }



      break;



    case 6:



      node = document.getElementById("feeStep") || null;



      break;



    case 7:



      node = document.getElementById("paymentStep") || null;



      break;



    default:



      node = allSteps[0] || null;



  }



  if (!node) return;



  try {



    // scroll without animation to avoid jittery motion on each step change



    node.scrollIntoView({ behavior: "auto", block: "center" });



    // apply fixed offset in case header overlaps



    setTimeout(() => window.scrollBy({ top: -80, behavior: "auto" }), 20);



  } catch (e) {



    /* noop */



  }



}







function bindCategoryButtons() {



  if (!dom.categoryButtons.length) {



    return;



  }



  dom.categoryButtons.forEach((btn) => {



    btn.addEventListener("click", () => {



      if (!window.LOGGED_IN) {



        alert("Please log in to select a service category.");



        const returnUrl = encodeURIComponent(window.location.pathname);



        window.location = `/login?returnUrl=${returnUrl}`;



        return;



      }



      dom.categoryButtons.forEach((node) => node.classList.remove("active"));



      btn.classList.add("active");



      state.category = btn.dataset.category;



      state.service = null;



      state.slot = null;



      state.issueDescription = "";



      if (dom.repairIssue) dom.repairIssue.value = "";



      if (dom.repairIssueContainer)



        dom.repairIssueContainer.classList.add("d-none");



      resetUserLocationState();



      if (dom.estimatedFee) {



        // resetting selection, clear both base and travel fares



        state.travelFare = 0;



        updateEstimatedFee();



      }



      hideAdvancedSteps();



      renderServiceCards();



      try {



        updateStepIndicators();



      } catch (e) {}



      // defensive re-check: remove duplicates and re-sync floating stepper immediately



      try {



        validateStepperMapping();



      } catch (err) {}



      requestAnimationFrame(() => {



        try {



          syncFloatingStepper();



        } catch (err) {}



      });



      // Auto-scroll to service selection to show "Step 2" header clearly



      setTimeout(() => {



        try {



          dom.serviceSelection?.scrollIntoView({



            behavior: "smooth",



            block: "center",



          });



          setTimeout(() => {



            window.scrollBy({ top: -100, behavior: "smooth" });



            const firstCard =



              dom.serviceCardsWrapper?.querySelector(".service-card");



            if (firstCard) firstCard.focus();



          }, 150);



        } catch (e) {}



      }, 200);



    });



  });



}







function bindModeButtons() {



  if (!dom.modeButtons.length) {



    return;



  }



  dom.modeButtons.forEach((btn) => {



    if (btn.dataset.mode === state.mode) {



      btn.classList.add("active");



    }



    btn.addEventListener("click", (e) => {



      // require technician selection first



      if (!state.technicianId) {



        alert("Please choose a technician before selecting a scheduling mode.");



        return;



      }







      dom.modeButtons.forEach((node) => node.classList.remove("active"));



      btn.classList.add("active");



      state.mode = btn.dataset.mode;







      // if we don't yet know the customer's location, delay showing any



      // calendar or suggestions; instead take the user back to Step 4



      if (!locationState.userCoords) {



        dom.locationStep?.classList.remove("d-none");



        try {



          dom.locationStep?.scrollIntoView({ behavior: "smooth", block: "start" });



        } catch (e) {}



        alert("Please provide your location before picking a schedule.");



        try {



          updateStepIndicators();



        } catch (e) {}



        return;



      }







      toggleScheduleMode();



      try {



        updateStepIndicators();



      } catch (e) {}







      // Auto-reveal the schedule area for the chosen mode and scroll to it



      // (defensive re-assert). At this point we know coords exist so it's safe.



      requestAnimationFrame(() => {



        if (state.mode === "manual") {



          dom.manualCalendar?.classList.remove("d-none");



          dom.manualCalendar?.scrollIntoView({



            behavior: "smooth",



            block: "start",



          });



          // re-assert after next paint in case of a race



          requestAnimationFrame(() =>



            dom.manualCalendar?.classList.remove("d-none"),



          );



        } else {



          dom.suggestedWrapper?.classList.remove("d-none");



          dom.suggestedWrapper?.scrollIntoView({



            behavior: "smooth",



            block: "start",



          });



          requestAnimationFrame(() =>



            dom.suggestedWrapper?.classList.remove("d-none"),



          );



        }



      });



    });



  });



}







function renderServiceCards() {
  // Check if multi-service mode is active (services-multi.js is handling this)
  const multiServiceContainer = document.getElementById('coreServiceCards') || document.getElementById('repairServiceCards');
  if (multiServiceContainer) {
    // Multi-service mode is active, let services-multi.js handle service selection
    return;
  }

  if (!dom.serviceCardsWrapper || !state.category) {

    return;

  }
  dom.serviceSelection.classList.remove("d-none");



  dom.serviceCardsWrapper.innerHTML = "";



  const catalog = servicesCatalog[state.category] || [];



  if (!servicesCatalog.loaded) {



    dom.serviceCardsWrapper.innerHTML =



      "<p class='text-muted'>Loading services&hellip;</p>";



    return;



  }



  if (catalog.length === 0) {



    dom.serviceCardsWrapper.innerHTML =



      "<p class='text-muted'>No services available</p>";



    return;



  }



  catalog.forEach((item) => {



    const column = document.createElement("div");



    column.className = "col-md-4";



    column.innerHTML = `



      <article class="card shadow-sm service-card h-100 p-4 text-center" role="button" tabindex="0">



        <div class="display-6 text-primary mb-3"><i class="bi ${item.icon}"></i></div>



        <h6 class="fw-semibold mb-1">${item.name}</h6>



        <p class="small mb-0">${item.duration} mins Â· ${currencyFormatter.format(item.price)}</p>



      </article>



    `;



    const card = column.querySelector(".service-card");



    card.addEventListener("click", () => handleServiceSelection(item, card));



    card.addEventListener("keydown", (event) => {



      if (event.key === "Enter" || event.key === " ") {



        event.preventDefault();



        handleServiceSelection(item, card);



      }



    });



    dom.serviceCardsWrapper.appendChild(column);



  });







  try {



    updateStepperVisibility(getCurrentBookingStep());



  } catch (e) {}



  // re-validate and reposition the floating stepper after rendering



  try {



    validateStepperMapping();



  } catch (err) {}



  requestAnimationFrame(() => {



    try {



      syncFloatingStepper();



    } catch (err) {}



  });



}







function handleServiceSelection(item, card) {
  // Check if multi-service mode is active - if so, let services-multi.js handle it
  const multiServiceContainer = document.getElementById('coreServiceCards') || document.getElementById('repairServiceCards');
  if (multiServiceContainer) {
    return;
  }

  resetUserLocationState();

  state.service = item;

  state.slot = null;



  state.suggestion = null;



  state.issueDescription = "";



  state.quantity = 1; // Reset quantity to 1

  state.selectedHp = null; // Reset HP selection



  if (dom.repairIssue) dom.repairIssue.value = "";



  dom.serviceSelection



    ?.querySelectorAll(".service-card")



    .forEach((node) => node.classList.remove("active"));



  card.classList.add("active");







  // Show/hide quantity selection based on service

  if (dom.quantitySelection) {

    if (item.allowsQuantity) {

      dom.quantitySelection.classList.remove("d-none");

      document.getElementById("quantityUnit").textContent = item.quantityUnit || "unit";

      document.getElementById("serviceQuantity").max = item.maxQuantity || 10;

      document.getElementById("serviceQuantity").value = 1;

      updateQuantityDisplay();

    } else {

      dom.quantitySelection.classList.add("d-none");

    }

  }



  // Show/hide HP selection based on service

  if (dom.hpSelection) {

    if (item.isAirconService && item.hpPricing && item.hpPricing.length > 0) {

      dom.hpSelection.classList.remove("d-none");

      renderHpOptions(item.hpPricing);

    } else {

      dom.hpSelection.classList.add("d-none");

      state.selectedHp = null;

    }

  }







  // show issue textarea if current category is repairs



  if (dom.repairIssueContainer) {



    if (state.category === "repairs") {



      dom.repairIssueContainer.classList.remove("d-none");



    } else {



      dom.repairIssueContainer.classList.add("d-none");



    }



  }







  // if a technician is already chosen, pulling service may require reloading schedule



  if (state.technicianId) {



    try {



      loadTechnicianSchedule();



    } catch (e) {}



  }







  if (dom.estimatedFee) {



    updateEstimatedFee();



  }



  ensureInitialDate();



  unlockAdvancedSteps();



  try {



    updateStepIndicators();



  } catch (e) {}







  // Hide ALL downstream steps when service changes — old selections
  // (technician, schedule, location) may no longer be valid for the new service.
  dom.locationStep?.classList.add("d-none");

  dom.feeStep?.classList.add("d-none");
  dom.paymentStep?.classList.add("d-none");
  dom.confirmStep?.classList.add("d-none");







  // Do NOT auto-open calendar/suggestions here â€” the user must pick a mode



  // from the Scheduling Mode selector. This prevents jumping directly to



  // Step 5 when no slot has been chosen.



  // (When the user clicks a mode button, `toggleScheduleMode` will reveal



  // the appropriate scheduling UI and still keep the schedule step hidden



  // until a date/time selection is made.)



  const firstMode = dom.modeButtons?.[0];



  try {



    firstMode?.focus();



  } catch (e) {}







  try {



    updateStepperVisibility(getCurrentBookingStep());



  } catch (e) {}







  // fetch any existing bookings so the calendar can show reserved days



  if (state.service) {



    const monthStart = startOfMonth(state.calendar.activeMonth);



    const monthEnd = addMonths(monthStart, 1);



    loadServiceCalendar(state.service._id, monthStart, monthEnd);



  }



}







function hideAdvancedSteps() {



  [



    "technicianStep",



    "modeSelection",



    "suggestedDates",



    "manualCalendar",



    "locationStep",



    "feeStep",



    "paymentStep",



    "confirmStep",



  ].forEach((id) => {



    const section = document.getElementById(id);



    if (section && !section.classList.contains("d-none")) {



      section.classList.add("d-none");



    }



  });



}







function unlockAdvancedSteps() {



  // Reveal only the technician picker (Step 3). Next steps will be



  // unlocked sequentially as the user progresses.



  const section = document.getElementById("technicianStep");



  if (section) {



    section.classList.remove("d-none");



    try {



      loadTechnicianOptions();



    } catch (e) {}



    try {



      section.scrollIntoView({ behavior: "smooth", block: "start" });



    } catch (e) {}



  }







  // Ensure the actual schedule panels remain hidden until the user



  // actively selects a mode + date/time.



  dom.suggestedWrapper?.classList.add("d-none");



  dom.manualCalendar?.classList.add("d-none");







  // Focus the first mode button to guide the user



  const firstMode = dom.modeButtons?.[0];



  try {



    firstMode?.focus();



  } catch (e) {}



}







function toggleScheduleMode() {



  // do not show any scheduling panels until we have customer coordinates



  if (!state.mode || !locationState.userCoords) {



    dom.suggestedWrapper?.classList.add("d-none");



    dom.manualCalendar?.classList.add("d-none");



    dom.locationStep?.classList.remove("d-none");



    try {



      // only scroll if the location step is not already visible in the viewport



      const rect = dom.locationStep?.getBoundingClientRect();



      const alreadyVisible = rect && rect.top >= 0 && rect.bottom <= window.innerHeight;



      if (!alreadyVisible) {



        dom.locationStep?.scrollIntoView({ behavior: "smooth", block: "start" });



      }



    } catch (e) {}



    return;



  }







  if (state.mode === "manual") {



    dom.suggestedWrapper?.classList.add("d-none");



    if (state.service) {



      dom.manualCalendar?.classList.remove("d-none");



      // ensure the step header/text is visible when calendar is shown



      try {



        dom.manualCalendar?.scrollIntoView({



          behavior: "smooth",



          block: "start",



        });



      } catch (e) {}



    }



    renderCalendarDays();







    // Ensure subsequent steps remain hidden until the user selects a date/time



    if (!state.slot && !state.suggestion) {



      dom.feeStep?.classList.add("d-none");



      dom.paymentStep?.classList.add("d-none");



      dom.confirmStep?.classList.add("d-none");



    }



    return;



  }



  if (state.service) {



    renderSuggestedDates();



  } else {



    dom.suggestedWrapper?.classList.add("d-none");



  }



  dom.manualCalendar?.classList.add("d-none");



  renderCalendarDays();







  // fee/payment/confirm remain hidden until a date/time is locked



  if (!state.slot && !state.suggestion) {



    dom.feeStep?.classList.add("d-none");



    dom.paymentStep?.classList.add("d-none");



    dom.confirmStep?.classList.add("d-none");



  }



}

async function renderSuggestedDates() {
  if (!dom.suggestedWrapper || !dom.suggestedCards) {
    return;
  }

  if (!state.service) {
    dom.suggestedWrapper.classList.add("d-none");
    dom.suggestedCards.innerHTML = "";
    return;
  }

  if (!state.technicianId) {
    dom.suggestedWrapper.classList.add("d-none");
    dom.suggestedCards.innerHTML = "";
    return;
  }

  // Show loading state
  dom.suggestedCards.innerHTML = '<div class="col-12"><div class="text-center"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div><p class="mt-2">Loading AI suggested dates...</p></div></div>';
  dom.suggestedWrapper.classList.remove("d-none");

  try {
    // Call new backend API for AI suggested dates
    const response = await fetch(
      `/api/schedule/available-dates?technicianId=${state.technicianId}&serviceId=${state.service._id}&mode=ai-suggested`
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log('ðŸ¤– AI Suggested dates response:', data);

    dom.suggestedCards.innerHTML = "";

    if (!data.availableDates || data.availableDates.length === 0) {
      dom.suggestedWrapper.classList.remove("d-none");
      dom.suggestedCards.innerHTML =
        '<div class="col-12"><div class="alert alert-warning">No suggested dates available right now. Please switch to manual calendar.</div></div>';
      return;
    }

    // Display the suggested dates (top 3)
    data.availableDates.forEach((dateInfo, index) => {
      const column = document.createElement("div");
      column.className = "col-md-4";

      const confidenceColors = ['#28a745', '#17a2b8', '#ffc107'];
      const confidenceLabels = ['Best Match', 'Great Option', 'Good Choice'];
      const color = confidenceColors[index] || '#6c757d';
      const label = confidenceLabels[index] || 'Available';

      column.innerHTML = `
        <article class="suggested-card h-100" role="button" tabindex="0" data-date="${dateInfo.date}">
          <div class="d-flex align-items-center justify-content-between mb-2">
            <span class="badge" style="background-color: ${color}20; color: ${color}">
              ${label}
            </span>
            <span class="badge bg-secondary">${dateInfo.availableSlots || 0} slots</span>
          </div>
          <div class="text-center my-3">
            <div class="display-4 fw-bold text-primary">${dateInfo.dayOfMonth}</div>
            <div class="h5 text-muted">${dateInfo.month}</div>
            <div class="small text-uppercase">${dateInfo.dayName}</div>
          </div>
          <div class="small text-muted text-center">
            <i class="bi bi-clock me-1"></i>
            ${dateInfo.availableSlots || 0} time slots available
          </div>
        </article>
      `;

      // Add click handler
      const card = column.querySelector('.suggested-card');
      card.addEventListener('click', () => {
        // Store the selected date
        state.calendar.selectedDate = new Date(dateInfo.date);
        state.suggestion = {
          date: new Date(dateInfo.date),
          dayName: dateInfo.dayName
        };
        // Load time slots for this date
        const dateObj = new Date(dateInfo.date);
        renderTimeSlotsForDate(dateObj, { scrollToSlots: true });
      });

      dom.suggestedCards.appendChild(column);
    });

    dom.suggestedWrapper.classList.remove("d-none");

    // Scroll to suggested dates
    try {
      dom.suggestedWrapper?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    } catch (e) {}

  } catch (error) {
    console.error('âŒ Error loading AI suggested dates:', error);
    dom.suggestedCards.innerHTML =
      '<div class="col-12"><div class="alert alert-danger">Failed to load suggested dates. Please try manual calendar or refresh the page.</div></div>';
  }
}







function handleSuggestionSelection(entry, card) {



  state.calendar.selectedDate = startOfDay(entry.date);



  state.suggestion = entry;



  state.slot = entry.timeLabel;



  state.slotStart = entry.timeStart;



  dom.suggestedCards



    ?.querySelectorAll(".suggested-card")



    .forEach((node) => node.classList.remove("active"));



  card.classList.add("active");



  renderCalendarDays();



  renderTimeSlotsForDate(entry.date);



  // highlight matching time slot if present



  const match = dom.timeSlots?.querySelector(



    `[data-start="${entry.timeStart}"]`,



  );



  if (match) {



    dom.timeSlots



      ?.querySelectorAll(".ent-time-slot")



      .forEach((n) => n.classList.remove("selected"));



    match.classList.add("active");



  }







  // Suggestion confirmed â€” location is already step 4 (done earlier).



  // Advance forward to the fee step.



  requestAnimationFrame(() => {



    dom.feeStep?.classList.remove("d-none");



    dom.paymentStep?.classList.remove("d-none");



    try { updateEstimatedFee(); } catch (e) {}



    setTimeout(() => {



      try {



        dom.feeStep?.scrollIntoView({ behavior: "smooth", block: "start" });



        setTimeout(() => window.scrollBy({ top: -80, behavior: "smooth" }), 100);



      } catch (e) {}



    }, 100);



  });



  try {



    updateStepIndicators();



    try { scrollToBookingStep(6); } catch (e) {}



  } catch (e) {}



}







function buildSuggestedDates() {

  const results = [];

  const candidates = [];

  

  // Generate candidate dates for the next 30 days

  let cursor = addDays(calendarConfig.minDate, 1);

  let guard = 0;

  

  while (candidates.length < 15 && guard < 60) {

    const status = resolveDateStatus(cursor);

    if (status === "available") {

      candidates.push({

        date: startOfDay(cursor),

        displayDate: friendlyDateFormatter.format(cursor),

        dayOfWeek: cursor.getDay(),

        daysFromToday: Math.floor((cursor - new Date()) / (1000 * 60 * 60 * 24))

      });

    }

    cursor = addDays(cursor, 1);

    guard += 1;

  }

  

  // Score candidates based on AI-like factors

  const scoredCandidates = candidates.map(candidate => {

    let score = 0;

    

    // Factor 1: Time quality (40%) - prefer weekdays, avoid weekends

    const dayOfWeek = candidate.dayOfWeek;

    if (dayOfWeek >= 1 && dayOfWeek <= 5) {

      score += 0.4; // Weekdays are preferred

    } else {

      score += 0.1; // Weekends are less preferred

    }

    

    // Factor 2: Distance from today (25%) - prefer sooner dates but not too soon

    const daysFromToday = candidate.daysFromToday;

    if (daysFromToday >= 2 && daysFromToday <= 14) {

      score += 0.25; // Sweet spot

    } else if (daysFromToday >= 15 && daysFromToday <= 21) {

      score += 0.15; // Still good but less ideal

    } else {

      score += 0.05; // Too soon or too far

    }

    

    // Factor 3: Service time compatibility (25%) - prefer times that work well with service duration

    const serviceDuration = state.service?.duration || 60;

    if (serviceDuration <= 120) {

      score += 0.25; // Short services are flexible

    } else if (serviceDuration <= 240) {

      score += 0.20; // Medium services

    } else {

      score += 0.15; // Long services need more planning

    }

    

    // Factor 4: Random variation (10%) - to provide variety

    score += Math.random() * 0.1;

    

    return {

      ...candidate,

      score: Math.min(score, 1.0)

    };

  });

  

  // Sort by score and take top 3

  scoredCandidates.sort((a, b) => b.score - a.score);

  const topCandidates = scoredCandidates.slice(0, 3);

  

  // Build final suggestions with time slots and confidence levels

  const timeSlots = ["09:00 AM", "11:00 AM", "02:00 PM", "04:00 PM"];

  

  topCandidates.forEach((candidate, index) => {

    const confidence = calculateConfidence(candidate.score);

    const timeLabel = timeSlots[index % timeSlots.length];

    

    // Generate realistic availability windows

    const availableRanges = generateAvailabilityWindows(timeLabel, state.service?.duration || 60);

    

    results.push({

      date: candidate.date,

      displayDate: candidate.displayDate,

      timeLabel,

      timeStart: parseAMPMToMinutes(timeLabel),

      score: candidate.score,

      confidence,

      availableRanges,

      technicianId: state.technicianId || null

    });

  });

  

  return results;

}



function calculateConfidence(score) {

  if (score >= 0.8) {

    return { level: "Excellent", color: "#10b981", icon: "ðŸŽ¯" };

  } else if (score >= 0.6) {

    return { level: "Very Good", color: "#3b82f6", icon: "âœ¨" };

  } else if (score >= 0.4) {

    return { level: "Good", color: "#10b981", icon: "ðŸ‘" };

  } else {

    return { level: "Fair", color: "#f59e0b", icon: "ðŸ’¡" };

  }

}



/**
 * Fetch the booking policy (minimum advance notice) from the server
 * and store it globally so buildCalendarConfig can use it.
 */
async function fetchBookingPolicy() {
  try {
    const resp = await fetch("/api/schedule/booking-policy", { cache: "no-store" });
    if (!resp.ok) return;
    const data = await resp.json();
    window.__bookingPolicy = {
      minAdvanceNoticeMinutes: data.minAdvanceNoticeMinutes || 120,
      earliestAllowedDateTime: data.earliestAllowedDateTime,
    };
    // Update the calendar config with the actual policy values
    if (calendarConfig && data.minAdvanceNoticeMinutes) {
      calendarConfig.minAdvanceNoticeMinutes = data.minAdvanceNoticeMinutes;
      // Recalculate earliest bookable date
      const now = new Date();
      const earliestMs = now.getTime() + data.minAdvanceNoticeMinutes * 60000;
      const earliestDate = new Date(earliestMs);
      const earliestMinutes = earliestDate.getHours() * 60 + earliestDate.getMinutes();
      const workingDayEnd = 19 * 60; // 7:00 PM (includes overtime)
      let newMinDate = startOfDay(earliestDate);
      if (earliestMinutes > workingDayEnd) {
        newMinDate = addDays(startOfDay(earliestDate), 1);
      }
      calendarConfig.minDate = newMinDate;
      calendarConfig.earliestSlotMinutes = earliestMinutes > workingDayEnd
        ? 480
        : Math.max(480, earliestMinutes);
      calendarConfig.earliestBookableDate = earliestDate;
      // Re-render calendar with updated config
      renderCalendarDays();
    }
  } catch (err) {
    console.warn("Failed to load booking policy", err);
    window.__bookingPolicy = { minAdvanceNoticeMinutes: 120 };
  }
}



function generateAvailabilityWindows(baseTime, serviceDuration) {

  const baseMinutes = parseAMPMToMinutes(baseTime);

  const windows = [];

  

  // Create 2-3 availability windows around the base time

  const windowCount = Math.floor(Math.random() * 2) + 2; // 2-3 windows

  

  for (let i = 0; i < windowCount; i++) {

    const offset = (i - 1) * 120; // Spread windows 2 hours apart

    const start = baseMinutes + offset;

    const end = start + 180; // 3-hour windows

    

    // Ensure windows are within business hours (8 AM - 6 PM)

    if (start >= 480 && start <= 1080 && end <= 1260) {

      windows.push({ start, end });

    }

  }

  

  return windows.sort((a, b) => a.start - b.start);

}







function ensureInitialDate() {



  if (state.calendar.selectedDate) {



    return;



  }



  const fallback = findNextAvailableDate(calendarConfig.minDate);



  if (fallback) {



    setSelectedDate(fallback);



  }



}







function findNextAvailableDate(startDate) {



  let cursor = startOfDay(new Date(startDate));



  for (let i = 0; i < 60; i += 1) {



    const status = resolveDateStatus(cursor);



    if (status === "available") {



      return cursor;



    }



    cursor = addDays(cursor, 1);



  }



  return null;



}







function setSelectedDate(date) {



  state.calendar.selectedDate = startOfDay(date);



  state.calendar.activeMonth = startOfMonth(date);



  state.suggestion = null;



  state.slotStart = null;



  if (state.mode === "manual") {



    state.slot = null;



  }







  // Re-render calendar and time slots; scroll to the time-slot section after



  // slots load because the user just picked a date from the calendar.



  renderCalendarDays();



  renderTimeSlotsForDate(date, { scrollToSlots: true });



  try {



    updateStepIndicators();



  } catch (e) {}



  // Note: renderTimeSlotsForDate will handle scrolling after slots are rendered



}







// Add time insights to available calendar dates



async function addTimeInsightToCell(cell, date, dateKey) {



  // Create time insight container



  const insightContainer = document.createElement("div");



  insightContainer.className = "ent-cal-slots";



  insightContainer.textContent = "...";



  cell.appendChild(insightContainer);



  



  try {



    // Fetch availability for this date



    const svcId = state.service?._id || "";



    const url = new URL("/api/services/availability", window.location.origin);



    url.searchParams.set("date", dateKey);



    if (svcId) url.searchParams.set("serviceId", svcId);



    if (state.technicianId) url.searchParams.set("technicianId", state.technicianId);



    



    const resp = await fetch(url.toString(), { cache: "no-store" });



    if (resp.ok) {



      const json = await resp.json();



      const slots = json.slots || [];



      



      // Get working hours for this date



      const workingHours = getWorkingHoursForDate(date);



      if (!workingHours) {



        insightContainer.textContent = "Not working";



        insightContainer.style.color = "rgba(255, 255, 255, 0.6)";



        return;



      }



      



      // Calculate available time ranges



      const availableRanges = calculateAvailableTimeRanges(slots, workingHours, date);



      



      // Format and display the available ranges



      const displayText = formatAvailableRangesForCalendar(availableRanges);



      insightContainer.textContent = displayText;



      



      // Update tooltip with detailed information



      const detailedTooltip = formatDetailedTooltip(availableRanges, workingHours, slots);



      const existingTitle = cell.title;



      cell.title = existingTitle + "\n" + detailedTooltip;



      



    } else {



      insightContainer.textContent = "Error";



      insightContainer.style.color = "rgba(255, 100, 100, 0.8)";



    }



  } catch (err) {



    console.warn("Failed to load time insight for", dateKey, err);



    insightContainer.textContent = "Error";



    insightContainer.style.color = "rgba(255, 100, 100, 0.8)";



  }



}







// Get working hours for a specific date



function getWorkingHoursForDate(date) {



  // Default working hours (can be enhanced with technician-specific schedules)



  const defaultWorkingHours = {



    start: 5 * 60, // 5:00 AM in minutes



    end: 19 * 60   // 7:00 PM in minutes (includes overtime)



  };



  



  // Check if it's a working day



  const dateKey = formatDateKey(date);



  const dow = date.getDay();



  



  // Check non-working weekdays



  if (scheduleState.nonWorkingWeekdays.includes(dow)) {



    return null;



  }



  



  // Check rest dates



  if (scheduleState.restDates.has(dateKey)) {



    return null;



  }



  



  // Check maintenance dates



  if (calendarConfig.maintenanceDates.has(dateKey)) {



    return null;



  }



  



  // Check public holidays



  if (calendarConfig.publicHolidays.has(dateKey)) {



    return null;



  }



  



  // Return working hours (can be enhanced for specific dates)



  return defaultWorkingHours;



}







// Calculate available time ranges by subtracting booked slots from working hours



function calculateAvailableTimeRanges(slots, workingHours, date) {



  const now = new Date();



  const today = startOfDay(now);



  const currentHour = now.getHours();



  const currentMinutes = now.getMinutes();



  const totalCurrentMinutes = currentHour * 60 + currentMinutes;



  const bufferMinutes = 30;



  



  // Filter booked/blocked slots



  const bookedSlots = slots.filter(slot => 



    slot.status === "booked" || slot.status === "blocked"



  );



  



  // Start with full working hours



  let availableRanges = [{



    start: workingHours.start,



    end: workingHours.end



  }];



  



  // For today, adjust start time to account for current time + buffer



  if (isSameDate(date, today)) {



    const earliestStart = totalCurrentMinutes + bufferMinutes;



    if (availableRanges[0].start < earliestStart) {



      availableRanges[0].start = earliestStart;



    }



  }



  



  // Subtract booked slots from available ranges



  bookedSlots.forEach(bookedSlot => {



    const newRanges = [];



    



    availableRanges.forEach(range => {



      // If booked slot doesn't overlap this range, keep it



      if (bookedSlot.endMinutes <= range.start || bookedSlot.startMinutes >= range.end) {



        newRanges.push(range);



      } else {



        // Booked slot overlaps, split the range



        // Add time before booked slot



        if (bookedSlot.startMinutes > range.start) {



          newRanges.push({



            start: range.start,



            end: Math.min(bookedSlot.startMinutes, range.end)



          });



        }



        



        // Add time after booked slot



        if (bookedSlot.endMinutes < range.end) {



          newRanges.push({



            start: Math.max(bookedSlot.endMinutes, range.start),



            end: range.end



          });



        }



      }



    });



    



    availableRanges = newRanges;



  });



  



  // Filter out ranges that are too short (less than 30 minutes)



  availableRanges = availableRanges.filter(range => 



    range.end - range.start >= 30



  );



  



  return availableRanges;



}







// Format available ranges for calendar display



function formatAvailableRangesForCalendar(ranges) {



  if (ranges.length === 0) {



    return "Fully booked";



  }



  



  if (ranges.length === 1) {



    const range = ranges[0];



    const startTime = minutesTo12HourLabel(range.start);



    const endTime = minutesTo12HourLabel(range.end);



    return `${startTime}-${endTime}`;



  }



  



  if (ranges.length === 2) {



    const range1 = ranges[0];



    const range2 = ranges[1];



    const start1 = minutesTo12HourLabel(range1.start);



    const end1 = minutesTo12HourLabel(range1.end);



    const start2 = minutesTo12HourLabel(range2.start);



    const end2 = minutesTo12HourLabel(range2.end);



    return `${start1}-${end1}, ${start2}-${end2}`;



  }



  



  // For 3+ ranges, show simplified format



  const firstStart = minutesTo12HourLabel(ranges[0].start);



  const lastEnd = minutesTo12HourLabel(ranges[ranges.length - 1].end);



  return `${ranges.length} gaps`;



}







// Format detailed tooltip information



function formatDetailedTooltip(availableRanges, workingHours, allSlots) {



  const workingStart = minutesTo12HourLabel(workingHours.start);



  const workingEnd = minutesTo12HourLabel(workingHours.end);



  



  let tooltip = `Working Hours: ${workingStart}-${workingEnd}\n`;



  



  if (availableRanges.length === 0) {



    tooltip += "Status: Fully booked";



  } else if (availableRanges.length === 1) {



    const range = availableRanges[0];



    const startTime = minutesTo12HourLabel(range.start);



    const endTime = minutesTo12HourLabel(range.end);



    tooltip += `Available: ${startTime}-${endTime}`;



  } else {



    tooltip += "Available time slots:\n";



    availableRanges.forEach((range, index) => {



      const startTime = minutesTo12HourLabel(range.start);



      const endTime = minutesTo12HourLabel(range.end);



      tooltip += `  ${index + 1}. ${startTime}-${endTime}\n`;



    });



  }



  



  // Add booked slots info



  const bookedSlots = allSlots.filter(slot => 



    slot.status === "booked" || slot.status === "blocked"



  );



  



  if (bookedSlots.length > 0) {



    tooltip += "\nBooked slots:\n";



    bookedSlots.forEach(slot => {



      tooltip += `  â€¢ ${slot.label}\n`;



    });



  }



  



  return tooltip.trim();



}







function bindCalendarNavigation() {



  if (!dom.calendarNavButtons?.length) {



    return;



  }



  dom.calendarNavButtons.forEach((button) => {



    button.addEventListener("click", () => {



      const direction = button.dataset.calendarNav;



      if (direction === "prev") {



        state.calendar.activeMonth = addMonths(state.calendar.activeMonth, -1);



      } else {



        state.calendar.activeMonth = addMonths(state.calendar.activeMonth, 1);



      }



      renderCalendarDays();



      // refresh booking info when month changes



      if (state.service) {



        const monthStart = startOfMonth(state.calendar.activeMonth);



        const monthEnd = addMonths(monthStart, 1);



        loadServiceCalendar(state.service._id, monthStart, monthEnd);



      }



    });



  });



}







function renderCalendarDays() {



  if (!dom.calendarGrid) {



    return;



  }



  dom.calendarGrid.innerHTML = "";



  const monthStart = startOfMonth(state.calendar.activeMonth);



  const year = monthStart.getFullYear();



  const month = monthStart.getMonth();



  const leadingEmptySlots = new Date(year, month, 1).getDay();



  for (let i = 0; i < leadingEmptySlots; i += 1) {



    const filler = document.createElement("div");



    filler.className = "ent-cal-cell empty";



    filler.setAttribute("aria-hidden", "true");



    dom.calendarGrid.appendChild(filler);



  }



  const daysInMonth = new Date(year, month + 1, 0).getDate();



  for (let day = 1; day <= daysInMonth; day += 1) {



    const current = new Date(year, month, day);



    const dateKey = formatDateKey(current);



    const status = resolveDateStatus(current);



    const cell = document.createElement("button");



    cell.type = "button";



    cell.className = "ent-cal-cell";

    const statusMap = { available: "available", booked: "full", blocked: "non-working", maintenance: "non-working", public: "holiday", past: "past" };
    cell.classList.add(statusMap[status] || "non-working");

    const today = startOfDay(new Date());
    if (isSameDate(current, today)) cell.classList.add("today");



    cell.dataset.status = status;

    cell.innerHTML = `<span class="ent-cal-date">${day}</span>`;



    let labelText = calendarStatusLabels[status] || "Unavailable";



    let extra = "";



    



    // Check if this is today and it's past working hours



    const now = new Date();
    const currentHour = now.getHours();
    const currentMinutes = now.getMinutes();
    const totalCurrentMinutes = currentHour * 60 + currentMinutes;
    const workingDayEndMinutes = 19 * 60; // 7:00 PM (includes overtime)



    



    if (isSameDate(current, today) && totalCurrentMinutes > workingDayEndMinutes && status === "blocked") {



      labelText = "Past working hours";



      extra = " (Booking closed for today)";



    }



    



    if (status === "public" && calendarConfig.publicHolidays.has(dateKey)) {



      extra = ` (${calendarConfig.publicHolidays.get(dateKey)})`;



    }



    if (calendarConfig.nonWorkingDays.has(dateKey)) {



      // note may refer to rest days or specific reason



      const note = calendarConfig.nonWorkingDays.get(dateKey);



      if (note) extra += ` (${note})`;



    }



    const dateLabel = calendarCellFormatter.format(current);



    cell.title = `${dateLabel} Â· ${labelText}${extra}`;



    cell.setAttribute("aria-label", `${dateLabel} â€“ ${labelText}${extra}`);



    cell.setAttribute("aria-pressed", "false");



    if (status !== "available") {



      cell.disabled = true;



      cell.setAttribute("aria-disabled", "true");
      cell.style.pointerEvents = "none";



    } else {



      cell.addEventListener("click", () => setSelectedDate(current));



    }







    // show label inside cell for any non-available status (use a brief form)



    if (status !== "available" && status !== "booked") {



      let shortLabel = labelText;



      if (status === "public") shortLabel = "Holiday";



      else if (status === "blocked") {



        // could be either generic non-work or specific rest/holiday note



        if (calendarConfig.nonWorkingDays.has(dateKey)) {



          const note = calendarConfig.nonWorkingDays.get(dateKey) || "";



          if (note.toLowerCase().includes("rest")) shortLabel = "Rest";



          else shortLabel = "Off";



        } else {



          shortLabel = "Off";



        }



      }



      const span = document.createElement("span");



      span.className = "ent-cal-reason";



      span.textContent = shortLabel;



      cell.appendChild(span);



    } else if (status === "available") {



      // Add available time insights for available dates



      addTimeInsightToCell(cell, current, dateKey);



    }



    if (



      state.calendar.selectedDate &&



      isSameDate(current, state.calendar.selectedDate)



    ) {



      cell.classList.add("selected");



      cell.setAttribute("aria-pressed", "true");



      // Append subtle check icon if not present



      if (!cell.querySelector(".selected-check")) {



        const check = document.createElement("i");



        check.className = "bi bi-check-lg selected-check";



        check.setAttribute("aria-hidden", "true");



        cell.appendChild(check);



      }



    }



    dom.calendarGrid.appendChild(cell);



  }



  updateCalendarLabel();



}







function updateCalendarLabel() {



  if (!dom.calendarLabel) {



    return;



  }



  const formatter = new Intl.DateTimeFormat("en-US", {



    month: "long",



    year: "numeric",



  });



  dom.calendarLabel.textContent = formatter.format(state.calendar.activeMonth);



}







function resolveDateStatus(date) {



  const dateKey = formatDateKey(date);



  const now = new Date();



  const today = startOfDay(now);



  const currentHour = now.getHours();



  const currentMinutes = now.getMinutes();



  const totalCurrentMinutes = currentHour * 60 + currentMinutes;



  



  // Default working hours end at 7 PM (19:00, includes overtime)



  const workingDayEndMinutes = 19 * 60;



  



  // Past dates (before today) are shown distinctly as "past"



  if (date < today) {



    return "past";



  }



  // Check if the date is before the minimum allowed date



  if (date < calendarConfig.minDate) {



    return "blocked";



  }



  



  // Additional check: if this is today and current time is past working hours, block it
  // Also block today if earliest bookable time is past working hours (advance notice)
  if (isSameDate(date, today)) {
    if (totalCurrentMinutes > workingDayEndMinutes) {
      return "blocked";
    }
    // If the earliest slot we can book today is already past working hours, block today
    if (calendarConfig.earliestSlotMinutes >= workingDayEndMinutes) {
      return "blocked";
    }
  }



  



  if (calendarConfig.bookedDates.has(dateKey)) {



    return "booked";



  }



  if (calendarConfig.publicHolidays.has(dateKey)) {



    return "public";



  }



  if (calendarConfig.maintenanceDates.has(dateKey)) {



    return "blocked";



  }



  if (calendarConfig.nonWorkingWeekdays.includes(date.getDay())) {



    return "blocked";



  }



  return "available";



}







function handleLocationStepVisible() {



  if (!dom.locationStep || dom.locationStep.classList.contains("d-none")) {



    return;



  }



  attemptMapMount();



  if (mapState.map) {



    // Leaflet automatically sizes when container is shown



    adjustMapViewport();



  }



}







function attachLocationHandlers() {



  if (dom.detectLocationBtn) {



    dom.detectLocationBtn.addEventListener("click", () =>



      attemptGeolocation(true),



    );



  }



  if (dom.locationInput) {



    // debounce timer for typing suggestions



    let suggestTimer = null;







    // keep track of rendered suggestion buttons for keyboard navigation



    let suggestionButtons = [];



    let highlightedSuggestionIndex = -1;







    function highlightSuggestion(index) {



      if (!dom.locationSuggest) return;



      const buttons = suggestionButtons;



      if (!buttons || !buttons.length) return;



      if (index < 0) index = -1;



      if (index >= buttons.length) index = buttons.length - 1;



      highlightedSuggestionIndex = index;



      buttons.forEach((btn, i) => {



        btn.classList.toggle("active", i === index);



      });



      if (index >= 0) {



        const btn = buttons[index];



        btn.scrollIntoView({ block: "nearest" });



      }



    }







    // fetch suggestions using several providers (guarantee at least one set)



    async function fetchAddressSuggestions(query) {



      console.debug("fetchAddressSuggestions called", query);







      // 1. If Google Places is loaded, try it first for fast predictions



      if (



        window.google &&



        google.maps &&



        google.maps.places &&



        google.maps.places.AutocompleteService



      ) {



        try {



          const predsRes = await new Promise((resolve) => {



            const svc = new google.maps.places.AutocompleteService();



            svc.getPlacePredictions(



              {



                input: query,



                componentRestrictions: { country: ["ph"] },



                bounds: mapState.map ? mapState.map.getBounds().toJSON() : undefined,



              },



              (preds, status) => resolve({ preds, status }),



            );



          });







          if (predsRes && predsRes.status === "OK" && predsRes.preds && predsRes.preds.length) {



            return predsRes.preds.map((p) => ({



              description: p.description,



              placeId: p.place_id,



            }));



          }



          // if Google gave no results, fall through to other providers



        } catch (e) {



          // ignore and fall through to other providers



        }



      }







      // 2. PSGC cloud search (contains administrative divisions)



      try {



        const p = await fetch(



          "/api/psgc/search?q=" + encodeURIComponent(query),



        );



        if (p.ok) {



          const j = await p.json();



          if (j && Array.isArray(j.results) && j.results.length) {



            return j.results.map((s) => ({



              description: s.description || '',



              lat: s.lat,



              lng: s.lng,



            }));



          }



        }



      } catch (err) {



        // fall through



      }







      // 3. Fallback to our nominatim proxy (with optional viewbox bias)



      try {



        let url = "/api/services/geocode-suggest?q=" + encodeURIComponent(query);



        if (mapState.map) {



          const b = mapState.map.getBounds();



          const sw = b.getSouthWest();



          const ne = b.getNorthEast();



          url += `&viewbox=${sw.lng},${sw.lat},${ne.lng},${ne.lat}`;



        }







        let r = await fetch(url);



        let j = null;



        if (r.ok) {



          j = await r.json();



        }







        // If bounding made it too restrictive (no results), retry without bounds.



        if ((!j || !j.suggestions || !j.suggestions.length) && mapState.map) {



          const retryUrl = "/api/services/geocode-suggest?q=" + encodeURIComponent(query);



          const r2 = await fetch(retryUrl);



          if (r2.ok) {



            j = await r2.json();



          }



        }







        return (j?.suggestions || []).map((s) => ({



          description: s.display_name,



          lat: s.lat,



          lng: s.lon,



        }));



      } catch (e) {}







      // final fallback: empty list



      return [];



    }







    function renderSuggestions(items) {



      console.debug("renderSuggestions items", items);



      const box = dom.locationSuggest;



      if (!box) return;



      box.innerHTML = "";



      suggestionButtons = [];



      highlightedSuggestionIndex = -1;



      if (!items || items.length === 0) {



        box.classList.add('d-none');



        return;



      }



      items.forEach((it, index) => {



        const btn = document.createElement("button");



        btn.type = "button";



        btn.className = "list-group-item list-group-item-action";



        btn.textContent = it.description;



        // Prevent input blur from hiding the list before click completes.



        btn.addEventListener("mousedown", (ev) => ev.preventDefault());



        btn.addEventListener("pointerdown", (ev) => ev.preventDefault());



        btn.addEventListener("touchstart", (ev) => ev.preventDefault());



        btn.addEventListener("click", () => onSuggestionSelected(it));



        box.appendChild(btn);



        suggestionButtons.push(btn);



      });



      box.classList.remove("d-none");



      highlightSuggestion(0);



    }







    function hideSuggestions() {



      dom.locationSuggest && dom.locationSuggest.classList.add("d-none");



      suggestionButtons = [];



      highlightedSuggestionIndex = -1;



    }







    async function onSuggestionSelected(item) {



      hideSuggestions();



      dom.locationInput.value = item.description;



      // cancel any ongoing geolocation



      if (locationState.watchId) {



        navigator.geolocation.clearWatch(locationState.watchId);



        locationState.watchId = null;



      }







      if (item.lat && item.lng) {



        const coords = { lat: parseFloat(item.lat), lng: parseFloat(item.lng) };



        locationState.userCoords = coords;



        placeUserMarker(coords, { pan: true });



        setLocationStatus(



          "Address resolved and pinned on the map. Please verify the pin.",



          "success",



        );



        // once we know where the customer is, expose scheduling mode controls



        dom.modeSelection?.classList.remove("d-none");



        // choose manual calendar mode by default once we have the location



        if (!state.mode) state.mode = "manual";



        toggleScheduleMode();



        // map may not yet be initialized; ensure it appears



        attemptMapMount();



        adjustMapViewport();



        // advance the user to the scheduling panel rather than keep



        // the viewport fixed on location



        try { scrollToBookingStep(5); } catch (e) {}



        try { updateStepIndicators(); } catch (e) {}



      } else if (



        item.placeId &&



        window.google &&



        google.maps &&



        google.maps.places



      ) {



        const svc = new google.maps.places.PlacesService(



          document.createElement("div"),



        );



        svc.getDetails(



          { placeId: item.placeId, fields: ["geometry", "formatted_address"] },



          (res, status) => {



            if (



              status === "OK" &&



              res &&



              res.geometry &&



              res.geometry.location



            ) {



              const coords = {



                lat: res.geometry.location.lat(),



                lng: res.geometry.location.lng(),



              };



              locationState.userCoords = coords;



              placeUserMarker(coords);



              dom.locationInput.value =



                res.formatted_address || item.description;



              setLocationStatus(



                "Address resolved and pinned on the map. Please verify the pin.",



                "success",



              );



              dom.modeSelection?.classList.remove("d-none");



              if (!state.mode) state.mode = "manual";



              toggleScheduleMode();



              attemptMapMount();



              adjustMapViewport();



              try { scrollToBookingStep(5); } catch (e) {}



              try { updateStepIndicators(); } catch (e) {}



            }



          },



        );



      }



    }







    // trigger suggestions while typing



    dom.locationInput.addEventListener("input", (e) => {



      const val = String(e.target.value || "").trim();



      clearTimeout(suggestTimer);



      if (!val) {



        hideSuggestions();



        return;



      }



      suggestTimer = setTimeout(async () => {



        let items = await fetchAddressSuggestions(val);



        // if no suggestions at all, attempt simple geocode lookup



        if ((!items || items.length === 0) && val) {



          try {



            const r = await fetch(



              "/api/services/geocode?q=" + encodeURIComponent(val),



            );



            if (r.ok) {



              const g = await r.json();



              if (g && g.lat && g.lon) {



                items = [



                  {



                    description: g.display_name || val,



                    lat: g.lat,



                    lng: g.lon,



                  },



                ];



              }



            }



          } catch (e) {}



        }



        renderSuggestions(items);



      }, 150);



    });







    // also trigger suggestions on focus when there is existing text



    dom.locationInput.addEventListener("focus", async (e) => {



      const val = String(e.target.value || "").trim();



      if (val) {



        const items = await fetchAddressSuggestions(val);



        renderSuggestions(items);



      }



    });







    // unified handler used on blur and when user presses enter



    const processLocationInput = () => {



      const raw = String(dom.locationInput.value || "").trim();



      if (!raw) return;







      // step1: coordinates shortcut



      const coords = parseCoordinateInput(raw);



      if (coords) {



        // if we previously started a geolocation watch, cancel it â€“ the



        // user is explicitly specifying a location now.



        if (locationState.watchId) {



          navigator.geolocation.clearWatch(locationState.watchId);



          locationState.watchId = null;



        }







        locationState.userCoords = coords;



        placeUserMarker(coords);



        setLocationStatus("Pinned custom coordinates on the map.", "success");



        try { updateStepIndicators(); } catch (e) {}



        // expose scheduling controls now that we have a location



        dom.modeSelection?.classList.remove("d-none");



        if (!state.mode) state.mode = "manual";



        toggleScheduleMode();



        // ensure map is mounted and sized correctly



        attemptMapMount();



        setTimeout(() => adjustMapViewport(), 150);



        try { scrollToBookingStep(5); } catch (e) {}



        return;



      }







      // step2: freeâ€‘form address lookup



      setLocationStatus("Resolving address â€” please wait...", "info");



      geocodeAddress(raw)



        .then((res) => {



          if (res) {



            // cancel existing GPS watch - user resolved their own address



            if (locationState.watchId) {



              navigator.geolocation.clearWatch(locationState.watchId);



              locationState.watchId = null;



            }







            const _coords = { lat: res.lat, lng: res.lng };



            locationState.userCoords = _coords;



            placeUserMarker(_coords);



            dom.locationInput.value = res.formatted || raw;



            setLocationStatus(



              "Address resolved and pinned on the map. Please verify the pin.",



              "success",



            );



            try { updateStepIndicators(); } catch (e) {}



            // expose scheduling controls now that we have a location



            dom.modeSelection?.classList.remove("d-none");



            if (!state.mode) state.mode = "manual";



            toggleScheduleMode();



            // ensure map is mounted and sized correctly



            attemptMapMount();



            setTimeout(() => adjustMapViewport(), 150);



            try { scrollToBookingStep(5); } catch (e) {}



            try { updateStepIndicators(); } catch (e) {}



          } else {



            setLocationStatus(



              "Unable to resolve address. Please enter coordinates (lat, lng) or click the map to pin.",



              "danger",



            );



          }



        })



        .catch(() => {



          setLocationStatus(



            "Unable to resolve address. Please enter coordinates (lat, lng) or click the map to pin.",



            "danger",



          );



        });



    };







    dom.locationInput.addEventListener("blur", () => {



      hideSuggestions();



      processLocationInput();



    });



    dom.locationInput.addEventListener("keydown", (e) => {



      if (e.key === "ArrowDown" || e.key === "ArrowUp") {



        if (!suggestionButtons || !suggestionButtons.length) return;



        e.preventDefault();



        const delta = e.key === "ArrowDown" ? 1 : -1;



        const nextIndex =



          (highlightedSuggestionIndex + delta + suggestionButtons.length) %



          suggestionButtons.length;



        highlightSuggestion(nextIndex);



        return;



      }







      if (e.key === "Enter") {



        // If a suggestion is highlighted, select it.



        if (



          highlightedSuggestionIndex >= 0 &&



          highlightedSuggestionIndex < suggestionButtons.length



        ) {



          e.preventDefault();



          suggestionButtons[highlightedSuggestionIndex].click();



          return;



        }



        e.preventDefault();



        processLocationInput();



      }







      if (e.key === "Escape") {



        hideSuggestions();



      }



    });



  }







  // helper utilities used above



  function scrollToLocationStep() {



    // Keep Step 4 visible so user can see the location status.



    // Only scroll if not already in the viewport to avoid bouncing.



    setTimeout(() => {



      try {



        const rect = dom.locationStep?.getBoundingClientRect();



        const alreadyVisible = rect && rect.top >= 0 && rect.bottom <= window.innerHeight;



        if (!alreadyVisible) {



          dom.locationStep?.scrollIntoView({



            behavior: "smooth",



            block: "start",



          });



        }



      } catch (e) {}



    }, 100);



  }



}







// IP Geolocation services with fallback



async function detectIPLocation() {



  const services = [



    {



      name: "server-proxy",



      url: "/api/services/ip-location",



      parse: (data) =>



        data && data.success && data.coords



          ? {



              lat: data.coords.lat,



              lng: data.coords.lng,



              city: data.coords.city,



              country: data.coords.country,



            }



          : null,



    },



    {



      name: "ipapi.co",



      url: "https://ipapi.co/json/",



      parse: (data) => ({



        lat: data.latitude,



        lng: data.longitude,



        city: data.city,



        country: data.country_name,



      }),



    },



    {



      name: "ipwho.is",



      url: "https://ipwho.is/",



      parse: (data) =>



        data && data.success !== false



          ? {



              lat: data.latitude,



              lng: data.longitude,



              city: data.city,



              country: data.country,



            }



          : null,



    },



    {



      name: "ipwhois.app",



      url: "https://ipwhois.app/json/",



      parse: (data) => ({



        lat: parseFloat(data.latitude),



        lng: parseFloat(data.longitude),



        city: data.city,



        country: data.country,



      }),



    },



  ];







  for (const service of services) {



    try {



      console.log(`[Location] Trying IP service: ${service.name}`);



      const controller = new AbortController();



      const timeoutId = setTimeout(() => controller.abort(), 8000);







      const res = await fetch(service.url, {



        signal: controller.signal,



        headers: { Accept: "application/json" },



      });



      clearTimeout(timeoutId);







      if (!res.ok) {



        console.warn(



          `[Location] ${service.name} returned status ${res.status}`,



        );



        continue;



      }







      const data = await res.json();



      console.log(`[Location] ${service.name} response:`, data);







      const coords = service.parse(data);



      if (



        coords &&



        Number.isFinite(Number(coords.lat)) &&



        Number.isFinite(Number(coords.lng))



      ) {



        coords.lat = Number(coords.lat);



        coords.lng = Number(coords.lng);



        console.log(



          `[Location] âœ“ Successfully detected location via ${service.name}:`,



          coords,



        );



        return { success: true, coords, service: service.name };



      } else {



        console.warn(`[Location] ${service.name} returned invalid coordinates`);



      }



    } catch (error) {



      if (error.name === "AbortError") {



        console.warn(`[Location] ${service.name} timeout after 8s`);



      } else {



        console.warn(`[Location] ${service.name} error:`, error.message);



      }



    }



  }







  console.error("[Location] âœ— All IP geolocation services failed");



  return { success: false, error: "All services failed" };



}







function attemptGeolocation(triggeredByUser = false) {



  console.log(



    "[Location] attemptGeolocation called, triggeredByUser:",



    triggeredByUser,



  );







  if (!navigator.geolocation) {



    console.warn("[Location] navigator.geolocation not available");



    if (triggeredByUser) {



      setLocationStatus(



        "Geolocation not available â€” attempting IP lookup...",



        "info",



      );



      performIPGeolocation();



    } else {



      setLocationStatus("Geolocation not supported on this browser.", "danger");



    }



    return;



  }







  // Primary: browser geolocation (if available)



  setLocationStatus("Detecting your location...", "info");



  console.log("[Location] Requesting browser geolocation...");







  if (!locationState.watchId) {



    locationState.watchId = navigator.geolocation.watchPosition(



      (position) => {



        console.log(



          "[Location] âœ“ Browser geolocation success:",



          position.coords,



        );



        const coords = {



          lat: position.coords.latitude,



          lng: position.coords.longitude,



        };



        locationState.userCoords = coords;



        if (dom.locationInput) {



          dom.locationInput.value = `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;



        }



        placeUserMarker(coords, { pan: !locationState._initialized });



        // only run the first-time reveal/scroll once â€” subsequent GPS ticks just update the pin



        if (!locationState._initialized) {



          locationState._initialized = true;



          setLocationStatus(



            "Location detected. You can fine-tune the pin if needed.",



            "success",



          );



          // reveal scheduling controls and default to manual calendar mode



          dom.modeSelection?.classList.remove("d-none");



          if (!state.mode) state.mode = "manual";



          toggleScheduleMode();



          // advance user to the scheduling step



          try { scrollToBookingStep(5); } catch (e) {}



          try { updateStepIndicators(); } catch (e) {}



        }



      },



      (err) => {



        console.warn(



          "[Location] âœ— Browser geolocation failed:",



          err.code,



          err.message,



        );



        // If user initiated the action, try IP-based fallback



        if (triggeredByUser) {



          setLocationStatus(



            "Browser denied geolocation â€” attempting IP-based lookup...",



            "info",



          );



          performIPGeolocation();



        }



      },



      { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 },



    );



  }



}







// Separate function for IP geolocation with better error handling



async function performIPGeolocation() {



  console.log("[Location] Starting IP geolocation...");



  try {



    const result = await detectIPLocation();







    if (result.success) {



      const coords = result.coords;



      locationState.userCoords = coords;



      if (dom.locationInput) {



        dom.locationInput.value = `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;



      }



      placeUserMarker(coords);



      const cityInfo = coords.city



        ? ` (${coords.city}, ${coords.country})`



        : "";



      setLocationStatus(



        `Location approximated (${coords.city}, ${coords.country}). Please verify the pin.`,



        "success",



      );



      console.log("[Location] âœ“ IP geolocation completed successfully");







      // Keep Step 4 visible so user can see the location status message



      setTimeout(() => {



        try {



          dom.locationStep?.scrollIntoView({



            behavior: "smooth",



            block: "center",



          });



          setTimeout(() => {



            window.scrollBy({ top: -80, behavior: "smooth" });



          }, 100);



        } catch (e) {}



      }, 100);







      // reveal scheduling controls (don't show fee/payment yet)



      dom.modeSelection?.classList.remove("d-none");



      if (!state.mode) state.mode = "manual";



      toggleScheduleMode();



      try { scrollToBookingStep(5); } catch (e) {}



      try { updateStepIndicators(); } catch (e) {}



    } else {



      console.error("[Location] âœ— IP geolocation failed completely");



      setLocationStatus(



        "Unable to detect location automatically. Please pin your site, type your address, or enter coordinates (lat, lng).",



        "danger",



      );



    }



  } catch (error) {



    console.error(



      "[Location] âœ— Unexpected error in performIPGeolocation:",



      error,



    );



    setLocationStatus(



      "Location detection error. Please enter your address or coordinates manually.",



      "danger",



    );



  }



}







function setLocationStatus(message, tone = "muted") {



  if (!dom.locationStatus) {



    return;



  }



  dom.locationStatus.className = `location-hint small text-${tone}`;



  dom.locationStatus.textContent = message;



}







// More tolerant coordinate parser â€” accepts "lat,lng", "lat lng", "(lat, lng)", "lat;lng" etc.



function parseCoordinateInput(value) {



  if (!value || typeof value !== "string") return null;



  const normalized = value.trim().replace(/[()\u2013\u2014]/g, " ");



  // Try common separators (comma, semicolon, whitespace)



  const sepMatch = normalized.match(



    /(-?\d+(?:\.\d+)?)[\s,;]+(-?\d+(?:\.\d+)?)/,



  );



  if (!sepMatch) return null;



  const lat = parseFloat(sepMatch[1]);



  const lng = parseFloat(sepMatch[2]);



  if (!isFinite(lat) || !isFinite(lng)) return null;



  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;



  return { lat: lat, lng: lng };



}







// Geocode a freeâ€‘form address using Google Maps JS API (returns null if unavailable/unresolved)



function geocodeAddress(query) {



  return new Promise((resolve) => {



    if (!query) return resolve(null);



    // prefer Google if loaded



    if (window.google && window.google.maps && window.google.maps.Geocoder) {



      try {



        const geocoder = new google.maps.Geocoder();



        geocoder.geocode({ address: String(query) }, (results, status) => {



          if (



            status === "OK" &&



            results &&



            results[0] &&



            results[0].geometry &&



            results[0].geometry.location



          ) {



            const loc = results[0].geometry.location;



            resolve({



              lat: loc.lat(),



              lng: loc.lng(),



              formatted: results[0].formatted_address,



            });



          } else {



            resolve(null);



          }



        });



      } catch (e) {



        resolve(null);



      }



      return;



    }



    // fallback: use our own proxy to avoid CORS issues



    fetch("/api/services/geocode?q=" + encodeURIComponent(query))



      .then((r) => r.json())



      .then((data) => {



        if (data && data.lat && data.lon) {



          resolve({



            lat: parseFloat(data.lat),



            lng: parseFloat(data.lon),



            formatted: data.display_name || query,



          });



        } else {



          resolve(null);



        }



      })



      .catch(() => resolve(null));



  });



}







function placeUserMarker(coords, { pan = false } = {}) {



  if (!mapState.element) {



    return;



  }



  if (!mapState.map) {



    return;



  }



  // customer marker â€” green location pin with white dot



  const greenIcon = L.divIcon({



    className: "",



    html: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">' +



      '<path d="M15 42 C15 42 0 24.5 0 15 A15 15 0 1 1 30 15 C30 24.5 15 42 15 42Z" fill="#4ecda4"/>' +



      '<circle cx="15" cy="15" r="5.5" fill="#fff"/>' +



      '</svg>',



    iconSize: [30, 42],



    iconAnchor: [15, 42],



    popupAnchor: [0, -42],



  });



  if (!mapState.markers.user) {



    mapState.markers.user = L.marker([coords.lat, coords.lng], {



      icon: greenIcon,



    })



      .addTo(mapState.map)



      .bindPopup("Your location");



  } else {



    mapState.markers.user.setLatLng([coords.lat, coords.lng]);



  }







  if (pan) {



    try {



      mapState.map.flyTo([coords.lat, coords.lng], 16, { duration: 0.7 });



      mapState.markers.user.openPopup();



    } catch (e) {



      // ignore



    }



  }







  // Reset the route debounce so OSRM always recalculates immediately when



  // the user places a new location pin â€” ensures road distance (not straight-



  // line) is used from the very first placement.



  mapState.lastRouteAt = 0;



  updateRoute();



  // Leaflet sometimes renders grey tiles when the container size was 0 at



  // mount time.  Force a second invalidate after the browser has repainted.



  // Do NOT call adjustMapViewport here â€” it would trigger a second animated



  // reposition immediately after the first one (causes visible bounce).



  setTimeout(() => {



    try {



      if (mapState.map) {



        mapState.map.invalidateSize();



      }



    } catch (e) {}



  }, 350);



}







// helper used by multiple pieces of logic: update of estimated fee in step 5



function updateEstimatedFee() {



  if (!dom.estimatedFee) return;



  const base   = state.service ? state.service.price : 0;



  const travel = state.travelFare || 0;

  // Add labor fee for project bookings (must match renderPaymentSummary in services.ejs)
  let laborFee = 0;
  if (state.isProject && window._projectLaborRatePerDay > 0 && state.projectScheduling) {
    const ps = state.projectScheduling;
    const workingDays = ps.preferredWorkingDays && ps.preferredWorkingDays.length > 0 ? ps.preferredWorkingDays.length : 1;
    laborFee = window._projectLaborRatePerDay * workingDays;
  } else if (state.laborFee && !state.isProject) {
    laborFee = Number(state.laborFee) || 0;
  }

  const total  = base + travel + laborFee;



  dom.estimatedFee.textContent = currencyFormatter.format(total);



  // Update Step 5 fee breakdown display

  if (dom.servicesTotalDisplay) {

    dom.servicesTotalDisplay.textContent = currencyFormatter.format(base);

  }

  if (dom.travelFareDisplay) {

    dom.travelFareDisplay.textContent = currencyFormatter.format(travel);

  }

  if (dom.totalFeeDisplay) {

    dom.totalFeeDisplay.textContent = currencyFormatter.format(total);

  }

  // Show/hide labor fee row in Step 5
  const laborFeeRow = document.getElementById("laborFeeRow");
  const laborFeeDisplay = document.getElementById("laborFeeDisplay");
  if (laborFeeRow && laborFeeDisplay) {
    if (laborFee > 0) {
      laborFeeRow.style.display = "";
      laborFeeDisplay.textContent = currencyFormatter.format(laborFee);
    } else {
      laborFeeRow.style.display = "none";
    }
  }



  // keep payment panels in sync with latest fee



  try { updateGcashAmountDisplay(); } catch (e) {}



  try { updateCashBreakdown(); }      catch (e) {}



}







// haversine formula returns kilometers between two lat/lng points



function haversineDistance(lat1, lon1, lat2, lon2) {



  const toRad = (x) => (x * Math.PI) / 180;



  const R = 6371; // Earth radius in km



  const dLat = toRad(lat2 - lat1);



  const dLon = toRad(lon2 - lon1);



  const a =



    Math.sin(dLat / 2) * Math.sin(dLat / 2) +



    Math.cos(toRad(lat1)) *



      Math.cos(toRad(lat2)) *



      Math.sin(dLon / 2) *



      Math.sin(dLon / 2);



  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));



  return R * c;



}







// Update the below-map info panel with distance, fare, and optional ETA



function updateMapInfoPanel(km, etaMinutes, etaLabel = "ETA") {



  const FARE_PER_KM = window._farePerKm || 40;



  const fare = (km * FARE_PER_KM).toFixed(2);



  // store travel fare/time â€” actual conditional re-render is handled below







  // only re-render time slots if travel time changed by more than 1 minute



  // â€” avoids wiping the selected slot on every poll / route-redraw cycle



  const prevTravelTime = typeof state.travelTime === "number" ? state.travelTime : -99;



  state.travelFare = parseFloat(fare) || 0;



  state.travelTime = typeof etaMinutes === "number" ? etaMinutes : 0;

  

  // Update Step 6 fee display immediately when travel fare changes

  try {

    updateEstimatedFee();

  } catch (e) {}



  if (



    state.calendar &&



    state.calendar.selectedDate &&



    Math.abs(state.travelTime - prevTravelTime) > 1



  ) {



    try {



      renderTimeSlotsForDate(state.calendar.selectedDate);



    } catch (e) {}



  }







  const distEl = document.getElementById("mapInfoDistance");



  const fareEl = document.getElementById("mapInfoFare");



  if (distEl) {



    let text = `Road distance: ${km.toFixed(1)} km`;



    if (typeof etaMinutes === "number" && etaMinutes > 0) {



      text += ` \u2022 ${etaLabel}: ~${etaMinutes} min`;



    }



    distEl.textContent = text;



  }



  if (fareEl) {



    fareEl.innerHTML = `Distance meter fare: <strong>\u20b1${fare}</strong> <span class="text-muted">(${km.toFixed(1)} km \u00D7 \u20b140)</span>`;



  }







  // after updating the map panel, refresh the estimated fee display



  updateEstimatedFee();



}







// --- Payment handlers and validation ---







/**



 * Update the GCash amount summary box (#gcashAmountDisplay) with the



 * current estimated fee whenever the payment step is shown.



 */



function updateGcashAmountDisplay() {



  if (!dom.gcashAmountDisplay) return;



  const fee = (state.service?.price || 0) + (state.travelFare || 0);



  dom.gcashAmountDisplay.textContent = fee > 0



    ? currencyFormatter.format(fee)



    : "â€”";



}







/**



 * Update the cash breakdown panel (#cashBreakdown) with live totals



 * whenever the user types in the downpayment input.



 */



function updateCashBreakdown() {



  const total = (state.service?.price || 0) + (state.travelFare || 0);



  const down  = parseFloat(dom.downpaymentAmt?.value || "0") || 0;



  const bal   = Math.max(0, total - down);



  const panel = dom.cashBreakdown;



  if (!panel) return;



  if (down > 0 && total > 0) {



    panel.style.display = "";



    if (dom.cashTotalDisplay)   dom.cashTotalDisplay.textContent   = currencyFormatter.format(total);



    if (dom.cashDownDisplay)    dom.cashDownDisplay.textContent    = currencyFormatter.format(down);



    if (dom.cashBalanceDisplay) dom.cashBalanceDisplay.textContent = currencyFormatter.format(bal);



  } else {



    panel.style.display = "none";



  }



}







function bindPaymentHandlers() {



  if (!dom.paymentMethodInputs) return;



  dom.paymentMethodInputs.forEach((input) => {



    input.addEventListener("change", onPaymentMethodChange);



  });







  // payment tabs (visual selectors) â€” sync with radios



  dom.paymentTabs.forEach((tab) => {



    tab.addEventListener("click", () => {



      const method = tab.dataset.method;



      // set active state on tabs



      dom.paymentTabs.forEach((t) => t.classList.toggle("active", t === tab));



      // check matching radio (if exists) and trigger change



      const radio = document.querySelector(



        `input[name="paymentMethod"][value="${method}"]`,



      );



      if (radio) radio.checked = true;



      try {



        onPaymentMethodChange();



      } catch (err) {



        /* noop */



      }



    });



    tab.addEventListener("keydown", (ev) => {



      if (ev.key === "Enter" || ev.key === " ") {



        ev.preventDefault();



        tab.click();



      }



    });



  });







  function syncPaymentTabs() {



    const sel =



      document.querySelector('input[name="paymentMethod"]:checked')?.value ||



      null;



    dom.paymentTabs.forEach((t) =>



      t.classList.toggle("active", t.dataset.method === sel),



    );



  }







  // sync initial visual state with checked radio



  syncPaymentTabs();



  if (dom.gcashNumber) {



    dom.gcashNumber.addEventListener("input", (e) => {



      // allow flexible typing but strip unexpected chars



      e.target.value = e.target.value.replace(/[^0-9+]/g, "").slice(0, 13);



    });



    dom.gcashNumber.addEventListener("blur", (e) =>



      formatGcashNumber(e.target),



    );



  }







  if (dom.cashReference) {



    dom.cashReference.addEventListener("input", (e) => {



      e.target.value = e.target.value.replace(/[^0-9A-Za-z-]/g, "").slice(0, 32);



    });



  }



  if (dom.gcashProof) {



    dom.gcashProof.addEventListener("change", async (e) => {



      const file = e.target.files && e.target.files[0];



      if (!file) {



        state.paymentProof = null;



        if (dom.gcashProofPreview) {



          dom.gcashProofPreview.classList.add("d-none");



          dom.gcashProofPreview.removeAttribute("src");



        }



        return;



      }



      if (!/^image\//i.test(file.type)) {



        alert("Please upload an image file for your GCash receipt.");



        e.target.value = "";



        state.paymentProof = null;



        return;



      }



      try {



        const dataUrl = await readFileAsDataURL(file);



        state.paymentProof = dataUrl;



        if (dom.gcashProofPreview) {



          dom.gcashProofPreview.src = dataUrl;



          dom.gcashProofPreview.classList.remove("d-none");



        }



      } catch (err) {



        console.warn("Failed to read receipt file", err && err.message);



        alert("Could not read the selected receipt file. Please try another image.");



      }



    });



  }



  if (dom.cashProof) {



    dom.cashProof.addEventListener("change", async (e) => {



      const file = e.target.files && e.target.files[0];



      if (!file) {



        state.cashProof = null;



        if (dom.cashProofPreview) {



          dom.cashProofPreview.classList.add("d-none");



          dom.cashProofPreview.removeAttribute("src");



        }



        return;



      }



      if (!/^image\//i.test(file.type)) {



        alert("Please upload an image file for your receipt.");



        e.target.value = "";



        state.cashProof = null;



        return;



      }



      try {



        const dataUrl = await readFileAsDataURL(file);



        state.cashProof = dataUrl;



        if (dom.cashProofPreview) {



          dom.cashProofPreview.src = dataUrl;



          dom.cashProofPreview.classList.remove("d-none");



        }



      } catch (err) {



        console.warn("Failed to read receipt file", err && err.message);



        alert("Could not read the selected receipt file. Please try another image.");



      }



    });



  }



  // Live breakdown update when downpayment amount changes



  if (dom.downpaymentAmt) {



    dom.downpaymentAmt.addEventListener("input", updateCashBreakdown);



    // ensure fixed value for cash method



    dom.downpaymentAmt.value = 400;



    dom.downpaymentAmt.readOnly = true;



  }



  // Ensure confirm visibility reflects initial selection



  updateConfirmVisibility();



}







function onPaymentMethodChange() {



  const selected = document.querySelector(



    'input[name="paymentMethod"]:checked',



  );



  dom.paymentError && (dom.paymentError.style.display = "none");



  // Hide all payment forms first



  dom.gcashFields?.classList.add("d-none");



  dom.cashFields?.classList.add("d-none");



  if (!selected) return;







  // Show the selected payment form



  if (selected.value === "gcash") {



    dom.gcashFields?.classList.remove("d-none");



    // populate gcash amount display with current estimated fee



    updateGcashAmountDisplay();



  } else if (selected.value === "cash") {



    dom.cashFields?.classList.remove("d-none");



    updateCashBreakdown();



  }







  // keep visual tabs in sync with the checked radio



  document.querySelectorAll(".payment-tab").forEach((t) => {



    t.classList.toggle("active", t.dataset.method === selected.value);



    t.setAttribute("aria-pressed", String(t.dataset.method === selected.value));



  });







  // ensure payment step header is visible when user selects a method



  setTimeout(() => {



    try {



      dom.paymentStep?.scrollIntoView({ behavior: "smooth", block: "center" });



      setTimeout(() => {



        window.scrollBy({ top: -80, behavior: "smooth" });



      }, 100);



    } catch (e) {}



  }, 100);







  updateConfirmVisibility();



  try {



    updateStepIndicators();



  } catch (e) {}



}







function updateConfirmVisibility() {



  const selected = document.querySelector(



    'input[name="paymentMethod"]:checked',



  );



  if (!dom.confirmStep) return;



  if (!selected) {



    dom.confirmStep.classList.add("d-none");



    try {



      dom.confirmStep.style.display = "none";



    } catch (e) {}



  } else {



    dom.confirmStep.classList.remove("d-none");



    try {



      dom.confirmStep.style.display = "";



    } catch (e) {}



    // Scroll to show Step 7 header, full payment form, and confirm button



    setTimeout(() => {



      try {



        // Scroll to payment step with "start" to show everything from top



        dom.paymentStep?.scrollIntoView({



          behavior: "smooth",



          block: "start",



        });



      } catch (e) {}



    }, 100);



  }



}







// Card payment handlers removed â€” card payment method deprecated.







function formatGcashNumber(inputEl) {



  if (!inputEl) return;



  let v = inputEl.value.replace(/\s+/g, "");



  v = v.replace(/^\+?0/, "+63"); // leading 0 -> +63



  if (/^9\d{9}$/.test(v)) v = "+63" + v; // 9XXXXXXXXX -> +639XXXXXXXX



  if (/^63\d+/.test(v)) v = "+" + v; // 63XXXXXXXX -> +63XXXXXXXX



  // allow only + and digits



  v = v.replace(/[^+0-9]/g, "");



  inputEl.value = v;



}







function readFileAsDataURL(file) {



  return new Promise((resolve, reject) => {



    const reader = new FileReader();



    reader.onload = () => resolve(reader.result);



    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));



    reader.readAsDataURL(file);



  });



}







function validatePayment() {



  const selected = document.querySelector(



    'input[name="paymentMethod"]:checked',



  );



  if (!selected)



    return { valid: false, message: "Please choose a payment method." };







  if (selected.value === "gcash") {



    // Manual GCash flow: require sender number, reference and receipt proof.



    const phone = (dom.gcashNumber?.value || "").replace(/\s+/g, "");



    if (!phone || (!/^(09|\+639)[0-9]{9}$/.test(phone) && !/^[0-9]{10,13}$/.test(phone.replace(/[^0-9]/g, "")))) {



      return { valid: false, message: "Please enter a valid GCash mobile number used for payment." };



    }







    if (!state.paymentProof) {



      return { valid: false, message: "Please upload your GCash receipt screenshot." };



    }



    return { valid: true };



  }







  if (selected.value === "cash") {



    // Manual cash flow: require phone, reference and receipt, downpayment fixed



    const phone = (dom.cashNumber?.value || "").replace(/\s+/g, "");



    if (!phone || (!/^(09|\+639)[0-9]{9}$/.test(phone) && !/^[0-9]{10,13}$/.test(phone.replace(/[^0-9]/g, "")))) {



      return { valid: false, message: "Please enter a valid mobile number used for payment." };



    }



    const reference = (dom.cashReference?.value || "").trim();



    if (!reference) {



      return { valid: false, message: "Please enter your payment reference number." };



    }



    if (!state.cashProof) {



      return { valid: false, message: "Please upload your receipt screenshot." };



    }



    // downpayment is fixed 400 so no need to check



    return { valid: true };



  }







  return { valid: false, message: "Unsupported payment method." };



}







function bindConfirmHandler() {



  const btn = document.getElementById("confirmBooking");



  if (!btn) return;



  btn.addEventListener("click", handleConfirmBooking);







  // capture issue description



  if (dom.repairIssue) {



    dom.repairIssue.addEventListener("input", (e) => {



      state.issueDescription = e.target.value;



    });



  }



}







async function handleConfirmBooking(e) {



  e.preventDefault();



  const btn = dom.confirmButton || document.getElementById("confirmBooking");



  const originalHtml = btn ? btn.innerHTML : null;







  const setLoading = (isLoading) => {



    if (!btn) return;



    btn.disabled = isLoading;



    if (isLoading) {



      btn.classList.add("btn-loading");



      btn.innerHTML =



        '<i class="bi bi-car-front-fill car-icon me-2" aria-hidden="true"></i>Booking...';



    } else {



      btn.classList.remove("btn-loading");



      if (originalHtml) btn.innerHTML = originalHtml;



    }



  };







  setLoading(true);







  // require authentication before letting customer book



  if (!window.LOGGED_IN) {



    setLoading(false);



    alert("You need to log in before you can book an appointment.");



    // send user to login page with return URL so they can come back



    const returnUrl = encodeURIComponent(window.location.pathname);



    window.location = `/login?returnUrl=${returnUrl}`;



    return;



  }



  // Basic pre-checks



  if (!state.service) {



    setLoading(false);



    alert("Please choose a service first.");



    return;



  }



  if (state.category === "repairs" && !state.issueDescription.trim()) {



    alert("Please describe the issue you want us to fix.");



    if (dom.repairIssue) dom.repairIssue.focus();



    return;



  }



  if (!state.calendar.selectedDate && !state.suggestion) {



    alert("Choose a date first.");



    return;



  }



  if (!state.slot && !state.suggestion) {



    alert("Select a time slot.");



    return;



  }



  // technician must be picked before submitting



  if (!state.technicianId) {



    alert("Please choose a technician before confirming your booking.");



    return;



  }







  // Validate payment



  const v = validatePayment();



  if (!v.valid) {



    if (dom.paymentError) {



      dom.paymentError.textContent = v.message;



      dom.paymentError.style.display = "block";



      dom.paymentStep &&



        dom.paymentStep.scrollIntoView({ behavior: "smooth", block: "start" });



    } else {



      alert(v.message);



    }



    return;



  }







  // build payload - support both single service and multi-service bookings
  const payload = {
    date: formatDateKey(
      state.suggestion ? state.suggestion.date : state.calendar.selectedDate,
    ),
    timeStart:
      state.slotStart || (state.suggestion && state.suggestion.timeStart),
    selectedTimeLabel: state.slot || (state.suggestion && state.suggestion.timeLabel) || "",
  };

  // Check if we have multi-service data
  if (window.BookingSystem && window.BookingSystem.selectedServices().length > 0) {
    // Multi-service booking
    const bookingData = window.BookingSystem.getBookingData();
    payload.services = bookingData.services;
    payload.totalPrice = bookingData.totalPrice;
    payload.repairIssues = bookingData.repairIssues;
    payload.isMultiService = true;
  } else {
    // Single service booking (legacy)
    payload.serviceId = state.service._id;
    payload.isMultiService = false;
  }







  // include payment details



  const selectedMethod =



    document.querySelector('input[name="paymentMethod"]:checked')?.value ||



    null;



  if (selectedMethod) {



    payload.paymentMethod = selectedMethod;



    if (selectedMethod === "gcash") {



      const phone = (dom.gcashNumber?.value || "").trim();
      if (phone) payload.gcashNumber = phone;
      if (state.paymentProof) payload.paymentProof = state.paymentProof;



    }



    if (selectedMethod === "cash") {



      // same fields as gcash but paymentMethod stays cod



      const phone = (dom.cashNumber?.value || "").trim();



      const ref = (dom.cashReference?.value || "").trim();



      if (phone) payload.gcashNumber = phone;



      if (ref) payload.paymentReference = ref;



      if (state.cashProof) payload.paymentProof = state.cashProof;



      payload.downpaymentAmount = 400;



      const notes = dom.cashNotes?.value?.trim();



      if (notes) payload.cashNotes = notes;



    }



  }







  // include location data: always coordinates (if available) and address text if present



  if (locationState.userCoords) {



    payload.customerLocation = {



      lat: locationState.userCoords.lat,



      lng: locationState.userCoords.lng,



    };



    if (dom.locationInput && dom.locationInput.value.trim()) {



      payload.customerLocation.address = dom.locationInput.value.trim();



    }



  }



  if (state.technicianId) {



    payload.technicianId = state.technicianId;



  }



  // send travel fare/time and estimated fee calculated on the client



  if (typeof state.travelFare === "number") {



    payload.travelFare = state.travelFare;



  }



  if (typeof state.travelTime === "number") {



    payload.travelTime = state.travelTime;



  }



  if (typeof state.service?.price === "number" && typeof state.travelFare === "number") {



    payload.estimatedFee = state.service.price + state.travelFare;



  }



  if (state.category === "repairs" && state.issueDescription) {



    payload.issueDescription = state.issueDescription;



  }







  try {



    const resp = await fetch("/api/appointments/create", {



      credentials: "same-origin",



      method: "POST",



      headers: { "Content-Type": "application/json" },



      body: JSON.stringify(payload),



    });



    if (resp.ok) {



      const json = await resp.json();



      const _msgEl  = document.getElementById("bookingResultMessage");



      const _refEl  = document.getElementById("bookingResultReference");



      const _dateEl = document.getElementById("bookingResultDate");



      const _timeEl = document.getElementById("bookingResultTime");



      const _feeEl  = document.getElementById("bookingResultFee");



      if (_refEl)  _refEl.textContent  = json.bookingReference || "";



      if (_dateEl) _dateEl.textContent = json.date || "";



      if (_timeEl) _timeEl.textContent = json.time || "";



      if (_feeEl && json.estimatedFee)



        _feeEl.textContent = "\u20b1" + Number(json.estimatedFee).toFixed(2);



      // Add distance fare display to modal if element exists

      const _distanceEl = document.getElementById("bookingResultDistance");

      const _distanceRow = document.getElementById("bookingResultDistanceRow");

      if (_distanceEl && state.travelFare > 0) {

        const km = (state.travelFare / 40).toFixed(1);

        _distanceEl.innerHTML = `<strong>\u20b1${state.travelFare}</strong> <span class="text-muted">(${km} km \u00D7 \u20b140)</span>`;

        if (_distanceRow) _distanceRow.style.display = 'flex';

      }



      // otherwise show the success modal as before



      if (_msgEl)



        _msgEl.textContent =



          "Your booking request has been submitted and is pending confirmation. A confirmation email has been sent to you.";



      if (window.hideBackdrop) hideBackdrop();



      const _modalEl = document.getElementById("bookingResultModal");



      if (_modalEl) {

        // Position modal on same screen as confirm button

        _modalEl.style.zIndex = '9999';

        const _bm = new bootstrap.Modal(_modalEl, { backdrop: 'static', keyboard: false });



        _modalEl.addEventListener("hidden.bs.modal", () => {



          window.location.href = "/book-history";



        }, { once: true });

        

        // Scroll modal into view on same screen

        _modalEl.addEventListener('shown.bs.modal', function() {

          _modalEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

        }, { once: true });



        _bm.show();



      } else {



        alert("Booking confirmed! Reference: " + (json.bookingReference || ""));



        window.location.href = "/book-history";



      }



    } else if (resp.status === 401) {



      alert("Please log in to complete the booking.");



      window.location = "/login";



    } else if (resp.status === 409) {



      // server returns exact conflicting time range in the error message



      let conflictMsg = "That time slot overlaps an existing booking. Please choose a different time.";



      try { const _d = await resp.json(); if (_d && _d.error) conflictMsg = _d.error; } catch (_) {}



      alert(conflictMsg);



    } else if (!resp.ok) {



      // try to show server error message if available



      let msg = `status=${resp.status}`;



      try {



        const data = await resp.json();



        if (data && data.error) msg = data.error;



      } catch (e) {}



      throw new Error(msg);



    } else {



      throw new Error(`status=${resp.status}`);



    }



  } catch (err) {



    console.error("booking failed", err);



    const fetchFailed =



      err &&



      (err.name === "TypeError" || /failed to fetch|networkerror|network error/i.test(String(err.message || err)));



    if (fetchFailed) {



      alert(



        `Cannot reach the server at ${window.location.origin}.\n\n` +



          `Check that the app server is running and reachable from this device/network, then try again.`,



      );



      return;



    }



    alert(



      `Failed to submit booking: ${err.message}. Please try again or contact support.`,



    );



  } finally {



    setLoading(false);



  }



}



// Particles removed: particle observer and updater removed to simplify UI







// Helpers for time slot rendering



function minutesTo12HourLabel(totalMinutes) {



  const h = Math.floor(totalMinutes / 60);



  const m = totalMinutes % 60;



  const ampm = h >= 12 ? "PM" : "AM";



  const hour12 = ((h + 11) % 12) + 1;



  return `${String(hour12).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;



}







function parseAMPMToMinutes(label) {



  // expected formats: '08:00 AM' or '8:00 AM'



  const parts = label.trim().split(/\s+/);



  if (parts.length < 2) return 0;



  const [timePart, ampm] = parts;



  const [hh, mm] = timePart.split(":").map((n) => parseInt(n, 10));



  let hours = hh % 12;



  if (ampm.toUpperCase() === "PM") hours += 12;



  return hours * 60 + (isNaN(mm) ? 0 : mm);



}







// fetch the list of active technicians for step 3 picker



async function loadTechnicianOptions() {



  if (!dom.technicianSelect) return;



  dom.technicianSelect.innerHTML =



    '<option value="">Loading technicians&hellip;</option>';



  try {



    const resp = await fetch("/api/services/technicians", {



      cache: "no-store",



    });



    if (!resp.ok) throw new Error(`status=${resp.status}`);



    const json = await resp.json();



    const techs = json.technicians || [];



    dom.technicianSelect.innerHTML =



      '<option value="">Select a technician</option>';



    techs.forEach((t) => {



      const opt = document.createElement("option");



      opt.value = t._id;



      opt.textContent = t.name || "Unnamed";



      dom.technicianSelect.appendChild(opt);



    });



  } catch (err) {



    console.warn("load technicians error", err);



    dom.technicianSelect.innerHTML =



      '<option value="">Unable to load technicians</option>';



  }



}







function formatDurationLabel(minutes) {
  if (!minutes) return "0m";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

const TimeSlotManager = {
  showLoading(date) {
    if (!dom.timeSelection || !dom.timeSlots) return;
    dom.timeSlots.innerHTML = "";
    dom.timeSelection.classList.remove("d-none");
    if (dom.timeSelectionDate) {
      dom.timeSelectionDate.textContent = date.toLocaleDateString("en-US", {
        weekday: "short", month: "short", day: "numeric",
      });
    }
    dom.timeNotice.textContent = "Loading availability...";
    if (dom.timeRangeInfo) dom.timeRangeInfo.textContent = "";
  },

  showError(message) {
    if (dom.timeSelection) dom.timeSelection.classList.add("d-none");
    if (dom.timeNotice) dom.timeNotice.textContent = message;
    if (dom.timeRangeInfo) dom.timeRangeInfo.textContent = "";
  },

  showEmpty(message) {
    if (dom.timeSelection) dom.timeSelection.classList.add("d-none");
    if (dom.timeNotice) dom.timeNotice.textContent = message;
    if (dom.timeRangeInfo) dom.timeRangeInfo.textContent = "";
  },

  showLargeProjectAlert(data) {
    if (dom.timeSelection) dom.timeSelection.classList.add("d-none");
    if (dom.timeRangeInfo) dom.timeRangeInfo.textContent = "";
    const totalHours = data.totalEstimatedHours || ((data.totalEstimatedMinutes || 0) / 60).toFixed(1);
    dom.timeNotice.innerHTML = `
      <div class="alert alert-info border-start border-4 border-primary mt-3" style="background:#eef2ff;border-radius:12px;">
        <div class="d-flex align-items-start gap-3">
          <i class="bi bi-building fs-3" style="color:#6366f1;"></i>
          <div>
            <h5 style="font-weight:700;color:#0f172a;font-size:0.95rem;">Large Project Detected</h5>
            <p style="font-size:0.85rem;color:#475569;margin-bottom:8px;">
              ${data.message || 'This request exceeds the capacity of a standard appointment and requires project scheduling.'}
            </p>
            <div style="background:#fff;border-radius:8px;padding:0.75rem;margin-bottom:8px;">
              <div class="d-flex justify-content-between mb-1">
                <span style="font-size:0.78rem;color:#64748b;">Total Estimated Duration</span>
                <span style="font-size:0.82rem;font-weight:700;color:#0f172a;">${totalHours} hours</span>
              </div>
              <div class="d-flex justify-content-between mb-1">
                <span style="font-size:0.78rem;color:#64748b;">Quantity</span>
                <span style="font-size:0.82rem;font-weight:700;color:#0f172a;">${data.quantity || ''} units</span>
              </div>
              <div class="d-flex justify-content-between">
                <span style="font-size:0.78rem;color:#64748b;">Duration Per Unit</span>
                <span style="font-size:0.82rem;font-weight:700;color:#0f172a;">${data.durationPerUnit || ''} minutes</span>
              </div>
            </div>
            <p style="font-size:0.82rem;color:#64748b;margin-bottom:4px;">
              After submitting, our administrator will prepare a project schedule and contact you for confirmation.
            </p>
          </div>
        </div>
      </div>
    `;
    dom.timeNotice.classList.remove("d-none");
  },

  renderSlots(slots, date) {
    if (!dom.timeSlots) return false;
    dom.timeSlots.innerHTML = "";
    const now = new Date();
    const today = startOfDay(now);
    const totalCurrentMinutes = now.getHours() * 60 + now.getMinutes();
    const bufferMinutes = 30;
    let any = false;

    slots.forEach((slot) => {
      const label = slot.label || "";
      const detail = slot.detail || "";
      const t = slot.startMinutes;

      if (isSameDate(date, today)) {
        if (t <= totalCurrentMinutes + bufferMinutes) return;
        if (t < calendarConfig.earliestSlotMinutes) return;
      }

      any = true;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ent-time-slot";
      btn.dataset.start = String(t);
      btn.dataset.label = label;
      btn.innerHTML = `<div class="ent-time-slot-label">${label}</div>`;

      if (slot.status !== "available") {
        btn.disabled = true;
        btn.classList.add("unavailable");
        const statusSpan = document.createElement("span");
        statusSpan.className = "ent-time-slot-status booked";
        statusSpan.textContent = slot.status === "booked" ? "Fully Booked" : "Not Working";
        btn.appendChild(statusSpan);
        btn.title = slot.status === "booked" ? "Already reserved" : "Not working";
      } else {
        const statusSpan = document.createElement("span");
        statusSpan.className = "ent-time-slot-status available";
        statusSpan.textContent = detail || "Open";
        btn.appendChild(statusSpan);
        btn.addEventListener("click", () => this._handleSlotClick(btn, label, t));
      }

      dom.timeSlots.appendChild(btn);
    });

    return any;
  },

  _handleSlotClick(btn, label, startMinutes) {
    dom.timeSlots.querySelectorAll(".ent-time-slot").forEach((n) => n.classList.remove("selected"));
    btn.classList.add("selected");
    state.slot = label;
    state.slotStart = startMinutes;
    try { updateEstimatedFee(); } catch (e) {}
    dom.feeStep?.classList.remove("d-none");
    dom.paymentStep?.classList.remove("d-none");
    try { updateStepIndicators(); } catch (e) {}
    setTimeout(() => {
      try { dom.feeStep?.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {}
    }, 80);
  },

  showTimeRange(slots) {
    if (!dom.timeRangeInfo) return;
    const avail = slots.filter((s) => s.status === "available");
    if (avail.length) {
      const minStart = avail[0].startMinutes;
      const maxEnd = avail[avail.length - 1].endMinutes;
      let html = `Available between ${minutesTo12HourLabel(minStart)} and ${minutesTo12HourLabel(maxEnd)}`;
      try {
        const raw = dom.timeRangeInfo.dataset.workload;
        if (raw) {
          const w = JSON.parse(raw);
          const parts = [];
          if (w.durationMinutes) parts.push(`🔧 ${formatDurationLabel(w.durationMinutes)} service`);
          if (w.travelMinutes) parts.push(`🚗 ${w.travelMinutes}m travel`);
          if (w.trafficAllowance) parts.push(`+ ${w.trafficAllowance}m traffic`);
          if (w.prepBuffer) parts.push(`${w.prepBuffer}m prep`);
          if (w.completionBuffer) parts.push(`${w.completionBuffer}m wrap-up`);
          if (parts.length) {
            html += `<br><span style="font-size:0.78rem;color:#64748b;">${parts.join(" · ")} · <strong>${formatDurationLabel(w.totalWorkloadMinutes)} total</strong></span>`;
          }
        }
      } catch (e) {}
      dom.timeRangeInfo.innerHTML = html;
    } else {
      dom.timeRangeInfo.textContent = "No available times";
    }
  },

  restoreSelection() {
    if (state.slotStart == null || !dom.timeSlots) return;
    const prevBtn = dom.timeSlots.querySelector(`[data-start="${state.slotStart}"]`);
    if (prevBtn && !prevBtn.disabled) {
      dom.timeSlots.querySelectorAll(".ent-time-slot").forEach((n) => n.classList.remove("selected"));
      prevBtn.classList.add("selected");
    }
  },

  scrollToContext(scrollToSlots) {
    if (state.slot) return;
    setTimeout(() => {
      try {
        const target = scrollToSlots ? dom.timeSelection : dom.modeSelection;
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (e) {}
    }, 150);
  },

  highlightSuggestion(date) {
    if (!state.suggestion || !isSameDate(state.suggestion.date, date) || !dom.timeSlots) return;
    const match = dom.timeSlots.querySelector(`[data-start="${state.suggestion.timeStart}"]`);
    if (match) match.classList.add("active");
  },
};

async function renderTimeSlotsForDate(date, { scrollToSlots = false } = {}) {
  if (!dom.timeSelection || !dom.timeSlots) return;

  if (state.technicianId && scheduleState.workingDays.length === 0) {
    try { await loadTechnicianSchedule(); } catch (e) {
      console.warn("failed to preload schedule", e);
    }
  }

  TimeSlotManager.showLoading(date);

  if (!state.service && !state.technicianId) {
    TimeSlotManager.showError("Please select a service and technician first.");
    return;
  }

  const dateKey = formatDateKey(date);

  if (!state.service && state.technicianId && dom.timeNotice) {
    dom.timeNotice.textContent = "Showing generic availability; durations may change after picking a service.";
  }

  if (state.technicianId) {
    const dow = date.getDay();
    if (scheduleState.nonWorkingWeekdays.includes(dow) || scheduleState.restDates.has(dateKey)) {
      TimeSlotManager.showError("Technician is not working on this date.");
      return;
    }
  }

  let slots = [];
  let serverWorked = false;

  try {
    const svcId = state.service?._id || "";
    const url = new URL("/api/services/availability", window.location.origin);
    url.searchParams.set("date", dateKey);
    if (svcId) url.searchParams.set("serviceId", svcId);
    if (state.technicianId) url.searchParams.set("technicianId", state.technicianId);
    if (typeof state.travelTime === "number") url.searchParams.set("travelTime", String(state.travelTime));
    if (state.quantity && state.quantity > 1) url.searchParams.set("quantity", String(state.quantity));

    const resp = await fetch(url.toString(), { cache: "no-store" });

    if (resp.ok) {
      const json = await resp.json();
      if (json.isLargeProject) {
        TimeSlotManager.showLargeProjectAlert(json);
        return;
      }
      if (json.blocked) {
        TimeSlotManager.showEmpty(json.message || "Booking exceeds available working hours. Please reduce the quantity.");
        return;
      }
      slots = json.slots || [];
      serverWorked = true;
      dom.timeSlots.innerHTML = "";
      if (json.workload && dom.timeRangeInfo) {
        const w = json.workload;
        dom.timeRangeInfo.dataset.workload = JSON.stringify(w);
      }
    } else {
      console.warn("availability API returned", resp.status);
    }
  } catch (err) {
    console.warn("availability API error", err);
  }

  if (!serverWorked) return;

  if (!slots.length) {
    const msg = state.technicianId
      ? "No working hours or all slots booked."
      : "No time slots available for this date.";
    TimeSlotManager.showEmpty(msg);
    return;
  }

  const any = TimeSlotManager.renderSlots(slots, date);

  if (!any) {
    TimeSlotManager.showEmpty("No time slots found for this date.");
    return;
  }

  dom.timeSelection.classList.remove("d-none");
  if (dom.timeSelectionDate) {
    dom.timeSelectionDate.textContent = date.toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric",
    });
  }
  dom.timeNotice.textContent = "";

  TimeSlotManager.showTimeRange(slots);
  TimeSlotManager.restoreSelection();
  TimeSlotManager.scrollToContext(scrollToSlots);
  TimeSlotManager.highlightSuggestion(date);
}


function adjustMapViewport() {



  if (!mapState.map || !window.L) return;



  // Debounce invalidateSize so rapid/polling calls don't thrash layout



  if (!adjustMapViewport._debTimer) {



    adjustMapViewport._debTimer = setTimeout(function () {



      adjustMapViewport._debTimer = null;



      try { mapState.map && mapState.map.invalidateSize(); } catch (e) {}



    }, 120);



  }







  // on first call, zoom to include both user and tech markers



  // After the initial fit, do not auto-pan anymore.



  if (!mapState._viewportInitialized) {



    const bounds = [];



    if (mapState.markers.technician) {



      bounds.push(mapState.markers.technician.getLatLng());



    }



    if (mapState.markers.user) {



      bounds.push(mapState.markers.user.getLatLng());



    }



    if (bounds.length) {



      const leafletBounds = L.latLngBounds(bounds);



      mapState.map.fitBounds(leafletBounds, { padding: [80, 80], animate: false });



    }



    mapState._viewportInitialized = true;



  }



}







// Decode an encoded polyline (Google/OSRM format) into [{lat,lng}, ...]



// based on https://developers.google.com/maps/documentation/utilities/polylinealgorithm



function decodePolyline(encoded) {



  if (!encoded || typeof encoded !== "string") return null;



  let index = 0;



  const length = encoded.length;



  const path = [];



  let lat = 0;



  let lng = 0;







  while (index < length) {



    let result = 0;



    let shift = 0;



    let b;



    do {



      b = encoded.charCodeAt(index++) - 63;



      result |= (b & 0x1f) << shift;



      shift += 5;



    } while (b >= 0x20);



    const deltaLat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;



    lat += deltaLat;







    result = 0;



    shift = 0;



    do {



      b = encoded.charCodeAt(index++) - 63;



      result |= (b & 0x1f) << shift;



      shift += 5;



    } while (b >= 0x20);



    const deltaLng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;



    lng += deltaLng;







    path.push({ lat: lat / 1e5, lng: lng / 1e5 });



  }







  return path;



}







// Attempt to obtain a traffic-aware route from Google Maps Directions API.



// If the Maps JS API isn't loaded, or the request fails, this returns null.



// Returned object includes:



//   - distanceMeters



//   - durationSeconds (base driving duration)



//   - durationTrafficSeconds (with traffic)



//   - points (array of {lat,lng}) for the route polyline



async function getGoogleRouteInfo(origin, destination, timeoutMs = 9000) {



  if (!window.google || !google.maps || !google.maps.DirectionsService) {



    return null;



  }







  const directionsService = new google.maps.DirectionsService();



  const request = {



    origin,



    destination,



    travelMode: google.maps.TravelMode.DRIVING,



    drivingOptions: {



      departureTime: new Date(),



      trafficModel: "best_guess",



    },



    unitSystem: google.maps.UnitSystem.METRIC,



    provideRouteAlternatives: false,



  };







  const p = new Promise((resolve) => {



    directionsService.route(request, (result, status) => {



      if (status === "OK" && result && result.routes && result.routes[0]) {



        const route = result.routes[0];



        const leg = route.legs && route.legs[0];



        if (leg) {



          const distanceMeters = leg.distance?.value;



          const durationSeconds = leg.duration?.value;



          const durationTrafficSeconds = leg.duration_in_traffic?.value;



          const encoded = route.overview_polyline?.points;



          let points = null;



          if (encoded) {



            points = decodePolyline(encoded);



          }



          resolve({



            distanceMeters,



            durationSeconds,



            durationTrafficSeconds,



            points,



          });



          return;



        }



      }



      resolve(null);



    });



  });







  if (timeoutMs) {



    return Promise.race([



      p,



      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),



    ]);



  }



  return p;



}







// Use server-side Google Directions proxy when client-side Google Maps JS is unavailable (or slow).



// This helps prevent straight-line fallbacks when the browser can't reach Google due to CSP/CORS.



async function fetchServerDirections(origin, destination, timeoutMs = 9000) {



  try {



    const url = `/api/services/directions?origin=${encodeURIComponent(



      `${origin.lat},${origin.lng}`,



    )}&destination=${encodeURIComponent(`${destination.lat},${destination.lng}`)}`;



    const controller = new AbortController();



    const id = setTimeout(() => controller.abort(), timeoutMs);



    const resp = await fetch(url, { signal: controller.signal, cache: "no-store" });



    clearTimeout(id);



    if (!resp.ok) return null;



    const data = await resp.json();



    if (!data || !data.geometry || !Array.isArray(data.geometry)) return null;



    return {



      distanceMeters: data.distance,



      durationSeconds: data.duration,



      durationTrafficSeconds: data.duration_in_traffic,



      points: data.geometry.map((p) => ({ lat: p[1], lng: p[0] })),



    };



  } catch (e) {



    return null;



  }



}







// Convenience wrapper to just fetch traffic-aware ETA (minutes)



async function getTrafficAwareEtaMinutes(origin, destination, timeoutMs = 4500) {



  const info = await getGoogleRouteInfo(origin, destination, timeoutMs);



  if (!info) return null;



  const secs = info.durationTrafficSeconds || info.durationSeconds;



  return typeof secs === "number" ? Math.round(secs / 60) : null;



}







// draw or update polyline between technician and user markers



async function updateRoute() {



  if (!mapState.map || !window.L) return;







  const tech = mapState.markers.technician;



  const user = mapState.markers.user;







  if (!tech || !user) {



    if (mapState.route) {



      mapState.map.removeLayer(mapState.route);



      mapState.route = null;



    }



    return;



  }







  const techPos = tech.getLatLng();



  const userPos = user.getLatLng();







  // Debounce OSRM requests: only allow recalculation every 10 seconds.



  const now = Date.now();



  const last = mapState.lastRouteAt || 0;



  // If we've calculated a route recently and we already have a route displayed,



  // skip requesting a new OSRM route to avoid API abuse and flicker.



  if (now - last < 10000 && mapState.route) {



    return;



  }







  // If Google Maps hasn't loaded yet, retry later (so we can use traffic-aware ETA)



  const canUseGoogle =



    window.google &&



    google.maps &&



    google.maps.DirectionsService;



  if (!canUseGoogle) {



    const lastRetry = mapState.lastGoogleRetryAt || 0;



    if (now - lastRetry > 2500) {



      mapState.lastGoogleRetryAt = now;



      setTimeout(() => {



        try {



          updateRoute();



        } catch (e) {}



      }, 2600);



    }



  }







  // Prefer Google Maps Directions (traffic-aware routing + road conditions) for ETA.



  // Still fall back to OSRM for route geometry when necessary.



  (async () => {



    let googleKm = null;



    let googleEtaMinutes = null;



    let googleEtaLabel = "ETA";



    let googlePoints = null;



    let usedGoogleEta = false;







    try {



        // Try Google routes up to twice (some devices may slow-load the API or hit occasional failures).



        const googleInfo =



          (await getGoogleRouteInfo(



            { lat: techPos.lat, lng: techPos.lng },



            { lat: userPos.lat, lng: userPos.lng },



          )) ||



          (await getGoogleRouteInfo(



            { lat: techPos.lat, lng: techPos.lng },



            { lat: userPos.lat, lng: userPos.lng },



          ));







        if (googleInfo) {



          googleKm = (googleInfo.distanceMeters || 0) / 1000;



          const wrap = (s) => (typeof s === "number" ? Math.round(s / 60) : 0);



          const mins = wrap(googleInfo.durationSeconds);



          const trafficMins = wrap(googleInfo.durationTrafficSeconds);



          googleEtaMinutes = trafficMins > 0 ? trafficMins : mins;



          googleEtaLabel = trafficMins > 0 ? "ETA (traffic)" : "ETA";



          if (Array.isArray(googleInfo.points) && googleInfo.points.length) {



            googlePoints = googleInfo.points.map((p) => L.latLng(p.lat, p.lng));



          }



        }



      } catch (e) {



        // ignore and continue to OSRM/server fallback



      }







    if (typeof googleKm === "number" && googleKm > 0 && typeof googleEtaMinutes === "number") {



      usedGoogleEta = true;



      console.debug("[Routing] Using Google Directions ETA", {



        km: googleKm,



        eta: googleEtaMinutes,



        label: googleEtaLabel,



      });



      const FARE = window._farePerKm || 40;



      const cost = (googleKm * FARE).toFixed(2);



      const info = document.getElementById("mapDistanceInfo");



      if (info) {



        info.textContent = `Distance: ${googleKm.toFixed(1)} km â€¢ Fare: â‚±${cost} â€¢ ${googleEtaLabel}: ${googleEtaMinutes} min`;



      }



      updateMapInfoPanel(googleKm, googleEtaMinutes, googleEtaLabel);



      mapState.lastRouteAt = Date.now();



    }







    // If Google provided points, we can still use OSRM for a backup route if desired,



    // but we should not overwrite the ETA already computed.



    // If Google provided an ETA, keep it, but still fall back to OSRM for geometry.



    if (googlePoints) return;







    // Use OSRM public routing service to obtain a road-following geometry.



    // Fallback: draw straight line if routing fails.







    // Use OSRM public routing service to obtain a road-following geometry.



    // Fallback: draw straight line if routing fails.



    try {



      const coords = `${techPos.lng},${techPos.lat};${userPos.lng},${userPos.lat}`;



      // Use server-side proxy to avoid Content-Security-Policy / CORS issues



      const proxyUrl = `/api/services/osrm-route?coords=${encodeURIComponent(coords)}`;



      console.debug("[Routing] OSRM proxy URL:", proxyUrl, "coords:", coords);



      const resp = await fetch(proxyUrl, { cache: "no-store" });



      console.debug("[Routing] OSRM status:", resp.status);



      if (!resp.ok) throw new Error(`status=${resp.status}`);



      const json = await resp.json();



      console.debug(



        "[Routing] OSRM routes returned:",



        (json.routes || []).length,



      );



      if (!json.routes || !json.routes.length) throw new Error("no routes");



      const geom = json.routes[0].geometry;



      if (!geom || !Array.isArray(geom.coordinates))



        throw new Error("invalid geometry");







      console.debug(



        "[Routing] geometry points:",



        geom.coordinates.length,



        geom.coordinates.slice(0, 5),



      );







      const pts = geom.coordinates.map((c) => L.latLng(c[1], c[0]));







      if (mapState.route) {



        mapState.route.setLatLngs(pts);



      } else {



        mapState.route = L.polyline(pts, { color: "purple", weight: 4 }).addTo(



          mapState.map,



        );



      }



      // show distance and ETA from OSRM route if element present



      try {



        const distMeters = json.routes[0].distance || 0;



        const durSeconds = json.routes[0].duration || 0;



        const km = distMeters / 1000;



        const mins = Math.round(durSeconds / 60);







        const FARE = window._farePerKm || 40;



        const cost = (km * FARE).toFixed(2);



        const info = document.getElementById("mapDistanceInfo");







        // Only update ETA from OSRM if we did not already get a Google ETA.



        if (!usedGoogleEta) {



          // Apply a small buffer for traffic/road conditions when Google data



          // isn't available. This keeps the ETA closer to what Google would show.



          const buffer = typeof window._osrmTrafficBuffer === "number" ? window._osrmTrafficBuffer : 1.4;



          const bufferedMins = Math.max(1, Math.round(mins * buffer));



          const etaLabel = buffer !== 1 ? "ETA (approx)" : "ETA";







          if (info) {



            info.textContent = `Distance: ${km.toFixed(1)} km â€¢ Fare: â‚±${cost} â€¢ ${etaLabel}: ${bufferedMins} min`;



          }



          updateMapInfoPanel(km, bufferedMins, etaLabel);







          // Try to get an even more accurate traffic-aware ETA via server-side Google Directions proxy.



          // This is optional; if it fails, we keep the OSRM estimate.



          (async () => {



            try {



              const serverInfo = await fetchServerDirections(



                { lat: techPos.lat, lng: techPos.lng },



                { lat: userPos.lat, lng: userPos.lng },



              );



              if (serverInfo && typeof serverInfo.durationTrafficSeconds === "number") {



                const trafficMins = Math.round(serverInfo.durationTrafficSeconds / 60);



                if (info) {



                  info.textContent = `Distance: ${km.toFixed(1)} km â€¢ Fare: â‚±${cost} â€¢ ETA (traffic): ${trafficMins} min`;



                }



                updateMapInfoPanel(km, trafficMins, "ETA (traffic)");



              }



            } catch (e) {



              // ignore



            }



          })();



        } else {



          if (info) {



            info.textContent = `Distance: ${km.toFixed(1)} km â€¢ Fare: â‚±${cost}`;



          }



        }



      } catch (e) {}



      // update last successful OSRM timestamp to enforce 10s debounce



      mapState.lastRouteAt = Date.now();



    } catch (err) {



      // if OSRM failed, try the server-side Google Directions proxy as a last attempt



      try {



        const googleServer = await fetchServerDirections(



          { lat: techPos.lat, lng: techPos.lng },



          { lat: userPos.lat, lng: userPos.lng },



        );



        if (googleServer && Array.isArray(googleServer.points) && googleServer.points.length) {



          const pts = googleServer.points.map((p) => L.latLng(p.lat, p.lng));



          if (mapState.route) {



            mapState.route.setLatLngs(pts);



          } else {



            mapState.route = L.polyline(pts, { color: "purple", weight: 4 }).addTo(



              mapState.map,



            );



          }







          if (!usedGoogleEta) {



            const km = (googleServer.distanceMeters || 0) / 1000;



            const mins = Math.round((googleServer.durationTrafficSeconds || googleServer.durationSeconds || 0) / 60);



            const FARE = window._farePerKm || 40;



            const cost = (km * FARE).toFixed(2);



            const info = document.getElementById("mapDistanceInfo");



            if (info) {



              info.textContent = `Distance: ${km.toFixed(1)} km â€¢ Fare: â‚±${cost} â€¢ ETA (traffic): ${mins} min`;



            }



            updateMapInfoPanel(km, mins, "ETA (traffic)");



          }



          mapState.lastRouteAt = Date.now();



          return;



        }



      } catch (e) {



        // ignore, fall back to straight line below



      }







      // routing failed â€” degrade to straight line (do NOT update lastRouteAt so



      // the code will retry OSRM on the next opportunity)



      console.warn("Routing failed, falling back to straight line:", err);



      const pts = [techPos, userPos];



      if (mapState.route) {



        mapState.route.setLatLngs(pts);



      } else {



        mapState.route = L.polyline(pts, { color: "purple", weight: 4 }).addTo(



          mapState.map,



        );



      }



      // show straight-line distance as fallback



      try {



        const km = haversineDistance(



          techPos.lat,



          techPos.lng,



          userPos.lat,



          userPos.lng,



        );



        const FARE = window._farePerKm || 40;



        const cost = (km * FARE).toFixed(2);



        const info = document.getElementById("mapDistanceInfo");



        if (info) {



          info.textContent = `Distance (approx): ${km.toFixed(1)} km â€¢ Fare: â‚±${cost}`;



        }



        updateMapInfoPanel(km);



      } catch (e) {}



    }



  })();



}







function attemptMapMount() {



  if (mapState.map) {



    return;



  }



  if (!dom.locationStep || dom.locationStep.classList.contains("d-none")) {



    return;



  }



  mapState.element =



    mapState.element || document.getElementById("technicianMap");



  if (!mapState.element || !window.L) {



    return;



  }



  // initialize Leaflet map



  mapState.map = L.map(mapState.element).setView(



    [mapState.technicianCoords.lat, mapState.technicianCoords.lng],



    13,



  );



  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {



    attribution:



      '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',



  }).addTo(mapState.map);







  // technician marker â€” 3D GPS cursor arrow



  const techIcon = L.divIcon({



    className: "",



    html: '<div style="filter:drop-shadow(0 2px 4px rgba(0,0,0,.35));animation:techPulse 2s ease-in-out infinite;">' +



      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">' +



      '<defs><linearGradient id="sg1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#5cacff"/><stop offset="100%" stop-color="#1a6ddb"/></linearGradient>' +



      '<linearGradient id="sg2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1a6ddb"/><stop offset="100%" stop-color="#0f4a9e"/></linearGradient></defs>' +



      '<ellipse cx="20" cy="36" rx="8" ry="2.5" fill="rgba(0,0,0,.18)"/>' +



      '<path d="M20 2 L34 32 L20 26 Z" fill="url(#sg2)"/>' +



      '<path d="M20 2 L6 32 L20 26 Z" fill="url(#sg1)"/>' +



      '<path d="M20 2 L6 32 L20 26 L34 32 Z" stroke="#fff" stroke-width="1.2" fill="none" stroke-linejoin="round"/>' +



      '<path d="M12 14 L20 4 L21 14 Z" fill="rgba(255,255,255,.3)"/>' +



      '</svg></div>' +



      '<style>@keyframes techPulse{0%,100%{transform:scale(1)}50%{transform:scale(1.06)}}</style>',



    iconSize: [40, 40],



    iconAnchor: [20, 20],



    popupAnchor: [0, -20],



  });



  mapState.markers.technician = L.marker(



    [mapState.technicianCoords.lat, mapState.technicianCoords.lng],



    { icon: techIcon },



  )



    .addTo(mapState.map)



    .bindPopup("Nearest technician");



  // if we already have a user marker (e.g. geolocation fired before map mount),



  // update distance display now that technician marker exists



  if (mapState.markers.user) {



    const userPos = mapState.markers.user.getLatLng();



    if (userPos) {



      placeUserMarker({ lat: userPos.lat, lng: userPos.lng });



    }



  }



  // new route might be possible now



  updateRoute();



  // start polling technician location once map is ready



  startTechPolling();







  // map clicks no longer add customer location to prevent accidental pins



  // (existing click handler removed per professional requirement)



  // mapState.map.on("click", ... ) intentionally omitted







  if (locationState.userCoords) {



    placeUserMarker(locationState.userCoords);



  }



  mapState.mounted = true;



  adjustMapViewport();



  // previously we would autoâ€‘geolocate when the map first mounted:



  //



  // if (!mapState.hasAutoGeolocated) {



  //   attemptGeolocation(false);



  //   mapState.hasAutoGeolocated = true;



  // }



  //



  // That behaviour caused the device GPS to fire even if the user



  // simply typed an address.  The intent is now to geolocate ONLY when



  // the "Use my current location" button is clicked, so we remove the



  // automatic call entirely.







  // Locate buttons: pan map to technician or customer



  const locateTechBtn = document.getElementById("locateTechBtn");



  const locateCustomerBtn = document.getElementById("locateCustomerBtn");



  if (locateTechBtn) {



    locateTechBtn.addEventListener("click", () => {



      if (mapState.markers.technician) {



        mapState.map.flyTo(mapState.markers.technician.getLatLng(), 16, {



          duration: 0.8,



        });



        mapState.markers.technician.openPopup();



      }



    });



  }



  if (locateCustomerBtn) {



    locateCustomerBtn.addEventListener("click", () => {



      if (mapState.markers.user) {



        mapState.map.flyTo(mapState.markers.user.getLatLng(), 16, {



          duration: 0.8,



        });



        mapState.markers.user.openPopup();



      }



    });



  }



}







function buildCalendarConfig() {



  const now = new Date();



  const currentHour = now.getHours();



  const currentMinutes = now.getMinutes();
  const totalCurrentMinutes = currentHour * 60 + currentMinutes;

  

  // Minimum advance booking notice (default 2 hours = 120 minutes)
  // Updated dynamically when server responds with actual config
  const MIN_ADVANCE_MINUTES = (window.__bookingPolicy && window.__bookingPolicy.minAdvanceNoticeMinutes) || 120;

  // Default working hours end at 7 PM (19:00, includes overtime)

  

  const workingDayEndMinutes = 19 * 60;

  

  // Compute earliest bookable time = now + min advance notice
  const earliestBookableMs = now.getTime() + MIN_ADVANCE_MINUTES * 60000;
  const earliestBookableDate = new Date(earliestBookableMs);
  const earliestBookableMinutes = earliestBookableDate.getHours() * 60 + earliestBookableDate.getMinutes();

  let baseDate = startOfDay(earliestBookableDate);

  // If earliest bookable time is past working hours, move to the next day
  if (earliestBookableMinutes > workingDayEndMinutes) {
    baseDate = addDays(startOfDay(earliestBookableDate), 1);
  }

  // Store the earliest bookable minutes for slot filtering
  const earliestSlotMinutes = earliestBookableMinutes > workingDayEndMinutes 
    ? 480 // next day starts at 8 AM
    : Math.max(480, earliestBookableMinutes);


  // defaults used while schedule is still loading



  return {



    minDate: baseDate,



    nonWorkingWeekdays: [0], // Sundays blocked by default



    bookedDates: new Set(),



    maintenanceDates: new Set(),



    publicHolidays: new Map(), // date->name



    nonWorkingDays: new Map(), // date->note

    minAdvanceNoticeMinutes: MIN_ADVANCE_MINUTES,

    earliestSlotMinutes: earliestSlotMinutes,

    earliestBookableDate: earliestBookableDate,



  };



}







// retrieve technician schedule from server and update calendar config



async function loadTechnicianSchedule() {



  try {



    let url = "/api/services/technician-schedule";



    if (state.technicianId) {



      url += "/" + encodeURIComponent(state.technicianId);



    }



    const resp = await fetch(url);



    if (!resp.ok) throw new Error(`status=${resp.status}`);



    const json = await resp.json();



    // update our scheduleState so slot generation can use it



    scheduleState.workingDays = Array.isArray(json.workingDays)



      ? json.workingDays.slice()



      : [];



    if (scheduleState.workingDays.length === 0) {



      // no explicit schedule defined; assume generic 8â€‘5 Mâ€“F (or every day)



      scheduleState.workingDays = [];



      for (let d = 0; d < 7; d++) {



        scheduleState.workingDays.push({



          dayOfWeek: d,



          startMinutes: 8 * 60,



          endMinutes: 19 * 60,



        });



      }



      scheduleState.nonWorkingWeekdays = [];



    } else {



      scheduleState.nonWorkingWeekdays = Array.isArray(json.nonWorkingWeekdays)



        ? json.nonWorkingWeekdays



        : [];



    }



    scheduleState.restDates = new Set(



      Array.isArray(json.restDates) ? json.restDates : [],



    );







    if (json.nonWorkingWeekdays && Array.isArray(json.nonWorkingWeekdays)) {



      calendarConfig.nonWorkingWeekdays = json.nonWorkingWeekdays;



    } else {



      calendarConfig.nonWorkingWeekdays = []; // default



    }



    if (json.restDates && Array.isArray(json.restDates)) {



      calendarConfig.maintenanceDates = new Set(json.restDates);



    } else {



      calendarConfig.maintenanceDates = new Set();



    }



    // refresh calendar display if it is already rendered



    renderCalendarDays();



    // if we haven't picked a date yet, the schedule update may have changed



    // what qualifies as 'available' so ensure we still land on a valid day.



    if (!state.calendar.selectedDate) {



      const fallback = findNextAvailableDate(calendarConfig.minDate);



      if (fallback) {



        setSelectedDate(fallback);



      }



    }



  } catch (err) {



    console.warn("Failed to load technician schedule", err);



  }



}







// live technician-location poller



let _techPollId = null;



let _techPollFailures = 0;



async function fetchTechLocation() {



  try {



    let url = "/api/services/technician-location";



    if (state.technicianId) {



      url += `?id=${encodeURIComponent(state.technicianId)}`;



    }



    const resp = await fetch(url);



    if (!resp.ok) throw new Error(`status=${resp.status}`);



    const json = await resp.json();



    _techPollFailures = 0;



    if (json.lat != null && json.lng != null) {



      mapState.technicianCoords = { lat: json.lat, lng: json.lng };



      if (mapState.markers.technician) {



        mapState.markers.technician.setLatLng([json.lat, json.lng]);



      }



      adjustMapViewport();



      updateRoute();



    }



  } catch (err) {



    _techPollFailures += 1;



    // Avoid flooding console/network when backend is unreachable.



    if (_techPollFailures <= 2) {



      console.warn("Failed to poll technician location", err);



    }



    if (_techPollFailures >= 6) {



      if (_techPollId) {



        clearInterval(_techPollId);



        _techPollId = null;



      }



      console.warn("Technician location polling paused after repeated connection failures.");



    }



  }



}







function startTechPolling() {



  if (_techPollId) return;



  _techPollFailures = 0;



  fetchTechLocation();



  _techPollId = setInterval(fetchTechLocation, 5000);



}







// also fetch booked dates for the currently selected service so the calendar



// shows reserved days for that service. start/end may be provided to limit



// the query; if omitted we default to a reasonable future range.



async function loadServiceCalendar(serviceId, startDate, endDate) {



  if (!serviceId) return;



  try {



    const params = new URLSearchParams();



    if (startDate) params.set("start", formatDateKey(startDate));



    if (endDate) params.set("end", formatDateKey(endDate));



    if (state.technicianId) params.set("technicianId", state.technicianId);



    const url = `/api/services/${encodeURIComponent(serviceId)}/calendar?${params.toString()}`;



    const resp = await fetch(url);



    if (!resp.ok) throw new Error(`status=${resp.status}`);



    const json = await resp.json();



    calendarConfig.bookedDates = new Set(json.bookedDates || []);



    // optionally incorporate any blockedDates from response (e.g. dayoffs)



    if (Array.isArray(json.blockedDates)) {



      calendarConfig.maintenanceDates = new Set(json.blockedDates);



    }



    // keep track of public holiday names for tooltips



    if (Array.isArray(json.publicHolidays)) {



      calendarConfig.publicHolidays = new Map(



        json.publicHolidays.map((h) => [h.date, h.name || ""]),



      );



    }



    if (Array.isArray(json.nonWorkingDays)) {



      calendarConfig.nonWorkingDays = new Map(



        json.nonWorkingDays.map((n) => [n.date, n.note || ""]),



      );



    }



    renderCalendarDays();



  } catch (err) {



    console.warn("Failed to load service calendar", err);



  }



}







function startOfDay(date) {



  return new Date(date.getFullYear(), date.getMonth(), date.getDate());



}







function startOfMonth(date) {



  return new Date(date.getFullYear(), date.getMonth(), 1);



}







function addDays(date, amount) {



  const clone = new Date(date);



  clone.setDate(clone.getDate() + amount);



  return clone;



}







function addMonths(date, amount) {



  const clone = new Date(date);



  clone.setMonth(clone.getMonth() + amount);



  return startOfMonth(clone);



}







function formatDateKey(date) {



  const year = date.getFullYear();



  const month = String(date.getMonth() + 1).padStart(2, "0");



  const day = String(date.getDate()).padStart(2, "0");



  return `${year}-${month}-${day}`;



}







function isSameDate(a, b) {



  return (



    a.getFullYear() === b.getFullYear() &&



    a.getMonth() === b.getMonth() &&



    a.getDate() === b.getDate()



  );



}







function toTimeRangeLabel(startMinutes, endMinutes) {



  const start = minutesToTime(startMinutes);



  const end = minutesToTime(endMinutes);



  return `${start} - ${end}`;



}







function minutesToTime(totalMinutes) {



  const hours = Math.floor(totalMinutes / 60);



  const minutes = totalMinutes % 60;



  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;



}



