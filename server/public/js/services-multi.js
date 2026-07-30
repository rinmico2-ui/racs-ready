/**
 * Enterprise-Level Multi-Service Booking System
 * Supports HP-based pricing, quantity selection, and multiple services
 */

"use strict";

// Global state management
const BookingState = {
  selectedServices: [],
  currentService: null,
  totalEstimatedPrice: 0,
  hasRepairServices: false,
  selectedTechnicianId: null,
  location: null,
  scheduleDate: null,
  scheduleTime: null,
  currentStep: 1,
  maxReachedStep: 1,

  // Service catalog
  catalog: {
    coreServices: [],
    repairServices: []
  },

  // UI state - Initialize modals object properly
  ui: {
    activeTab: 'core',
    modals: {
      hp: null,
      quantity: null
    }
  }
};
window.BookingState = BookingState;

// DOM elements cache
const DOM = {
  // Service selection
  coreServiceCards: null,
  repairServiceCards: null,
  selectedServicesList: null,
  selectedServiceCount: null,
  totalEstimatedPrice: null,
  totalPricingSection: null,
  repairIssueContainer: null,
  repairIssue: null,

  // Modals
  hpModal: null,
  quantityModal: null,

  // Modal elements
  hpModalServiceName: null,
  hpModalQuantity: null,
  hpModalOptions: null,
  confirmHpSelection: null,

  quantityModalServiceName: null,
  quantityModalUnit: null,
  quantityModalInput: null,
  quantityModalDecrease: null,
  quantityModalIncrease: null,
  quantityModalPrice: null,
  confirmQuantitySelection: null
};

/**
 * Initialize the multi-service booking system
 */
function initMultiServiceBooking() {
  // Expose key functions on window so Step 3 inline scripts can safely call them.
  window.geocodeAddress = geocodeAddress;
  window.drawRoute = drawRoute;

  // Inject transition CSS
  injectTransitionStyles();

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initMultiServiceBooking);
    return;
  }

  // Add a small delay to ensure all user data is loaded
  setTimeout(() => {
    // Check if user is logged in first - multiple methods
    let isLoggedIn = false;

    // Method 1: Check for user data in window object (most common)
    if (typeof window.user !== 'undefined' && window.user) {
      isLoggedIn = true;
    }

    // Method 2: Check for user data in script tags
    if (!isLoggedIn) {
      const userScripts = document.querySelectorAll('script[data-user], script[id*="user"], script[src*="user"]');
      userScripts.forEach(script => {
        const userData = script.getAttribute('data-user') || script.textContent;
        if (userData && userData !== 'null' && userData !== 'undefined') {
          isLoggedIn = true;
        }
      });
    }

    // Method 3: Check for any user-related elements
    if (!isLoggedIn) {
      const userElements = document.querySelectorAll('[data-user], [data-logged-in], .user-info, .logged-in-user');
      if (userElements.length > 0) {
        isLoggedIn = true;
      }
    }

    // Method 4: Check if there are any disabled category buttons (server-side check)
    if (!isLoggedIn) {
      const categoryButtons = document.querySelectorAll('.category-btn');
      const hasEnabledButtons = Array.from(categoryButtons).some(btn => !btn.disabled);
      if (hasEnabledButtons) {
        isLoggedIn = true;
      }
    }

    // Method 5: Check for any existing login prompts (server-side already handled)
    if (!isLoggedIn) {
      const existingLoginPrompt = document.querySelector('.alert-warning');
      if (existingLoginPrompt) {
        // Don't add another prompt, just disable features
        disableBookingFeatures();
        return;
      }
    }


    if (!isLoggedIn) {
      disableBookingFeatures();
      return;
    }

    // Remove any existing login prompts (user is logged in)
    const existingPrompts = document.querySelectorAll('.alert-warning');
    existingPrompts.forEach(prompt => prompt.remove());

    // Ensure BookingState is properly initialized
    if (!window.BookingState) {
      window.BookingState = BookingState;
    }

    // Cache DOM elements
    cacheDOMElements();

    // Initialize booking state
    initializeBookingState();

    // Load services catalog
    loadServicesCatalog();

    // Setup event listeners
    setupEventListeners();

    // Initialize stepper (handled implicitly or uses updateStepperIndicators)
    updateStepperIndicators(1);

  }, 500); // 500ms delay to ensure everything is loaded
}

/**
 * Inject CSS styles for scrollable container layout
 */
function injectTransitionStyles() {
  const styleId = 'booking-transition-styles';
  if (document.getElementById(styleId)) return;

  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    /* Scrollable container layout */
    .booking-body {
      max-height: none !important;
      overflow: visible !important;
      position: relative;
    }
    
    /* All steps visible in scrollable container */
    .booking-step {
      position: relative;
      margin-bottom: 2rem;
      padding: 2rem;
      background: #fff;
      border: 1px solid #e9ecef;
      border-radius: 0.5rem;
      box-shadow: 0 0.125rem 0.25rem rgba(0, 0, 0, 0.075);
      transition: all 0.3s ease;
    }
    
    .booking-step.step-visible {
      display: block !important;
      opacity: 1;
    }
    
    .booking-step.step-active {
      border-color: #0d6efd;
      box-shadow: 0 0 0 0.2rem rgba(13, 110, 253, 0.25);
      transform: scale(1.02);
    }
    
    .booking-step.step-completed {
      border-color: #198754;
      background: linear-gradient(135deg, #f8fff9 0%, #ffffff 100%);
    }
    
    .booking-step.step-completed::before {
      content: '✓';
      position: absolute;
      top: 1rem;
      right: 1rem;
      background: #198754;
      color: white;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: bold;
    }
    
    .booking-step.step-highlight {
      animation: highlightPulse 2s ease-in-out;
    }
    
    @keyframes highlightPulse {
      0% {
        box-shadow: 0 0 0 0 rgba(13, 110, 253, 0.7);
      }
      70% {
        box-shadow: 0 0 0 10px rgba(13, 110, 253, 0);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(13, 110, 253, 0);
      }
    }
    
    /* Step headers styling */
    .booking-step h5 {
      color: #495057;
      font-weight: 600;
      margin-bottom: 1rem;
      padding-bottom: 0.5rem;
      border-bottom: 2px solid #e9ecef;
    }
    
    .booking-step.step-active h5 {
      color: #0d6efd;
      border-bottom-color: #0d6efd;
    }
    
    .booking-step.step-completed h5 {
      color: #198754;
      border-bottom-color: #198754;
    }
    
    /* Smooth scrolling */
    html {
      scroll-behavior: smooth;
      scroll-padding-top: 100px;
    }
    
    /* Step indicators animation */
    .stepper-step {
      transition: all 0.3s ease;
    }
    
    .stepper-step.active {
      transform: scale(1.05);
      box-shadow: 0 0.125rem 0.25rem rgba(13, 110, 253, 0.25);
    }
    
    .stepper-step.completed {
      opacity: 0.8;
      background: #198754;
    }
    
    .stepper-step.completed::after {
      content: '✓';
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      color: white;
      font-weight: bold;
    }
    
    /* Form validation feedback */
    .is-valid {
      border-color: #198754 !important;
      box-shadow: 0 0 0 0.2rem rgba(25, 135, 84, 0.25);
    }
    
    /* Progress indicator for scrollable container */
    .booking-progress-indicator {
      position: fixed;
      top: 50%;
      right: 2rem;
      transform: translateY(-50%);
      z-index: 1000;
      background: white;
      padding: 1rem;
      border-radius: 0.5rem;
      box-shadow: 0 0.125rem 0.25rem rgba(0, 0, 0, 0.075);
    }
    
    .progress-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: #dee2e6;
      margin: 0.5rem 0;
      cursor: pointer;
      transition: all 0.3s ease;
    }
    
    .progress-dot.active {
      background: #0d6efd;
      transform: scale(1.5);
    }
    
    .progress-dot.completed {
      background: #198754;
    }
    
    /* Mobile responsive */
    @media (max-width: 768px) {
      .booking-step {
        padding: 1rem;
        margin-bottom: 1rem;
      }
      
      .booking-progress-indicator {
        right: 1rem;
        padding: 0.5rem;
      }
      
      html {
        scroll-padding-top: 80px;
      }
    }
    
    /* Map styles */
    .technician-map {
      width: 100%;
      height: 400px;
      border-radius: 0.5rem;
      background: #f8f9fa;
    }
    
    .map-wrapper {
      position: relative;
      overflow: hidden;
    }
    
    .map-locate-btns {
      position: absolute;
      top: 10px;
      right: 10px;
      z-index: 1000;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    
    .map-locate-btn {
      background: white;
      border: 1px solid #dee2e6;
      border-radius: 0.25rem;
      padding: 8px 12px;
      font-size: 12px;
      cursor: pointer;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
      transition: all 0.2s ease;
    }
    
    .map-locate-btn:hover {
      background: #f8f9fa;
      transform: translateY(-1px);
      box-shadow: 0 4px 8px rgba(0,0,0,0.15);
    }
    
    /* Location input enhancements */
    .location-hint {
      font-size: 0.875rem;
      color: #6c757d;
      font-style: italic;
    }
    
    /* Technician details styling */
    #technicianDetails {
      border-left: 4px solid #0d6efd;
      background: linear-gradient(135deg, #f8f9ff 0%, #ffffff 100%);
    }
    
    /* Loading spinner for map */
    .map-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 400px;
      background: #f8f9fa;
    }
    
    /* Custom popup styling */
    .custom-popup .leaflet-popup-content-wrapper {
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    }
    
    .custom-popup .leaflet-popup-content {
      margin: 0;
      min-width: 150px;
      color: #334155;
    }
    
    .custom-popup .leaflet-popup-tip {
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    
    /* Marker hover effects */
    .technician-marker:hover,
    .user-marker:hover {
      filter: brightness(1.1);
      transform: scale(1.05);
      transition: all 0.2s ease;
    }
    
    /* Current location button styling */
    .current-location-btn-container {
      position: relative;
    }
    
    #currentLocationBtn:hover {
      transform: translateY(-1px);
      box-shadow: 0 4px 8px rgba(13, 110, 253, 0.2);
    }
    
    #currentLocationBtn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  `;

  document.head.appendChild(style);
  console.log('✅ Scrollable container styles injected');

  // Add progress indicator
  addProgressIndicator();
}

/**
 * Add side progress indicator for navigation
 */
function addProgressIndicator() {
  // Remove existing indicator
  const existing = document.getElementById('booking-progress-indicator');
  if (existing) existing.remove();

  const indicator = document.createElement('div');
  indicator.id = 'booking-progress-indicator';
  indicator.className = 'booking-progress-indicator';
  indicator.innerHTML = `
    <div class="progress-dot" data-step="1" title="Select Services"></div>
    <div class="progress-dot" data-step="2" title="Service Details"></div>
    <div class="progress-dot" data-step="3" title="Location"></div>
    <div class="progress-dot" data-step="4" title="Schedule"></div>
    <div class="progress-dot" data-step="5" title="Fee"></div>
    <div class="progress-dot" data-step="6" title="Payment"></div>
  `;

  document.body.appendChild(indicator);

  // Add click handlers to dots
  indicator.querySelectorAll('.progress-dot').forEach(dot => {
    dot.addEventListener('click', () => {
      const step = parseInt(dot.dataset.step);
      showStep(step);
    });
  });

  console.log('✅ Progress indicator added');
}

/**
 * Disable booking features for non-logged-in users
 */
function disableBookingFeatures() {

  // Check if user is actually logged in (server-side check)
  const userElement = document.querySelector('script[data-user]');
  const hasUserScript = userElement && userElement.getAttribute('data-user') !== 'null';

  // Check if Step 1 shows welcome message (user is logged in)
  const welcomeMessage = document.querySelector('.alert-success');
  const isUserLoggedIn = hasUserScript || welcomeMessage;


  // If user is logged in, don't disable features or add login prompt
  if (isUserLoggedIn) {
    return;
  }

  // Check if login prompt already exists to avoid duplicates
  const existingPrompt = document.querySelector('.alert-warning');
  if (existingPrompt) {
    return;
  }

  // Disable all category buttons
  document.querySelectorAll('.category-btn').forEach(btn => {
    btn.disabled = true;
    btn.title = 'Please log in to continue';
    btn.classList.add('disabled');
  });

  // Show login prompt only if not already present
  const bookingBody = document.querySelector('.booking-body');
  if (bookingBody && !existingPrompt) {
    const loginPrompt = document.createElement('div');
    loginPrompt.className = 'alert alert-warning';
    loginPrompt.innerHTML = `
      <i class="bi bi-exclamation-triangle me-2"></i>
      <strong>Login Required</strong><br>
      Please <a href="/login" class="alert-link">log in to your account</a> to book services.
    `;
    bookingBody.insertBefore(loginPrompt, bookingBody.firstChild);
  }
}

/**
 * Initialize booking state
 */
function initializeBookingState() {
  // Initialize BookingState
  BookingState.selectedServices = [];
  BookingState.currentService = null;
  BookingState.totalEstimatedPrice = 0;
  BookingState.hasRepairServices = false;
}

/**
 * Load services catalog
 */
function loadServicesCatalog() {
  // Load service catalog from window.initialCatalog or fetch from API
  if (window.initialCatalog) {
    BookingState.catalog.coreServices = window.initialCatalog.coreServices || [];
    BookingState.catalog.repairServices = window.initialCatalog.repairs || [];

    console.log('Services loaded from window.initialCatalog:', {
      coreServices: BookingState.catalog.coreServices.length,
      repairServices: BookingState.catalog.repairServices.length
    });

    // Render services immediately
    renderCoreServices();
    renderRepairServices();
  } else {
    // Fallback: fetch from API
    fetchServicesFromAPI();
  }
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  // Initialize event listeners
  initEventListeners();

  // Add category button listeners
  document.querySelectorAll('.category-btn').forEach(btn => {
    btn.addEventListener('click', handleCategoryClick);
  });
}

/**
 * Continue to Services (called from Step 1 button)
 */
function continueToServices() {

  // Ensure DOM elements are cached
  cacheDOMElements();

  // Ensure services catalog is loaded
  if (BookingState.catalog.coreServices.length === 0 && BookingState.catalog.repairServices.length === 0) {
    loadServicesCatalog();
  }

  // Move to Step 2
  showStep(2);

  // Ensure services are loaded in tabs
  if (DOM.coreServiceCards && DOM.coreServiceCards.children.length === 0) {
    renderCoreServices();
  } else {
  }

  if (DOM.repairServiceCards && DOM.repairServiceCards.children.length === 0) {
    renderRepairServices();
  } else {
  }

  // Re-cache DOM elements after rendering services to ensure all elements are available
  setTimeout(() => {
    cacheDOMElements();

    // Initialize selected services display
    updateSelectedServicesDisplay();
    updatePricingDisplay();
  }, 100);

  // Update stepper
  updateStepper(2);
}

/**
 * Handle category button clicks
 */
function handleCategoryClick(event) {

  const btn = event.target.closest('.category-btn');
  if (!btn) return;

  // If user is logged in, go directly to Step 2 (service selection with tabs)

  // Move to Step 2
  showStep(2);

  // Ensure services are loaded in tabs
  if (DOM.coreServiceCards && DOM.coreServiceCards.children.length === 0) {
    renderCoreServices();
  }
  if (DOM.repairServiceCards && DOM.repairServiceCards.children.length === 0) {
    renderRepairServices();
  }
}

/**
 * Update Step 2 display based on selected category
 */
function updateStep2Display(category) {

  // Update selected category display
  const categoryDisplay = document.getElementById('selectedCategoryDisplay');
  if (categoryDisplay) {
    categoryDisplay.textContent = category === 'services' ? 'Core Services' : 'Repair Services';
  }

  // Load services for the selected category
  const serviceCards = document.getElementById('categoryServiceCards');
  if (serviceCards) {
    serviceCards.innerHTML = '';

    const services = category === 'services'
      ? BookingState.catalog.coreServices
      : BookingState.catalog.repairServices;


    services.forEach(service => {
      const serviceCard = createServiceCard(service, category === 'services' ? 'core' : 'repair');
      serviceCards.appendChild(serviceCard);
    });
  }
}

/**
 * Reset category selection and go back to Step 1
 */
function resetCategorySelection() {
  BookingState.selectedCategory = null;
  BookingState.selectedServices = [];
  BookingState.scheduleDate = null;
  BookingState.scheduleTime = null;
  BookingState.location = null;
  BookingState.selectedTechnicianId = null;
  showStep(2);
  updateSelectedServicesDisplay();
}

/**
 * Load technician options for Step 3
 */
async function loadTechnicianOptions() {
  const technicianSelect = document.getElementById("technicianSelect");

  if (!technicianSelect) {
    console.error('❌ Technician select element not found');
    return;
  }

  console.log('🔄 Loading technicians...');

  // Remove any existing event listeners by cloning the element
  const newSelect = technicianSelect.cloneNode(true);
  technicianSelect.parentNode.replaceChild(newSelect, technicianSelect);

  newSelect.innerHTML = '<option value="">Loading technicians&hellip;</option>';

  try {
    const resp = await fetch("/api/services/technicians", {
      cache: "no-store",
      headers: {
        'Content-Type': 'application/json'
      }
    });

    console.log('📡 API Response status:', resp.status);

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }

    const json = await resp.json();
    console.log('📦 API Response data:', json);

    const techs = json.technicians || [];
    console.log(`👨‍🔧 Found ${techs.length} technicians`);

    // Clear dropdown
    newSelect.innerHTML = '';

    // Add default option
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Select a technician";
    newSelect.appendChild(defaultOption);

    if (techs.length === 0) {
      const noTechOption = document.createElement("option");
      noTechOption.value = "";
      noTechOption.textContent = "No technicians available";
      noTechOption.disabled = true;
      newSelect.appendChild(noTechOption);
      console.warn('⚠️ No technicians found in response');
      return;
    }

    // Add technician options with location data
    techs.forEach((t, index) => {
      const opt = document.createElement("option");
      opt.value = t._id;
      opt.textContent = t.name || `Technician ${index + 1}`;

      // Store location data in data attributes
      if (t.location) {
        opt.dataset.location = t.location;
      }

      if (t.lat && t.lng) {
        opt.dataset.lat = t.lat;
        opt.dataset.lng = t.lng;
      }

      if (t.location) {
        opt.textContent += ` (${t.location})`;
      }

      newSelect.appendChild(opt);
      console.log(`✅ Added technician: ${opt.textContent}`, {
        id: t._id,
        name: t.name,
        location: t.location,
        lat: t.lat,
        lng: t.lng,
        rating: t.rating
      });
    });

    // Add event listener for technician selection
    newSelect.addEventListener("change", (e) => {
      const technicianId = e.target.value || null;
      const selectedOption = e.target.options[e.target.selectedIndex];

      console.log('👨‍🔧 Technician selected:', technicianId);

      // Check if this is a reselection (technician already selected)
      const isReselection = BookingState.selectedTechnicianId &&
        BookingState.selectedTechnicianId !== technicianId;

      if (isReselection) {
        console.log('🔄 Technician reselection detected - resetting dependent steps');
        resetTechnicianDependentSteps();
      }

      // Store selected technician with location data
      if (typeof BookingState !== 'undefined') {
        BookingState.selectedTechnicianId = technicianId;

        if (technicianId && selectedOption) {
          BookingState.selectedTechnician = {
            id: technicianId,
            name: selectedOption.textContent,
            location: selectedOption.dataset.location || null,
            lat: selectedOption.dataset.lat || null,
            lng: selectedOption.dataset.lng || null
          };

          console.log('📍 Stored technician data:', BookingState.selectedTechnician);
        } else {
          BookingState.selectedTechnician = null;
        }
      }

      // If technician is selected, automatically advance to next step after a short delay
      if (technicianId) {
        // Show selection feedback
        newSelect.classList.add('is-valid');

        // Auto-advance after 1 second
        setTimeout(() => {
          console.log('⏭️ Auto-advancing to Step 4 after technician selection');
          showStep(4);
        }, 1000);
      }
    });

    console.log('✅ Technicians loaded successfully');
    console.log('📋 Dropdown options count:', newSelect.options.length);

  } catch (err) {
    console.error("❌ Load technicians error:", err);
    newSelect.innerHTML = '<option value="">Unable to load technicians</option>';

    // Show more detailed error to user
    const errorDiv = document.createElement('div');
    errorDiv.className = 'alert alert-warning mt-2';
    errorDiv.innerHTML = `
      <small>
        <i class="bi bi-exclamation-triangle me-1"></i>
        Failed to load technicians: ${err.message}
      </small>
    `;

    // Remove existing error message if any
    const existingError = newSelect.parentNode.querySelector('.alert');
    if (existingError) {
      existingError.remove();
    }

    newSelect.parentNode.appendChild(errorDiv);
  }
}

/**
 * Reset technician-dependent steps when technician is reselected
 */
function resetTechnicianDependentSteps() {
  console.log('🔄 Resetting technician-dependent steps');

  // Show notification about technician change
  showTechnicianChangeNotification(BookingState.selectedTechnician?.name || 'Previous technician');

  // Reset Step 4 (Location/Map)
  resetStep4ForTechnicianChange();

  // Reset Step 5 (Schedule)
  resetStep5ForTechnicianChange();

  // Clear dependent data
  BookingState.location = null;
  BookingState.userCoordinates = null;
  BookingState.selectedDate = null;
  BookingState.selectedTimeSlot = null;
  BookingState.distance = null;
  BookingState.fare = null;
  BookingState.travelDuration = null;

  console.log('✅ Technician-dependent steps reset complete');
}

/**
 * Reset Step 4 (Location/Map) for technician change
 */
function resetStep4ForTechnicianChange() {
  console.log('🗺️ Resetting Step 4 map for new technician');

  // Clear location input
  const locationInput = document.getElementById('locationInput');
  if (locationInput) {
    locationInput.value = '';
    locationInput.classList.remove('is-valid');
  }

  // Ensure company baseline coordinates persist for the new map instance.
  // Step 3 already loaded window._companyBaseLocation and set BookingState.companyBaseCoordinates.
  // We re-assign it here in case cleanupMap() or reinit timing clears dependent state.
  if (window._companyBaseLocation && typeof window._companyBaseLocation.lat === 'number' && typeof window._companyBaseLocation.lng === 'number') {
    BookingState.companyBaseCoordinates = {
      lat: window._companyBaseLocation.lat,
      lng: window._companyBaseLocation.lng
    };
  }


  // Clear distance and fare info
  const distanceElement = document.getElementById('mapInfoDistance');
  const fareElement = document.getElementById('mapInfoFare');
  const distanceInfoElement = document.getElementById('mapDistanceInfo');

  if (distanceElement) distanceElement.textContent = 'Detecting locations...';
  if (fareElement) fareElement.innerHTML = '<strong>Estimated Fare:</strong> Calculating...';
  if (distanceInfoElement) distanceInfoElement.innerHTML = '<i class="bi bi-hourglass-split me-1"></i> Waiting for location input...';

  // Clear and reinitialize map with proper timing
  if (typeof cleanupMap === 'function') {
    console.log('🧹 Cleaning up existing map...');
    cleanupMap();
  }

  // Wait a bit longer for cleanup to complete, then reinitialize
  setTimeout(() => {
    console.log('🔄 Reinitializing map after technician change...');
    if (typeof initializeMap === 'function') {
      initializeMap();
    }
  }, 1000); // Increased delay to ensure cleanup is complete

  console.log('✅ Step 4 map reset initiated');
}

/**
 * Reset Step 5 (Schedule) for technician change
 */
function resetStep5ForTechnicianChange() {
  console.log('📅 Resetting Step 5 schedule for new technician');

  // Clear calendar selections
  document.querySelectorAll('.date-btn').forEach(btn => {
    btn.classList.remove('btn-primary', 'active');
    btn.classList.add('btn-outline-primary');
  });

  // Clear time slot selections
  document.querySelectorAll('.time-slot-btn').forEach(btn => {
    btn.classList.remove('btn-success', 'active');
    btn.classList.add('btn-outline-secondary');
  });

  // Clear calendar containers
  const aiDatesContainer = document.getElementById('aiAvailableDates');
  const manualDatesContainer = document.getElementById('manualAvailableDates');
  const timeSlotsContainer = document.getElementById('timeSlots');

  // Enforce manual-only: wipe AI container if it exists, and keep manual empty until reloaded
  if (aiDatesContainer) aiDatesContainer.innerHTML = '';
  if (manualDatesContainer) manualDatesContainer.innerHTML = '';
  if (timeSlotsContainer) timeSlotsContainer.innerHTML = '<p class="text-muted">Select a date to view preferred start times.</p>';

  // Clear any success messages
  const successMessages = document.querySelectorAll('#timeSlots .alert-success');
  successMessages.forEach(msg => msg.remove());

  // Clear mode info
  const modeInfoElement = document.getElementById('modeInfo');
  if (modeInfoElement) modeInfoElement.innerHTML = '';

  // Clear duration info
  const durationInfoElement = document.getElementById('durationInfo');
  if (durationInfoElement) durationInfoElement.innerHTML = '';

  // Enforce manual-only panels (hide AI UI if present in markup)
  const aiDescription = document.getElementById('aiDescription');
  const manualDescription = document.getElementById('manualDescription');
  const aiSuggestedPanel = document.getElementById('aiSuggestedPanel');
  const manualCalendarPanel = document.getElementById('manualCalendarPanel');
  const aiSuggestedBtn = document.getElementById('aiSuggestedBtn');
  const manualCalendarBtn = document.getElementById('manualCalendarBtn');

  if (aiDescription) aiDescription.classList.add('d-none');
  if (manualDescription) manualDescription.classList.remove('d-none');

  if (aiSuggestedPanel) aiSuggestedPanel.classList.add('d-none');
  if (manualCalendarPanel) manualCalendarPanel.classList.remove('d-none');

  // Button styling (if the buttons still exist in old markup)
  if (aiSuggestedBtn) {
    aiSuggestedBtn.classList.remove('active', 'btn-primary');
    aiSuggestedBtn.classList.add('btn-outline-primary');
  }
  if (manualCalendarBtn) {
    manualCalendarBtn.classList.add('active', 'btn-primary');
    manualCalendarBtn.classList.remove('btn-outline-primary');
  }

  // Reset booking state to manual-only
  if (typeof BookingState !== 'undefined') {
    BookingState.calendarType = 'manual';
  }

  // If calendar elements are present, ensure manual calendar is visible
  const suggestedWrapper = document.getElementById('suggestedDates');
  const manualCalendar = document.getElementById('manualCalendar');
  if (suggestedWrapper) suggestedWrapper.classList.add('d-none');
  if (manualCalendar) manualCalendar.classList.remove('d-none');

  console.log('✅ Step 5 schedule reset complete (manual-only enforced)');
}

/**
 * Show technician change notification
 */
function showTechnicianChangeNotification(technicianName) {
  // Remove existing notification if any
  const existingNotification = document.querySelector('.alert.alert-info');
  if (existingNotification) {
    existingNotification.remove();
  }

  const notification = document.createElement('div');
  notification.className = 'alert alert-info alert-dismissible fade show position-fixed';
  notification.style.cssText = 'top: 20px; right: 20px; z-index: 9999; min-width: 300px;';
  notification.innerHTML = `
    <i class="bi bi-person-check me-2"></i>
    <strong>Technician Changed!</strong> Map and schedule reset for new selection.
    <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
  `;

  document.body.appendChild(notification);

  // Auto-remove after 4 seconds
  setTimeout(() => {
    if (notification.parentNode) {
      notification.parentNode.removeChild(notification);
    }
  }, 4000);

  console.log('📢 Technician change notification shown');
}

/**
 * Show specific step with completed steps visibility
 */
function showStep(stepNumber) {
  console.log(`🔧 showStep(${stepNumber}) called`);

  const prevStep = BookingState.currentStep || 1;
  const isBackward = stepNumber < prevStep;
  BookingState.currentStep = stepNumber;

  // Track furthest step reached (for stepper navigation)
  if (stepNumber > BookingState.maxReachedStep) {
    BookingState.maxReachedStep = stepNumber;
  }

  // Get target step element
  const targetStep = document.querySelector(`.booking-step[data-step="${stepNumber}"]`);

  if (!targetStep) {
    console.error(`❌ Step ${stepNumber} not found!`);
    return;
  }

  // ── Reset downstream state when navigating backward ──
  if (isBackward) {
    if (stepNumber <= 2) {
      // Going back to services: clear schedule, location, fee, payment
      BookingState.scheduleDate = null;
      BookingState.scheduleTime = null;
      BookingState.location = null;
      BookingState.selectedTechnicianId = null;
    } else if (stepNumber <= 3) {
      // Going back to location: clear schedule, fee, payment
      BookingState.scheduleDate = null;
      BookingState.scheduleTime = null;
    }
  }

  // Sync the ent-stepper if available
  if (typeof updateEntStepper === 'function') {
    updateEntStepper(stepNumber);
  }

  // Hide all steps first
  const allSteps = document.querySelectorAll('.booking-step');
  allSteps.forEach(step => {
    step.classList.add('d-none');
    step.classList.remove('step-visible', 'step-active', 'step-completed');
  });

  // Show ONLY the current step
  allSteps.forEach(step => {
    const stepNum = parseInt(step.dataset.step);
    if (stepNum === stepNumber) {
      step.classList.remove('d-none');
      step.classList.add('step-visible', 'step-active');
    }
  });

  // Load content for specific steps
  if (stepNumber === 4) {
    console.log('🔧 Initializing Step 4 scheduling...');
    setTimeout(() => {
      const manualCalendar = document.getElementById('manualCalendar');
      const suggestedWrapper = document.getElementById('suggestedDates');

      if (suggestedWrapper) suggestedWrapper.classList.add('d-none');
      if (manualCalendar) manualCalendar.classList.remove('d-none');

      initializeSchedulingModes();

      if (typeof BookingState !== 'undefined') {
        BookingState.calendarType = 'manual';

        if (!BookingState.selectedServiceId) {
          if (Array.isArray(BookingState.selectedServices) && BookingState.selectedServices.length > 0) {
            BookingState.selectedServiceId = BookingState.selectedServices[0].serviceId || BookingState.selectedServices[0]._id || null;
          }
        }
      }

      let attempts = 0;
      const maxAttempts = 5;

      const tryLoad = () => {
        attempts += 1;
        const serviceId = BookingState?.selectedServiceId;

        if (serviceId) {
          loadAvailableDates('manual');
          return;
        }

        if (attempts < maxAttempts) {
          setTimeout(tryLoad, 300);
        }
      };

      tryLoad();
    }, 0);
  }


  if (stepNumber === 5) {
    // Recalculate and display total fee from current BookingState.selectedServices
    console.log('💰 Calculating total fee for Fee Review...');
    displayTotalFee();
    updateReviewContent();
  }

  if (stepNumber === 6) {
    // Initialize payment step
    console.log('💳 Initializing Step 7 (Payment)...');
    setTimeout(() => {
      initializePaymentStep();
    }, 100);
  }

  if (stepNumber >= 3) {
    setupStepProgression(stepNumber);
  }

  // Smooth scroll to target step
  setTimeout(() => {
    targetStep.scrollIntoView({
      behavior: 'smooth',
      block: 'start',
      inline: 'nearest'
    });

    // Add highlight animation
    targetStep.classList.add('step-highlight');
    setTimeout(() => {
      targetStep.classList.remove('step-highlight');
    }, 2000);

    console.log(`✅ Scrolled to Step ${stepNumber}`);
  }, 100);

  // Update stepper
  updateStepper(stepNumber);
}

/**
 * Setup progression for location and later steps
 */
function setupStepProgression(stepNumber) {
  console.log(`🔧 Setting up progression for Step ${stepNumber}`);

  // For Step 3 (Location), setup location input auto-progress
  if (stepNumber === 3) {
    setupLocationAutoProgress();
  }

  // For Step 4 (Schedule), setup schedule auto-progress
  if (stepNumber === 4) {
    setupScheduleAutoProgress();
  }

  // For Step 5 (Fee), setup final review helpers
  if (stepNumber === 5) {
    setupReviewStep();
  }
}

/**
 * Setup location input with map display
 */
function setupLocationAutoProgress() {
  console.log('🔄 Setting up location auto-progress');

  const locationInput = document.getElementById("locationInput");
  const technicianMap = document.getElementById("technicianMap");

  if (!locationInput) {
    console.error('❌ Location input not found');
    return;
  }

  console.log('✅ Location input found');

  // Remove existing listener
  const newInput = locationInput.cloneNode(true);
  locationInput.parentNode.replaceChild(newInput, locationInput);

  // Display selected technician details
  displayTechnicianDetails();

  // Initialize map
  initializeMap();

  // Setup address autocomplete
  setupAddressAutocomplete(newInput);

  // Setup locate buttons
  setupLocateButtons();

  // Auto-populate user address if logged in and has a saved address
  if (window.currentUser && window.currentUser.address) {
    const addr = window.currentUser.address;
    const savedAddress = (typeof addr === 'string' ? addr : (addr.street || addr.line1 || addr.address || '')).toString().trim();
    if (savedAddress) {
      console.log('🏠 Auto-populating user saved address:', savedAddress);
      newInput.value = savedAddress;
      newInput.classList.add('is-valid');
      if (typeof BookingState !== 'undefined') {
        BookingState.location = savedAddress;
      }
      // Geocode and show on map
      setTimeout(() => {
        geocodeAddress(savedAddress, true);
      }, 500);
    }
  } else if (navigator.geolocation) {
    // If no saved address, try getting current location automatically
    console.log('🌐 No saved address, attempting to auto-detect current location...');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        console.log('📍 Auto-detected coordinates:', lat, lng);
        reverseGeocode(lat, lng);
      },
      (error) => {
        console.log('ℹ️ Auto-detection of location declined/failed:', error.message);
      },
      { enableHighAccuracy: true, timeout: 5000 }
    );
  }

  // Add listener for location input
  let debounceTimer;
  newInput.addEventListener("input", (e) => {
    clearTimeout(debounceTimer);
    const value = e.target.value.trim();

    console.log('📝 Location input changed:', value);

    // Update map as user types
    if (value.length >= 3) {
      geocodeAddress(value);
    }

    if (value.length >= 10) { // Minimum address length
      debounceTimer = setTimeout(() => {
        console.log('📍 Location entered, auto-advancing to Step 5');
        newInput.classList.add('is-valid');

        // Store location
        if (typeof BookingState !== 'undefined') {
          BookingState.location = value;
        }

        // Finalize map location
        geocodeAddress(value, true);

        setTimeout(() => showStep(4), 1500); // Give extra time for map to load
      }, 1500);
    }
  });

  console.log('✅ Location auto-progress setup complete');
}

/**
 * Setup address autocomplete using Nominatim
 */
function setupAddressAutocomplete(input) {
  const suggestContainer = document.getElementById('locationSuggest');
  if (!suggestContainer) return;

  let debounceTimer;

  input.addEventListener('input', function (e) {
    clearTimeout(debounceTimer);
    const query = e.target.value.trim();

    if (query.length < 3) {
      suggestContainer.classList.add('d-none');
      return;
    }

    debounceTimer = setTimeout(() => {
      fetchAddressSuggestions(query);
    }, 800); // Increased to 800ms to prevent rate limiting
  });

  // Hide suggestions when clicking outside
  document.addEventListener('click', function (e) {
    if (!input.contains(e.target) && !suggestContainer.contains(e.target)) {
      suggestContainer.classList.add('d-none');
    }
  });
}

/**
 * Fetch address suggestions from backend proxy (avoids CORS issues)
 */
function fetchAddressSuggestions(query) {
  const suggestContainer = document.getElementById('locationSuggest');
  if (!suggestContainer) return;

  // Use backend proxy endpoint instead of direct Nominatim API
  const url = `/api/geocoding/search?q=${encodeURIComponent(query)}&limit=5`;

  fetch(url)
    .then(response => response.json())
    .then(data => {
      if (data && data.length > 0) {
        displaySuggestions(data);
      } else {
        suggestContainer.classList.add('d-none');
      }
    })
    .catch(error => {
      console.error('Address suggestions error:', error);
      suggestContainer.classList.add('d-none');
    });
}

/**
 * Display address suggestions
 */
function displaySuggestions(suggestions) {
  const suggestContainer = document.getElementById('locationSuggest');
  const locationInput = document.getElementById("locationInput");

  if (!suggestContainer || !locationInput) return;

  suggestContainer.innerHTML = '';

  suggestions.forEach(suggestion => {
    const item = document.createElement('div');
    item.className = 'list-group-item list-group-item-action suggestion-item';
    item.style.cursor = 'pointer';

    // Format the display name
    let displayName = suggestion.display_name;

    // Highlight the main parts
    const parts = displayName.split(',');
    if (parts.length > 2) {
      displayName = parts.slice(0, 3).join(',') + '...';
    }

    item.innerHTML = `
      <div class="d-flex align-items-center">
        <i class="bi bi-geo-alt text-muted me-2"></i>
        <div>
          <div class="fw-semibold">${parts[0]}</div>
          <small class="text-muted">${parts.slice(1).join(', ').trim()}</small>
        </div>
      </div>
    `;

    item.addEventListener('click', () => {
      locationInput.value = suggestion.display_name;
      locationInput.classList.add('is-valid');
      suggestContainer.classList.add('d-none');

      // Geocode and update map
      if (suggestion.lat && suggestion.lon) {
        const lat = parseFloat(suggestion.lat);
        const lng = parseFloat(suggestion.lon);

        // Store customer location for booking (CRITICAL for validation)
        if (typeof BookingState !== 'undefined') {
          BookingState.customerLocation = {
            address: suggestion.display_name,
            lat: lat,
            lng: lng
          };
          BookingState.location = suggestion.display_name; // Legacy support
          BookingState.userCoordinates = { lat, lng }; // Legacy support

          console.log('📍 Customer location stored:', BookingState.customerLocation);
        }

        // Update map immediately
        if (BookingState?.map) {
          BookingState.map.setView([lat, lng], 16);

          // Remove existing user marker
          if (BookingState.userMarker) {
            BookingState.map.removeLayer(BookingState.userMarker);
          }

          // Add user marker
          BookingState.userMarker = L.marker([lat, lng], {
            icon: BookingState.userIcon
          }).addTo(BookingState.map);

          BookingState.userMarker.bindPopup(`
            <div style="padding: 8px; min-width: 150px;">
              <strong>🏠 Your Location</strong><br>
              <small>${suggestion.display_name}</small><br>
              <small>Click to zoom in</small>
            </div>
          `);

          // Add click handler
          BookingState.userMarker.on('click', function () {
            BookingState.map.setView([lat, lng], 16);
          });

          // Draw route if company location exists
          if (BookingState.companyBaseCoordinates) {
            drawRoute();
          }
        }
      }

      // Trigger auto-advance after 1.5 seconds
      setTimeout(() => {
        if (locationInput.value.length >= 10) {
          showStep(4);
        }
      }, 1500);
    });

    suggestContainer.appendChild(item);
  });

  suggestContainer.classList.remove('d-none');
}

/**
 * Display selected technician details
 */
function displayTechnicianDetails() {
  if (!BookingState.selectedTechnicianId) {
    console.warn('No technician selected');
    return;
  }

  const technicianName = BookingState.selectedTechnician?.name || 'Selected Technician';
  const technicianLocation = BookingState.selectedTechnician?.location || 'Location not specified';

  // Create/update technician details display
  let detailsContainer = document.getElementById('technicianDetails');
  if (!detailsContainer) {
    detailsContainer = document.createElement('div');
    detailsContainer.id = 'technicianDetails';
    detailsContainer.className = 'alert alert-info mb-3';

    // Insert after technician select or at appropriate location
    const locationStep = document.querySelector('.booking-step[data-step="4"]');
    if (locationStep) {
      const firstChild = locationStep.querySelector('h5');
      if (firstChild) {
        firstChild.insertAdjacentElement('afterend', detailsContainer);
      } else {
        locationStep.insertBefore(detailsContainer, locationStep.firstChild);
      }
    }
  }

  detailsContainer.innerHTML = `
    <div class="d-flex align-items-center">
      <i class="bi bi-person-check-fill me-2 fs-5"></i>
      <div>
        <strong>Selected Technician:</strong> ${technicianName}
        <br><small class="text-muted">Location: ${technicianLocation}</small>
        <br><small class="text-muted">Your service will be handled by this professional</small>
      </div>
    </div>
  `;

  console.log('✅ Technician details displayed:', { name: technicianName, location: technicianLocation });
}

/**
 * Initialize Leaflet Map
 */
function initializeMap() {
  const mapContainer = document.getElementById("technicianMap");

  if (!mapContainer) {
    console.warn('Map container not found');
    return;
  }

  // Clean up any existing map instance first
  cleanupMap();

  if (typeof L === 'undefined') {
    console.warn('Leaflet not loaded, waiting...');
    mapContainer.innerHTML = `
      <div class="d-flex align-items-center justify-content-center h-100 bg-light">
        <div class="text-center">
          <div class="spinner-border text-primary mb-2" role="status">
            <span class="visually-hidden">Loading map...</span>
          </div>
          <p class="text-muted mb-0">Loading map...</p>
        </div>
      </div>
    `;

    const checkLeafletInterval = setInterval(() => {
      if (window.leafletLoaded && typeof L !== 'undefined') {
        clearInterval(checkLeafletInterval);
        initializeMapInternal(mapContainer);
      }
    }, 100);

    setTimeout(() => {
      clearInterval(checkLeafletInterval);
      if (!window.leafletLoaded) {
        mapContainer.innerHTML = `
          <div class="alert alert-warning m-3">
            <i class="bi bi-exclamation-triangle me-2"></i>
            Unable to load map. Please check your internet connection and refresh the page.
          </div>
        `;
      }
    }, 10000);

    return;
  }

  // Ensure container is completely clean
  mapContainer.innerHTML = '';
  mapContainer._leaflet_id = null;

  initializeMapInternal(mapContainer);
}

/**
 * Clean up existing map instance
 */
function cleanupMap() {
  if (typeof BookingState === 'undefined') return;

  try {
    // Remove map instance
    if (BookingState.map) {
      BookingState.map.remove();
      BookingState.map = null;
      console.log('✅ Map instance removed');
    }

    // Clear markers
    BookingState.technicianMarker = null;
    BookingState.userMarker = null;
    BookingState.companyBaseMarker = null;
    BookingState.routeLine = null;
    BookingState.routeMarkers = [];

    // Clear coordinates
    BookingState.userCoordinates = null;

    // Clear the map container completely to prevent "already initialized" error
    const mapContainer = document.getElementById('technicianMap');
    if (mapContainer) {
      mapContainer.innerHTML = '';
      mapContainer._leaflet_id = null; // Clear Leaflet's internal tracking
      console.log('✅ Map container cleared');
    }

  } catch (error) {
    console.warn('⚠️ Error during map cleanup:', error);

    // Fallback: force clear the container
    const mapContainer = document.getElementById('technicianMap');
    if (mapContainer) {
      mapContainer.innerHTML = '';
      mapContainer._leaflet_id = null;
    }
  }
}


/**
 * Internal map initialization function
 */
function renderCompanyBaseMarker() {
  // Disabled: The main marker (formerly technicianMarker) is now centered on the company location.
  return;
  try {
    // Requires Leaflet map + company base coords
    if (!BookingState?.map) return;
    const coords = BookingState?.companyBaseCoordinates;
    if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return;

    // Remove previous marker
    if (BookingState.companyBaseMarker) {
      BookingState.map.removeLayer(BookingState.companyBaseMarker);
      BookingState.companyBaseMarker = null;
    }

    const companyIcon = L.divIcon({
      html: `<div style="background:#ffc107;border:3px solid white;border-radius:50% 50% 50% 0;width:30px;height:30px;transform:rotate(-45deg);box-shadow:0 2px 8px rgba(0,0,0,0.3);z-index:1200;">
        <div style="background:white;border-radius:50%;width:12px;height:12px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);"></div>
      </div>`,
      className: 'company-base-marker',
      iconSize: [40, 40],
      iconAnchor: [20, 40],
      popupAnchor: [0, -40],
      zIndexOffset: 1200
    });

    const marker = L.marker([Number(coords.lat), Number(coords.lng)], {
      icon: companyIcon,
      zIndexOffset: 1200
    }).addTo(BookingState.map);

    marker.bindPopup(
      `<div style="padding:8px;min-width:160px;">
        <strong>🏢 Company Baseline</strong><br>
        <small>${BookingState?.companyBaseAddress || window._companyBaseLocation?.address || 'Company location'}</small>
      </div>`,
      { className: 'custom-popup', maxWidth: 260 }
    );

    BookingState.companyBaseMarker = marker;

    const infoEl = document.getElementById('mapDistanceInfo');
    if (infoEl) infoEl.textContent = 'Company baseline loaded. Add your location to calculate fare.';

    // Keep map framed if technician marker exists
    if (BookingState.technicianMarker) {
      const group = new L.featureGroup([BookingState.technicianMarker, marker]);
      BookingState.map.fitBounds(group.getBounds().pad(0.2));
    }
  } catch (e) {
    console.warn('Company base marker render failed:', e);
  }
}

function setupCompanyBaseMarkerAfterMap() {
  // Retry because BookingState.companyBaseCoordinates may be set after map init.
  // We keep it light and bounded.
  let attempts = 0;
  const maxAttempts = 10;

  const tryRender = () => {
    attempts += 1;

    // Render as soon as we have the map + coords.
    // Avoid calling renderCompanyBaseMarker before Leaflet map is ready.
    if (BookingState?.companyBaseCoordinates && BookingState?.map) {
      BookingState.companyBaseAddress =
        window._companyBaseLocation?.address ||
        BookingState.companyBaseAddress ||
        null;
      renderCompanyBaseMarker();

      // If userCoordinates is already present, draw the route and calculate distance/fare
      if (BookingState.userCoordinates) {
        console.log('🏁 Coordinates found during company base setup, drawing route...');
        drawRoute();
      }
      return;
    }

    if (attempts < maxAttempts) {
      setTimeout(tryRender, 200);
    }
  };

  tryRender();
}


// Existing function
function initializeMapInternal(mapContainer) {
  // Always fetch/use company baseline coordinates from site settings
  let technicianLat = 14.676049; // Default: Manila, Philippines
  let technicianLng = 121.043731;

  if (BookingState.companyBaseCoordinates && BookingState.companyBaseCoordinates.lat && BookingState.companyBaseCoordinates.lng) {
    technicianLat = parseFloat(BookingState.companyBaseCoordinates.lat);
    technicianLng = parseFloat(BookingState.companyBaseCoordinates.lng);
    console.log('📍 Using company baseline coordinates for map base:', { lat: technicianLat, lng: technicianLng });
  } else if (window._companyBaseLocation && window._companyBaseLocation.lat && window._companyBaseLocation.lng) {
    technicianLat = parseFloat(window._companyBaseLocation.lat);
    technicianLng = parseFloat(window._companyBaseLocation.lng);
    BookingState.companyBaseCoordinates = { lat: technicianLat, lng: technicianLng };
    console.log('📍 Using company baseline coordinates from window location for map base:', { lat: technicianLat, lng: technicianLng });
  } else {
    // Fallback to data attributes or default
    technicianLat = parseFloat(mapContainer.dataset.technicianLat) || technicianLat;
    technicianLng = parseFloat(mapContainer.dataset.technicianLng) || technicianLng;
    console.log('📍 Using fallback coordinates for map base:', { lat: technicianLat, lng: technicianLng });
  }

  // Initialize Leaflet map with error handling
  let map;
  try {
    map = L.map(mapContainer, {
      center: [technicianLat, technicianLng],
      zoom: 13
    });
    console.log('✅ Leaflet map instance created');
  } catch (error) {
    console.error('❌ Failed to create map instance:', error);
    // Try to recover by clearing container and retrying
    mapContainer.innerHTML = '';
    try {
      map = L.map(mapContainer).setView([technicianLat, technicianLng], 13);
      console.log('✅ Map instance created on retry');
    } catch (retryError) {
      console.error('❌ Failed to create map instance on retry:', retryError);
      showError('Unable to initialize map. Please refresh the page.');
      return;
    }
  }

  // Add OpenStreetMap tiles
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19
  }).addTo(map);

  // Create custom technician icon (blue color)
  const technicianIcon = L.divIcon({
    html: `
      <div style="
        background: #0d6efd;
        border: 3px solid white;
        border-radius: 50% 50% 50% 0;
        width: 30px;
        height: 30px;
        transform: rotate(-45deg);
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        cursor: pointer;
        z-index: 1000;
      ">
        <div style="
          background: white;
          border-radius: 50%;
          width: 12px;
          height: 12px;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
        "></div>
      </div>
    `,
    className: 'technician-marker',
    iconSize: [40, 40],
    iconAnchor: [20, 40],
    popupAnchor: [0, -40],
    zIndexOffset: 1000
  });

  // Create custom user icon
  const userIcon = L.divIcon({
    html: `
      <div style="
        background: #198754;
        border: 3px solid white;
        border-radius: 50% 50% 50% 0;
        width: 40px;
        height: 40px;
        position: relative;
        transform: rotate(-45deg);
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        cursor: pointer;
        z-index: 1000;
      ">
        <div style="
          background: white;
          border-radius: 50%;
          width: 12px;
          height: 12px;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
        "></div>
      </div>
    `,
    className: 'user-marker',
    iconSize: [40, 40],
    iconAnchor: [20, 40],
    popupAnchor: [0, -40],
    zIndexOffset: 1000
  });

  // Add technician marker with enhanced click handler
  const technicianMarker = L.marker([technicianLat, technicianLng], {
    icon: technicianIcon,
    zIndexOffset: 1000
  }).addTo(map);

  // Popup with company location info
  const technicianPopupContent = `
    <div style="padding: 8px; min-width: 150px;">
      <strong>🏢 Company Location</strong><br>
      <small>${window._companyBaseLocation?.address || BookingState.companyBaseAddress || 'Company base location'}</small><br>
      <small style="color: #0d6efd; cursor: pointer;" onclick="zoomToTechnician()">Click to zoom in</small>
    </div>
  `;

  technicianMarker.bindPopup(technicianPopupContent, {
    maxWidth: 250,
    className: 'custom-popup'
  });

  // Enhanced click handler for technician marker
  technicianMarker.on('click', function (e) {
    console.log('📍 Technician marker clicked');
    map.setView([technicianLat, technicianLng], 16);

    // Open popup
    this.openPopup();

    // Add visual feedback
    this.setIcon(createPulsingIcon('#0d6efd'));
    setTimeout(() => {
      this.setIcon(technicianIcon);
    }, 1000);
  });

  // Make zoomToTechnician globally available
  window.zoomToTechnician = function () {
    console.log('🔍 Zooming to technician');
    if (BookingState?.map && BookingState?.technicianMarker) {
      const pos = BookingState.technicianMarker.getLatLng();
      BookingState.map.setView(pos, 16);
    }
  };

  // Store map instances
  if (typeof BookingState !== 'undefined') {
    BookingState.map = map;
    BookingState.technicianMarker = technicianMarker;
    BookingState.userMarker = null;
    BookingState.routeLine = null;
    BookingState.technicianIcon = technicianIcon;
    BookingState.userIcon = userIcon;
    BookingState.routeMarkers = [];
  }

  // Render company baseline marker after map init (fare uses company↔customer, not technician↔customer)
  // BookingState.companyBaseCoordinates is set from Step 3 inline script; may arrive slightly after map.
  // IMPORTANT: trigger via setupCompanyBaseMarkerAfterMap() so it waits for both map + coordinates.
  if (typeof setupCompanyBaseMarkerAfterMap === 'function') {
    setupCompanyBaseMarkerAfterMap();
    // Retry again shortly to cover DOM/script timing races.
    setTimeout(() => {
      try {
        setupCompanyBaseMarkerAfterMap();
      } catch (e) {
        console.warn('Re-run company base marker setup failed:', e);
      }
    }, 150);
  } else {
    // If for some reason setupCompanyBaseMarkerAfterMap is missing, fall back to best-effort immediate render.
    if (BookingState?.companyBaseCoordinates && typeof renderCompanyBaseMarker === 'function') {
      try {
        renderCompanyBaseMarker();
      } catch (e) {
        console.warn('Immediate company base marker render failed:', e);
      }
    }
  }


  // Invalidate map size to ensure tiles load correctly when container transitions/displays
  setTimeout(() => {
    try {
      if (map) {
        map.invalidateSize();
        console.log('🔄 Leaflet map size invalidated');
      }
    } catch (err) {
      console.warn('Map invalidateSize failed:', err);
    }
  }, 250);

  console.log('✅ Leaflet map initialized with technician location:', {
    lat: technicianLat,
    lng: technicianLng,
    name: BookingState.selectedTechnician?.name
  });
}

/**
 * Create pulsing icon for visual feedback
 */
function createPulsingIcon(color) {
  return L.divIcon({
    html: `
      <div style="
        background: ${color};
        border: 3px solid white;
        border-radius: 50% 50% 50% 0;
        width: 50px;
        height: 50px;
        position: relative;
        transform: rotate(-45deg);
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        cursor: pointer;
        z-index: 1000;
        animation: pulse 1s infinite;
      ">
        <div style="
          background: white;
          border-radius: 50%;
          width: 15px;
          height: 15px;
          position: absolute;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
        "></div>
      </div>
      <style>
        @keyframes pulse {
          0% { transform: rotate(-45deg) scale(1); }
          50% { transform: rotate(-45deg) scale(1.2); }
          100% { transform: rotate(-45deg) scale(1); }
        }
      </style>
    `,
    className: 'pulsing-marker',
    iconSize: [50, 50],
    iconAnchor: [25, 50],
    popupAnchor: [0, -50],
    zIndexOffset: 2000
  });
}

/**
 * Geocode address using Nominatim (OpenStreetMap)
 */
function geocodeAddress(address, finalize = false) {
  if (!BookingState?.map) {
    console.warn('Map not initialized');
    return;
  }

  // Use backend proxy for geocoding (avoids CORS issues)
  const geocodeUrl = `/api/geocoding/search?q=${encodeURIComponent(address)}&limit=1`;

  fetch(geocodeUrl)
    .then(response => response.json())
    .then(data => {
      if (data && data.error) {
        console.error('Geocoding API error:', data.error);
        if (finalize) {
          showError(data.error);
        }
        return;
      }
      if (data && data.length > 0) {
        const result = data[0];
        const lat = parseFloat(result.lat);
        const lng = parseFloat(result.lon);

        // Update map center
        BookingState.map.setView([lat, lng], finalize ? 16 : 14);

        // Remove existing user marker
        if (BookingState.userMarker) {
          BookingState.map.removeLayer(BookingState.userMarker);
        }

        // Add user location marker with enhanced click handler
        BookingState.userMarker = L.marker([lat, lng], {
          icon: BookingState.userIcon,
          zIndexOffset: 1000
        }).addTo(BookingState.map);

        BookingState.userMarker.bindPopup(`
          <div style="padding: 8px; min-width: 150px;">
            <strong>🏠 Your Location</strong><br>
            <small>${result.display_name}</small><br>
            <small style="color: #198754; cursor: pointer;" onclick="zoomToUser()">Click to zoom in</small>
          </div>
        `, {
          maxWidth: 250,
          className: 'custom-popup'
        });

        // Enhanced click handler for user marker
        BookingState.userMarker.on('click', function (e) {
          console.log('🏠 User marker clicked');
          BookingState.map.setView([lat, lng], 16);

          // Open popup
          this.openPopup();

          // Add visual feedback
          this.setIcon(createPulsingIcon('#198754'));
          setTimeout(() => {
            this.setIcon(BookingState.userIcon);
          }, 1000);
        });

        // Make zoomToUser globally available
        window.zoomToUser = function () {
          console.log('🔍 Zooming to user location');
          if (BookingState?.map && BookingState?.userMarker) {
            const pos = BookingState.userMarker.getLatLng();
            BookingState.map.setView(pos, 16);
          }
        };

        // Store coordinates
        BookingState.userCoordinates = { lat, lng };

        // Draw route if both company baseline and user coordinates exist and finalizing
        if (BookingState.companyBaseCoordinates && finalize) {
          drawRoute();
        }

        console.log('✅ Address geocoded:', address, { lat, lng });

      } else {
        console.warn('Geocoding failed: No results found');
        if (finalize) {
          showError('Unable to find the address. Please check and try again.');
        }
      }
    })
    .catch(error => {
      console.error('Geocoding error:', error);
      if (finalize) {
        showError('Unable to geocode address. Please try again.');
      }
    });
}

/**
 * Draw route between technician and user using actual road paths
 */
function drawRoute() {
  if (!BookingState.userCoordinates) {
    console.warn('⚠️ Customer location required for route drawing');
    return;
  }

  // Ensure company base coordinates are loaded
  if (!BookingState.companyBaseCoordinates && window._companyBaseLocation) {
    BookingState.companyBaseCoordinates = {
      lat: window._companyBaseLocation.lat,
      lng: window._companyBaseLocation.lng
    };
  }

  // Route/distance must be based on company baseline ↔ customer location.
  const companyPos = BookingState.companyBaseCoordinates
    ? L.latLng(BookingState.companyBaseCoordinates.lat, BookingState.companyBaseCoordinates.lng)
    : null;

  if (!companyPos) {
    console.warn('⚠️ Company base location required for route drawing');
    return;
  }

  const userPos = L.latLng(BookingState.userCoordinates.lat, BookingState.userCoordinates.lng);

  console.log('🛣️ Drawing route from company baseline to user');
  console.log('📍 Company baseline position:', companyPos);
  console.log('📍 User position:', userPos);

  // Remove existing route
  if (BookingState.routeLine) {
    BookingState.map.removeLayer(BookingState.routeLine);
    console.log('🗑️ Removed existing route line');
  }

  // Remove existing route markers
  if (BookingState.routeMarkers) {
    BookingState.routeMarkers.forEach(marker => BookingState.map.removeLayer(marker));
    BookingState.routeMarkers = [];
    console.log('🗑️ Removed existing route markers');
  }

  // Show loading indicator
  showRouteLoading();

  // Get actual route using OpenStreetMap routing API
  getActualRoute(companyPos, userPos)
    .then(routeData => {
      hideRouteLoading();

      if (routeData && routeData.coordinates && routeData.coordinates.length > 2) {
        console.log('✅ Drawing actual route with', routeData.coordinates.length, 'points');

        // Draw the actual route with enhanced styling
        BookingState.routeLine = L.polyline(routeData.coordinates, {
          color: '#0d6efd',
          weight: 5,
          opacity: 0.9,
          smoothFactor: 1,
          className: 'actual-route animate-route'
        }).addTo(BookingState.map);

        // Add route animation effect
        animateRoute(BookingState.routeLine);

        // Add route waypoints markers (turn points)
        if (routeData.waypoints && routeData.waypoints.length > 0) {
          console.log('🎯 Adding', routeData.waypoints.length, 'waypoint markers');
          BookingState.routeMarkers = [];

          routeData.waypoints.forEach((waypoint, index) => {
            const marker = L.circleMarker(waypoint, {
              radius: 4,
              fillColor: '#ffffff',
              color: '#0d6efd',
              weight: 2,
              opacity: 1,
              fillOpacity: 1,
              className: 'route-waypoint'
            }).addTo(BookingState.map);

            // Add popup with turn instruction if available
            if (routeData.instructions && routeData.instructions[index]) {
              marker.bindPopup(routeData.instructions[index]);
            }

            BookingState.routeMarkers.push(marker);
          });
        }

        // Fit map to show the entire route with padding
        if (routeData.bounds) {
          BookingState.map.fitBounds(routeData.bounds, {
            padding: [60, 60],
            maxZoom: 16
          });
          console.log('🗺️ Fitted map to route bounds');
        } else {
          const markers = [];
          if (BookingState.technicianMarker) markers.push(BookingState.technicianMarker);
          if (BookingState.userMarker) markers.push(BookingState.userMarker);
          if (markers.length > 0) {
            const group = new L.featureGroup(markers);
            BookingState.map.fitBounds(group.getBounds().pad(0.15));
          }
        }

        // Update distance info with actual route data
        if (routeData.distance && routeData.duration) {
          updateDistanceInfo(routeData.distance, Math.round(routeData.distance * 30), Math.round(routeData.duration));
        }

        console.log('✅ Actual route drawn successfully');

      } else {
        console.warn('⚠️ Route data insufficient, falling back to straight line');
        drawStraightLineRoute(companyPos, userPos);
      }
    })
    .catch(error => {
      hideRouteLoading();
      console.warn('❌ Route API failed, using straight line:', error);
      drawStraightLineRoute(companyPos, userPos);
    });

  // Calculate distance and fare
  calculateDistanceAndFare();
}


/**
 * Show route loading indicator
 */
function showRouteLoading() {
  const loadingHtml = `
    <div id="routeLoading" style="
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(255, 255, 255, 0.95);
      padding: 15px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 2000;
      font-size: 14px;
      color: #0d6efd;
      font-weight: 500;
    ">
      <i class="bi bi-arrow-clockwise spin me-2"></i>
      Calculating best route...
    </div>
  `;

  const mapContainer = document.getElementById('technicianMap');
  if (mapContainer) {
    mapContainer.insertAdjacentHTML('beforeend', loadingHtml);
  }
}

/**
 * Hide route loading indicator
 */
function hideRouteLoading() {
  const loadingElement = document.getElementById('routeLoading');
  if (loadingElement) {
    loadingElement.remove();
  }
}

/**
 * Animate route drawing
 */
function animateRoute(routeLine) {
  // Add CSS animation class
  routeLine.setStyle({
    dashArray: '15, 10',
    dashOffset: '0'
  });

  // Animate the dashes
  let offset = 0;
  const animateDash = () => {
    offset = (offset + 1) % 25;
    routeLine.setStyle({ dashOffset: offset.toString() });
    requestAnimationFrame(animateDash);
  };

  // Start animation after a short delay
  setTimeout(() => {
    requestAnimationFrame(animateDash);
  }, 500);

  // Stop animation after 3 seconds
  setTimeout(() => {
    routeLine.setStyle({
      dashArray: '',
      dashOffset: ''
    });
  }, 3000);
}

/**
 * Get actual route from OpenStreetMap routing service
 */
async function getActualRoute(startPos, endPos) {
  try {
    console.log('🛣️ Getting actual route from', startPos, 'to', endPos);

    // Using OSRM (Open Source Routing Machine) - free OpenStreetMap routing service
    const url = `https://router.project-osrm.org/route/v1/driving/${startPos.lng},${startPos.lat};${endPos.lng},${endPos.lat}?overview=full&geometries=geojson&steps=true`;

    console.log('📡 Requesting route from OSRM:', url);

    const response = await fetch(url);
    console.log('📡 OSRM response status:', response.status);

    if (!response.ok) {
      throw new Error(`OSRM API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    console.log('📦 OSRM response data:', data);

    if (data.routes && data.routes.length > 0) {
      const route = data.routes[0];
      console.log('✅ Found route with', route.geometry.coordinates.length, 'coordinates');

      // Convert [lng, lat] to [lat, lng] for Leaflet
      const coordinates = route.geometry.coordinates.map(coord => {
        const leafletCoord = [coord[1], coord[0]];
        console.log('📍 Converting coordinate:', coord, 'to', leafletCoord);
        return leafletCoord;
      });

      // Create bounds from the route
      const bounds = L.latLngBounds(coordinates);
      console.log('🗺️ Route bounds:', bounds);

      // Extract waypoints for visual markers (turn points)
      const waypoints = [];
      if (route.legs && route.legs.length > 0) {
        route.legs.forEach((leg, legIndex) => {
          console.log(`🚶 Processing leg ${legIndex} with ${leg.steps ? leg.steps.length : 0} steps`);
          if (leg.steps) {
            leg.steps.forEach((step, stepIndex) => {
              if (step.maneuver && step.maneuver.location) {
                const waypoint = [step.maneuver.location[1], step.maneuver.location[0]];
                waypoints.push(waypoint);
                console.log(`🔄 Waypoint ${stepIndex}:`, waypoint, step.maneuver.instruction || '');
              }
            });
          }
        });
      }

      console.log('🎯 Total waypoints:', waypoints.length);

      return {
        coordinates: coordinates,
        bounds: bounds,
        distance: route.distance / 1000, // Convert meters to km
        duration: route.duration / 60, // Convert seconds to minutes
        waypoints: waypoints.slice(1, -1) // Exclude start and end points
      };
    } else {
      console.warn('⚠️ No routes found in OSRM response');
      return null;
    }
  } catch (error) {
    console.error('❌ Error getting route from OSRM:', error);
    return null;
  }
}

/**
 * Fallback: Draw straight line route
 */
function drawStraightLineRoute(technicianPos, userPos) {
  BookingState.routeLine = L.polyline([technicianPos, userPos], {
    color: '#0d6efd',
    weight: 3,
    opacity: 0.7,
    dashArray: '10, 10',
    className: 'straight-line-route'
  }).addTo(BookingState.map);

  // Fit map to show both markers safely
  const markers = [];
  if (BookingState.technicianMarker) markers.push(BookingState.technicianMarker);
  if (BookingState.userMarker) markers.push(BookingState.userMarker);
  if (markers.length > 0) {
    const group = new L.featureGroup(markers);
    BookingState.map.fitBounds(group.getBounds().pad(0.1));
  }

  console.log('✅ Fallback straight line route drawn');
}

/**
 * Reverse geocode coordinates to address using backend proxy
 */
function reverseGeocode(lat, lng) {
  const reverseGeocodeUrl = `/api/geocoding/reverse?lat=${lat}&lon=${lng}`;

  fetch(reverseGeocodeUrl)
    .then(response => response.json())
    .then(data => {
      if (data && data.error) {
        console.error('Reverse geocoding API error:', data.error);
        showError(data.error);
        return;
      }
      if (data && data.display_name) {
        const address = data.display_name;
        const locationInput = document.getElementById("locationInput");

        if (locationInput) {
          locationInput.value = address;
          locationInput.classList.add('is-valid');

          // Store customer location for booking (CRITICAL for validation)
          if (typeof BookingState !== 'undefined') {
            BookingState.customerLocation = {
              address: address,
              lat: lat,
              lng: lng
            };
            BookingState.location = address; // Legacy support
            BookingState.userCoordinates = { lat, lng }; // Legacy support

            console.log('📍 Customer location stored (reverse geocode):', BookingState.customerLocation);
          }

          // Update map
          if (BookingState.map) {
            BookingState.map.setView([lat, lng], 16);

            // Add user marker with enhanced click handler
            BookingState.userMarker = L.marker([lat, lng], {
              icon: BookingState.userIcon,
              zIndexOffset: 1000
            }).addTo(BookingState.map);

            BookingState.userMarker.bindPopup(`
              <div style="padding: 8px; min-width: 150px;">
                <strong>🏠 Your Location</strong><br>
                <small>${address}</small><br>
                <small style="color: #198754; cursor: pointer;" onclick="zoomToUser()">Click to zoom in</small>
              </div>
            `, {
              maxWidth: 250,
              className: 'custom-popup'
            });

            // Enhanced click handler for user marker
            BookingState.userMarker.on('click', function (e) {
              console.log('🏠 User marker clicked (reverse geocode)');
              BookingState.map.setView([lat, lng], 16);

              // Open popup
              this.openPopup();

              // Add visual feedback
              this.setIcon(createPulsingIcon('#198754'));
              setTimeout(() => {
                this.setIcon(BookingState.userIcon);
              }, 1000);
            });

            // Update global zoomToUser function
            window.zoomToUser = function () {
              console.log('🔍 Zooming to user location (reverse geocode)');
              if (BookingState?.map && BookingState?.userMarker) {
                const pos = BookingState.userMarker.getLatLng();
                BookingState.map.setView(pos, 16);
              }
            };

            drawRoute();
          }

          console.log('✅ Current location set:', address);
        }
      }
    })
    .catch(error => {
      console.error('Reverse geocoding error:', error);
      showError('Unable to get address from coordinates. Please enter manually.');
    });
}

/**
 * Add current location button
 */
function addCurrentLocationButton() {
  console.log('🔄 addCurrentLocationButton called');

  const locationInput = document.getElementById("locationInput");
  if (!locationInput) {
    console.error('❌ Location input not found for current location button');
    return;
  }

  console.log('✅ Location input found, checking for existing button');

  // Check if button already exists by ID
  const existingBtn = document.getElementById('currentLocationBtn');
  if (existingBtn) {
    console.log('⚠️ Current location button already exists, removing old one');
    existingBtn.parentNode.remove();
  }

  // Check if container already exists
  let buttonContainer = locationInput.parentNode.querySelector('.current-location-btn-container');
  if (buttonContainer) {
    console.log('⚠️ Button container already exists, removing old one');
    buttonContainer.remove();
  }

  // Find the input group container
  const inputGroup = locationInput.closest('.input-group');
  const suggestContainer = document.getElementById('locationSuggest');

  // Create button container
  buttonContainer = document.createElement('div');
  buttonContainer.className = 'current-location-btn-container mt-2';

  const currentLocationBtn = document.createElement('button');
  currentLocationBtn.type = 'button';
  currentLocationBtn.className = 'btn btn-outline-primary btn-sm w-100';
  currentLocationBtn.id = 'currentLocationBtn'; // Add ID for tracking
  currentLocationBtn.innerHTML = '<i class="bi bi-geo-alt-fill me-1"></i> Use Current Location';

  console.log('✅ Creating current location button with event listener');

  currentLocationBtn.addEventListener('click', function () {
    console.log('📍 Current location button clicked');

    if (!navigator.geolocation) {
      console.error('❌ Geolocation not supported');
      showError('Geolocation is not supported by your browser');
      return;
    }

    console.log('🔄 Getting current location...');
    this.disabled = true;
    this.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i> Getting location...';

    navigator.geolocation.getCurrentPosition(
      (position) => {
        console.log('✅ Location received:', position.coords);
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;

        // Reverse geocode to get address
        reverseGeocode(lat, lng);

        this.disabled = false;
        this.innerHTML = '<i class="bi bi-geo-alt-fill me-1"></i> Use Current Location';
      },
      (error) => {
        console.error('❌ Geolocation error:', error);
        let errorMessage = 'Unable to get your location. Please enter address manually.';

        switch (error.code) {
          case error.PERMISSION_DENIED:
            errorMessage = 'Location access denied. Please allow location access and try again.';
            break;
          case error.POSITION_UNAVAILABLE:
            errorMessage = 'Location information unavailable. Please enter address manually.';
            break;
          case error.TIMEOUT:
            errorMessage = 'Location request timed out. Please try again.';
            break;
        }

        showError(errorMessage);
        this.disabled = false;
        this.innerHTML = '<i class="bi bi-geo-alt-fill me-1"></i> Use Current Location';
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  });

  buttonContainer.appendChild(currentLocationBtn);

  // Insert button after the suggestions container or input group
  if (suggestContainer && suggestContainer.parentNode) {
    suggestContainer.parentNode.insertBefore(buttonContainer, suggestContainer.nextSibling);
    console.log('✅ Current location button added after suggestions container');
  } else if (inputGroup) {
    inputGroup.parentNode.insertBefore(buttonContainer, inputGroup.nextSibling);
    console.log('✅ Current location button added after input group');
  } else {
    locationInput.parentNode.insertBefore(buttonContainer, locationInput.nextSibling);
    console.log('✅ Current location button added after location input');
  }

  console.log('✅ Current location button setup complete');
}

/**
 * Setup locate buttons for technician and customer
 */
function setupLocateButtons() {
  const locateCompanyBtn = document.getElementById('locateCompanyBtn');
  const locateCustomerBtn = document.getElementById('locateCustomerBtn');
  const focusCustomerBtn = document.getElementById('focusCustomerBtn');

  if (locateCompanyBtn) {
    locateCompanyBtn.addEventListener('click', () => {
      console.log('🔍 Locate company button clicked');
      if (BookingState?.technicianMarker && BookingState?.map) {
        const pos = BookingState.technicianMarker.getLatLng();
        BookingState.map.setView(pos, 16);
        BookingState.technicianMarker.openPopup();
      } else {
        console.warn('Company marker not available');
      }
    });
  }

  if (locateCustomerBtn) {
    locateCustomerBtn.addEventListener('click', () => {
      console.log('📍 Use My Location clicked');
      if (!navigator.geolocation) {
        showError('Geolocation is not supported by your browser');
        return;
      }

      locateCustomerBtn.disabled = true;
      const originalText = locateCustomerBtn.innerHTML;
      locateCustomerBtn.innerHTML = '<i class="bi bi-arrow-clockwise spin me-1"></i> Getting location...';

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const lat = position.coords.latitude;
          const lng = position.coords.longitude;
          console.log('📍 Location detected:', lat, lng);
          reverseGeocode(lat, lng);
          locateCustomerBtn.disabled = false;
          locateCustomerBtn.innerHTML = originalText;
        },
        (error) => {
          console.error('❌ Geolocation error:', error);
          showError('Unable to get your location. Please enter address manually.');
          locateCustomerBtn.disabled = false;
          locateCustomerBtn.innerHTML = originalText;
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        }
      );
    });
  }

  if (focusCustomerBtn) {
    focusCustomerBtn.addEventListener('click', () => {
      console.log('🔍 Focus customer button clicked');
      if (BookingState?.userMarker && BookingState?.map) {
        const pos = BookingState.userMarker.getLatLng();
        BookingState.map.setView(pos, 16);
        BookingState.userMarker.openPopup();
      } else {
        console.warn('User marker not available');
        showError('Please enter your location first');
      }
    });
  }

  console.log('✅ Locate buttons setup complete');
}

/**
 * Calculate distance and travel fare with realistic duration
 */
function calculateDistanceAndFare() {
  // Ensure company base coordinates are loaded
  if (!BookingState.companyBaseCoordinates && window._companyBaseLocation) {
    BookingState.companyBaseCoordinates = {
      lat: window._companyBaseLocation.lat,
      lng: window._companyBaseLocation.lng
    };
  }

  if (!BookingState?.companyBaseCoordinates || !BookingState?.userCoordinates) {
    console.warn('Both company baseline and user coordinates are required for distance calculation');
    return;
  }

  const companyPos = L.latLng(BookingState.companyBaseCoordinates.lat, BookingState.companyBaseCoordinates.lng);
  const userPos = L.latLng(BookingState.userCoordinates.lat, BookingState.userCoordinates.lng);

  console.log('🧮 Calculating realistic distance and fare');

  // Try to get actual route distance from OSRM
  getActualRoute(companyPos, userPos)
    .then(routeData => {
      let distance;
      let travelDurationMinutes;

      if (routeData && routeData.distance) {
        // Use actual route distance from OSRM
        distance = routeData.distance;
        console.log('🛣️ Using actual route distance:', distance.toFixed(2), 'km');

        // Calculate realistic duration
        const trafficFactor = getTrafficFactor();
        travelDurationMinutes = calculateRealisticDuration(routeData, trafficFactor);

      } else {
        // Fallback to Haversine calculation
        const straightDistance = calculateHaversineDistance(
          companyPos.lat, companyPos.lng,
          userPos.lat, userPos.lng
        );
        distance = straightDistance * 1.4; // Apply road factor
        console.log('📏 Using calculated distance:', distance.toFixed(2), 'km');

        // Calculate realistic duration for fallback
        const trafficFactor = getTrafficFactor();
        const fallbackRouteData = { distance: distance };
        travelDurationMinutes = calculateRealisticDuration(fallbackRouteData, trafficFactor);
      }

      // Apply traffic factor to fare calculation (but not to distance display)
      const trafficFactor = getTrafficFactor();
      const adjustedDistance = distance * trafficFactor;

      // Calculate fare based on traffic-adjusted distance
      const farePerKm = window._farePerKm || 40; // Use admin-configured fare per km
      const fare = Math.round(adjustedDistance * farePerKm);

      // Update UI with realistic data
      updateDistanceInfo(distance, fare, travelDurationMinutes);

      // Store in booking state
      if (typeof BookingState !== 'undefined') {
        BookingState.distance = distance;
        BookingState.fare = fare;
        BookingState.travelFare = fare; // Sync with displayTotalFee() which reads travelFare
        BookingState.travelDuration = travelDurationMinutes;
        BookingState.trafficFactor = trafficFactor;
        BookingState.actualRouteDistance = routeData?.distance || null;
        BookingState.actualRouteDuration = routeData?.duration || null;
      }

      console.log('📊 Realistic calculation complete:', {
        distance: distance.toFixed(2) + ' km',
        trafficFactor: trafficFactor,
        adjustedDistance: adjustedDistance.toFixed(2) + ' km',
        fare: '₱' + fare.toLocaleString(),
        duration: travelDurationMinutes + ' min',
        dataSource: routeData ? 'OSRM route data' : 'Calculated fallback'
      });

      // Trigger update of total booking fee display
      if (typeof displayTotalFee === 'function') {
        displayTotalFee();
      }
    })
    .catch(error => {
      console.warn('Route calculation failed, using enhanced fallback:', error);

      // Enhanced fallback calculation
      const straightDistance = calculateHaversineDistance(
        companyPos.lat, companyPos.lng,
        userPos.lat, userPos.lng
      );
      const distance = straightDistance * 1.4; // Apply road factor

      const trafficFactor = getTrafficFactor();
      const adjustedDistance = distance * trafficFactor;
      const fare = Math.round(adjustedDistance * (window._farePerKm || 40));

      // Use realistic duration calculation for fallback
      const fallbackRouteData = { distance: distance };
      const travelDurationMinutes = calculateRealisticDuration(fallbackRouteData, trafficFactor);

      updateDistanceInfo(distance, fare, travelDurationMinutes);

      if (typeof BookingState !== 'undefined') {
        BookingState.distance = distance;
        BookingState.fare = fare;
        BookingState.travelFare = fare; // Sync with displayTotalFee() which reads travelFare
        BookingState.travelDuration = travelDurationMinutes;
        BookingState.trafficFactor = trafficFactor;
      }

      // Trigger update of total booking fee display
      if (typeof displayTotalFee === 'function') {
        displayTotalFee();
      }
    });
}

/**
 * Calculate Haversine distance between two points
 */
function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in kilometers
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Convert degrees to radians
 */
function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

/**
 * Get traffic factor based on current time and road conditions
 */
function getTrafficFactor() {
  const now = new Date();
  const hour = now.getHours();
  const day = now.getDay(); // 0 = Sunday, 6 = Saturday

  console.log(`🕐 Getting traffic factor for ${day === 0 || day === 6 ? 'weekend' : 'weekday'} at ${hour}:00`);

  // Weekend traffic patterns (lighter overall)
  if (day === 0 || day === 6) {
    if (hour >= 10 && hour <= 20) {
      return 1.2; // Weekend shopping/activities
    } else if (hour >= 7 && hour <= 9) {
      return 1.1; // Weekend morning light traffic
    } else {
      return 1.0; // Very light weekend traffic
    }
  }

  // Weekday traffic patterns (more realistic)
  if (hour >= 5 && hour <= 6) {
    return 1.1; // Early morning - minimal traffic
  } else if (hour >= 7 && hour <= 9) {
    return 2.2; // Morning rush hour (7-9 AM) - heavy congestion
  } else if (hour >= 10 && hour <= 11) {
    return 1.4; // Mid-morning - moderate traffic
  } else if (hour >= 12 && hour <= 13) {
    return 1.6; // Lunch hour - moderate to heavy
  } else if (hour >= 14 && hour <= 15) {
    return 1.3; // Early afternoon - lighter
  } else if (hour >= 16 && hour <= 18) {
    return 2.5; // Evening rush hour (4-6 PM) - peak congestion
  } else if (hour >= 19 && hour <= 21) {
    return 1.8; // Evening - moderate traffic
  } else if (hour >= 22 && hour <= 23) {
    return 1.2; // Late evening - light traffic
  } else {
    return 1.0; // Late night/early morning - free flow
  }
}

/**
 * Get road condition factor based on route characteristics
 */
function getRoadConditionFactor(routeData) {
  if (!routeData || !routeData.distance) {
    return 1.0; // Default factor
  }

  // Base factor for urban/suburban areas (Philippines context)
  let roadFactor = 1.0;

  // Adjust for distance (longer routes may have highway portions)
  if (routeData.distance > 10) {
    roadFactor *= 0.9; // Longer routes likely use highways
  } else if (routeData.distance < 3) {
    roadFactor *= 1.2; // Short routes likely in congested local roads
  }

  // Adjust for time of day (road quality perception changes)
  const hour = new Date().getHours();
  if (hour >= 20 || hour <= 5) {
    roadFactor *= 0.95; // Better road perception at night
  }

  // Philippines-specific factors
  roadFactor *= 1.1; // General road condition factor for PH

  console.log('🛣️ Road condition factor:', roadFactor);
  return roadFactor;
}

/**
 * Get realistic average speed based on traffic and road conditions
 */
function getRealisticAverageSpeed(baseSpeedKmh, trafficFactor, roadConditionFactor) {
  // Base speeds for different conditions (Philippines context)
  const baseSpeeds = {
    highway: 40,    // km/h on highways
    arterial: 25,   // km/h on main roads
    local: 15,      // km/h on local streets
    congested: 8    // km/h in heavy traffic
  };

  // Determine effective speed based on traffic factor
  let effectiveSpeed;

  if (trafficFactor >= 2.0) {
    // Heavy traffic
    effectiveSpeed = baseSpeeds.congested;
  } else if (trafficFactor >= 1.5) {
    // Moderate traffic
    effectiveSpeed = baseSpeeds.local;
  } else if (trafficFactor >= 1.2) {
    // Light traffic
    effectiveSpeed = baseSpeeds.arterial;
  } else {
    // Free flow
    effectiveSpeed = baseSpeeds.highway;
  }

  // Apply road condition factor
  effectiveSpeed = effectiveSpeed / roadConditionFactor;

  // Ensure minimum and maximum speeds
  effectiveSpeed = Math.max(5, Math.min(50, effectiveSpeed));

  console.log(`🚗 Realistic speed: ${effectiveSpeed.toFixed(1)} km/h (traffic: ${trafficFactor}, road: ${roadConditionFactor})`);

  return effectiveSpeed;
}

/**
 * Calculate realistic travel duration with multiple factors
 */
function calculateRealisticDuration(routeData, trafficFactor) {
  if (!routeData || !routeData.distance) {
    return null;
  }

  const distance = routeData.distance;

  // Get realistic base speed for Philippines context
  let baseSpeed = getRealisticBaseSpeed(distance);

  // Apply traffic factor (but don't reduce speed too much)
  const trafficMultiplier = Math.max(0.6, Math.min(1.0, 2.0 - trafficFactor));
  baseSpeed *= trafficMultiplier;

  // Calculate base duration in minutes
  let durationMinutes = (distance / baseSpeed) * 60;

  // Add time-based factors (more conservative)
  const currentTime = new Date();
  const hour = currentTime.getHours();

  // Rush hour addition (not multiplier) - add extra minutes instead
  const isRushHour = (hour >= 7 && hour <= 9) || (hour >= 17 && hour <= 19);
  if (isRushHour) {
    durationMinutes += Math.min(30, distance * 0.3); // Add up to 30 min for rush hour
  }

  // Weekend reduction (slightly faster on weekends)
  const dayOfWeek = currentTime.getDay();
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  if (isWeekend) {
    durationMinutes *= 0.9; // 10% faster on weekends
  }

  // Add reasonable buffer time (not distance-based excessive)
  const bufferTime = Math.min(15, 5 + distance * 0.1); // 5-15 minutes max
  durationMinutes += bufferTime;

  // Add parking time (reasonable amounts)
  const parkingTime = distance < 5 ? 10 : 5; // 10 min for short trips, 5 min for longer
  durationMinutes += parkingTime;

  // Add minimal preparation time
  const preparationTime = Math.min(10, 3 + distance * 0.1); // 3-10 minutes
  durationMinutes += preparationTime;

  // Apply small weather factor (not dramatic)
  const month = currentTime.getMonth();
  if (month >= 5 && month <= 9) { // Monsoon season
    durationMinutes *= 1.05; // Only 5% increase
  }

  // Round to nearest 5 minutes
  durationMinutes = Math.round(durationMinutes / 5) * 5;

  // Ensure reasonable minimum and maximum
  durationMinutes = Math.max(15, Math.min(180, durationMinutes)); // 15 min to 3 hours max

  console.log(`⏱️ Realistic duration: ${durationMinutes} min`, {
    distance: `${distance.toFixed(1)} km`,
    baseSpeed: `${baseSpeed.toFixed(1)} km/h`,
    trafficMultiplier: trafficMultiplier.toFixed(2),
    rushHour: isRushHour,
    weekend: isWeekend,
    bufferTime: `${bufferTime.toFixed(1)} min`,
    parkingTime: `${parkingTime} min`,
    preparationTime: `${preparationTime.toFixed(1)} min`
  });

  return durationMinutes;
}

/**
 * Get realistic base speed based on distance (Philippines context)
 */
function getRealisticBaseSpeed(distance) {
  // More realistic speeds for Philippines
  if (distance < 2) return 20;     // Very short urban trips: 20 km/h
  if (distance < 5) return 25;     // Short urban trips: 25 km/h  
  if (distance < 10) return 30;    // Medium trips: 30 km/h
  if (distance < 20) return 35;    // Longer trips: 35 km/h
  if (distance < 50) return 45;    // Long trips: 45 km/h (some highway)
  return 50;                       // Very long trips: 50 km/h (mostly highway)
}

/**
 * Get base speed based on distance (shorter trips = slower average speed)
 */
function getBaseSpeedByDistance(distance) {
  if (distance < 2) return 15;     // Very short urban trips
  if (distance < 5) return 20;     // Short urban trips  
  if (distance < 10) return 25;    // Medium trips
  if (distance < 20) return 30;    // Longer trips
  if (distance < 50) return 35;    // Long trips
  return 40;                       // Very long trips (highway speeds)
}

/**
 * Get weather multiplier (simplified version)
 */
function getWeatherMultiplier(currentTime) {
  const month = currentTime.getMonth();

  // Monsoon season (June-October) - slower travel
  if (month >= 5 && month <= 9) {
    return 1.1;
  }

  // Holiday season (December) - heavier traffic
  if (month === 11) {
    return 1.05;
  }

  return 1.0; // Normal weather
}

/**
 * Update distance information in the UI
 */
function updateDistanceInfo(distance, fare, duration) {
  const distanceElement = document.getElementById('mapInfoDistance');
  const fareElement = document.getElementById('mapInfoFare');
  const distanceInfoElement = document.getElementById('mapDistanceInfo');

  console.log('📍 Updating distance info:', { distance, fare, duration });

  if (distanceElement) {
    distanceElement.textContent = `Distance: ${distance.toFixed(1)} km (approx.)`;
    console.log('✅ Distance element updated');
  }

  if (fareElement) {
    fareElement.innerHTML = `<strong>Estimated Fare:</strong> ₱${fare.toLocaleString()}`;
    console.log('✅ Fare element updated');
  }

  if (distanceInfoElement) {
    const durationText = duration > 60
      ? `${Math.floor(duration / 60)}h ${duration % 60}min`
      : `${duration} min`;

    distanceInfoElement.innerHTML = `
      <i class="bi bi-route me-1"></i>
      <strong>Travel Distance:</strong> ${distance.toFixed(1)} km<br>
      <i class="bi bi-clock me-1"></i>
      <strong>Travel Duration:</strong> ${durationText} (considering traffic)
    `;
    console.log('✅ Distance info element updated');
  }

  // Also update the main distance panel to include duration
  const mainDistancePanel = document.querySelector('#mapInfoPanel .small.text-muted');
  if (mainDistancePanel) {
    const durationText = duration > 60
      ? `${Math.floor(duration / 60)}h ${duration % 60}min`
      : `${duration} min`;
    const rate = window._farePerKm || 40;

    mainDistancePanel.innerHTML = `
      <i class="bi bi-info-circle me-1"></i>
      Distance: ${distance.toFixed(1)} km • Duration: ${durationText} • 
      Distance meter fare is calculated at <strong>₱${rate} per kilometer</strong> based on the road distance between the company and your location, considering current traffic conditions.
    `;
    console.log('✅ Main distance panel updated');
  }

  // Enhanced auto-advance detection
  const hasValidDistance = distance && distance > 0;
  const hasValidFare = fare && fare > 0;
  const hasValidDuration = duration && duration > 0;

  console.log('🔍 Auto-advance check:', {
    hasValidDistance,
    hasValidFare,
    hasValidDuration,
    currentStep: document.querySelector('.booking-step:not(.d-none)')?.dataset.step
  });

  // Check if distance calculation is complete and auto-advance to next step
  if (hasValidDistance && hasValidFare && hasValidDuration) {
    console.log('✅ Distance and fare calculation complete, preparing to auto-advance');

    // Show success feedback immediately
    showLocationStepComplete();

    // Auto-advance after 2 seconds for user to see the information
    setTimeout(() => {
      autoAdvanceToNextStep();
    }, 2000);
  } else {
    console.log('⏳ Distance calculation not yet complete, waiting...', {
      distance,
      fare,
      duration
    });
  }
}

/**
 * Auto-advance to next step after distance calculation is complete
 */
function autoAdvanceToNextStep() {
  const currentStep = document.querySelector('.booking-step:not(.d-none)');
  const currentStepNumber = currentStep ? currentStep.dataset.step : 'unknown';

  console.log('🔍 Auto-advance check:', {
    currentStep: currentStepNumber,
    targetStep: '4'
  });

  if (currentStep && currentStep.dataset.step === '3') {

    const distanceElement = document.getElementById('mapInfoDistance');
    const fareElement = document.getElementById('mapInfoFare');

    const hasDistanceContent = distanceElement && distanceElement.textContent &&
      distanceElement.textContent.includes('Distance:');
    const hasFareContent = fareElement && fareElement.textContent &&
      fareElement.textContent.includes('₱');
    const isNotDetecting = distanceElement &&
      !distanceElement.textContent.includes('Detecting');

    if (hasDistanceContent && hasFareContent && isNotDetecting) {

      console.log('🚀 Auto-advancing from Step 3 to Step 4');

      showStep(4);
      updateStepper(4);

      if (typeof showError !== 'undefined') {
        const successMsg = document.createElement('div');
        successMsg.className = 'alert alert-success alert-dismissible fade show position-fixed';
        successMsg.style.cssText = 'top: 20px; right: 20px; z-index: 9999; min-width: 300px;';
        successMsg.innerHTML = `
          <i class="bi bi-check-circle me-2"></i>
          <strong>Location confirmed!</strong> Proceeding to schedule selection.
          <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        `;
        document.body.appendChild(successMsg);

        setTimeout(() => {
          if (successMsg.parentNode) {
            successMsg.parentNode.removeChild(successMsg);
          }
        }, 3000);
      }

    } else {
      console.log('⏳ Distance calculation not yet complete, waiting...');

      setTimeout(() => {
        autoAdvanceToNextStep();
      }, 1000);
    }
  } else {
    console.log('ℹ️ Not on Step 3, skipping auto-advance');
  }
}

/**
 * Show visual feedback when location step is complete
 */
function showLocationStepComplete() {
  const locationInput = document.getElementById('locationInput');
  const distancePanel = document.getElementById('mapInfoPanel');

  // Add success styling to location input
  if (locationInput) {
    locationInput.classList.add('is-valid');
    locationInput.style.borderColor = '#198754';
  }

  // Add success indicator to distance panel
  if (distancePanel) {
    distancePanel.style.borderColor = '#198754';
    distancePanel.style.backgroundColor = '#f8fff9';

    // Add success badge
    const successBadge = document.createElement('div');
    successBadge.className = 'alert alert-success alert-sm mt-2';
    successBadge.innerHTML = `
      <i class="bi bi-check-circle me-1"></i>
      <strong>Location confirmed!</strong> Distance and fare calculated. Proceeding to next step...
    `;

    // Remove existing success badge if any
    const existingBadge = distancePanel.querySelector('.alert-success');
    if (existingBadge) {
      existingBadge.remove();
    }

    distancePanel.appendChild(successBadge);

    // Remove badge after auto-advance
    setTimeout(() => {
      if (successBadge.parentNode) {
        successBadge.remove();
      }
    }, 3000);
  }

  console.log('✅ Location step completion feedback shown');
}

/**
 * Setup schedule selection with auto-progress
 */
function setupScheduleAutoProgress() {
  console.log('📅 Setting up schedule auto-progress');

  setupCalendarTypeSelection();
  setupDateSelection();
  setupTimeSlotSelection();

  console.log('✅ Schedule auto-progress setup complete');
}

/**
 * Setup Step 5: Schedule with enhanced functionality
 */
function setupStep5() {
  console.log('📅 Setting up Step 5: Schedule');

  // Initialize enhanced calendar state
  initializeCalendarState();

  // Initialize professional scheduling mode buttons
  initializeSchedulingModes();

  // Setup calendar type selection (AI Suggested vs Manual)
  setupCalendarTypeSelection();

  // Load available dates when step is shown (default to AI suggested)
  loadAvailableDates();

  // Setup date selection
  setupDateSelection();

  // Setup time slot selection
  setupTimeSlotSelection();

  // Setup enhanced calendar navigation
  bindCalendarNavigationEnhanced();

  // Load technician schedule for enhanced functionality
  if (BookingState.selectedTechnicianId) {
    loadTechnicianScheduleEnhanced().catch(error => {
      console.warn('Failed to load technician schedule on Step 5 init:', error);
    });
  }

  console.log('✅ Enhanced Step 5 setup complete with professional scheduling');
}

/**
 * Setup calendar type selection (AI Suggested vs Manual)
 */
function setupCalendarTypeSelection() {
  // Enforce manual-only scheduling in Step 5.
  // Hide AI/suggested UI entirely and set default calendarType to "manual"
  // until a (now removed) suggested mode could exist.

  const suggestedWrapper = document.getElementById('suggestedDates');
  const manualCalendar = document.getElementById('manualCalendar');
  const modeSelection = document.getElementById('modeSelection');

  console.log('🔍 Looking for calendar elements (manual-only enforcement):', {
    suggestedWrapper: !!suggestedWrapper,
    manualCalendar: !!manualCalendar,
    modeSelection: !!modeSelection
  });

  // Always hide suggested wrapper if it exists in DOM (even if removed from EJS)
  if (suggestedWrapper) {
    suggestedWrapper.classList.add('d-none');
  }

  // Always show manual calendar if it exists
  if (manualCalendar) {
    manualCalendar.classList.remove('d-none');
  }

  // Set deterministic default state: manual
  if (typeof BookingState !== 'undefined') {
    BookingState.calendarType = 'manual';
  }

  // Also prevent any attempt to initialize mode button click handlers that could flip back to AI.
  // If the buttons exist in DOM, we simply ensure they don't trigger AI mode.
  if (modeSelection) {
    const modeButtons = modeSelection.querySelectorAll('button');
    modeButtons.forEach((button) => {
      const freshBtn = button.cloneNode(true);
      freshBtn.addEventListener('click', () => {
        if (typeof BookingState !== 'undefined') {
          BookingState.calendarType = 'manual';
        }
        if (suggestedWrapper) suggestedWrapper.classList.add('d-none');
        if (manualCalendar) manualCalendar.classList.remove('d-none');
        loadAvailableDates('manual');
      });
      button.parentNode.replaceChild(freshBtn, button);
    });
  }

  console.log('✅ Calendar type set to manual (AI suggested hidden)');
}

/**
 * Load available dates from backend
 */
async function loadAvailableDates(modeOverride = null) {
  // Allow caller to force mode deterministically (fixes Step 5 auto-render)
  // modeOverride: 'manual' | 'ai-suggested' | null

  // Try to get technician and service from BookingState first, then from global state
  const technicianId = (typeof BookingState !== 'undefined' && BookingState.selectedTechnicianId) ||
    (typeof state !== 'undefined' && state.technicianId);

  // Derive the real MongoDB service _id.
  // BookingState.selectedServiceId may already be correct, but it could also
  // be the frontend-generated unique "id" (not a DB id).  The actual DB id
  // lives in selectedServices[].serviceId.  Try that first.
  let serviceId = null;
  if (typeof BookingState !== 'undefined') {
    // Best source: the real DB id stored on the service item
    if (!serviceId && Array.isArray(BookingState.selectedServices) && BookingState.selectedServices.length > 0) {
      serviceId = BookingState.selectedServices[0].serviceId || null;
    }
    // Fallback: previously set selectedServiceId (may already be the DB id)
    if (!serviceId && BookingState.selectedServiceId) {
      serviceId = BookingState.selectedServiceId;
    }
  }
  // Last resort: global state object
  if (!serviceId && typeof state !== 'undefined') {
    serviceId = state.service?._id || state.service?.slug || null;
  }

  console.log('🔍 loadAvailableDates resolved serviceId:', serviceId);

  if (!serviceId) {
    console.warn('⚠️ Technician or service not selected:', {
      technicianId,
      serviceId,
      BookingState: typeof BookingState !== 'undefined' ? {
        selectedTechnicianId: BookingState.selectedTechnicianId,
        selectedServiceId: BookingState.selectedServiceId
      } : 'undefined',
      state: typeof state !== 'undefined' ? {
        technicianId: state.technicianId,
        serviceId: state.service?.slug || state.service?._id,
      } : 'undefined'
    });
    return;
  }

  console.log('📅 Loading available dates...', { technicianId, serviceId });

  try {
    // Get current calendar type selection - use BookingState or default
    let mode = 'ai-suggested'; // default
    if (typeof BookingState !== 'undefined' && BookingState.calendarType) {
      mode = BookingState.calendarType;
    } else if (typeof state !== 'undefined' && state.mode) {
      mode = state.mode === 'manual' ? 'manual' : 'ai-suggested';
    }

    console.log(`📅 Loading dates in ${mode} mode`);

    const params = new URLSearchParams({ serviceId, mode });
    if (technicianId) params.set('technicianId', technicianId);
    const response = await fetch(`/api/schedule/available-dates?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log('📅 Available dates response:', data);

    // Store scheduling info in both state systems for compatibility
    if (typeof BookingState !== 'undefined') {
      BookingState.serviceDuration = data.serviceDuration;
      BookingState.travelTimeBuffer = data.travelTimeBuffer;
      BookingState.totalRequiredTime = data.totalRequiredTime;
      BookingState.workingSchedule = data.workingSchedule;
    }

    if (typeof state !== 'undefined') {
      state.serviceDuration = data.serviceDuration;
      state.travelTimeBuffer = data.travelTimeBuffer;
      state.totalRequiredTime = data.totalRequiredTime;
    }

    // Display dates based on mode
    displayAvailableDates(data.availableDates, mode);

    // Update mode info display
    updateModeInfo(data, mode);

  } catch (error) {
    console.error('❌ Error loading available dates:', error);
    // In manual mode, still try to render the enterprise calendar —
    // it loads its own data independently via EnterpriseCalendar.init()
    const fallbackMode = (typeof BookingState !== 'undefined' && BookingState.calendarType) || 'manual';
    if (fallbackMode === 'manual') {
      renderManualCalendar();
      return;
    }
    if (typeof showError !== 'undefined') {
      showError('Unable to load available dates. Please try again.');
    }
  }
}

/**
 * Update mode information display
 */
function updateModeInfo(data, mode) {
  const modeInfoElement = document.getElementById('modeInfo');
  if (modeInfoElement) {
    if (mode === 'ai-suggested') {
      modeInfoElement.innerHTML = `
        <div class="alert alert-info">
          <i class="bi bi-robot me-2"></i>
          <strong>AI Suggested Dates</strong><br>
          <small>Showing ${data.availableDates.length} best dates from ${data.totalAvailable} total available dates</small>
        </div>
      `;
    } else {
      modeInfoElement.innerHTML = `
        <div class="alert alert-secondary">
          <i class="bi bi-calendar3 me-2"></i>
          <strong>Manual Calendar - Technician Schedule</strong><br>
          <small>Showing all ${data.availableDates.length} available dates based on technician's working schedule</small>
        </div>
      `;
    }
  }

  // Update service duration info
  const durationInfoElement = document.getElementById('durationInfo');
  if (durationInfoElement) {
    durationInfoElement.innerHTML = `
      <small class="text-muted">
        <i class="bi bi-clock me-1"></i>
        Service: ${data.serviceDuration}min + Travel: ${data.travelTimeBuffer}min = 
        <strong>${data.totalRequiredTime}min total</strong>
      </small>
    `;
  }
}

/**
 * Display available dates in the calendar
 */
function displayAvailableDates(availableDates, mode = 'ai-suggested') {
  const aiDatesContainer = document.getElementById('aiAvailableDates');
  const manualDatesContainer = document.getElementById('manualAvailableDates');

  // Also try to find containers from services.js structure
  const suggestedCards = document.getElementById('suggestedCards');
  const calendarGrid = document.getElementById('calendarGrid') || document.querySelector('.calendar-grid');

  // Clear both containers first
  if (aiDatesContainer) aiDatesContainer.innerHTML = '';
  if (manualDatesContainer) manualDatesContainer.innerHTML = '';
  if (suggestedCards) suggestedCards.innerHTML = '';

  // Manual mode: always delegate to the enterprise calendar renderer.
  // EnterpriseCalendar fetches its own data and renders independently.
  if (mode === 'manual') {
    renderManualCalendar();
    return;
  }

  if (availableDates.length === 0) {
    const noDatesMsg = '<p class="text-muted">No available dates found for this technician.</p>';
    if (aiDatesContainer) aiDatesContainer.innerHTML = noDatesMsg;
    if (suggestedCards) suggestedCards.innerHTML = noDatesMsg;
    return;
  }

  // Determine which container to use based on mode
  const activeContainer = mode === 'ai-suggested'
    ? (aiDatesContainer || suggestedCards)
    : (manualDatesContainer || calendarGrid);

  if (!activeContainer) {
    console.warn(`⚠️ Container not found for mode: ${mode}`);
    return;
  }

  // Create date buttons and add to active container only
  availableDates.forEach((dateInfo, index) => {
    const dateButton = document.createElement('button');
    dateButton.type = 'button';
    dateButton.className = 'date-btn btn m-1';

    // Set availability styling
    if (dateInfo.availableSlots > 0) {
      dateButton.classList.add('btn-outline-primary');
    } else {
      dateButton.classList.add('btn-outline-secondary', 'text-muted');
      dateButton.disabled = false; // Keep clickable but show as unavailable
    }

    dateButton.dataset.date = dateInfo.date;
    dateButton.dataset.dayName = dateInfo.dayName;
    dateButton.dataset.dayOfMonth = dateInfo.dayOfMonth;
    dateButton.dataset.month = dateInfo.month;

    // Create button content
    let availabilityBadge = '';
    let availabilityText = '';
    if (dateInfo.availableSlots > 0) {
      availabilityBadge = `<span class="badge bg-success ms-1">${dateInfo.availableSlots}</span>`;
      availabilityText = `<div class="small text-success">${dateInfo.availableSlots} slot${dateInfo.availableSlots > 1 ? 's' : ''}</div>`;
    } else {
      availabilityBadge = `<span class="badge bg-danger ms-1">Full</span>`;
      availabilityText = `<div class="small text-danger">Fully booked</div>`;
    }

    dateButton.innerHTML = `
      <div class="text-center">
        <div class="fw-bold">${dateInfo.dayOfMonth}</div>
        <div class="small">${dateInfo.month}</div>
        <div class="small text-muted">${dateInfo.dayName}</div>
        ${availabilityBadge}
        ${availabilityText}
      </div>
    `;

    // Add event listener only for the newly created date buttons
    dateButton.addEventListener('click', () => {
      const raw = dateButton.dataset.date;
      let date;
      if (raw && /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const [y, m, d] = raw.split('-').map(Number);
        date = new Date(y, m - 1, d);
      } else {
        date = new Date(raw);
      }
      selectDate(date);
    });

    activeContainer.appendChild(dateButton);
  });

  console.log(`✅ Displayed ${availableDates.length} available dates in ${mode} mode`);
}

/**
 * Format time range for display (e.g., "9:00 AM - 11:00 AM")
 */
function formatTimeRange(startTime, endTime) {
  const formatTime = (time) => {
    const [hours, minutes] = time.split(':').map(Number);
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
  };

  return `${formatTime(startTime)} - ${formatTime(endTime)}`;
}

/**
 * Format a 24h time string (HH:MM) to 12-hour display (e.g., "8:00 AM")
 */
function formatTime12h(time24) {
  const [hours, minutes] = time24.split(':').map(Number);
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
  return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
}


/**
 * Load time slots for selected date
 */
async function loadTimeSlots(date) {
  if (!BookingState.selectedServiceId) {
    console.warn('⚠️ Service not selected');
    return;
  }

  console.log('🕐 Loading time slots for date:', date);

  try {
    let url;
    if (BookingState.selectedTechnicianId) {
      url = `/api/schedule/time-slots?technicianId=${BookingState.selectedTechnicianId}&serviceId=${BookingState.selectedServiceId}&date=${date}`;
    } else {
      // Capacity mode: aggregate across all technicians
      url = `/api/schedule/time-slots?serviceId=${BookingState.selectedServiceId}&date=${date}`;
    }

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log('🕐 Time slots response:', data);

    // Check if booking is blocked (exceeds working hours)
    if (data.blocked) {
      const timeSlotsContainer = document.getElementById('timeSlots');
      if (timeSlotsContainer) {
        timeSlotsContainer.innerHTML = `
          <div class="text-center py-4" style="color:#dc2626;">
            <i class="bi bi-exclamation-triangle-fill" style="font-size:1.5rem;"></i>
            <p class="mt-2">${escapeHtml(data.message || 'Booking exceeds available working hours. Please reduce the quantity.')}</p>
          </div>`;
      }
      return;
    }

    displayTimeSlots(data.timeSlots);

  } catch (error) {
    console.error('❌ Error loading time slots:', error);
    showError('Unable to load time slots. Please try again.');
  }
}

/**
 * Display available time slots
 */
function displayTimeSlots(timeSlots) {
  const timeSlotsContainer = document.getElementById('timeSlots');

  if (!timeSlotsContainer) {
    return;
  }

  timeSlotsContainer.innerHTML = '';

  // Filter out past time slots and unavailable slots
  const availableSlots = timeSlots.filter(slot => {
    return slot.available && !slot.isPast;
  });

  if (availableSlots.length === 0) {
    timeSlotsContainer.innerHTML = '<p class="text-muted">No preferred time available for this date.</p>';
    return;
  }

  // Create time slot buttons — each shows only the preferred start time
  availableSlots.forEach(slot => {
    const slotButton = document.createElement('button');
    slotButton.type = 'button';
    slotButton.className = 'btn btn-outline-secondary time-slot-btn m-1';
    slotButton.dataset.startTime = slot.startTime;
    slotButton.dataset.duration = slot.duration;

    const displayText = slot.startTime;

    slotButton.innerHTML = `
      <div class="text-center">
        <div class="fw-semibold">${displayText}</div>
        <div class="small text-success">Available</div>
      </div>
    `;

    slotButton.addEventListener('click', () => selectTimeSlot(slot));
    timeSlotsContainer.appendChild(slotButton);
  });

  // Add scheduling disclaimer
  const disclaimer = document.createElement('div');
  disclaimer.className = 'alert alert-light mt-3 small text-muted';
  disclaimer.innerHTML = '<i class="bi bi-info-circle me-1"></i>' +
    'Estimated service duration may vary depending on site conditions, service requirements, ' +
    'travel conditions, and technician availability. Selected times represent preferred service ' +
    'start times and are used for scheduling purposes.';
  timeSlotsContainer.appendChild(disclaimer);
}

/**
 * Enhanced Step 5 Scheduling Functions
 * Moved from services.js with improvements for AI/Manual modes
 */

/**
 * Load technician schedule with enhanced error handling
 */
async function loadTechnicianScheduleEnhanced() {
  if (!BookingState.selectedTechnicianId) {
    console.warn('⚠️ No technician selected for schedule loading');
    return;
  }

  try {
    console.log('📅 Loading enhanced technician schedule for:', BookingState.selectedTechnicianId);

    let url = "/api/services/technician-schedule";
    if (BookingState.selectedTechnicianId) {
      url += "/" + encodeURIComponent(BookingState.selectedTechnicianId);
    }

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`status=${resp.status}`);

    const json = await resp.json();
    console.log('📅 Technician schedule loaded:', json);

    // Update schedule state for slot generation
    if (typeof BookingState !== 'undefined') {
      console.log('📅 Updating schedule state with:', {
        workingDays: json.workingDays,
        nonWorkingWeekdays: json.nonWorkingWeekdays,
        restDates: json.restDates
      });

      BookingState.scheduleState = {
        workingDays: Array.isArray(json.workingDays) ? json.workingDays.slice() : [],
        nonWorkingWeekdays: Array.isArray(json.nonWorkingWeekdays) ? json.nonWorkingWeekdays : [],
        restDates: new Set(Array.isArray(json.restDates) ? json.restDates : [])
      };

      console.log('✅ Schedule state updated:', {
        workingDaysCount: BookingState.scheduleState.workingDays.length,
        nonWorkingWeekdaysCount: BookingState.scheduleState.nonWorkingWeekdays.length,
        restDatesCount: BookingState.scheduleState.restDates.size
      });

      // Apply conservative default schedule if none defined (Mon, Wed, Thu, Fri only)
      if (BookingState.scheduleState.workingDays.length === 0) {
        console.log('📅 Using conservative default schedule (8 AM - 5 PM, Mon/Wed/Thu/Fri only)');
        BookingState.scheduleState.workingDays = [];
        const workingDays = [1, 3, 4, 5]; // Monday, Wednesday, Thursday, Friday
        workingDays.forEach(d => {
          BookingState.scheduleState.workingDays.push({
            dayOfWeek: d,
            startMinutes: 8 * 60,  // 8:00 AM
            endMinutes: 19 * 60    // 7:00 PM (includes overtime)
          });
        });
        BookingState.scheduleState.nonWorkingWeekdays = [
          { dayOfWeek: 0 }, // Sunday
          { dayOfWeek: 2 }, // Tuesday
          { dayOfWeek: 6 }  // Saturday
        ];
      }
    }

    console.log('✅ Enhanced technician schedule loaded successfully');

    // Schedule state now respects the actual technician schedule from the backend
    // (no hardcoded day-of-week overrides)

  } catch (error) {
    console.error('❌ Failed to load technician schedule:', error);

    // Set conservative default schedule on error
    if (typeof BookingState !== 'undefined') {
      BookingState.scheduleState = {
        workingDays: [],
        nonWorkingWeekdays: [],
        restDates: new Set()
      };

      // Apply conservative default schedule (Mon, Wed, Thu, Fri only)
      const workingDays = [1, 3, 4, 5]; // Monday, Wednesday, Thursday, Friday
      workingDays.forEach(d => {
        BookingState.scheduleState.workingDays.push({
          dayOfWeek: d,
          startMinutes: 8 * 60,
          endMinutes: 19 * 60 // 7:00 PM (includes overtime)
        });
      });

      // Set weekends and Tuesday as non-working
      BookingState.scheduleState.nonWorkingWeekdays = [
        { dayOfWeek: 0 }, // Sunday
        { dayOfWeek: 2 }, // Tuesday  
        { dayOfWeek: 6 }  // Saturday
      ];
    }

    throw error;
  }
}

/**
 * Render enhanced time slots for a specific date
 */
async function renderTimeSlotsForDateEnhanced(date, { scrollToSlots = false } = {}) {
  console.log('🕐 Rendering enhanced time slots for date:', date);

  const timeSelection = document.getElementById('timeSelection');
  const timeSlots = document.getElementById('timeSlots');
  const timeNotice = document.getElementById('timeNotice');

  if (!timeSelection || !timeSlots) {
    console.warn('⚠️ Time selection elements not found');
    return;
  }

  timeSlots.innerHTML = '';
  timeSelection.classList.remove('d-none');

  if (timeNotice) {
    timeNotice.textContent = "Loading availability...";
  }

  // Ensure schedule is loaded
  if (BookingState.selectedTechnicianId && (!BookingState.scheduleState || BookingState.scheduleState.workingDays.length === 0)) {
    try {
      await loadTechnicianScheduleEnhanced();
    } catch (e) {
      console.warn("Failed to preload schedule", e);
      if (timeNotice) {
        timeNotice.textContent = "Unable to load schedule. Please try again.";
      }
      return;
    }
  }

  // Validate selections
  if (!BookingState.selectedServiceId) {
    timeSelection.classList.add('d-none');
    if (timeNotice) {
      timeNotice.textContent = "Please select a service first.";
    }
    return;
  }

  const dateKey = formatDateKey(date);
  const dow = date.getDay();

  // Check if technician is working on this day
  if (BookingState.selectedTechnicianId && BookingState.scheduleState) {
    const isNonWorkingWeekday = BookingState.scheduleState.nonWorkingWeekdays.some(nwd => nwd.dayOfWeek === dow);
    if (
      isNonWorkingWeekday ||
      BookingState.scheduleState.restDates.has(dateKey)
    ) {
      timeSelection.classList.add('d-none');
      if (timeNotice) {
        timeNotice.textContent = "Technician is not working on this date.";
      }
      return;
    }
  }

  // Show appropriate notice based on selections
  if (!BookingState.selectedServiceId && BookingState.selectedTechnicianId && timeNotice) {
    timeNotice.textContent = "Showing generic availability; durations may change after picking a service.";
  }

  try {
    // Fetch available slots from our new API
    let url = new URL("/api/schedule/time-slots", window.location.origin);
    url.searchParams.set("date", dateKey);

    if (BookingState.selectedServiceId) {
      url.searchParams.set("serviceId", BookingState.selectedServiceId);
    }

    if (BookingState.selectedTechnicianId) {
      url.searchParams.set("technicianId", BookingState.selectedTechnicianId);
    }

    console.log('🕐 Fetching time slots from:', url.toString());

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);

    const data = await resp.json();
    console.log('🕐 Time slots response:', data);

    // Display the time slots
    displayTimeSlots(data.timeSlots || []);

    if (timeNotice) {
      if (data.timeSlots && data.timeSlots.length > 0) {
        timeNotice.textContent = `Select preferred start time (${data.timeSlots.length} options found)`;
      } else {
        timeNotice.textContent = "No preferred time available for this date.";
      }
    }

    // Scroll to slots if requested
    if (scrollToSlots && timeSlots) {
      setTimeout(() => {
        timeSlots.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 100);
    }

  } catch (error) {
    console.error('❌ Error fetching time slots:', error);

    if (timeNotice) {
      timeNotice.textContent = "Failed to load preferred times. Please try again.";
    }

    if (timeSlots) {
      timeSlots.innerHTML = '<p class="text-danger">Unable to load preferred times.</p>';
    }
  }
}

/**
 * Format date as YYYY-MM-DD key (Local timezone instead of UTC)
 */
function formatDateKey(date) {
  // Use local timezone to ensure exact calendar date is preserved
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Enhanced calendar navigation with mode awareness
 */
function bindCalendarNavigationEnhanced() {
  const calendarNavButtons = document.querySelectorAll('[data-calendar-nav]');

  if (!calendarNavButtons?.length) {
    console.warn('⚠️ Calendar navigation buttons not found');
    return;
  }

  calendarNavButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const direction = button.dataset.calendarNav;

      if (typeof BookingState !== 'undefined' && BookingState.calendarState) {
        if (direction === "prev") {
          BookingState.calendarState.activeMonth = addMonths(BookingState.calendarState.activeMonth, -1);
        } else {
          BookingState.calendarState.activeMonth = addMonths(BookingState.calendarState.activeMonth, 1);
        }

        // Reload dates for new month
        loadAvailableDates();
      }
    });
  });

  console.log('✅ Enhanced calendar navigation bound');
}

/**
 * Add months to date (helper function)
 */
function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

/**
 * Initialize enhanced calendar state
 */
function initializeCalendarState() {
  if (typeof BookingState !== 'undefined') {
    BookingState.calendarState = {
      activeMonth: new Date(),
      selectedDate: null
    };

    console.log('✅ Calendar state initialized');
  }
}

/**
 * Handle time slot selection
 */
function selectTimeSlot(slot) {
  console.log('🕐 Time slot selected:', slot);

  // Update UI
  document.querySelectorAll('.time-slot-btn').forEach(btn => {
    btn.classList.remove('btn-success', 'active');
    btn.classList.add('btn-outline-secondary');
  });

  // Highlight selected time slot
  event.target.closest('.time-slot-btn').classList.remove('btn-outline-secondary');
  event.target.closest('.time-slot-btn').classList.add('btn-success', 'active');

  // Store selected time slot
  if (typeof BookingState !== 'undefined') {
    BookingState.selectedTimeSlot = {
      startTime: slot.startTime,
      endTime: slot.endTime,
      duration: slot.duration,
      displayText: slot.displayText
    };
  }

  // Show success feedback
  showTimeSlotComplete();

  // Auto-advance after time slot selection
  setTimeout(() => {
    console.log('⏭️ Auto-advancing to Step 6 after time slot selection');
    showStep(5);
    updateStepper(5);
  }, 1500);

  console.log('✅ Time slot selection complete');
}

/**
 * Show visual feedback when time slot is selected
 */
function showTimeSlotComplete() {
  const timeSlotsContainer = document.getElementById('timeSlots');

  if (timeSlotsContainer) {
    // Add success indicator
    const successBadge = document.createElement('div');
    successBadge.className = 'alert alert-success alert-sm mt-3';
    successBadge.innerHTML = `
      <i class="bi bi-check-circle me-1"></i>
      <strong>Time slot confirmed!</strong> Your appointment has been scheduled.
    `;

    // Remove existing success badge if any
    const existingBadge = timeSlotsContainer.querySelector('.alert-success');
    if (existingBadge) {
      existingBadge.remove();
    }

    timeSlotsContainer.appendChild(successBadge);

    // Remove badge after auto-advance
    setTimeout(() => {
      if (successBadge.parentNode) {
        successBadge.remove();
      }
    }, 3000);
  }

  console.log('✅ Time slot completion feedback shown');
}

/**
 * Setup date selection handlers
 */
function setupDateSelection() {
  // Additional date selection setup if needed
  console.log('📅 Date selection handlers setup');
}

/**
 * Setup time slot selection handlers
 */
function setupTimeSlotSelection() {
  // Additional time slot selection setup if needed
  console.log('🕐 Time slot selection handlers setup');
}

/**
 * Setup review step with final submission
 */
function setupReviewStep() {
  console.log('📋 Setting up review step');

  // Update review content with booking details
  updateReviewContent();

  // Setup submit button
  const submitBtn = document.getElementById('submitBooking');
  if (submitBtn) {
    submitBtn.addEventListener('click', (e) => {
      e.preventDefault();
      submitBooking();
    });
  }
}

/**
 * Update review content with booking details
 */
function updateReviewContent() {
  if (typeof BookingState === 'undefined') return;

  const reviewContent = document.getElementById('reviewContent');
  if (!reviewContent) return;

  let html = '<div class="booking-review">';

  // Services
  if (BookingState.selectedServices.length > 0) {
    html += '<h6>📦 Selected Services</h6>';
    BookingState.selectedServices.forEach(service => {
      html += `<div class="mb-2">
        <strong>${service.name}</strong>
        ${service.quantity ? ` x${service.quantity}` : ''}
        ${service.hp ? ` (${service.hp} HP)` : ''}
        - ₱${service.price.toLocaleString()}
      </div>`;
    });
  }

  // Technician
  if (BookingState.selectedTechnicianId) {
    const technicianSelect = document.getElementById("technicianSelect");
    const selectedOption = technicianSelect?.options[technicianSelect.selectedIndex];
    html += `<h6 class="mt-3">👨‍🔧 Technician</h6>
      <div>${selectedOption?.textContent || 'Selected'}</div>`;
  }

  // Location
  if (BookingState.location) {
    html += `<h6 class="mt-3">📍 Location</h6>
      <div>${BookingState.location}</div>`;
  }

  // Schedule
  if (BookingState.scheduleDate && BookingState.scheduleTime) {
    html += `<h6 class="mt-3">📅 Schedule</h6>
      <div>${BookingState.scheduleDate} at ${BookingState.scheduleTime}</div>`;
  }

  // Total — recalculate from current services
  const reviewTotal = (BookingState.selectedServices || []).reduce((sum, s) => {
    const qty = s.quantity || 1;
    const price = s.unitPrice || s.price || 0;
    return sum + (price * qty);
  }, 0) + (BookingState.travelFare || BookingState.fare || 0);
  BookingState.totalEstimatedPrice = reviewTotal;
  html += `<h6 class="mt-3">💰 Total Price</h6>
    <div class="fs-5 text-primary fw-bold">₱${reviewTotal.toLocaleString()}</div>`;

  html += '</div>';
  reviewContent.innerHTML = html;
}

/**
 * Submit the booking
 */
function submitBooking() {
  console.log('🚀 Submitting booking...');

  // Get all booking data
  const bookingData = {
    services: BookingState.selectedServices,
    technicianId: BookingState.selectedTechnicianId,
    location: BookingState.location,
    scheduleDate: BookingState.scheduleDate,
    scheduleTime: BookingState.scheduleTime,
    totalPrice: BookingState.totalEstimatedPrice
  };

  console.log('Booking data:', bookingData);

  // Here you would typically send this to your backend
  // For now, just show a success message
  alert('Booking submitted successfully! (This is a demo - implement actual submission)');
}

/**
 * Update stepper to show active step
 */
function updateStepper(activeStep) {
  // Update main stepper
  document.querySelectorAll('.stepper-step').forEach(step => {
    const stepNumber = parseInt(step.dataset.step);
    if (stepNumber <= activeStep) {
      step.classList.add('active');
    } else {
      step.classList.remove('active');
    }

    // Add completed class for past steps
    if (stepNumber < activeStep) {
      step.classList.add('completed');
    } else {
      step.classList.remove('completed');
    }
  });

  // Update progress indicator dots
  const progressDots = document.querySelectorAll('.progress-dot');
  progressDots.forEach(dot => {
    const dotStep = parseInt(dot.dataset.step);
    dot.classList.remove('active', 'completed');

    if (dotStep === activeStep) {
      dot.classList.add('active');
    } else if (dotStep < activeStep) {
      dot.classList.add('completed');
    }
  });

  // Update progress bar if exists
  updateProgressBar(activeStep);
}

/**
 * Cache frequently used DOM elements
 */
function cacheDOMElements() {
  // Service selection elements
  DOM.coreServiceCards = document.getElementById('coreServiceCards');
  DOM.repairServiceCards = document.getElementById('repairServiceCards');
  DOM.selectedServicesList = document.getElementById('selectedServicesList');
  DOM.selectedServiceCount = document.getElementById('selectedServiceCount');
  DOM.totalEstimatedPrice = document.getElementById('totalEstimatedPrice');
  DOM.totalPricingSection = document.getElementById('totalPricingSection');
  DOM.repairIssueContainer = document.getElementById('repairIssueContainer');
  DOM.repairIssue = document.getElementById('repairIssue');

  // Modal elements
  DOM.hpModal = document.getElementById('hpSelectionModal');
  DOM.quantityModal = document.getElementById('quantitySelectionModal');

  // HP Modal elements
  DOM.hpModalServiceName = document.getElementById('hpModalServiceName');
  DOM.hpModalQuantity = document.getElementById('hpModalQuantity');
  DOM.hpModalOptions = document.getElementById('hpModalOptions');
  DOM.confirmHpSelection = document.getElementById('confirmHpSelection');

  // Quantity Modal elements
  DOM.quantityModalServiceName = document.getElementById('quantityModalServiceName');
  DOM.quantityModalDescription = document.getElementById('quantityModalDescription');
  DOM.quantityModalUnit = document.getElementById('quantityModalUnit');
  DOM.quantityModalInput = document.getElementById('quantityModalInput');
  DOM.quantityModalDecrease = document.getElementById('quantityModalDecrease');
  DOM.quantityModalIncrease = document.getElementById('quantityModalIncrease');
  DOM.quantityModalEstimatedPrice = document.getElementById('quantityModalEstimatedPrice'); // Fixed ID
  DOM.confirmQuantitySelection = document.getElementById('confirmQuantitySelection');

  // Log missing elements for debugging
  const missingElements = [];
  const foundElements = [];

  Object.keys(DOM).forEach(key => {
    if (!DOM[key]) {
      missingElements.push(key);
    } else {
      foundElements.push(key);
    }
  });

  // Log DOM caching summary
  console.log('DOM Cache:', {
    found: foundElements.length,
    missing: missingElements.length,
    missingElements: missingElements,
    foundElements: foundElements
  });

  if (missingElements.length > 0) {
    console.warn('Missing DOM elements:', missingElements);
  } else {
    console.log('All DOM elements cached successfully');
  }
}

/**
 * Load service catalog from window.initialCatalog or fetch from API
 */
function loadServiceCatalog() {
  if (window.initialCatalog) {
    BookingState.catalog.coreServices = window.initialCatalog.coreServices || [];
    BookingState.catalog.repairServices = window.initialCatalog.repairs || [];

    console.log('Services loaded from window.initialCatalog:', {
      coreServices: BookingState.catalog.coreServices.length,
      repairServices: BookingState.catalog.repairServices.length
    });

    // Render services immediately
    renderCoreServices();
    renderRepairServices();
  } else {
    // Fallback: fetch from API
    fetchServicesFromAPI();
  }
}

/**
 * Fetch services from API as fallback
 */
async function fetchServicesFromAPI() {
  try {

    // Use the public services endpoint
    const response = await fetch('/services');

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();

    // Extract the initialServices data from the HTML
    const match = html.match(/window\.initialCatalog\s*=\s*({[^;]+});/);
    if (match) {
      const initialData = eval('(' + match[1] + ')'); // Safe since it's server-generated
      BookingState.catalog.coreServices = initialData.coreServices || [];
      BookingState.catalog.repairServices = initialData.repairs || [];

      renderCoreServices();
      renderRepairServices();
    } else {
      throw new Error('Could not extract services data from page');
    }
  } catch (error) {

    // Try direct API endpoints as last resort
    try {
      const [coreResponse, repairResponse] = await Promise.all([
        fetch('/api/core-services'),
        fetch('/api/repair-services')
      ]);

      if (coreResponse.ok && repairResponse.ok) {
        const coreServices = await coreResponse.json();
        const repairServices = await repairResponse.json();

        BookingState.catalog.coreServices = coreServices;
        BookingState.catalog.repairServices = repairServices;

        renderCoreServices();
        renderRepairServices();
      } else {
        throw new Error('Admin API endpoints not accessible');
      }
    } catch (apiError) {
      showError('Unable to load services. Please refresh the page.');
    }
  }
}

/**
 * Render core services in the UI
 */
function renderCoreServices() {

  if (!DOM.coreServiceCards) {
    return;
  }

  const emptyState = document.getElementById('coreServiceEmpty');

  DOM.coreServiceCards.innerHTML = '';

  if (BookingState.catalog.coreServices.length === 0) {
    DOM.coreServiceCards.innerHTML = '<div class="col-12"><div class="alert alert-info">No core services available at the moment.</div></div>';
    if (emptyState) emptyState.classList.remove('d-none');
    return;
  }

  if (emptyState) emptyState.classList.add('d-none');

  BookingState.catalog.coreServices.forEach((service, index) => {
    const serviceCard = createServiceCard(service, 'core');
    DOM.coreServiceCards.appendChild(serviceCard);
  });

}

/**
 * Render repair services in the UI
 */
function renderRepairServices() {

  if (!DOM.repairServiceCards) {
    return;
  }


  DOM.repairServiceCards.innerHTML = '';

  if (BookingState.catalog.repairServices.length === 0) {
    DOM.repairServiceCards.innerHTML = '<div class="col-12"><div class="alert alert-info">No repair services available at the moment.</div></div>';
    return;
  }

  BookingState.catalog.repairServices.forEach((service, index) => {
    const serviceCard = createServiceCard(service, 'repair');
    DOM.repairServiceCards.appendChild(serviceCard);
  });

}

/**
 * Create a service card element
 */
function createServiceCard(service, type) {

  const col = document.createElement('div');
  col.className = 'col-12 col-md-6 col-lg-4';

  const card = document.createElement('div');
  card.className = 'card service-card h-100 border-0 shadow-sm';
  card.dataset.serviceId = service._id;
  card.dataset.serviceType = type;

  // Determine if service supports HP-based pricing
  const isAirconService = service.isAirconService && service.hpPricing && service.hpPricing.length > 0;
  const basePrice = service.basePrice || service.price || 0;
  const priceRange = service.priceRange;

  // Price display logic
  let priceDisplay = '';
  if (isAirconService) {
    const minPrice = Math.min(...service.hpPricing.map(hp => hp.price));
    const maxPrice = Math.max(...service.hpPricing.map(hp => hp.price));
    priceDisplay = `₱${minPrice.toLocaleString()} - ₱${maxPrice.toLocaleString()}`;
  } else if (priceRange) {
    priceDisplay = `₱${priceRange.min.toLocaleString()} - ₱${priceRange.max.toLocaleString()}`;
  } else if (basePrice) {
    priceDisplay = `₱${basePrice.toLocaleString()}`;
  } else {
    priceDisplay = 'Price on quote';
  }

  const durationLabel = service.duration
    ? `${service.duration} min`
    : service.estimatedDuration
      ? `${service.estimatedDuration} min`
      : 'Duration TBD';

  const serviceTypeBadge = isAirconService
    ? '<span class="badge bg-info text-dark service-card-chip">HP-based</span>'
    : type === 'repair'
      ? '<span class="badge bg-secondary text-white service-card-chip">Repair</span>'
      : '<span class="badge bg-primary service-card-chip">Service</span>';

  card.innerHTML = `
    <div class="card-body p-3">
      <div class="d-flex align-items-center mb-2">
        <div class="service-icon flex-shrink-0 me-3">
          <i class="${service.icon || (type === 'repair' ? 'bi bi-tools' : 'bi bi-gear-fill')} fs-4 text-primary"></i>
        </div>
        <div class="flex-grow-1">
          <h6 class="card-title fw-semibold mb-1 text-dark">${service.name}</h6>
          <div class="d-flex align-items-center gap-2">
            ${serviceTypeBadge}
            <span class="badge bg-light text-muted service-card-chip">${durationLabel}</span>
          </div>
        </div>
      </div>
      <div class="text-center mb-3">
        <div class="price-box rounded-pill px-3 py-2 fw-bold text-primary d-inline-block">
          ${priceDisplay}
        </div>
      </div>
      <button class="btn btn-primary w-100 add-service-btn" 
              data-service-id="${service._id}" 
              data-service-type="${type}"
              data-service-name="${service.name}"
              data-is-aircon="${isAirconService}">
        <i class="bi bi-plus-circle me-2"></i>Add to Booking
      </button>
    </div>
  `;

  col.appendChild(card);

  // Add direct event listener to the button
  const addBtn = card.querySelector('.add-service-btn');
  if (addBtn) {
    addBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();

      // Find the service object
      const serviceId = this.dataset.serviceId;
      const serviceType = this.dataset.serviceType;
      const service = BookingState.catalog[serviceType === 'core' ? 'coreServices' : 'repairServices']
        .find(s => s._id === serviceId);

      if (!service) {
        showError('Service not found');
        return;
      }


      // Set current service
      BookingState.currentService = {
        ...service,
        type: serviceType
      };

      // Show combined quantity and HP modal

      try {
        showCombinedQuantityHpModal(BookingState.currentService);
      } catch (error) {
        showError('Unable to open service selection');
      }
    });
  }

  return col;
}

/**
 * Initialize event listeners
 */
function initEventListeners() {
  // Service card add buttons
  document.addEventListener('click', handleServiceCardClick);

  // Category buttons
  const categoryButtons = document.querySelectorAll('.category-btn');
  categoryButtons.forEach(btn => {
    btn.addEventListener('click', handleCategorySelection);
  });

  // Modal confirm buttons
  DOM.confirmHpSelection?.addEventListener('click', confirmHpSelection);

  // Note: confirmQuantitySelection event listener will be attached when modal is opened
  // because the button might not exist in DOM initially

  // Quantity controls
  DOM.quantityModalDecrease?.addEventListener('click', decreaseQuantity);
  DOM.quantityModalIncrease?.addEventListener('click', increaseQuantity);
  DOM.quantityModalInput?.addEventListener('input', updateCombinedPrice);

  // Repair issue textarea
  DOM.repairIssue?.addEventListener('input', updateRepairIssues);

  // Add "Continue" button for service selection step (with delay to ensure DOM is ready)
  setTimeout(() => {
    addContinueButton();
  }, 500);

  // Note: Event listeners for Add to Cart buttons are attached when modal is shown
  // in showEnterpriseModal and attachAddToCartListener functions
}

/**
 * Attach event listener to Add to Cart button in a modal
 */
function attachAddToCartListener(modalElement) {

  // CAPTURE SERVICE AT TIME OF ATTACHMENT
  const capturedService = BookingState.currentService;

  // Check for both types of confirm buttons
  let confirmBtn = modalElement.querySelector('#confirmQuantitySelection');
  let isHpModal = false;

  // If not found, look for HP confirmation button
  if (!confirmBtn) {
    confirmBtn = modalElement.querySelector('#confirmHpSelection');
    isHpModal = true;
  }

  // If still not found, try by text content
  if (!confirmBtn) {
    const buttons = modalElement.querySelectorAll('button');
    buttons.forEach(btn => {
      const text = btn.textContent.trim();
      if (text.includes('Add to Cart') || text.includes('Add to cart') ||
        text.includes('Confirm HP') || text.includes('Confirm')) {
        confirmBtn = btn;
        isHpModal = text.includes('HP');
      }
    });
  }

  if (confirmBtn && !confirmBtn.hasAttribute('data-listener-attached')) {

    // Store service on button before cloning
    if (capturedService) {
      try {
        confirmBtn.dataset.serviceJson = JSON.stringify({
          _id: capturedService._id,
          name: capturedService.name,
          type: capturedService.type,
          basePrice: capturedService.basePrice,
          price: capturedService.price,
          isAirconService: capturedService.isAirconService,
          hpPricing: capturedService.hpPricing,
          airconTypes: capturedService.airconTypes,
          durationMinutes: capturedService.durationMinutes,
          duration: capturedService.duration,
          icon: capturedService.icon
        });
      } catch (e) {
      }
    }

    // Clone button to remove any existing listeners
    const newConfirmBtn = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

    // Attach the appropriate event listener with captured service
    newConfirmBtn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();

      // Use captured service or restore from button
      let service = capturedService;
      if (!service && newConfirmBtn.dataset.serviceJson) {
        try {
          service = JSON.parse(newConfirmBtn.dataset.serviceJson);
          BookingState.currentService = service;
        } catch (e) {
        }
      }

      if (!service && !BookingState.currentService) {
        showError('Service not found. Please try again.');
        return;
      }

      if (isHpModal) {
        confirmHpSelection();
      } else {
        confirmQuantitySelection();
      }
    });

    newConfirmBtn.setAttribute('data-listener-attached', 'true');

    // Test the button by adding a visual indicator
    newConfirmBtn.style.border = '3px solid lime !important';
    newConfirmBtn.title = 'Click me - event listener attached!';

  } else if (confirmBtn) {
  } else {
    const allButtons = modalElement.querySelectorAll('button');
    allButtons.forEach((btn, index) => {
    });
  }
}

/**
 * Handle category selection
 */
function handleCategorySelection(event) {
  const btn = event.target.closest('.category-btn');
  if (!btn) return;

  const category = btn.dataset.category;
  BookingState.ui.activeTab = category === 'services' ? 'core' : 'repair';

  // Show appropriate tab
  const coreTab = document.getElementById('core-tab');
  const repairTab = document.getElementById('repair-tab');

  if (category === 'services' && coreTab) {
    coreTab.click();
  } else if (category === 'repairs' && repairTab) {
    repairTab.click();
  }
}

/**
 * Add continue button to service selection step
 */
function addContinueButton() {
  const continueBtn = document.getElementById('continueToNextStep');
  const continueHint = document.getElementById('continueHint');

  if (!continueBtn) {
    return;
  }


  // Use onclick for direct assignment (most reliable method)
  continueBtn.onclick = function (e) {
    e.preventDefault();
    e.stopPropagation();

    if (BookingState.selectedServices.length > 0) {
      advanceToNextStep();
    } else {
      alert('Please select at least one service first');
    }
    return false;
  };

  // Update button state based on service selection
  updateContinueButtonState();

}

/**
 * Update continue button state based on service selection
 */
function updateContinueButtonState() {
  const continueBtn = document.getElementById('continueToNextStep');
  const continueHint = document.getElementById('continueHint');

  if (!continueBtn) return;

  const hasServices = BookingState.selectedServices.length > 0;
  continueBtn.disabled = !hasServices;

  if (continueHint) {
    if (hasServices) {
      continueHint.innerHTML = `<i class="bi bi-check-circle text-success me-1"></i>${BookingState.selectedServices.length} service(s) selected - click to continue`;
    } else {
      continueHint.textContent = 'Please select at least one service to continue';
    }
  }
}

/**
 * Initialize Bootstrap modals
 */
function initModals() {
  // Ensure BookingState.ui.modals exists
  if (!BookingState.ui) {
    BookingState.ui = {};
  }
  if (!BookingState.ui.modals) {
    BookingState.ui.modals = {};
  }

  // Wait for DOM to be ready and Bootstrap to be available
  if (typeof bootstrap !== 'undefined' && DOM.hpModal && DOM.quantityModal) {
    try {
      BookingState.ui.modals.hp = new bootstrap.Modal(DOM.hpModal);
      BookingState.ui.modals.quantity = new bootstrap.Modal(DOM.quantityModal);
    } catch (error) {
      // Fallback: use manual modal controls
      initFallbackModals();
    }
  } else {
    initFallbackModals();
  }
}

/**
 * Fallback modal controls for when Bootstrap is not available
 */
function initFallbackModals() {
  // Ensure BookingState.ui.modals exists
  if (!BookingState.ui) {
    BookingState.ui = {};
  }
  if (!BookingState.ui.modals) {
    BookingState.ui.modals = {};
  }

  BookingState.ui.modals.hp = {
    show: () => {
      if (DOM.hpModal) {

        // Remove any existing backdrops first
        const existingBackdrops = document.querySelectorAll('.modal-backdrop');
        existingBackdrops.forEach(backdrop => backdrop.remove());

        // Create backdrop with proper styling
        const backdrop = document.createElement('div');
        backdrop.className = 'modal-backdrop fade show';
        backdrop.id = 'hpModalBackdrop';
        backdrop.style.cssText = `
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          z-index: 1040 !important;
          width: 100vw !important;
          height: 100vh !important;
          background-color: rgba(0,0,0,0.5) !important;
          pointer-events: none !important;
          opacity: 1 !important;
          transition: opacity 0.15s linear !important;
        `;
        document.body.appendChild(backdrop);

        // Show modal with highest z-index
        DOM.hpModal.style.display = 'block';
        DOM.hpModal.classList.add('show');
        DOM.hpModal.style.cssText = `
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          z-index: 1070 !important;
          width: 100% !important;
          height: 100% !important;
          overflow: hidden !important;
          outline: 0 !important;
          pointer-events: auto !important;
        `;

        // Ensure dialog is fully interactive and centered
        const dialog = DOM.hpModal.querySelector('.modal-dialog');
        if (dialog) {
          dialog.style.cssText = `
            position: relative !important;
            width: auto !important;
            margin: 0.5rem auto !important;
            pointer-events: auto !important;
            z-index: 1080 !important;
            transform: none !important;
            max-width: 500px !important;
          `;
        }

        // Ensure all modal content is interactive
        const modalContent = DOM.hpModal.querySelector('.modal-content');
        if (modalContent) {
          modalContent.style.cssText = `
            position: relative !important;
            z-index: 1085 !important;
            pointer-events: auto !important;
          `;
        }

        // Enable all form elements
        const inputs = DOM.hpModal.querySelectorAll('input, button, select, textarea');
        inputs.forEach(input => {
          input.style.pointerEvents = 'auto';
          input.style.zIndex = '1090';
        });

        document.body.classList.add('modal-open');
        document.body.style.overflow = 'hidden';

      }
    },
    hide: () => {
      if (DOM.hpModal) {
        // Remove backdrop
        const backdrop = document.getElementById('hpModalBackdrop');
        if (backdrop) {
          backdrop.remove();
        }

        // Hide modal
        DOM.hpModal.style.display = 'none';
        DOM.hpModal.classList.remove('show');
        document.body.classList.remove('modal-open');
        document.body.style.overflow = '';

      }
    }
  };

  BookingState.ui.modals.quantity = {
    show: () => {
      if (DOM.quantityModal) {

        // Remove ALL existing backdrops and overlays
        const existingBackdrops = document.querySelectorAll('.modal-backdrop');
        existingBackdrops.forEach(backdrop => backdrop.remove());

        // Remove any overlay divs that might be causing gray overlay
        const overlays = document.querySelectorAll('[style*="position: fixed"], [style*="position: absolute"]');
        overlays.forEach(overlay => {
          if (overlay.style.zIndex && parseInt(overlay.style.zIndex) > 1000) {
            overlay.remove();
          }
        });

        // NO BACKDROP - just show the modal directly
        // This eliminates the gray overlay issue completely

        // Show modal with highest z-index and NO backdrop
        DOM.quantityModal.style.display = 'block';
        DOM.quantityModal.classList.add('show');
        DOM.quantityModal.style.cssText = `
          position: fixed !important;
          top: 0 !important;
          left: 0 !important;
          width: 100% !important;
          height: 100% !important;
          z-index: 100005 !important;
          background-color: rgba(0, 0, 0, 0.5) !important;
          overflow: auto !important;
          pointer-events: auto !important;
        `;

        // IMPORTANT: Attach event listener to Add to Cart button now that modal is visible
        // Use multiple methods to find and attach the event listener
        let confirmBtn = document.getElementById('confirmQuantitySelection');

        // If not found by ID, try other selectors
        if (!confirmBtn) {
          confirmBtn = DOM.quantityModal.querySelector('button#confirmQuantitySelection');
        }

        // If still not found, try by text content
        if (!confirmBtn) {
          const buttons = DOM.quantityModal.querySelectorAll('button');
          buttons.forEach(btn => {
            if (btn.textContent.includes('Add to Cart') || btn.textContent.includes('Add to cart')) {
              confirmBtn = btn;
            }
          });
        }

        // CAPTURE SERVICE BEFORE ATTACHING
        const capturedService = BookingState.currentService;

        if (confirmBtn && !confirmBtn.hasAttribute('data-listener-attached')) {

          // Store service on button before cloning
          if (capturedService) {
            try {
              confirmBtn.dataset.serviceJson = JSON.stringify({
                _id: capturedService._id,
                name: capturedService.name,
                type: capturedService.type,
                basePrice: capturedService.basePrice,
                price: capturedService.price,
                isAirconService: capturedService.isAirconService,
                hpPricing: capturedService.hpPricing,
                airconTypes: capturedService.airconTypes,
                durationMinutes: capturedService.durationMinutes,
                duration: capturedService.duration,
                icon: capturedService.icon
              });
            } catch (e) {
            }
          }

          // Remove any existing event listeners by cloning the button
          const newConfirmBtn = confirmBtn.cloneNode(true);
          confirmBtn.parentNode.replaceChild(newConfirmBtn, confirmBtn);

          // Attach the event listener to the new button with captured service
          newConfirmBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();

            // Restore service from captured or button data
            let service = capturedService;
            if (!service && newConfirmBtn.dataset.serviceJson) {
              try {
                service = JSON.parse(newConfirmBtn.dataset.serviceJson);
                BookingState.currentService = service;
              } catch (e) {
              }
            }

            if (!service && !BookingState.currentService) {
              showError('Service not found. Please try again.');
              return;
            }

            confirmQuantitySelection();
          });

          newConfirmBtn.setAttribute('data-listener-attached', 'true');

        } else if (confirmBtn) {
        } else {
        }

        // Ensure dialog is fully interactive and centered
        const dialog = DOM.quantityModal.querySelector('.modal-dialog');
        if (dialog) {
          dialog.style.cssText = `
            position: relative !important;
            width: auto !important;
            margin: 1rem auto !important;
            pointer-events: auto !important;
            z-index: 10000 !important;
            transform: none !important;
            max-width: 500px !important;
          `;
        }

        // Ensure all modal content is interactive
        const modalContent = DOM.quantityModal.querySelector('.modal-content');
        if (modalContent) {
          modalContent.style.cssText = `
            position: relative !important;
            z-index: 10001 !important;
            pointer-events: auto !important;
            background-color: white !important;
            border-radius: 8px !important;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3) !important;
          `;
        }

        // Enable all form elements
        const inputs = DOM.quantityModal.querySelectorAll('input, button, select, textarea, .hp-option-card, .btn');
        inputs.forEach(input => {
          input.style.pointerEvents = 'auto';
          input.style.zIndex = '10002';
          input.style.position = 'relative';
        });

        document.body.classList.add('modal-open');
        document.body.style.overflow = 'hidden';

      }
    },
    hide: () => {
      if (DOM.quantityModal) {
        // Remove any remaining backdrops
        const backdrops = document.querySelectorAll('.modal-backdrop');
        backdrops.forEach(backdrop => backdrop.remove());

        // Hide modal
        DOM.quantityModal.style.display = 'none';
        DOM.quantityModal.classList.remove('show');
        document.body.classList.remove('modal-open');
        document.body.style.overflow = '';

      }
    }
  };

  // Add close button handlers for fallback - with proper reset
  const hpCloseBtn = DOM.hpModal?.querySelector('[data-bs-dismiss="modal"]');
  const quantityCloseBtn = DOM.quantityModal?.querySelector('[data-bs-dismiss="modal"]');
  const quantityCancelBtn = DOM.quantityModal?.querySelector('.modal-footer .btn-secondary');

  if (hpCloseBtn) {
    hpCloseBtn.addEventListener('click', () => {
      hideModalWithoutBackdrop(DOM.hpModal);
      resetModalForNextUse();
    });
  }

  if (quantityCloseBtn) {
    quantityCloseBtn.addEventListener('click', () => {
      hideModalWithoutBackdrop(DOM.quantityModal);
      resetModalForNextUse();
    });
  }

  if (quantityCancelBtn && quantityCancelBtn !== quantityCloseBtn) {
    quantityCancelBtn.addEventListener('click', () => {
      hideModalWithoutBackdrop(DOM.quantityModal);
      resetModalForNextUse();
    });
  }

  // Close on backdrop click (disabled since backdrop has pointer-events: none)
  // Users will need to use the close button or cancel button
}

/**
 * Handle service card click events
 */
function handleServiceCardClick(event) {

  const addBtn = event.target.closest('.add-service-btn');
  if (!addBtn) {
    return;
  }

  console.log('Service card clicked:', {
    serviceId: addBtn.dataset.serviceId,
    serviceType: addBtn.dataset.serviceType,
    serviceName: addBtn.dataset.serviceName,
    isAircon: addBtn.dataset.isAircon === 'true'
  });

  event.preventDefault();
  event.stopPropagation();

  const serviceId = addBtn.dataset.serviceId;
  const serviceType = addBtn.dataset.serviceType;
  const serviceName = addBtn.dataset.serviceName;
  const isAircon = addBtn.dataset.isAircon === 'true';

  // Find the service object
  const service = BookingState.catalog[serviceType === 'core' ? 'coreServices' : 'repairServices']
    .find(s => s._id === serviceId);

  if (!service) {
    showError('Service not found');
    return;
  }


  // Set current service with type
  BookingState.currentService = {
    ...service,
    type: serviceType
  };

  // Show combined quantity and HP modal

  try {
    // Pass the modified service with type to the modal function
    showCombinedQuantityHpModal(BookingState.currentService);
  } catch (error) {
    showError('Unable to open service selection');
  }
}

/**
 * Show combined quantity and HP selection modal - Enterprise Edition with Aircon Types
 */
function showCombinedQuantityHpModal(service) {
  console.log('showCombinedQuantityHpModal called for:', service.name, {
    isAirconService: service.isAirconService,
    hasAirconTypes: !!(service.airconTypes && service.airconTypes.length > 0),
    airconTypesCount: service.airconTypes?.length || 0,
    hasLegacyHpPricing: !!(service.hpPricing && service.hpPricing.length > 0)
  });

  // Store current service and reset selections
  BookingState.currentService = service;
  BookingState.selectedHps = [];
  BookingState.selectedAirconType = null; // Track selected aircon type
  BookingState.applianceType = '';
  BookingState.applianceTypeName = '';
  BookingState.selectedBrand = '';
  hideBrandSection();

  // Get modal elements
  const modal = DOM.quantityModal;
  const serviceNameEl = DOM.quantityModalServiceName;
  const serviceUnitEl = DOM.quantityModalUnit;
  const hpSection = document.getElementById('hpSelectionSection');
  const hpContainer = document.getElementById('hpOptionsContainer');
  const modalTitle = document.querySelector('#quantitySelectionModal .modal-title');
  const singleQuantitySection = DOM.quantityModalInput?.closest('.mb-3');

  console.log('Modal elements check:', {
    modal: !!modal,
    serviceNameEl: !!serviceNameEl,
    serviceUnitEl: !!serviceUnitEl,
    hpSection: !!hpSection,
    hpContainer: !!hpContainer,
    modalTitle: !!modalTitle,
    singleQuantitySection: !!singleQuantitySection
  });

  if (!modal || !serviceNameEl || !serviceUnitEl) {
    showError('Unable to show service selection');
    return;
  }


  // Reset modal state
  serviceNameEl.textContent = service.name;
  serviceUnitEl.textContent = getServiceUnit(service);

  const descriptionEl = DOM.quantityModalDescription || document.getElementById('quantityModalDescription');
  if (descriptionEl) {
    descriptionEl.textContent = service.description || service.summary || 'No additional details available.';
    descriptionEl.classList.toggle('d-none', !service.description && !service.summary);
  }

  // Show pricing note for repair services with quantity calculation
  const pricingNoteEl = document.getElementById('pricingNoteSection');
  const issueDescriptionEl = document.getElementById('issueDescriptionSection');

  console.log('Checking if repair service:', {
    serviceType: service.type,
    isRepair: service.type === 'repair' || service.type === 'repairServices',
    hasPricingNoteEl: !!pricingNoteEl,
    hasIssueDescriptionEl: !!issueDescriptionEl
  });

  // Accept both 'repair' and 'repairServices' as the type
  if (service.type === 'repair' || service.type === 'repairServices') {
    // Show and populate pricing note
    if (pricingNoteEl) {
      const initialPrice = service.initialPrice || service.basePrice || 0;
      const noteText = service.pricingNote || 'This is an initial service fee. Final pricing will be determined by the technician after diagnosis.';

      pricingNoteEl.innerHTML = `
        <div class="d-flex align-items-start">
          <i class="bi bi-info-circle-fill text-info me-2 mt-1"></i>
          <div class="w-100">
            <strong class="d-block mb-1">Initial Service Fee: ₱${initialPrice.toLocaleString()} per unit</strong>
            <div class="d-flex justify-content-between align-items-center mb-2">
              <span>Quantity: <span id="pricingQuantityDisplay">1</span> unit(s)</span>
              <span class="fw-bold">Total Initial: ₱<span id="pricingTotalDisplay">${initialPrice.toLocaleString()}</span></span>
            </div>
            <small class="text-muted">${noteText}</small>
          </div>
        </div>
      `;
      pricingNoteEl.classList.remove('d-none');

      // Add event listener to update pricing display when quantity changes
      if (DOM.quantityModalInput) {
        const updatePricingDisplay = () => {
          const qty = parseInt(DOM.quantityModalInput.value) || 1;
          const total = initialPrice * qty;
          const qtyDisplay = document.getElementById('pricingQuantityDisplay');
          const totalDisplay = document.getElementById('pricingTotalDisplay');
          if (qtyDisplay) qtyDisplay.textContent = qty;
          if (totalDisplay) totalDisplay.textContent = total.toLocaleString();
        };

        // Remove old listeners and add new one
        DOM.quantityModalInput.removeEventListener('input', updatePricingDisplay);
        DOM.quantityModalInput.addEventListener('input', updatePricingDisplay);

        // Also listen to the decrease/increase buttons
        DOM.quantityModalDecrease?.addEventListener('click', () => {
          setTimeout(updatePricingDisplay, 50);
        });
        DOM.quantityModalIncrease?.addEventListener('click', () => {
          setTimeout(updatePricingDisplay, 50);
        });
      }
    }

    // Show and update issue description section
    if (issueDescriptionEl) {
      // Update placeholder with appliance type
      const textarea = issueDescriptionEl.querySelector('#repairIssueDescription');
      if (textarea) {
        textarea.placeholder = `Please describe the problem with your ${service.applianceType || 'appliance'} (e.g., not cooling, making noise, leaking water...)`;
        textarea.value = ''; // Clear previous value
      }
      issueDescriptionEl.classList.remove('d-none');
    }

  } else {
    // Hide repair-specific elements for non-repair services
    if (pricingNoteEl) pricingNoteEl.classList.add('d-none');
    if (issueDescriptionEl) issueDescriptionEl.classList.add('d-none');
  }

  // Update price label based on service type
  const priceLabel = document.getElementById('priceLabel');
  if (priceLabel) {
    if (service.type === 'repair' || service.type === 'repairServices') {
      priceLabel.textContent = 'Initial Cost: ';
    } else {
      priceLabel.textContent = 'Estimated Price: ';
    }
  }

  // Check if service has aircon types (new structure) or legacy HP pricing
  const hasAirconTypes = service.isAirconService && service.airconTypes && service.airconTypes.length > 0;
  const hasLegacyHpPricing = service.isAirconService && service.hpPricing && service.hpPricing.length > 0;
  const isAirconService = hasAirconTypes || hasLegacyHpPricing;

  console.log('Service type analysis:', {
    hasAirconTypes,
    hasLegacyHpPricing,
    isAirconService
  });

  if (isAirconService) {

    // Update modal title
    if (modalTitle) modalTitle.textContent = hasAirconTypes ? 'Select Aircon Type & HP' : 'Select HP Rating(s)';

    // Show HP section
    if (hpSection) {
      hpSection.style.display = 'block';

      // Render based on data structure
      if (hpContainer) {
        hpContainer.innerHTML = '';

        if (hasAirconTypes) {
          // NEW: Show aircon type selection first
          renderAirconTypeSelection(service.airconTypes, hpContainer);
        } else if (hasLegacyHpPricing) {
          // LEGACY: Show HP options directly
          service.hpPricing.forEach((hpOption, index) => {
            const hpCard = createProfessionalHpCard(hpOption, index);
            hpContainer.appendChild(hpCard);
          });
          // No appliance-type cards in legacy mode — show brand directly.
          showBrandSection(service);
        }

      }
    }

    // Hide single quantity input for aircon services
    if (singleQuantitySection) {
      singleQuantitySection.style.display = 'none';
    }

    // Show brand section first (required) for aircon services
    if (service.brands && service.brands.length) {
      showBrandSection(service);
    }

  } else {

    // Update modal title
    if (modalTitle) modalTitle.textContent = 'Select Quantity';

    // Hide HP section
    if (hpSection) {
      hpSection.style.display = 'none';
    }

    // Show single quantity input
    if (singleQuantitySection) {
      singleQuantitySection.style.display = 'block';
    }

    if (DOM.quantityModalInput) {
      DOM.quantityModalInput.value = 1;
    }
  }

  // Update price display
  updateCombinedPrice();

  // Show modal with enterprise-level styling
  try {
    showEnterpriseModal(modal);

    // Add immediate visibility check
    setTimeout(() => {
      console.log('Modal visibility check:', {
        display: window.getComputedStyle(modal).display,
        visibility: window.getComputedStyle(modal).visibility,
        opacity: window.getComputedStyle(modal).opacity,
        zIndex: window.getComputedStyle(modal).zIndex,
        classList: modal.classList.toString(),
        isVisible: modal.offsetParent !== null
      });
    }, 100);

  } catch (error) {
    showError('Unable to show modal');
  }
}

/**
 * Render aircon type selection section
 */
function renderAirconTypeSelection(airconTypes, container) {

  // Create type selection section
  const typeSection = document.createElement('div');
  typeSection.id = 'airconTypeSection';
  typeSection.className = 'mb-4';

  // Add header
  const header = document.createElement('div');
  header.className = 'mb-3';
  header.innerHTML = `
    <h6 class="fw-bold text-dark mb-2">Step 1: Select Aircon Type</h6>
    <p class="text-muted small mb-0">Choose the type of aircon unit. Prices vary by type and HP rating.</p>
  `;
  typeSection.appendChild(header);

  // Create type cards container
  const typesContainer = document.createElement('div');
  typesContainer.className = 'row g-3 mb-4';

  // Type icon mapping
  const typeIcons = {
    split: 'bi-columns-gap',
    window: 'bi-window',
    floor_mounted: 'bi-box',
    floor_standing: 'bi-door-closed',
    split_suspended: 'bi-arrow-down-circle',
    cassette: 'bi-grid-3x3',
    central: 'bi-building'
  };

  // Type description mapping
  const typeDescriptions = {
    split: 'Wall-mounted indoor + outdoor units',
    window: 'Self-contained window units',
    floor_mounted: 'Floor-standing units',
    floor_standing: 'Freestanding floor-standing units',
    split_suspended: 'Ceiling-suspended units',
    cassette: 'Ceiling cassette for commercial',
    central: 'Centralized ducted system'
  };

  airconTypes.forEach((type, index) => {

    const typeCol = document.createElement('div');
    typeCol.className = 'col-6 col-md-4';

    const typeCard = document.createElement('div');
    typeCard.className = 'card aircon-type-card h-100 border-2 bg-white shadow-sm cursor-pointer';
    typeCard.dataset.type = type.type;
    typeCard.dataset.index = index;
    typeCard.style.cssText = `
      border-radius: 12px !important;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
      border-color: #e5e7eb !important;
      cursor: pointer !important;
      position: relative !important;
      overflow: hidden !important;
    `;

    // Get price range for this type
    const minPrice = Math.min(...type.hpPricing.map(hp => hp.price));
    const maxPrice = Math.max(...type.hpPricing.map(hp => hp.price));
    const hpCount = type.hpPricing.length;

    typeCard.innerHTML = `
      <div class="card-body p-3 text-center">
        <div class="mb-2">
          <i class="bi ${typeIcons[type.type] || 'bi-fan'} fs-2 text-primary"></i>
        </div>
        <h6 class="fw-bold mb-1">${type.name}</h6>
        <p class="text-muted small mb-2" style="font-size: 0.75rem;">${typeDescriptions[type.type] || type.description}</p>
        <div class="d-flex justify-content-center align-items-center gap-2">
          <span class="badge bg-success bg-opacity-10 text-success">
            ₱${minPrice.toLocaleString()} - ₱${maxPrice.toLocaleString()}
          </span>
        </div>
        <div class="text-muted mt-1" style="font-size: 0.7rem;">
          ${hpCount} HP options available
        </div>
      </div>
    `;

    // Add click event
    typeCard.addEventListener('click', () => {

      // Remove previous selection
      document.querySelectorAll('.aircon-type-card').forEach(card => {
        card.classList.remove('selected');
        card.style.cssText = `
          border-radius: 12px !important;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
          border-color: #e5e7eb !important;
          cursor: pointer !important;
          position: relative !important;
          overflow: hidden !important;
          transform: translateY(0) !important;
        `;
      });

      // Add selection styling
      typeCard.classList.add('selected');
      typeCard.style.cssText += `
        border-color: #3b82f6 !important;
        background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%) !important;
        box-shadow: 0 4px 20px rgba(59, 130, 246, 0.15) !important;
        transform: translateY(-2px) !important;
      `;

      // Store selected type
      BookingState.selectedAirconType = type;
      // Record appliance type (customer-facing) for this booking
      BookingState.applianceType = type.type;
      BookingState.applianceTypeName = type.name;

      // Show & populate brand selector now that an appliance type is chosen
      showBrandSection(BookingState.currentService);

      // Show HP options for this type
      renderHpOptionsForType(type, container);
    });

    typeCol.appendChild(typeCard);
    typesContainer.appendChild(typeCol);
  });

  typeSection.appendChild(typesContainer);
  container.appendChild(typeSection);

  // Create HP selection section (initially hidden)
  const hpSectionDiv = document.createElement('div');
  hpSectionDiv.id = 'hpSelectionForType';
  hpSectionDiv.className = 'd-none';
  hpSectionDiv.innerHTML = `
    <div class="border-top pt-4 mb-3">
      <h6 class="fw-bold text-dark mb-2">Step 2: Select HP Rating(s)</h6>
      <p class="text-muted small mb-0">Choose the horsepower rating and quantity for each unit.</p>
    </div>
    <div id="hpOptionsForType" class="row g-3"></div>
  `;
  container.appendChild(hpSectionDiv);

}

/**
 * Show the brand selector for an aircon service and populate it from the
 * service's `brands` catalog (with an optional free-text entry).
 */
function showBrandSection(service) {
  const section = document.getElementById('brandSection');
  const select = document.getElementById('brandInput');
  const custom = document.getElementById('brandInputCustom');
  if (!section || !select) return;

  // Preserve any brand the user already chose (e.g. selected before picking an aircon type)
  const prevBrand = BookingState.selectedBrand || select.value || (custom && !custom.classList.contains('d-none') ? custom.value : '');
  const prevIsCustom = custom && !custom.classList.contains('d-none') && custom.value;

  BookingState.selectedBrand = '';
  select.value = '';
  if (custom) { custom.value = ''; custom.classList.add('d-none'); }

  const brands = (service && Array.isArray(service.brands)) ? service.brands : [];
  select.innerHTML = '<option value="">Select brand…</option>' +
    brands.map(b => `<option value="${String(b).replace(/"/g, '&quot;')}">${b}</option>`).join('') +
    '<option value="__other__">Other (type your brand)</option>';

  // Restore previous selection if it is still valid
  if (prevBrand) {
    let matched = false;
    if (prevIsCustom) {
      select.value = '__other__';
      if (custom) { custom.classList.remove('d-none'); custom.value = prevBrand; }
      BookingState.selectedBrand = prevBrand;
      matched = true;
    } else {
      const opts = Array.from(select.options).map(o => o.value);
      if (opts.includes(prevBrand)) {
        select.value = prevBrand;
        BookingState.selectedBrand = prevBrand;
        matched = true;
      }
    }
    if (!matched && custom) {
      // Fall back to "Other" with the free-text value
      select.value = '__other__';
      custom.classList.remove('d-none');
      custom.value = prevBrand;
      BookingState.selectedBrand = prevBrand;
    }
  }

  section.style.display = 'block';
  clearModalError();

  // Wire up once
  if (!select.dataset.wired) {
    select.dataset.wired = '1';
    select.addEventListener('change', () => {
      clearModalError();
      if (custom) {
        if (select.value === '__other__') {
          custom.classList.remove('d-none');
          custom.focus();
          BookingState.selectedBrand = custom.value;
        } else {
          custom.classList.add('d-none');
          custom.value = '';
          BookingState.selectedBrand = select.value;
        }
      } else {
        BookingState.selectedBrand = select.value;
      }
    });
    if (custom) {
      custom.addEventListener('input', () => { BookingState.selectedBrand = custom.value; clearModalError(); });
    }
  }
}

function hideBrandSection() {
  const section = document.getElementById('brandSection');
  const select = document.getElementById('brandInput');
  const custom = document.getElementById('brandInputCustom');
  if (section) section.style.display = 'none';
  if (select) select.value = '';
  if (custom) { custom.value = ''; custom.classList.add('d-none'); }
  BookingState.selectedBrand = '';
}

/**
 * Render HP options for selected aircon type
 */
function renderHpOptionsForType(airconType, container) {

  // Show HP section
  const hpSectionDiv = container.querySelector('#hpSelectionForType');
  if (hpSectionDiv) {
    hpSectionDiv.classList.remove('d-none');
  }

  // Get HP container
  const hpContainer = container.querySelector('#hpOptionsForType');
  if (!hpContainer) {
    return;
  }

  // Clear existing HP options
  hpContainer.innerHTML = '';

  // Render HP options for this type
  airconType.hpPricing.forEach((hpOption, index) => {

    // Create HP card with type context
    const hpCard = createProfessionalHpCardForType(hpOption, index, airconType);
    hpContainer.appendChild(hpCard);
  });

  // Scroll to HP section
  hpSectionDiv.scrollIntoView({ behavior: 'smooth', block: 'start' });

}

/**
 * Create HP card for specific aircon type
 */
function createProfessionalHpCardForType(hpOption, index, airconType) {
  const col = document.createElement('div');
  col.className = 'col-12 mb-3';

  const card = document.createElement('div');
  card.className = 'card hp-selection-card border-2 bg-white shadow-sm';
  card.dataset.hp = hpOption.hp;
  card.dataset.price = hpOption.price;
  card.dataset.description = hpOption.description;
  card.dataset.type = airconType.type;
  card.dataset.selected = 'false';
  card.style.cssText = `
    border-radius: 12px !important;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
    border-color: #e5e7eb !important;
    cursor: pointer !important;
    position: relative !important;
    overflow: hidden !important;
  `;

  card.innerHTML = `
    <div class="card-body p-4">
      <div class="row align-items-center">
        <div class="col-md-6">
          <div class="d-flex align-items-start">
            <div class="form-check form-check-lg me-4">
              <input class="form-check-input hp-checkbox" type="checkbox" value="${hpOption.hp}" 
                     data-price="${hpOption.price}" data-type="${airconType.type}" style="width: 1.25rem; height: 1.25rem;">
            </div>
            <div class="flex-grow-1">
              <div class="d-flex align-items-center mb-2">
                <span class="badge bg-primary bg-gradient rounded-pill px-3 py-2 me-2">
                  ${hpOption.hp} HP
                </span>
                <div class="text-primary fw-bold fs-5">₱${hpOption.price.toLocaleString()}</div>
              </div>
              <div class="text-muted small">
                <i class="bi bi-clock me-1"></i>
                ${hpOption.durationMinutes || 60} minutes
              </div>
              ${hpOption.description ? `<div class="text-muted small mt-1">${hpOption.description}</div>` : ''}
              <div class="mt-2">
                <span class="badge bg-info bg-opacity-10 text-info">${airconType.name}</span>
              </div>
            </div>
          </div>
        </div>
        <div class="col-md-6">
          <div class="hp-quantity-control" style="opacity:0.5;pointer-events:none;">
            <label class="form-label fw-semibold text-dark mb-2">Quantity:</label>
            <div class="quantity-selector">
              <div class="input-group input-group-lg shadow-sm">
                <button class="btn btn-outline-primary quantity-decrease" type="button" disabled
                        style="border-radius: 8px 0 0 8px; min-width: 50px;">
                  <i class="bi bi-dash-lg"></i>
                </button>
                <input type="number" class="form-control text-center hp-quantity-input fw-bold" 
                       value="1" min="1" max="20" readonly disabled
                       style="background: #f8f9fa; border: none; font-size: 1.1rem;">
                <button class="btn btn-outline-primary quantity-increase" type="button" disabled
                        style="border-radius: 0 8px 8px 0; min-width: 50px;">
                  <i class="bi bi-plus-lg"></i>
                </button>
              </div>
              <div class="text-muted small mt-2 text-center">
                <span class="quantity-price">₱${hpOption.price.toLocaleString()}</span> per unit
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Add event listeners with type context
  addHpCardEventListenersForType(card, hpOption, airconType);

  // Also add click handler to the entire card to toggle checkbox
  card.addEventListener('click', (e) => {
    // Don't toggle if clicking on quantity controls
    if (e.target.closest('.hp-quantity-control') ||
      e.target.closest('.quantity-decrease') ||
      e.target.closest('.quantity-increase')) {
      return;
    }

    const checkbox = card.querySelector('.hp-checkbox');
    if (checkbox && e.target !== checkbox) {
      checkbox.checked = !checkbox.checked;
      // Trigger change event
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  col.appendChild(card);
  return col;
}

/**
 * Add event listeners to HP card with type context
 */
function addHpCardEventListenersForType(card, hpOption, airconType) {
  const checkbox = card.querySelector('.hp-checkbox');
  const quantityControl = card.querySelector('.hp-quantity-control');
  const decreaseBtn = card.querySelector('.quantity-decrease');
  const increaseBtn = card.querySelector('.quantity-increase');
  const quantityInput = card.querySelector('.hp-quantity-input');
  const quantityPrice = card.querySelector('.quantity-price');

  console.log('Adding HP card event listeners:', {
    hp: hpOption.hp,
    type: airconType.type,
    checkboxFound: !!checkbox,
    quantityControlFound: !!quantityControl
  });

  if (!checkbox) {
    return;
  }

  // Checkbox change event
  checkbox.addEventListener('change', (e) => {
    console.log('HP checkbox changed:', {
      checked: e.target.checked,
      hp: hpOption.hp,
      price: hpOption.price,
      type: airconType.type,
      timestamp: Date.now()
    });

    const isChecked = e.target.checked;
    card.dataset.selected = isChecked;

    if (isChecked) {
      // Professional selection styling
      card.style.cssText += `
        border-color: #3b82f6 !important;
        background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%) !important;
        box-shadow: 0 4px 20px rgba(59, 130, 246, 0.15) !important;
        transform: translateY(-2px) !important;
      `;
      quantityControl.style.opacity = '1';
      quantityControl.style.pointerEvents = 'auto';
      quantityControl.querySelectorAll('button, input').forEach(el => el.disabled = false);

      // Add to selected HPs with type info
      const newHpSelection = {
        hp: parseFloat(hpOption.hp),
        price: parseInt(hpOption.price),
        quantity: 1,
        description: hpOption.description,
        airconType: airconType.type,
        airconTypeName: airconType.name
      };

      const existing = BookingState.selectedHps.find(
        hp => hp.hp === parseFloat(hpOption.hp) && hp.airconType === airconType.type
      );
      if (!existing) BookingState.selectedHps.push(newHpSelection);

    } else {
      // Reset styling
      card.style.cssText = `
        border-radius: 12px !important;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
        border-color: #e5e7eb !important;
        cursor: pointer !important;
        position: relative !important;
        overflow: hidden !important;
        transform: translateY(0) !important;
      `;
      quantityControl.style.opacity = '0.5';
      quantityControl.style.pointerEvents = 'none';
      quantityControl.querySelectorAll('button, input').forEach(el => el.disabled = true);

      // Remove from selected HPs
      const beforeCount = BookingState.selectedHps.length;
      BookingState.selectedHps = BookingState.selectedHps.filter(
        hp => !(hp.hp === parseFloat(hpOption.hp) && hp.airconType === airconType.type)
      );
    }

    // Update price immediately
    updateCombinedPrice();
  });

  // Quantity controls with animation
  decreaseBtn.addEventListener('click', () => {
    const currentValue = parseInt(quantityInput.value);
    if (currentValue > 1) {
      const newValue = currentValue - 1;
      quantityInput.value = newValue;
      updateQuantityPriceDisplay(quantityPrice, hpOption.price, newValue);
      updateHpQuantityForType(hpOption.hp, newValue, airconType.type);
      animateQuantityChange(quantityInput);
    }
  });

  increaseBtn.addEventListener('click', () => {
    const currentValue = parseInt(quantityInput.value);
    if (currentValue < 20) {
      const newValue = currentValue + 1;
      quantityInput.value = newValue;
      updateQuantityPriceDisplay(quantityPrice, hpOption.price, newValue);
      updateHpQuantityForType(hpOption.hp, newValue, airconType.type);
      animateQuantityChange(quantityInput);
    }
  });
}

/**
 * Update HP quantity for specific type
 */
function updateHpQuantityForType(hp, quantity, type) {

  const hpSelection = BookingState.selectedHps.find(
    hpItem => hpItem.hp === parseFloat(hp) && hpItem.airconType === type
  );

  if (hpSelection) {
    const oldQuantity = hpSelection.quantity;
    hpSelection.quantity = quantity;
    console.log('Updated HP quantity:', {
      hp: hpSelection.hp,
      type: hpSelection.airconType,
      oldQuantity: oldQuantity,
      newQuantity: quantity,
      price: hpSelection.price
    });
    updateCombinedPrice();
  } else {
  }
}

/**
 * Create professional HP card
 */
function createProfessionalHpCard(hpOption, index) {
  const col = document.createElement('div');
  col.className = 'col-12 mb-3';

  const card = document.createElement('div');
  card.className = 'card hp-selection-card border-2 bg-white shadow-sm';
  card.dataset.hp = hpOption.hp;
  card.dataset.price = hpOption.price;
  card.dataset.description = hpOption.description;
  card.dataset.selected = 'false';
  card.style.cssText = `
    border-radius: 12px !important;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
    border-color: #e5e7eb !important;
    cursor: pointer !important;
    position: relative !important;
    overflow: hidden !important;
  `;

  card.innerHTML = `
    <div class="card-body p-4">
      <div class="row align-items-center">
        <div class="col-md-6">
          <div class="d-flex align-items-start">
            <div class="form-check form-check-lg me-4">
              <input class="form-check-input hp-checkbox" type="checkbox" value="${hpOption.hp}" 
                    data-price="${hpOption.price}" style="width: 1.25rem; height: 1.25rem;">
            </div>
            <div class="flex-grow-1">
              <div class="d-flex align-items-center mb-2">
                <span class="badge bg-primary bg-gradient rounded-pill px-3 py-2 me-2">
                  ${hpOption.hp} HP
                </span>
                <div class="text-primary fw-bold fs-5">₱${hpOption.price.toLocaleString()}</div>
              </div>
              <div class="text-muted small">
                <i class="bi bi-clock me-1"></i>
                ${hpOption.durationMinutes || 60} minutes
              </div>
              ${hpOption.description ? `<div class="text-muted small mt-1">${hpOption.description}</div>` : ''}
            </div>
          </div>
        </div>
        <div class="col-md-6">
          <div class="hp-quantity-control" style="opacity:0.5;pointer-events:none;">
            <label class="form-label fw-semibold text-dark mb-2">Quantity:</label>
            <div class="quantity-selector">
              <div class="input-group input-group-lg shadow-sm">
                <button class="btn btn-outline-primary quantity-decrease" type="button" disabled
                        style="border-radius: 8px 0 0 8px; min-width: 50px;">
                  <i class="bi bi-dash-lg"></i>
                </button>
                <input type="number" class="form-control text-center hp-quantity-input fw-bold" 
                       value="1" min="1" max="20" readonly disabled
                       style="background: #f8f9fa; border: none; font-size: 1.1rem;">
                <button class="btn btn-outline-primary quantity-increase" type="button" disabled
                        style="border-radius: 0 8px 8px 0; min-width: 50px;">
                  <i class="bi bi-plus-lg"></i>
                </button>
              </div>
              <div class="text-muted small mt-2 text-center">
                <span class="quantity-price">₱${hpOption.price.toLocaleString()}</span> per unit
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Add event listeners
  addHpCardEventListeners(card, hpOption);

  col.appendChild(card);
  return col;
}

/**
 * Add event listeners to HP card
 */
function addHpCardEventListeners(card, hpOption) {
  const checkbox = card.querySelector('.hp-checkbox');
  const quantityControl = card.querySelector('.hp-quantity-control');
  const decreaseBtn = card.querySelector('.quantity-decrease');
  const increaseBtn = card.querySelector('.quantity-increase');
  const quantityInput = card.querySelector('.hp-quantity-input');
  const quantityPrice = card.querySelector('.quantity-price');

  // Checkbox change event
  checkbox.addEventListener('change', (e) => {
    console.log('HP checkbox changed:', {
      checked: e.target.checked,
      hp: hpOption.hp,
      price: hpOption.price
    });

    const isChecked = e.target.checked;
    card.dataset.selected = isChecked;

    if (isChecked) {
      // Professional selection styling
      card.style.cssText += `
        border-color: #3b82f6 !important;
        background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%) !important;
        box-shadow: 0 4px 20px rgba(59, 130, 246, 0.15) !important;
        transform: translateY(-2px) !important;
      `;
      quantityControl.style.opacity = '1';
      quantityControl.style.pointerEvents = 'auto';
      quantityControl.querySelectorAll('button, input').forEach(el => el.disabled = false);

      // Add to selected HPs
      const newHpSelection = {
        hp: parseFloat(hpOption.hp),
        price: parseInt(hpOption.price),
        quantity: 1,
        description: hpOption.description
      };

      const existing = BookingState.selectedHps.find(hp => hp.hp === parseFloat(hpOption.hp));
      if (!existing) BookingState.selectedHps.push(newHpSelection);

    } else {
      // Reset styling
      card.style.cssText = `
        border-radius: 12px !important;
        transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
        border-color: #e5e7eb !important;
        cursor: pointer !important;
        position: relative !important;
        overflow: hidden !important;
        transform: translateY(0) !important;
      `;
      quantityControl.style.opacity = '0.5';
      quantityControl.style.pointerEvents = 'none';
      quantityControl.querySelectorAll('button, input').forEach(el => el.disabled = true);

      // Remove from selected HPs
      const beforeCount = BookingState.selectedHps.length;
      BookingState.selectedHps = BookingState.selectedHps.filter(
        hp => hp.hp !== parseFloat(hpOption.hp)
      );
    }

    // Update price immediately
    updateCombinedPrice();
  });

  // Quantity controls with animation
  decreaseBtn.addEventListener('click', () => {
    const currentValue = parseInt(quantityInput.value);
    if (currentValue > 1) {
      const newValue = currentValue - 1;
      quantityInput.value = newValue;
      updateQuantityPriceDisplay(quantityPrice, hpOption.price, newValue);
      updateHpQuantity(hpOption.hp, newValue);
      animateQuantityChange(quantityInput);
    }
  });

  increaseBtn.addEventListener('click', () => {
    const currentValue = parseInt(quantityInput.value);
    if (currentValue < 20) {
      const newValue = currentValue + 1;
      quantityInput.value = newValue;
      updateQuantityPriceDisplay(quantityPrice, hpOption.price, newValue);
      updateHpQuantity(hpOption.hp, newValue);
      animateQuantityChange(quantityInput);
    }
  });
}

/**
 * Update quantity price display
 */
function updateQuantityPriceDisplay(element, basePrice, quantity) {
  const total = basePrice * quantity;
  element.textContent = `₱${total.toLocaleString()} per unit`;
}

/**
 * Animate quantity change
 */
function animateQuantityChange(input) {
  input.style.transition = 'transform 0.18s ease';
  input.style.transform = 'scale(1.08)';

  setTimeout(() => {
    input.style.transform = 'scale(1)';
  }, 180);
}

/**
 * Global modal cleanup - ensures multiple modals work properly
 */
function cleanupAllModals() {

  // Clear all cleanup intervals
  document.querySelectorAll('[id$="Modal"]').forEach(modal => {
    if (modal._cleanupInterval) {
      clearInterval(modal._cleanupInterval);
      modal._cleanupInterval = null;
    }
  });

  // Remove all backdrops and overlays
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.remove());
  document.querySelectorAll('[style*="position: fixed"], [style*="position: absolute"]').forEach(overlay => {
    if (overlay.style.zIndex && parseInt(overlay.style.zIndex) > 1000) {
      // Only remove overlays that are not the modal itself
      if (!overlay.classList.contains('modal')) {
        overlay.remove();
      }
    }
  });

  // Reset only hidden modals, not all modals (preserve modal elements for reuse)
  document.querySelectorAll('.modal:not(.show)').forEach(modal => {
    modal.classList.remove('show', 'hide');
    modal.style.display = 'none';
    modal.removeAttribute('aria-modal');
    modal.setAttribute('aria-hidden', 'true');
  });

  // Reset body styles only if no modal is showing
  const showingModals = document.querySelectorAll('.modal.show');
  if (showingModals.length === 0) {
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';
  } else {
  }

}

/**
 * Reset modal state for reuse
 */
function resetModalState(modalElement) {

  if (!modalElement) {
    return;
  }

  // Clear any cleanup intervals
  if (modalElement._cleanupInterval) {
    clearInterval(modalElement._cleanupInterval);
    modalElement._cleanupInterval = null;
  }

  // Only reset display and classes, preserve the element and its styles
  modalElement.classList.remove('show', 'hide');
  modalElement.style.display = 'none';

  // Reset body styles only if no modal is showing
  const showingModals = document.querySelectorAll('.modal.show');
  if (showingModals.length === 0) {
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';
  }

  // Reset aria attributes
  modalElement.removeAttribute('aria-modal');
  modalElement.setAttribute('aria-hidden', 'true');

}

/**
 * Reset modal for next use - call this when modal is closed without adding
 */
function resetModalForNextUse() {

  // Reset the Add to Cart button - COMPLETELY
  const confirmBtn = document.getElementById('confirmQuantitySelection');
  if (confirmBtn) {
    confirmBtn.removeAttribute('data-listener-attached');
    confirmBtn.disabled = false;
    confirmBtn.style.border = '';
    confirmBtn.title = '';
    confirmBtn.style.transform = '';
  }

  // Reset current service state
  BookingState.currentService = null;
  BookingState.selectedHps = [];
  BookingState.selectedAirconType = null;

  // Clear HP container
  const hpContainer = document.getElementById('hpOptionsContainer');
  if (hpContainer) {
    hpContainer.innerHTML = '';
  }

  // Hide pricing note and issue description sections
  const pricingNoteEl = document.getElementById('pricingNoteSection');
  const issueDescriptionEl = document.getElementById('issueDescriptionSection');
  if (pricingNoteEl) pricingNoteEl.classList.add('d-none');
  if (issueDescriptionEl) issueDescriptionEl.classList.add('d-none');

  // Reset quantity input
  if (DOM.quantityModalInput) {
    DOM.quantityModalInput.value = 1;
  }

  console.log('Reset modal for next use:', {
    hasListener: confirmBtn?.hasAttribute('data-listener-attached'),
    disabled: confirmBtn?.disabled,
    buttonId: confirmBtn?.id,
    buttonExists: !!confirmBtn
  });
}

/**
 * Show enterprise-level modal with proper cleanup
 */
function showEnterpriseModal(modalElement) {

  if (!modalElement) {
    showError('Modal element not found');
    return;
  }


  // Global cleanup first - ensures multiple modals work properly
  cleanupAllModals();

  // Reset any existing modal state first
  resetModalState(modalElement);

  // Prevent Bootstrap interference
  modalElement.setAttribute('data-bs-backdrop', 'false');
  modalElement.setAttribute('data-bs-keyboard', 'false');
  modalElement.removeAttribute('aria-hidden'); // Remove aria-hidden to fix accessibility
  modalElement.setAttribute('aria-modal', 'true'); // Add proper aria-modal instead

  // Force modal to be visible with aggressive styling
  modalElement.style.display = 'block';
  modalElement.classList.add('show');
  modalElement.classList.remove('hide');

  console.log('Modal shown with enterprise-level styling:', {
    display: modalElement.style.display,
    classList: modalElement.classList.toString()
  });

  // Remove all conflicting classes and styles first
  modalElement.classList.remove('fade');
  modalElement.style.removeProperty('transition');
  modalElement.style.removeProperty('transform');

  // Apply styles directly to element (not via cssText)
  modalElement.style.setProperty('position', 'fixed', 'important');
  modalElement.style.setProperty('top', '0', 'important');
  modalElement.style.setProperty('left', '0', 'important');
  modalElement.style.setProperty('z-index', '99999', 'important');
  modalElement.style.setProperty('width', '100%', 'important');
  modalElement.style.setProperty('height', '100%', 'important');
  modalElement.style.setProperty('overflow', 'auto', 'important');
  modalElement.style.setProperty('outline', '0', 'important');
  modalElement.style.setProperty('pointer-events', 'auto', 'important');
  modalElement.style.setProperty('background', 'rgba(0, 0, 0, 0.6)', 'important');
  modalElement.style.setProperty('backdrop-filter', 'blur(8px)', 'important');
  modalElement.style.setProperty('display', 'flex', 'important');
  modalElement.style.setProperty('visibility', 'visible', 'important');
  modalElement.style.setProperty('opacity', '1', 'important');
  modalElement.style.setProperty('align-items', 'center', 'important');
  modalElement.style.setProperty('justify-content', 'center', 'important');
  modalElement.style.setProperty('padding', '2rem 1rem', 'important');


  // Force body styles
  document.body.style.setProperty('overflow', 'hidden', 'important');
  document.body.classList.add('modal-open');

  // Check if modal is actually visible after styling
  const computedStyle = window.getComputedStyle(modalElement);
  console.log('Modal visibility check after styling:', {
    display: computedStyle.display,
    visibility: computedStyle.visibility,
    opacity: computedStyle.opacity,
    zIndex: computedStyle.zIndex,
    position: computedStyle.position,
    background: computedStyle.background,
    offsetParent: modalElement.offsetParent !== null,
    offsetWidth: modalElement.offsetWidth,
    offsetHeight: modalElement.offsetHeight
  });

  // If still not visible, try forcing with setTimeout
  setTimeout(() => {
    const style = modalElement.style;
    style.setProperty('display', 'flex', 'important');
    style.setProperty('visibility', 'visible', 'important');
    style.setProperty('opacity', '1', 'important');
    style.setProperty('z-index', '99999', 'important');


    // Final check
    const finalStyle = window.getComputedStyle(modalElement);
    console.log('Final modal visibility check:', {
      display: finalStyle.display,
      visibility: finalStyle.visibility,
      opacity: finalStyle.opacity,
      zIndex: finalStyle.zIndex,
      isVisible: modalElement.offsetParent !== null
    });
  }, 50);


  // Professional dialog styling
  const dialog = modalElement.querySelector('.modal-dialog');
  if (dialog) {
    dialog.style.cssText = `
      position: relative !important;
      width: auto !important;
      margin: 0 !important;
      pointer-events: auto !important;
      z-index: 100000 !important;
      transform: none !important;
      max-width: 700px !important;
      max-height: 90vh !important;
      animation: slideUp 0.4s cubic-bezier(0.4, 0, 0.2, 1) !important;
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      flex-direction: column !important;
    `;
  } else {
  }

  // Professional content styling
  const modalContent = modalElement.querySelector('.modal-content');
  if (modalContent) {
    modalContent.style.cssText = `
      position: relative !important;
      z-index: 100001 !important;
      pointer-events: auto !important;
      background: white !important;
      border-radius: 16px !important;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25) !important;
      border: none !important;
      overflow: hidden !important;
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      flex-direction: column !important;
      max-height: 90vh !important;
    `;
  } else {
  }

  // Professional footer styling
  const modalFooter = modalElement.querySelector('.modal-footer');
  if (modalFooter) {
    modalFooter.style.cssText = `
      position: relative !important;
      z-index: 100003 !important;
      background: linear-gradient(to bottom, #ffffff, #f8fafc) !important;
      border-top: 1px solid #e5e7eb !important;
      padding: 1.5rem !important;
      pointer-events: auto !important;
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      justify-content: flex-end !important;
      gap: 0.75rem !important;
      flex-shrink: 0 !important;
      border-radius: 0 0 16px 16px !important;
    `;

    const footerButtons = modalFooter.querySelectorAll('button');
    footerButtons.forEach((btn, index) => {
      if (btn.id === 'confirmQuantitySelection') {
        // Style the button
        btn.style.cssText = `
          pointer-events: auto !important;
          z-index: 100004 !important;
          position: relative !important;
          opacity: 1 !important;
          visibility: visible !important;
          display: inline-block !important;
          background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%) !important;
          border: none !important;
          border-radius: 12px !important;
          padding: 0.75rem 2rem !important;
          font-weight: 600 !important;
          font-size: 1rem !important;
          box-shadow: 0 4px 14px rgba(59, 130, 246, 0.4) !important;
          transition: all 0.2s ease !important;
          color: white !important;
        `;

        // CRITICAL: Attach event listener to Add to Cart button

        // ALWAYS reset button state before attaching new listener
        btn.removeAttribute('data-processing');
        btn.removeAttribute('data-listener-attached');
        btn.disabled = false;

        // ALWAYS attach a new listener when modal opens to ensure it works
        // Remove any existing listeners by cloning first
        const newBtn = btn.cloneNode(true);
        newBtn.removeAttribute('data-processing');
        newBtn.removeAttribute('data-listener-attached');
        newBtn.disabled = false;
        btn.parentNode.replaceChild(newBtn, btn);
        btn = newBtn; // Update reference to the new button

        // CAPTURE SERVICE IN CLOSURE - This ensures the service is available when button is clicked
        // even if BookingState.currentService gets cleared
        const capturedService = BookingState.currentService;

        // Store service data on the button as backup
        if (capturedService) {
          try {
            btn.dataset.serviceJson = JSON.stringify({
              _id: capturedService._id,
              name: capturedService.name,
              type: capturedService.type,
              basePrice: capturedService.basePrice,
              price: capturedService.price,
              isAirconService: capturedService.isAirconService,
              hpPricing: capturedService.hpPricing,
              airconTypes: capturedService.airconTypes,
              durationMinutes: capturedService.durationMinutes,
              duration: capturedService.duration,
              icon: capturedService.icon
            });
          } catch (e) {
          }
        }

        // Apply styles to new button - AGGRESSIVE STYLING FOR CLICKABILITY
        btn.style.cssText = `
          pointer-events: auto !important;
          z-index: 100004 !important;
          position: relative !important;
          opacity: 1 !important;
          visibility: visible !important;
          display: inline-block !important;
          background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%) !important;
          border: none !important;
          border-radius: 12px !important;
          padding: 0.75rem 2rem !important;
          font-weight: 600 !important;
          font-size: 1rem !important;
          box-shadow: 0 4px 14px rgba(59, 130, 246, 0.4) !important;
          transition: all 0.2s ease !important;
          color: white !important;
          cursor: pointer !important;
          user-select: none !important;
          touch-action: manipulation !important;
        `;

        // Attach click handler - uses CAPTURED service from closure
        const handleAddToCart = function (e) {
          e.preventDefault();
          e.stopPropagation();

          // Get the current button (might be different from original due to cloning)
          const currentBtn = e.currentTarget || e.target;
          console.log('Button click listener attached:', {
            disabled: currentBtn.disabled,
            hasListener: currentBtn.hasAttribute('data-listener-attached')
          });

          // Prevent multiple clicks - simple check
          if (currentBtn.disabled) {
            return;
          }

          // Disable button immediately to prevent double-clicks
          currentBtn.disabled = true;

          // Use captured service from closure (most reliable)
          let service = capturedService;

          // Fallback: try BookingState if captured service is null
          if (!service) {
            service = BookingState.currentService;
          }

          // Fallback 2: try button dataset
          if (!service && currentBtn.dataset.serviceJson) {
            try {
              service = JSON.parse(currentBtn.dataset.serviceJson);
            } catch (e) {
            }
          }

          if (!service) {
            showError('Service data not found. Please close the modal and try again.');
            // Re-enable button on error
            currentBtn.disabled = false;
            return;
          }


          // Ensure BookingState has the service for confirmQuantitySelection
          BookingState.currentService = service;

          // Visual feedback
          currentBtn.style.transform = 'scale(0.95)';
          setTimeout(() => {
            currentBtn.style.transform = 'scale(1)';
          }, 100);

          // Re-enable button immediately to ensure it's ready for next use
          currentBtn.disabled = false;

          // Call the confirm function
          try {
            confirmQuantitySelection();
          } catch (error) {
            currentBtn.disabled = false;
          }
        };

        btn.addEventListener('click', handleAddToCart);

        // Mark the button as having listener attached
        btn.setAttribute('data-listener-attached', 'true');

      } else {
        btn.style.cssText = `
          pointer-events: auto !important;
          z-index: 100004 !important;
          position: relative !important;
          opacity: 1 !important;
          visibility: visible !important;
          display: inline-block !important;
          background: #f3f4f6 !important;
          border: 1px solid #d1d5db !important;
          border-radius: 12px !important;
          padding: 0.75rem 2rem !important;
          font-weight: 600 !important;
          color: #374151 !important;
          transition: all 0.2s ease !important;
        `;
      }
    });
  } else {
  }

  // Make modal body scrollable
  const modalBody = modalElement.querySelector('.modal-body');
  if (modalBody) {
    modalBody.style.cssText = `
      position: relative !important;
      z-index: 100002 !important;
      pointer-events: auto !important;
      overflow-y: auto !important;
      overflow-x: hidden !important;
      flex-grow: 1 !important;
      padding: 1.5rem !important;
      max-height: calc(90vh - 200px) !important;
      scrollbar-width: thin !important;
      scrollbar-color: #e5e7eb #f8fafc !important;
    `;

    // Add custom scrollbar styling
    if (!document.querySelector('#modal-scrollbar-styles')) {
      const style = document.createElement('style');
      style.id = 'modal-scrollbar-styles';
      style.textContent = `
        .modal-body::-webkit-scrollbar {
          width: 6px !important;
        }
        .modal-body::-webkit-scrollbar-track {
          background: #f8fafc !important;
          border-radius: 3px !important;
        }
        .modal-body::-webkit-scrollbar-thumb {
          background: #e5e7eb !important;
          border-radius: 3px !important;
        }
        .modal-body::-webkit-scrollbar-thumb:hover {
          background: #d1d5db !important;
        }
      `;
      document.head.appendChild(style);
    }
  } else {
  }

  // Enable all interactive elements
  const allInteractiveElements = modalElement.querySelectorAll('input, button, select, textarea, .hp-option-card, .btn');
  allInteractiveElements.forEach((input, index) => {
    input.style.pointerEvents = 'auto';
    input.style.zIndex = '100002';
    input.style.position = 'relative';
    input.style.visibility = 'visible';
    input.style.opacity = '1';
  });

  // Add close button functionality
  const closeBtn = modalElement.querySelector('.btn-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideModalWithoutBackdrop(modalElement);
      resetModalForNextUse();
    });
    closeBtn.style.cssText = `
      pointer-events: auto !important;
      z-index: 100005 !important;
      position: relative !important;
      visibility: visible !important;
      opacity: 1 !important;
      cursor: pointer !important;
    `;
  }

  // Add cancel button functionality
  const cancelBtn = modalElement.querySelector('button[data-bs-dismiss="modal"]');
  if (cancelBtn && cancelBtn.id !== 'confirmQuantitySelection') {
    // Remove any existing event listeners to prevent duplicates
    const newCancelBtn = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);

    newCancelBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideModalWithoutBackdrop(modalElement);
      resetModalForNextUse();
    });
    newCancelBtn.style.cssText = `
      pointer-events: auto !important;
      z-index: 100004 !important;
      position: relative !important;
      visibility: visible !important;
      opacity: 1 !important;
      cursor: pointer !important;
    `;
  } else {
  }

  // Also handle any button with text "Cancel" or "Close"
  const allButtons = modalElement.querySelectorAll('button');
  allButtons.forEach(btn => {
    const btnText = btn.textContent.trim().toLowerCase();
    if ((btnText.includes('cancel') || btnText.includes('close')) && btn.id !== 'confirmQuantitySelection') {
      // Remove any existing event listeners
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      newBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideModalWithoutBackdrop(modalElement);
        resetModalForNextUse();
      });
      newBtn.style.cssText = `
        pointer-events: auto !important;
        z-index: 100004 !important;
        position: relative !important;
        visibility: visible !important;
        opacity: 1 !important;
        cursor: pointer !important;
      `;
    }
  });

  // Force body styles
  document.body.classList.add('modal-open');
  document.body.style.overflow = 'hidden';
  document.body.style.marginRight = ''; // Clear any scrollbar compensation

  // Add CSS animations to head if not present
  if (!document.querySelector('#enterprise-modal-animations')) {
    const style = document.createElement('style');
    style.id = 'enterprise-modal-animations';
    style.textContent = `
      @keyframes fadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      @keyframes slideUp {
        from { transform: translateY(30px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  // Continuous backdrop cleanup
  const cleanupInterval = setInterval(() => {
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.remove());
  }, 100);

  modalElement._cleanupInterval = cleanupInterval;

  // PROFESSIONAL QUANTITY BUTTONS OVERRIDE - Fix for non-HP services
  setupQuantityButtonOverride(modalElement);

  console.log('Modal element visibility check:', {
    display: window.getComputedStyle(modalElement).display,
    visibility: window.getComputedStyle(modalElement).visibility,
    opacity: window.getComputedStyle(modalElement).opacity,
    zIndex: window.getComputedStyle(modalElement).zIndex
  });

  // Debug: Log modal HTML structure
}

/**
 * PROFESSIONAL QUANTITY BUTTON OVERRIDE - Ensures quantity buttons work for non-HP services
 */
function setupQuantityButtonOverride(modalElement) {

  // Find quantity controls in the modal
  const decreaseBtn = modalElement.querySelector('#quantityModalDecrease');
  const increaseBtn = modalElement.querySelector('#quantityModalIncrease');
  const quantityInput = modalElement.querySelector('#quantityModalInput');

  console.log('Quantity control elements found:', {
    decreaseBtn: !!decreaseBtn,
    increaseBtn: !!increaseBtn,
    quantityInput: !!quantityInput
  });

  // Setup decrease button
  if (decreaseBtn) {

    // Remove existing listeners by cloning
    const newDecreaseBtn = decreaseBtn.cloneNode(true);
    decreaseBtn.parentNode.replaceChild(newDecreaseBtn, decreaseBtn);

    // Add professional styling
    newDecreaseBtn.style.cssText = `
      pointer-events: auto !important;
      z-index: 100005 !important;
      position: relative !important;
      opacity: 1 !important;
      visibility: visible !important;
      display: inline-block !important;
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%) !important;
      border: none !important;
      border-radius: 8px 0 0 8px !important;
      min-width: 50px !important;
      color: white !important;
      font-weight: bold !important;
      font-size: 1.2rem !important;
      transition: all 0.2s ease !important;
    `;

    // Add click handler
    newDecreaseBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();

      const currentValue = parseInt(quantityInput?.value || 1);
      if (currentValue > 1) {
        const newValue = currentValue - 1;
        quantityInput.value = newValue;

        // Visual feedback
        quantityInput.style.transform = 'scale(1.1)';
        quantityInput.style.backgroundColor = '#fee2e2';
        setTimeout(() => {
          quantityInput.style.transform = 'scale(1)';
          quantityInput.style.backgroundColor = '#f8f9fa';
        }, 200);

        // Update price
        updateCombinedPrice();
      } else {
        // Error feedback
        newDecreaseBtn.style.transform = 'scale(0.95)';
        setTimeout(() => {
          newDecreaseBtn.style.transform = 'scale(1)';
        }, 200);
      }
    };

    // Hover effects
    newDecreaseBtn.onmouseenter = function () {
      this.style.transform = 'scale(1.05)';
      this.style.boxShadow = '0 4px 12px rgba(239, 68, 68, 0.4)';
    };
    newDecreaseBtn.onmouseleave = function () {
      this.style.transform = 'scale(1)';
      this.style.boxShadow = 'none';
    };

  }

  // Setup increase button
  if (increaseBtn) {

    // Remove existing listeners by cloning
    const newIncreaseBtn = increaseBtn.cloneNode(true);
    increaseBtn.parentNode.replaceChild(newIncreaseBtn, increaseBtn);

    // Add professional styling
    newIncreaseBtn.style.cssText = `
      pointer-events: auto !important;
      z-index: 100005 !important;
      position: relative !important;
      opacity: 1 !important;
      visibility: visible !important;
      display: inline-block !important;
      background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%) !important;
      border: none !important;
      border-radius: 0 8px 8px 0 !important;
      min-width: 50px !important;
      color: white !important;
      font-weight: bold !important;
      font-size: 1.2rem !important;
      transition: all 0.2s ease !important;
    `;

    // Add click handler
    newIncreaseBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();

      const currentValue = parseInt(quantityInput?.value || 1);
      if (currentValue < 20) {
        const newValue = currentValue + 1;
        quantityInput.value = newValue;

        // Visual feedback
        quantityInput.style.transform = 'scale(1.1)';
        quantityInput.style.backgroundColor = '#dcfce7';
        setTimeout(() => {
          quantityInput.style.transform = 'scale(1)';
          quantityInput.style.backgroundColor = '#f8f9fa';
        }, 200);

        // Update price
        updateCombinedPrice();
      } else {
        // Error feedback
        newIncreaseBtn.style.transform = 'scale(0.95)';
        setTimeout(() => {
          newIncreaseBtn.style.transform = 'scale(1)';
        }, 200);
      }
    };

    // Hover effects
    newIncreaseBtn.onmouseenter = function () {
      this.style.transform = 'scale(1.05)';
      this.style.boxShadow = '0 4px 12px rgba(34, 197, 94, 0.4)';
    };
    newIncreaseBtn.onmouseleave = function () {
      this.style.transform = 'scale(1)';
      this.style.boxShadow = 'none';
    };

  }

  // Setup quantity input styling
  if (quantityInput) {

    quantityInput.style.cssText = `
      pointer-events: auto !important;
      z-index: 100005 !important;
      position: relative !important;
      background: #f8f9fa !important;
      border: none !important;
      font-size: 1.1rem !important;
      font-weight: bold !important;
      text-align: center !important;
      transition: all 0.2s ease !important;
    `;

    // Add change listener
    quantityInput.onchange = function () {
      let value = parseInt(this.value);
      if (isNaN(value) || value < 1) value = 1;
      if (value > 20) value = 20;
      this.value = value;
      updateCombinedPrice();
    };

  }

  // Also setup HP card quantity controls if they exist
  setupHpCardQuantityOverrides(modalElement);

}

/**
 * Setup HP card quantity controls override
 */
function setupHpCardQuantityOverrides(modalElement) {

  const hpCards = modalElement.querySelectorAll('.hp-selection-card');

  hpCards.forEach((card, index) => {
    const hpValue = card.dataset.hp;
    const decreaseBtn = card.querySelector('.quantity-decrease');
    const increaseBtn = card.querySelector('.quantity-increase');
    const quantityInput = card.querySelector('.hp-quantity-input');
    const quantityPrice = card.querySelector('.quantity-price');

    if (!decreaseBtn || !increaseBtn || !quantityInput) {
      return;
    }


    // Get HP pricing data
    const hpPrice = parseInt(card.dataset.price) || 0;

    // Setup decrease button
    const newDecreaseBtn = decreaseBtn.cloneNode(true);
    decreaseBtn.parentNode.replaceChild(newDecreaseBtn, decreaseBtn);

    newDecreaseBtn.style.cssText = `
      pointer-events: auto !important;
      z-index: 100006 !important;
      position: relative !important;
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%) !important;
      border: 2px solid #3b82f6 !important;
      border-radius: 8px 0 0 8px !important;
      min-width: 45px !important;
      color: white !important;
      font-weight: bold !important;
      transition: all 0.2s ease !important;
    `;

    newDecreaseBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();

      const currentValue = parseInt(quantityInput.value);
      if (currentValue > 1) {
        const newValue = currentValue - 1;
        quantityInput.value = newValue;

        // Update price display
        if (quantityPrice) {
          const total = hpPrice * newValue;
          quantityPrice.textContent = `₱${total.toLocaleString()} per unit`;
        }

        // Visual feedback
        quantityInput.style.transform = 'scale(1.1)';
        quantityInput.style.backgroundColor = '#dbeafe';
        setTimeout(() => {
          quantityInput.style.transform = 'scale(1)';
          quantityInput.style.backgroundColor = '#f8f9fa';
        }, 200);

        // Update state
        updateHpQuantity(hpValue, newValue);
      }
    };

    // Setup increase button
    const newIncreaseBtn = increaseBtn.cloneNode(true);
    increaseBtn.parentNode.replaceChild(newIncreaseBtn, increaseBtn);

    newIncreaseBtn.style.cssText = `
      pointer-events: auto !important;
      z-index: 100006 !important;
      position: relative !important;
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%) !important;
      border: 2px solid #3b82f6 !important;
      border-radius: 0 8px 8px 0 !important;
      min-width: 45px !important;
      color: white !important;
      font-weight: bold !important;
      transition: all 0.2s ease !important;
    `;

    newIncreaseBtn.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();

      const currentValue = parseInt(quantityInput.value);
      if (currentValue < 20) {
        const newValue = currentValue + 1;
        quantityInput.value = newValue;

        // Update price display
        if (quantityPrice) {
          const total = hpPrice * newValue;
          quantityPrice.textContent = `₱${total.toLocaleString()} per unit`;
        }

        // Visual feedback
        quantityInput.style.transform = 'scale(1.1)';
        quantityInput.style.backgroundColor = '#dbeafe';
        setTimeout(() => {
          quantityInput.style.transform = 'scale(1)';
          quantityInput.style.backgroundColor = '#f8f9fa';
        }, 200);

        // Update state
        updateHpQuantity(hpValue, newValue);
      }
    };

    // Style input
    quantityInput.style.cssText = `
      pointer-events: auto !important;
      z-index: 100006 !important;
      position: relative !important;
      background: #f8f9fa !important;
      border: 2px solid #e5e7eb !important;
      font-size: 1rem !important;
      font-weight: bold !important;
      text-align: center !important;
      transition: all 0.2s ease !important;
    `;

  });

}

/**
 * Update HP quantity in the selected array
 */
function updateHpQuantity(hp, quantity) {

  const hpSelection = BookingState.selectedHps.find(hpItem => hpItem.hp === parseFloat(hp));
  if (hpSelection) {
    const oldQuantity = hpSelection.quantity;
    hpSelection.quantity = quantity;
    console.log('Updated HP quantity:', {
      hp: hpSelection.hp,
      oldQuantity: oldQuantity,
      newQuantity: quantity,
      price: hpSelection.price
    });
    updateCombinedPrice();
  } else {
  }
}

/**
 * Show modal without any backdrop to prevent gray overlay
 */
function showModalWithoutBackdrop(modalElement) {
  // Remove ALL existing backdrops and overlays
  const existingBackdrops = document.querySelectorAll('.modal-backdrop');
  existingBackdrops.forEach(backdrop => backdrop.remove());

  // Remove any overlay divs that might be causing gray overlay
  const overlays = document.querySelectorAll('[style*="position: fixed"], [style*="position: absolute"]');
  overlays.forEach(overlay => {
    if (overlay.style.zIndex && parseInt(overlay.style.zIndex) > 1000) {
      overlay.remove();
    }
  });

  // Prevent Bootstrap from creating backdrop
  modalElement.setAttribute('data-bs-backdrop', 'false');
  modalElement.setAttribute('data-bs-keyboard', 'false');

  // Show modal with highest z-index and NO backdrop
  modalElement.style.display = 'block';
  modalElement.classList.add('show');
  modalElement.style.cssText = `
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    z-index: 9999 !important;
    width: 100% !important;
    height: 100% !important;
    overflow: hidden !important;
    outline: 0 !important;
    pointer-events: auto !important;
    background-color: rgba(0,0,0,0.3) !important;
  `;

  // Ensure dialog is fully interactive and centered
  const dialog = modalElement.querySelector('.modal-dialog');
  if (dialog) {
    dialog.style.cssText = `
      position: relative !important;
      width: auto !important;
      margin: 1rem auto !important;
      pointer-events: auto !important;
      z-index: 10000 !important;
      transform: none !important;
      max-width: 500px !important;
    `;
  }

  // Ensure all modal content is interactive
  const modalContent = modalElement.querySelector('.modal-content');
  if (modalContent) {
    modalContent.style.cssText = `
      position: relative !important;
      z-index: 10001 !important;
      pointer-events: auto !important;
      background-color: white !important;
      border-radius: 8px !important;
      box-shadow: 0 10px 30px rgba(0,0,0,0.3) !important;
    `;
  }

  // Enable all form elements
  const inputs = modalElement.querySelectorAll('input, button, select, textarea, .hp-option-card, .btn');
  inputs.forEach(input => {
    input.style.pointerEvents = 'auto';
    input.style.zIndex = '10002';
    input.style.position = 'relative';
  });

  // Specifically fix modal footer buttons
  const modalFooter = modalElement.querySelector('.modal-footer');
  if (modalFooter) {
    modalFooter.style.cssText = `
      position: relative !important;
      z-index: 10003 !important;
      pointer-events: auto !important;
      background-color: white !important;
      border-top: 1px solid #dee2e6 !important;
      padding: 1rem !important;
    `;

    const footerButtons = modalFooter.querySelectorAll('button');
    footerButtons.forEach(btn => {
      btn.style.cssText = `
        pointer-events: auto !important;
        z-index: 10004 !important;
        position: relative !important;
        opacity: 1 !important;
        visibility: visible !important;
        display: inline-block !important;
      `;
    });
  }

  document.body.classList.add('modal-open');
  document.body.style.overflow = 'hidden';

  // Add continuous cleanup to prevent Bootstrap interference
  const cleanupInterval = setInterval(() => {
    const backdrops = document.querySelectorAll('.modal-backdrop');
    backdrops.forEach(backdrop => backdrop.remove());
  }, 100);

  // Store interval ID for cleanup
  modalElement._cleanupInterval = cleanupInterval;

}

/**
 * Show HP selection modal - Enterprise Edition
 */
function showHpModal(service, quantity) {

  if (!DOM.hpModalServiceName || !DOM.hpModalOptions) {
    showError('Unable to show HP selection');
    return;
  }


  // Store current service and quantity
  BookingState.currentService = service;
  BookingState.currentQuantity = quantity;

  DOM.hpModalServiceName.textContent = service.name;
  DOM.hpModalQuantity.textContent = quantity;

  // Clear existing HP options
  DOM.hpModalOptions.innerHTML = '';

  // Render professional HP options
  service.hpPricing.forEach((hpOption, index) => {

    const hpCol = document.createElement('div');
    hpCol.className = 'col-12 mb-3';

    const hpCard = document.createElement('div');
    hpCard.className = 'card hp-selection-card border-2 bg-white shadow-sm';
    hpCard.dataset.hp = hpOption.hp;
    hpCard.dataset.price = hpOption.price;
    hpCard.dataset.description = hpOption.description;
    hpCard.dataset.selected = 'false';
    hpCard.style.cssText = `
      border-radius: 12px !important;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
      border-color: #e5e7eb !important;
      cursor: pointer !important;
      position: relative !important;
      overflow: hidden !important;
    `;

    hpCard.innerHTML = `
      <div class="card-body p-4">
        <div class="text-center">
          <div class="d-flex align-items-center justify-content-center mb-3">
            <span class="badge bg-primary bg-gradient rounded-pill px-3 py-2 me-2">
              ${hpOption.hp} HP
            </span>
            <div class="text-primary fw-bold fs-5">₱${hpOption.price.toLocaleString()}</div>
          </div>
          <div class="text-muted small">
            <i class="bi bi-clock me-1"></i>
            ${hpOption.durationMinutes || 60} minutes
          </div>
          ${hpOption.description ? `<div class="text-muted small mt-2">${hpOption.description}</div>` : ''}
          <div class="text-muted small mt-3">
            Total: <span class="hp-total-price fw-bold text-primary">₱${(hpOption.price * quantity).toLocaleString()}</span>
            <br><small>(₱${hpOption.price.toLocaleString()} × ${quantity} units)</small>
          </div>
        </div>
      </div>
    `;

    // Add click event listener
    hpCard.addEventListener('click', () => {

      // Remove previous selection
      document.querySelectorAll('.hp-selection-card').forEach(card => {
        card.classList.remove('selected');
        card.style.cssText = `
          border-radius: 12px !important;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1) !important;
          border-color: #e5e7eb !important;
          cursor: pointer !important;
          position: relative !important;
          overflow: hidden !important;
          transform: translateY(0) !important;
        `;
      });

      // Add selection styling
      hpCard.classList.add('selected');
      hpCard.style.cssText += `
        border-color: #3b82f6 !important;
        background: linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%) !important;
        box-shadow: 0 4px 20px rgba(59, 130, 246, 0.15) !important;
        transform: translateY(-2px) !important;
      `;

      // Store selected HP
      BookingState.selectedHp = hpOption;

      // Update price display
      updateHpModalPrice();
    });

    DOM.hpModalOptions.appendChild(hpCol);
  });


  // Show modal with enterprise styling
  showEnterpriseHpModal();
}

/**
 * Show enterprise-level HP modal
 */
function showEnterpriseHpModal() {
  const modalElement = DOM.hpModal;

  if (!modalElement) {
    showError('HP modal not found');
    return;
  }


  // Remove ALL existing backdrops and overlays
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.remove());
  document.querySelectorAll('[style*="position: fixed"], [style*="position: absolute"]').forEach(overlay => {
    if (overlay.style.zIndex && parseInt(overlay.style.zIndex) > 1000) {
      overlay.remove();
    }
  });

  // Prevent Bootstrap interference
  modalElement.setAttribute('data-bs-backdrop', 'false');
  modalElement.setAttribute('data-bs-keyboard', 'false');

  // Force modal to be visible with aggressive styling
  modalElement.style.display = 'block';
  modalElement.classList.add('show');
  modalElement.classList.remove('hide');

  // Enterprise modal styling
  modalElement.style.cssText = `
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    z-index: 99999 !important;
    width: 100% !important;
    height: 100% !important;
    overflow: auto !important;
    outline: 0 !important;
    pointer-events: auto !important;
    background: rgba(0, 0, 0, 0.6) !important;
    backdrop-filter: blur(8px) !important;
    animation: fadeIn 0.3s ease-out !important;
    display: flex !important;
    visibility: visible !important;
    opacity: 1 !important;
    align-items: center !important;
    justify-content: center !important;
    padding: 2rem 1rem !important;
  `;

  // Professional dialog styling
  const dialog = modalElement.querySelector('.modal-dialog');
  if (dialog) {
    dialog.style.cssText = `
      position: relative !important;
      width: auto !important;
      margin: 0 !important;
      pointer-events: auto !important;
      z-index: 100000 !important;
      transform: none !important;
      max-width: 700px !important;
      max-height: 90vh !important;
      animation: slideUp 0.4s cubic-bezier(0.4, 0, 0.2, 1) !important;
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      flex-direction: column !important;
    `;
  }

  // Professional content styling
  const modalContent = modalElement.querySelector('.modal-content');
  if (modalContent) {
    modalContent.style.cssText = `
      position: relative !important;
      z-index: 100001 !important;
      pointer-events: auto !important;
      background: white !important;
      border-radius: 16px !important;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25) !important;
      border: none !important;
      overflow: hidden !important;
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      flex-direction: column !important;
      max-height: 90vh !important;
    `;
  }

  // Make modal body scrollable
  const modalBody = modalElement.querySelector('.modal-body');
  if (modalBody) {
    modalBody.style.cssText = `
      position: relative !important;
      z-index: 100002 !important;
      pointer-events: auto !important;
      overflow-y: auto !important;
      overflow-x: hidden !important;
      flex-grow: 1 !important;
      padding: 1.5rem !important;
      max-height: calc(90vh - 200px) !important;
      scrollbar-width: thin !important;
      scrollbar-color: #e5e7eb #f8fafc !important;
    `;
  }

  // Professional footer styling
  const modalFooter = modalElement.querySelector('.modal-footer');
  if (modalFooter) {
    modalFooter.style.cssText = `
      position: relative !important;
      z-index: 100003 !important;
      background: linear-gradient(to bottom, #ffffff, #f8fafc) !important;
      border-top: 1px solid #e5e7eb !important;
      padding: 1.5rem !important;
      pointer-events: auto !important;
      display: flex !important;
      visibility: visible !important;
      opacity: 1 !important;
      justify-content: flex-end !important;
      gap: 0.75rem !important;
      flex-shrink: 0 !important;
      border-radius: 0 0 16px 16px !important;
    `;

    const footerButtons = modalFooter.querySelectorAll('button');
    footerButtons.forEach((btn, index) => {
      if (btn.id === 'confirmHpSelection') {
        btn.style.cssText = `
          pointer-events: auto !important;
          z-index: 100004 !important;
          position: relative !important;
          opacity: 1 !important;
          visibility: visible !important;
          display: inline-block !important;
          background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%) !important;
          border: none !important;
          border-radius: 12px !important;
          padding: 0.75rem 2rem !important;
          font-weight: 600 !important;
          font-size: 1rem !important;
          box-shadow: 0 4px 14px rgba(59, 130, 246, 0.4) !important;
          transition: all 0.2s ease !important;
          color: white !important;
        `;
      } else {
        btn.style.cssText = `
          pointer-events: auto !important;
          z-index: 100004 !important;
          position: relative !important;
          opacity: 1 !important;
          visibility: visible !important;
          display: inline-block !important;
          background: #f3f4f6 !important;
          border: 1px solid #d1d5db !important;
          border-radius: 12px !important;
          padding: 0.75rem 2rem !important;
          font-weight: 600 !important;
          color: #374151 !important;
          transition: all 0.2s ease !important;
        `;
      }
    });
  }

  // Enable all interactive elements
  const allInteractiveElements = modalElement.querySelectorAll('input, button, select, textarea, .hp-option-card, .btn');
  allInteractiveElements.forEach((input) => {
    input.style.pointerEvents = 'auto';
    input.style.zIndex = '100002';
    input.style.position = 'relative';
    input.style.visibility = 'visible';
    input.style.opacity = '1';
  });

  // Force body styles
  document.body.classList.add('modal-open');
  document.body.style.overflow = 'hidden';
  document.body.style.marginRight = '';

}

/**
 * Update HP modal price display
 */
function updateHpModalPrice() {

  const selectedHp = BookingState.selectedHp;
  const quantity = BookingState.currentQuantity || 1;

  if (selectedHp) {
    const totalPrice = selectedHp.price * quantity;
    console.log('Updating HP price display:', {
      hp: selectedHp.hp,
      price: selectedHp.price,
      quantity: quantity,
      total: totalPrice
    });

    // Update all price displays in the modal
    document.querySelectorAll('.hp-total-price').forEach(element => {
      if (element.closest('.hp-selection-card').dataset.hp === selectedHp.hp.toString()) {
        element.textContent = `₱${totalPrice.toLocaleString()}`;
      }
    });

    // Enable confirm button
    const confirmBtn = document.getElementById('confirmHpSelection');
    if (confirmBtn) {
      confirmBtn.disabled = false;
    }
  } else {
    const confirmBtn = document.getElementById('confirmHpSelection');
    if (confirmBtn) {
      confirmBtn.disabled = true;
    }
  }
}
function updateCombinedPrice() {

  if (!DOM.quantityModalEstimatedPrice) {
    return;
  }

  const service = BookingState.currentService;
  if (!service) {
    return;
  }


  let totalPrice = 0;
  let priceText = '';

  // Check if service has aircon types (new structure) or legacy HP pricing
  const hasAirconTypes = service.isAirconService && service.airconTypes && service.airconTypes.length > 0;
  const hasLegacyHpPricing = service.isAirconService && service.hpPricing && service.hpPricing.length > 0;
  const isAirconService = hasAirconTypes || hasLegacyHpPricing;


  if (isAirconService) {

    // Calculate price based on selected HPs
    if (BookingState.selectedHps && BookingState.selectedHps.length > 0) {

      // Calculate total price (price × quantity for each HP)
      totalPrice = BookingState.selectedHps.reduce((sum, hpSelection) => {
        const hpTotal = hpSelection.price * hpSelection.quantity;
        const typeLabel = hpSelection.airconTypeName || '';
        return sum + hpTotal;
      }, 0);

      // Show only total price - NO HP BREAKDOWN
      priceText = `₱${totalPrice.toLocaleString()}`;
      const footerHint = document.getElementById('quantityModalFooterHint');
      if (footerHint) footerHint.textContent = '';


    } else {
      priceText = '₱0';
    }
  } else {

    // Regular service pricing
    const quantity = parseInt(DOM.quantityModalInput?.value || 1);
    const basePrice = service.basePrice || service.price || 0;
    totalPrice = basePrice * quantity;
    priceText = `₱${totalPrice.toLocaleString()}`;
  }

  // Update price display
  DOM.quantityModalEstimatedPrice.textContent = priceText;

  // Enable/disable confirm button based on selection
  const confirmBtn = DOM.confirmQuantitySelection;
  if (confirmBtn) {
    if (isAirconService) {
      const shouldDisable = !BookingState.selectedHps || BookingState.selectedHps.length === 0;
      // AGGRESSIVE FIX: Don't disable the button, just show error on click instead
      // This ensures the button is always clickable
      confirmBtn.disabled = false; // Always enable for aircon services
      confirmBtn.dataset.requiresHp = shouldDisable ? 'true' : 'false'; // Mark if HP is required
    } else {
      const quantity = parseInt(DOM.quantityModalInput?.value || 0);
      confirmBtn.disabled = quantity < 1 || quantity > 20;
      confirmBtn.dataset.requiresHp = 'false';
    }

    // AGGRESSIVE FIX: Ensure button is visible and clickable
    confirmBtn.style.pointerEvents = 'auto';
    confirmBtn.style.zIndex = '100004';
    confirmBtn.style.position = 'relative';
    confirmBtn.style.visibility = 'visible';
    confirmBtn.style.opacity = '1';
  }
}

/**
 * Handle HP option selection
 */
function selectHpOption(event) {
  const hpCard = event.currentTarget;


  // Remove previous selection
  document.querySelectorAll('#hpOptionsContainer .hp-option-card').forEach(card => {
    card.classList.remove('border-primary', 'bg-primary', 'text-white');
    card.classList.add('bg-light');
  });

  // Add selection to current card
  hpCard.classList.remove('bg-light');
  hpCard.classList.add('border-primary', 'bg-primary', 'text-white');

  // Update price
  updateCombinedPrice();
}

/**
 * Confirm HP selection
 */
function confirmHpSelection() {
  if (!DOM.hpModalOptions) {
    showError('Unable to confirm HP selection');
    return;
  }

  const selectedHpCard = DOM.hpModalOptions.querySelector('.hp-option-card.border-primary');

  if (!selectedHpCard) {
    showError('Please select an HP rating');
    return;
  }

  const hpData = {
    hp: parseFloat(selectedHpCard.dataset.hp),
    price: parseInt(selectedHpCard.dataset.price),
    description: selectedHpCard.dataset.description
  };

  // Add service with HP selection
  addServiceToBooking(BookingState.currentService, parseInt(DOM.quantityModalInput?.value || 1), hpData);

  // Close modal
  try {
    BookingState.ui.modals.hp?.hide();
  } catch (error) {
  }
}

/**
 * Confirm quantity selection
 */
function confirmQuantitySelection() {

  // PREVENT DUPLICATE EXECUTION - But with a timeout fail-safe
  if (confirmQuantitySelection._isProcessing) {
    const timeSinceStart = Date.now() - (confirmQuantitySelection._processingStartTime || 0);
    if (timeSinceStart < 1000) { // If it's been less than 1 second, it's a duplicate click
      return;
    } else {
    }
  }

  confirmQuantitySelection._isProcessing = true;
  confirmQuantitySelection._processingStartTime = Date.now();

  // Ensure flag is always reset when function exits
  const resetProcessingFlag = () => {
    confirmQuantitySelection._isProcessing = false;
    confirmQuantitySelection._processingStartTime = null;
  };

  let service = BookingState.currentService;

  // AGGRESSIVE FIX: If service not in state, try to get from button
  if (!service) {
    const modal = DOM.quantityModal;
    if (modal) {
      const addToCartBtn = modal.querySelector('#confirmQuantitySelection');
      if (addToCartBtn && addToCartBtn.dataset.serviceJson) {
        try {
          service = JSON.parse(addToCartBtn.dataset.serviceJson);
          // Restore to BookingState for future use
          BookingState.currentService = service;
        } catch (e) {
        }
      } else {
      }
    }
  }

  if (!service) {
    showError('Service not found. Please close the modal and try again.');
    resetProcessingFlag();
    return;
  }


  // Check if service has aircon types (new structure) or legacy HP pricing
  const hasAirconTypes = service.isAirconService && service.airconTypes && service.airconTypes.length > 0;
  const hasLegacyHpPricing = service.isAirconService && service.hpPricing && service.hpPricing.length > 0;
  const isAirconService = hasAirconTypes || hasLegacyHpPricing;

  // DEBUG: Log the current state for troubleshooting

  // Get repair issue description if it's a repair service
  let repairIssueDescription = '';
  if (service.type === 'repair' || service.type === 'repairServices') {
    const issueTextarea = document.getElementById('repairIssueDescription');
    if (issueTextarea) {
      repairIssueDescription = issueTextarea.value.trim();
    }
  }

  if (isAirconService) {

    // Refresh selected brand from the DOM (select or custom input)
    const brandSelect = document.getElementById('brandInput');
    const brandCustom = document.getElementById('brandInputCustom');
    const brandFromDom = (brandCustom && !brandCustom.classList.contains('d-none') && brandCustom.value.trim())
      ? brandCustom.value.trim()
      : (brandSelect ? brandSelect.value.trim() : '');
    BookingState.selectedBrand = brandFromDom;
    if (!BookingState.selectedBrand) {
      const brandSection = document.getElementById('brandSection');
      if (brandSection) {
        brandSection.classList.add('border', 'border-danger', 'rounded', 'p-2');
        setTimeout(() => brandSection.classList.remove('border', 'border-danger', 'rounded', 'p-2'), 2500);
      }
      const brandLabel = document.querySelector('label[for="brandInput"]');
      if (brandLabel) {
        brandLabel.classList.add('text-danger');
        setTimeout(() => brandLabel.classList.remove('text-danger'), 2500);
      }
      showModalError('Please select or enter a brand name before adding to booking.');
      const banner = document.getElementById('modalErrorBanner');
      if (banner && banner.scrollIntoView) banner.scrollIntoView({ block: 'nearest' });
      resetProcessingFlag();
      return;
    }

    // AGGRESSIVE FIX: If selectedHps is empty, scan DOM for selected HPs
    if (!BookingState.selectedHps || BookingState.selectedHps.length === 0) {

      const modal = DOM.quantityModal;
      if (modal) {
        const checkedBoxes = modal.querySelectorAll('.hp-checkbox:checked');

        checkedBoxes.forEach(checkbox => {
          const card = checkbox.closest('.hp-selection-card');
          if (card) {
            const hp = parseFloat(checkbox.value);
            const price = parseInt(checkbox.dataset.price);
            const type = checkbox.dataset.type || 'split';
            const typeName = card.querySelector('.badge.bg-info')?.textContent || 'Standard';
            const quantityInput = card.querySelector('.hp-quantity-input');
            const quantity = quantityInput ? parseInt(quantityInput.value) : 1;

            const hpSelection = {
              hp: hp,
              price: price,
              quantity: quantity,
              description: card.dataset.description || '',
              airconType: type,
              airconTypeName: typeName
            };


            // Add to state
            if (!BookingState.selectedHps) {
              BookingState.selectedHps = [];
            }
            BookingState.selectedHps.push(hpSelection);
          }
        });
      }
    }

    // Validate HP selections
    if (!BookingState.selectedHps || BookingState.selectedHps.length === 0) {
      showError('Please select at least one HP rating');
      resetProcessingFlag();
      return;
    }

    // Additional check: verify at least one HP has quantity > 0
    const hasValidSelection = BookingState.selectedHps.some(hp => hp.quantity > 0);

    if (!hasValidSelection) {
      showError('Please select at least one HP rating with quantity greater than 0');
      resetProcessingFlag();
      return;
    }


    // Add each selected HP as a separate service item
    BookingState.selectedHps.forEach(hpSelection => {
      if (hpSelection.quantity > 0) {
        console.log('Adding HP selection to cart:', {
          service: service.name,
          quantity: hpSelection.quantity,
          hp: hpSelection.hp,
          price: hpSelection.price,
          type: hpSelection.airconType,
          typeName: hpSelection.airconTypeName
        });

        addServiceToBooking(service, hpSelection.quantity, {
          hp: hpSelection.hp,
          price: hpSelection.price,
          description: hpSelection.description,
          airconType: hpSelection.airconType,
          airconTypeName: hpSelection.airconTypeName
        });
      }
    });
  } else {

    // Regular service validation
    if (!DOM.quantityModalInput) {
      showError('Unable to confirm service selection');
      resetProcessingFlag();
      return;
    }

    const quantity = parseInt(DOM.quantityModalInput.value);

    if (isNaN(quantity) || quantity < 1 || quantity > 20) {
      showError('Please enter a valid quantity (1-20)');
      resetProcessingFlag();
      return;
    }

    console.log('Adding non-HP service with quantity:', {
      service: service.name,
      quantity: quantity,
      basePrice: service.basePrice || service.initialPrice || service.price
    });

    // Add service directly with quantity - use initialPrice for repair services, basePrice for others
    const unitPrice = service.initialPrice || service.basePrice || service.price || 0;
    console.log('Service pricing details:', {
      initialPrice: service.initialPrice,
      basePrice: service.basePrice,
      price: service.price,
      finalUnitPrice: unitPrice
    });

    // Pass repair issue description if available
    const serviceData = { price: unitPrice };
    if ((service.type === 'repair' || service.type === 'repairServices') && repairIssueDescription) {
      serviceData.repairIssue = repairIssueDescription;
      // Also set the global repair issue field if it's empty
      if (DOM.repairIssue && !DOM.repairIssue.value) {
        DOM.repairIssue.value = repairIssueDescription;
      }
    }

    addServiceToBooking(service, quantity, serviceData);
  }

  // Clear current service and selected HPs after adding
  BookingState.currentService = null;
  BookingState.selectedHps = [];
  BookingState.selectedAirconType = null;

  // IMPORTANT: Reset the Add to Cart button for next use
  const confirmBtn = document.getElementById('confirmQuantitySelection');
  if (confirmBtn) {
    confirmBtn.removeAttribute('data-listener-attached');
    confirmBtn.disabled = false;
    confirmBtn.style.border = '';
    confirmBtn.title = '';
  }

  // Update the summary section
  try {
    if (typeof updateSelectedServicesSummary === 'function') {
      updateSelectedServicesSummary();
    }
    updateSelectedServicesDisplay();
    updatePricingDisplay();
    updateContinueButtonState();
  } catch (err) {
  }

  // Close quantity modal IMMEDIATELY and forcefully using Bootstrap's API first if available

  if (DOM.quantityModal) {
    // Try to use Bootstrap's API to close it cleanly if initialized
    try {
      if (BookingState.ui.modals.quantity) {
        BookingState.ui.modals.quantity.hide();
      } else {
        const bsModal = bootstrap.Modal.getInstance(DOM.quantityModal);
        if (bsModal) {
          bsModal.hide();
        }
      }
    } catch (e) {
    }

    // Manual fallback to ensure it's hidden no matter what
    setTimeout(() => {
      DOM.quantityModal.style.display = 'none';
      DOM.quantityModal.style.visibility = 'hidden';
      DOM.quantityModal.style.opacity = '0';
      DOM.quantityModal.classList.remove('show');
      DOM.quantityModal.classList.add('hide');

      // Reset all important properties
      DOM.quantityModal.removeAttribute('aria-modal');
      DOM.quantityModal.setAttribute('aria-hidden', 'true');

      // Clean up body styles
      document.body.classList.remove('modal-open');
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';

      // Remove all backdrops
      document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.remove());


      // Reset modal state after closing
      resetModalForNextUse();
    }, 150);
  }

  // Show success feedback with SweetAlert2
  if (typeof Swal !== 'undefined') {
    // Use a toast notification instead of modal to avoid blocking
    Swal.fire({
      icon: 'success',
      title: 'Service Added!',
      text: `${service.name} has been added to your booking`,
      toast: true,
      position: 'top-end',
      showConfirmButton: false,
      timer: 2000,
      timerProgressBar: true,
      didOpen: (toast) => {
        toast.addEventListener('mouseenter', Swal.stopTimer)
        toast.addEventListener('mouseleave', Swal.resumeTimer)
      }
    });
  } else {
    // Fallback if SweetAlert2 not loaded
  }

  // Reset processing flag after completion
  resetProcessingFlag();
}

/**
 * Hide modal without backdrop and clean up properly
 */
function hideModalWithoutBackdrop(modalElement) {

  if (!modalElement) {
    return;
  }

  // Clear the cleanup interval
  if (modalElement._cleanupInterval) {
    clearInterval(modalElement._cleanupInterval);
    modalElement._cleanupInterval = null;
  }

  // Remove ALL backdrops and overlays
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => backdrop.remove());
  document.querySelectorAll('[style*="position: fixed"], [style*="position: absolute"]').forEach(overlay => {
    if (overlay.style.zIndex && parseInt(overlay.style.zIndex) > 1000) {
      // Only remove overlays that are not the modal itself
      if (!overlay.classList.contains('modal')) {
        overlay.remove();
      }
    }
  });

  // Hide the modal properly but don't reset all styles
  modalElement.style.display = 'none';
  modalElement.classList.remove('show');
  modalElement.classList.add('hide');

  // Reset body styles only if no modal is showing
  const showingModals = document.querySelectorAll('.modal.show');
  if (showingModals.length === 0) {
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';
  }

  // Remove aria attributes
  modalElement.removeAttribute('aria-modal');
  modalElement.setAttribute('aria-hidden', 'true');

}

/**
 * Add service to booking
 */
function addServiceToBooking(service, quantity, hpData = null) {
  console.log('Adding service to booking:', {
    service: service.name,
    quantity: quantity,
    hpData: hpData
  });

  const serviceItem = {
    id: generateUniqueId(),
    serviceId: service._id,
    name: service.name,
    type: service.type,
    quantity: quantity,
    unitPrice: hpData ? hpData.price : (service.initialPrice || service.basePrice || service.price || 0),
    totalPrice: (hpData ? hpData.price : (service.initialPrice || service.basePrice || service.price || 0)) * quantity,
    hp: hpData && hpData.hp !== undefined ? hpData.hp : null,
    hpDescription: hpData && hpData.description ? hpData.description : null,
    airconType: hpData && hpData.airconType ? hpData.airconType : null,
    airconTypeName: hpData && hpData.airconTypeName ? hpData.airconTypeName : null,
    applianceType: BookingState.applianceType || (hpData && hpData.airconType) || null,
    applianceTypeName: BookingState.applianceTypeName || null,
    brand: BookingState.selectedBrand || null,
    repairIssue: hpData && hpData.repairIssue ? hpData.repairIssue : null, // Handle individual repair issues
    duration: service.durationMinutes || service.duration || 60,
    icon: service.icon || (service.type === 'repair' ? 'bi-tools' : 'bi-gear-fill'),
    isAirconService: service.isAirconService || false,
    // Initial cost for repair services (technician will update to final cost after diagnosis)
    initialCost: (service.type === 'repair' || service.type === 'repairServices') ?
      (hpData ? hpData.price : (service.initialPrice || service.basePrice || 0)) : null,
    finalCost: null, // To be set by technician after diagnosis
    costUpdatedByTechnician: false,
    diagnosisNotes: null
  };


  // Add to selected services
  BookingState.selectedServices.push(serviceItem);


  // Update UI
  updateSelectedServicesDisplay();
  updatePricingDisplay();
  updateRepairIssueDisplay();
  updateContinueButtonState();

  // Show success feedback
  showSuccess(`${service.name} added to booking`);

  // Note: Auto-advance removed - user must click continue button
}

/**
 * Advance to the next step with smooth transition
 */
function advanceToNextStep() {
  console.log('🔧 advanceToNextStep called');

  // Get current active step
  const visibleStep = document.querySelector('.booking-step.step-active') || document.querySelector('.booking-step:not(.d-none)');
  let currentStep = 1;

  if (visibleStep && visibleStep.dataset.step) {
    currentStep = parseInt(visibleStep.dataset.step);
  }

  const nextStep = currentStep + 1;
  console.log(`📋 Current: ${currentStep}, Next: ${nextStep}`);

  // Validate current step before advancing
  if (!validateStep(currentStep)) {
    console.log(`⚠️ Step ${currentStep} validation failed`);
    return;
  }

  // Use showStep which handles smooth transitions
  showStep(nextStep);

  // Verify it worked
  setTimeout(() => {
    const verifyStep = document.querySelector('.booking-step.step-active');
    if (verifyStep) {
      const verifyNum = parseInt(verifyStep.dataset.step);
      console.log(`✅ Now showing Step ${verifyNum}`);

      if (verifyNum !== nextStep) {
        console.error(`❌ ERROR: Expected Step ${nextStep} but showing Step ${verifyNum}`);
      }
    } else {
      console.error('❌ ERROR: No step is active after navigation!');
    }
  }, 400); // Wait for transition to complete
}

/**
 * Validate current step before allowing advancement
 */
function validateStep(stepNumber) {
  console.log(`🔍 Validating Step ${stepNumber}`);

  switch (stepNumber) {
    case 1:
      // Check if services are selected
      if (BookingState.selectedServices.length === 0) {
        showError('Please select at least one service to continue');
        return false;
      }
      break;

    case 2:
      // Step 2 is service details, auto-advances after selection
      break;

    case 3:
      // Check if location is entered
      if (!BookingState.location || BookingState.location.length < 10) {
        showError('Please enter a valid location (at least 10 characters)');
        return false;
      }
      break;

    case 4:
      // Check if schedule is selected
      const _isProject =
        (EnterpriseCalendar.isProjectMode && EnterpriseCalendar.isProjectMode()) ||
        BookingState.isProject === true ||
        !!BookingState.projectScheduling;
      if (!BookingState.selectedDate || (!_isProject && !BookingState.selectedTimeSlot)) {
        showError(_isProject
          ? 'Please select a start date for your project'
          : 'Please select both date and time for your appointment');
        return false;
      }
      break;

    case 5:
      // Fee step - no validation needed
      break;

    default:
      console.warn(`Unknown step number: ${stepNumber}`);
  }

  console.log(`✅ Step ${stepNumber} validation passed`);
  return true;
}

/**
 * Get current visible booking step
 */
function getCurrentVisibleStep() {
  const visibleStep = document.querySelector('.booking-step.step-active') || document.querySelector('.booking-step:not(.d-none)');

  if (visibleStep) {
    const stepNum = parseInt(visibleStep.dataset.step) || 1;
    return stepNum;
  }

  // Check if any steps exist
  const allSteps = document.querySelectorAll('.booking-step');
  allSteps.forEach((step, i) => {
  });

  return 1;
}

/**
 * Update stepper indicators
 */
function updateStepperIndicators(activeStep) {
  const stepperSteps = document.querySelectorAll('.stepper-step');

  stepperSteps.forEach((step, index) => {
    const stepNumber = parseInt(step.dataset.step) || (index + 1);

    // Remove all classes
    step.classList.remove('active', 'completed');

    // Add appropriate classes
    if (stepNumber < activeStep) {
      step.classList.add('completed');
    } else if (stepNumber === activeStep) {
      step.classList.add('active');
    }
  });

  // Update progress bar if exists
  updateProgressBar(activeStep);
}

/**
 * Update progress bar
 */
function updateProgressBar(activeStep) {
  const progressBar = document.querySelector('.booking-stepper::after');
  if (progressBar) {
    const progress = ((activeStep - 1) / 6) * 100; // Assuming 7 steps total
    document.documentElement.style.setProperty('--stepper-progress', `${progress}%`);
  }
}

/**
 * Update selected services display
 */
function updateSelectedServicesDisplay() {
  if (!DOM.selectedServicesList || !DOM.selectedServiceCount) return;

  DOM.selectedServiceCount.textContent = BookingState.selectedServices.length;

  if (BookingState.selectedServices.length === 0) {
    DOM.selectedServicesList.innerHTML = '<p class="text-muted mb-0">No services selected yet</p>';
  } else {
    const servicesHtml = BookingState.selectedServices.map(service => `
      <div class="selected-service-item d-flex justify-content-between align-items-center mb-2 p-2 bg-white rounded border">
        <div class="d-flex align-items-center">
          <div class="service-icon me-2">
            <i class="${service.icon} fs-5 text-primary"></i>
          </div>
          <div>
            <div class="fw-semibold">${service.name}</div>
            <div class="text-muted small">
              Quantity: ${service.quantity} ${getServiceUnitText(service)}
              ${service.airconTypeName ? `| <span class="badge bg-info bg-opacity-10 text-info">${service.airconTypeName}</span>` : ''}
              ${service.hp ? `| ${service.hp} HP` : ''}
              ${service.hpDescription ? `(${service.hpDescription})` : ''}
            </div>
            ${service.repairIssue ? `
            <div class="text-warning small mt-1" style="max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
              <i class="bi bi-exclamation-triangle-fill me-1"></i>
              Issue: ${service.repairIssue}
            </div>` : ''}
          </div>
        </div>
        <div class="d-flex align-items-center">
          <div class="text-end me-3">
            <div class="fw-bold text-primary">₱${service.totalPrice.toLocaleString()}</div>
            <div class="text-muted small">₱${service.unitPrice.toLocaleString()} each</div>
          </div>
          <button class="btn btn-sm btn-outline-danger remove-service-btn" data-service-id="${service.id}">
            <i class="bi bi-trash"></i>
          </button>
        </div>
      </div>
    `).join('');

    DOM.selectedServicesList.innerHTML = servicesHtml;

    // Add event listeners to remove buttons
    DOM.selectedServicesList.querySelectorAll('.remove-service-btn').forEach(btn => {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();

        const serviceId = this.dataset.serviceId;

        // Find and remove service
        const index = BookingState.selectedServices.findIndex(s => s.id === serviceId);
        if (index > -1) {
          const removedService = BookingState.selectedServices[index];
          BookingState.selectedServices.splice(index, 1);


          // Update UI displays
          updateSelectedServicesDisplay();
          updatePricingDisplay();
          updateContinueButtonState();

          // Show feedback
          showSuccess(`${removedService.name} removed from booking`);
        }
      });
    });
  }

  // Show/hide total pricing section
  const totalPricingSection = document.getElementById('totalPricingSection');
  if (totalPricingSection) {
    if (BookingState.selectedServices.length > 0) {
      totalPricingSection.classList.remove('d-none');
    } else {
      totalPricingSection.classList.add('d-none');
    }
  }
}

/**
 * Remove service from booking
 */
function removeService(serviceId) {
  BookingState.selectedServices = BookingState.selectedServices.filter(s => s.id !== serviceId);
  updateSelectedServicesDisplay();
  updatePricingDisplay();
  updateRepairIssueDisplay();

  if (typeof displayTotalFee === 'function') displayTotalFee();
  if (typeof updateReviewContent === 'function') updateReviewContent();

  showSuccess('Service removed from booking');

  // If no services remain, go back to step 2
  if (BookingState.selectedServices.length === 0) {
    BookingState.scheduleDate = null;
    BookingState.scheduleTime = null;
    BookingState.location = null;
    BookingState.selectedTechnicianId = null;
    if (typeof showStep === 'function') showStep(2);
  }
}

/**
 * Update pricing display
 */
function updatePricingDisplay() {
  if (!DOM.totalEstimatedPrice || !DOM.totalPricingSection) return;

  const total = BookingState.selectedServices.reduce((sum, service) => sum + service.totalPrice, 0);
  BookingState.totalEstimatedPrice = total;

  DOM.totalEstimatedPrice.textContent = `₱${total.toLocaleString()}`;

  if (BookingState.selectedServices.length > 0) {
    DOM.totalPricingSection.classList.remove('d-none');
  } else {
    DOM.totalPricingSection.classList.add('d-none');
  }
}

/**
 * Update repair issue display
 */
function updateRepairIssueDisplay() {
  if (!DOM.repairIssueContainer) return;

  const hasRepairServices = BookingState.selectedServices.some(s => s.type === 'repair');
  BookingState.hasRepairServices = hasRepairServices;

  if (hasRepairServices) {
    DOM.repairIssueContainer.classList.remove('d-none');
  } else {
    DOM.repairIssueContainer.classList.add('d-none');
  }
}

/**
 * Update repair issues in state
 */
function updateRepairIssues() {
  if (DOM.repairIssue) {
    // This will be used when submitting the booking
    DOM.repairIssue.dataset.updated = 'true';
  }
}

/**
 * Quantity control functions
 */
function decreaseQuantity() {
  const current = parseInt(DOM.quantityModalInput.value);
  if (current > 1) {
    DOM.quantityModalInput.value = current - 1;
    updateCombinedPrice();
  }
}

function increaseQuantity() {
  const current = parseInt(DOM.quantityModalInput.value);
  if (current < 20) {
    DOM.quantityModalInput.value = current + 1;
    updateCombinedPrice();
  }
}

function updateQuantityPrice() {
  const quantity = parseInt(DOM.quantityModalInput.value) || 1;
  const service = BookingState.currentService;

  if (!service) return;

  let unitPrice = service.basePrice || service.price || 0;

  // For aircon services, use the minimum HP price as estimate
  if (service.isAirconService && service.hpPricing && service.hpPricing.length > 0) {
    unitPrice = Math.min(...service.hpPricing.map(hp => hp.price));
  }

  const totalPrice = unitPrice * quantity;

  if (DOM.quantityModalPrice) {
    DOM.quantityModalPrice.textContent = `₱${totalPrice.toLocaleString()}`;
  }
}

/**
 * Utility functions
 */
function generateUniqueId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function getServiceUnit(service) {
  if (service.name.toLowerCase().includes('aircon')) return 'aircon';
  if (service.name.toLowerCase().includes('ref')) return 'refrigerator';
  if (service.name.toLowerCase().includes('tv')) return 'TV';
  if (service.name.toLowerCase().includes('washing')) return 'washing machine';
  return 'unit';
}

function getServiceUnitText(service) {
  const unit = getServiceUnit(service);
  return unit === 'aircon' ? 'aircon' : unit;
}

function showError(message) {
  // Show error toast or alert
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      icon: 'error',
      title: 'Error',
      text: message,
      toast: true,
      position: 'top-end',
      showConfirmButton: false,
      timer: 3000
    });
  } else {
    // Fallback to alert
    alert(message);
  }
}

function showModalError(message) {
  const banner = document.getElementById('modalErrorBanner');
  const text = document.getElementById('modalErrorBannerText');
  if (banner && text) {
    text.textContent = message;
    banner.classList.remove('d-none');
    banner.classList.add('d-flex');
  } else {
    showError(message);
  }
}

function clearModalError() {
  const banner = document.getElementById('modalErrorBanner');
  if (banner) {
    banner.classList.add('d-none');
    banner.classList.remove('d-flex');
  }
}

function showSuccess(message) {
  // Show success toast or alert
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      icon: 'success',
      title: 'Success',
      text: message,
      toast: true,
      position: 'top-end',
      showConfirmButton: false,
      timer: 2000
    });
  } else {
    // Fallback to console
  }
}

/**
 * Get booking data for submission
 */
function getBookingData() {
  return {
    services: BookingState.selectedServices,
    totalPrice: BookingState.totalEstimatedPrice,
    repairIssues: BookingState.hasRepairServices && DOM.repairIssue ? DOM.repairIssue.value : '',
    hasRepairServices: BookingState.hasRepairServices
  };
}

/**
 * ========================================
 * PROFESSIONAL STEP 5 SCHEDULING SYSTEM
 * ========================================
 * Complete implementation with:
 * - AI Suggested Dates (3 best dates)
 * - Manual Calendar (full technician schedule)
 * - Smart time slot generation (service duration + travel time)
 * - Booking conflict detection
 * - Professional backend integration
 */

/**
 * Initialize Step 5 scheduling mode buttons
 */
function initializeSchedulingModes() {
  console.log('🔧 initializeSchedulingModes() called');

  let aiSuggestedBtn = document.querySelector('[data-mode="suggested"]');
  let manualCalendarBtn = document.querySelector('[data-mode="manual"]');

  console.log('🔍 Looking for mode buttons:', {
    aiSuggestedBtn: aiSuggestedBtn ? 'Found' : 'Not found',
    manualCalendarBtn: manualCalendarBtn ? 'Found' : 'Not found'
  });

  if (aiSuggestedBtn) {
    // Clone button to remove old event listeners
    const newAiBtn = aiSuggestedBtn.cloneNode(true);
    aiSuggestedBtn.parentNode.replaceChild(newAiBtn, aiSuggestedBtn);
    aiSuggestedBtn = newAiBtn;

    // Add fresh event listener
    aiSuggestedBtn.addEventListener('click', function (e) {
      e.preventDefault();
      console.log('🤖 AI Suggested button clicked!');
      switchSchedulingMode('ai-suggested');
    });

    console.log('✅ AI Suggested button initialized');
  } else {
    console.warn('⚠️ AI Suggested button not found in DOM');
  }

  if (manualCalendarBtn) {
    // Clone button to remove old event listeners
    const newManualBtn = manualCalendarBtn.cloneNode(true);
    manualCalendarBtn.parentNode.replaceChild(newManualBtn, manualCalendarBtn);
    manualCalendarBtn = newManualBtn;

    // Add fresh event listener
    manualCalendarBtn.addEventListener('click', function (e) {
      e.preventDefault();
      console.log('📅 Manual Calendar button clicked!');
      switchSchedulingMode('manual');
    });

    console.log('✅ Manual Calendar button initialized');
  } else {
    console.warn('⚠️ Manual Calendar button not found in DOM');
  }

  console.log('✅ All scheduling mode buttons initialized');
}

/**
 * Show mode selection and hide both scheduling views
 */
function showModeSelection() {
  const modeSelection = document.getElementById('modeSelection');
  const suggestedContainer = document.getElementById('suggestedDates');
  const manualContainer = document.getElementById('manualCalendar');

  // Show mode selection, hide both views
  if (modeSelection) modeSelection.classList.remove('d-none');
  if (suggestedContainer) suggestedContainer.classList.add('d-none');
  if (manualContainer) manualContainer.classList.add('d-none');

  // Reset button states
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.remove('active', 'btn-primary');
    btn.classList.add('btn-outline-primary');
  });

  console.log('🔄 Returned to mode selection');
}

/**
 * Switch between AI Suggested and Manual Calendar modes
 */
function switchSchedulingMode(mode) {
  console.log('🔄 Switching to mode:', mode);

  // Validate technician and service selection
  if (false && !BookingState.selectedTechnicianId) {
    return;
  }

  // Check if service is selected (either selectedServiceId or selectedServices array)
  const hasService = BookingState.selectedServiceId ||
    (BookingState.selectedServices && BookingState.selectedServices.length > 0);

  if (!hasService) {
    console.warn('⚠️ No service selected');
    showError('Please select a service first');
    return;
  }

  // Ensure selectedServiceId is set for API calls
  if (!BookingState.selectedServiceId && BookingState.selectedServices?.length > 0) {
    // Service items store the actual service ID in the 'serviceId' property
    BookingState.selectedServiceId = BookingState.selectedServices[0].serviceId ||
      BookingState.selectedServices[0]._id ||
      BookingState.selectedServices[0].id;
    console.log('📝 Set selectedServiceId from selectedServices:', BookingState.selectedServiceId);
    console.log('📝 First service object:', BookingState.selectedServices[0]);
  }

  // Update active button state
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.classList.remove('active', 'btn-primary');
    btn.classList.add('btn-outline-primary');
  });

  // Highlight the selected button
  const modeValue = mode === 'ai-suggested' ? 'suggested' : 'manual';
  const activeBtn = document.querySelector(`[data-mode="${modeValue}"]`);
  if (activeBtn) {
    activeBtn.classList.remove('btn-outline-primary');
    activeBtn.classList.add('btn-primary', 'active');
  }

  // Store mode in state
  BookingState.schedulingMode = mode;

  console.log('📊 Current state:', {
    technicianId: BookingState.selectedTechnicianId,
    serviceId: BookingState.selectedServiceId,
    mode: mode
  });

  // Render appropriate view
  if (mode === 'ai-suggested') {
    console.log('🤖 Rendering AI suggested dates...');
    renderAISuggestedDates();
  } else {
    console.log('📅 Rendering manual calendar...');
    renderManualCalendar();
  }
}

/**
 * Render AI Suggested Dates (3 best dates)
 */
async function renderAISuggestedDates() {
  const suggestedContainer = document.getElementById('suggestedDates');
  const suggestedCards = document.getElementById('suggestedCards');
  const manualContainer = document.getElementById('manualCalendar');

  if (!suggestedContainer || !suggestedCards) {
    console.warn('⚠️ Suggested dates container not found');
    return;
  }

  // Show suggested, hide manual and mode selection
  const modeSelection = document.getElementById('modeSelection');
  suggestedContainer.classList.remove('d-none');
  if (manualContainer) manualContainer.classList.add('d-none');
  if (modeSelection) modeSelection.classList.add('d-none');

  // Remove any existing change-mode buttons first to avoid duplicates
  suggestedContainer.querySelectorAll('.change-mode-btn-wrapper').forEach(el => el.remove());

  // Add change mode button at the top
  const changeModeBtn = document.createElement('div');
  changeModeBtn.className = 'mb-3 change-mode-btn-wrapper';
  changeModeBtn.innerHTML = `
    <button type="button" class="btn btn-outline-secondary btn-sm" onclick="showModeSelection()">
      <i class="bi bi-arrow-left me-1"></i>Change Scheduling Mode
    </button>
  `;
  suggestedContainer.insertBefore(changeModeBtn, suggestedContainer.firstChild);

  // Show loading
  suggestedCards.innerHTML = `
    <div class="col-12">
      <div class="text-center py-4">
        <div class="spinner-border text-primary mb-3" role="status">
          <span class="visually-hidden">Loading...</span>
        </div>
        <p class="text-muted">Finding best available dates...</p>
      </div>
    </div>
  `;

  try {
    // Fetch AI suggested dates from backend
    const response = await fetch(
      `/api/schedule/available-dates?technicianId=${BookingState.selectedTechnicianId}&serviceId=${BookingState.selectedServiceId}&mode=ai-suggested`
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    console.log('🤖 AI Suggested dates received:', data);

    suggestedCards.innerHTML = '';

    if (!data.availableDates || data.availableDates.length === 0) {
      suggestedCards.innerHTML = `
        <div class="col-12">
          <div class="alert alert-warning">
            <i class="bi bi-exclamation-triangle me-2"></i>
            No available dates found. Please try manual calendar or contact support.
          </div>
        </div>
      `;
      return;
    }

    // Display top 3 dates
    const labels = ['Best Match', 'Great Option', 'Good Choice'];
    const colors = ['#28a745', '#17a2b8', '#ffc107'];

    data.availableDates.slice(0, 3).forEach((dateInfo, index) => {
      const col = document.createElement('div');
      col.className = 'col-md-4 mb-3';

      col.innerHTML = `
        <div class="card h-100 shadow-sm suggested-date-card" role="button" tabindex="0" data-date="${dateInfo.date}">
          <div class="card-body text-center">
            <div class="d-flex justify-content-between align-items-center mb-3">
              <span class="badge" style="background-color: ${colors[index]}20; color: ${colors[index]}; font-size: 0.75rem;">
                ${labels[index]}
              </span>
              <span class="badge bg-secondary">${dateInfo.availableSlots || 0} slots</span>
            </div>
            <div class="mb-3">
              <div class="display-4 fw-bold text-primary">${dateInfo.dayOfMonth}</div>
              <div class="h5 text-muted mb-1">${dateInfo.month}</div>
              <div class="text-uppercase small text-secondary">${dateInfo.dayName}</div>
            </div>
            <div class="small text-muted">
              <i class="bi bi-clock me-1"></i>
              ${dateInfo.availableSlots || 0} time slots available
            </div>
          </div>
        </div>
      `;

      // Add click handler
      const card = col.querySelector('.suggested-date-card');
      card.addEventListener('click', () => selectDate(new Date(dateInfo.date)));
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectDate(new Date(dateInfo.date));
        }
      });

      suggestedCards.appendChild(col);
    });

    // Scroll to view
    setTimeout(() => {
      suggestedContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);

  } catch (error) {
    console.error('❌ Error loading AI suggested dates:', error);
    suggestedCards.innerHTML = `
      <div class="col-12">
        <div class="alert alert-danger">
          <i class="bi bi-exclamation-circle me-2"></i>
          Failed to load suggested dates. Please try again or use manual calendar.
        </div>
      </div>
    `;
  }
}

/**
 * Render Manual Calendar with proper month view
 */
async function renderManualCalendar() {
  const manualContainer = document.getElementById('manualCalendar');
  const calendarGrid = document.getElementById('calendarGrid');
  const suggestedContainer = document.getElementById('suggestedDates');

  if (!manualContainer || !calendarGrid) {
    console.warn('⚠️ Manual calendar container not found');
    return;
  }

  // Show manual, hide suggested and mode selection
  const modeSelection = document.getElementById('modeSelection');
  manualContainer.classList.remove('d-none');
  if (suggestedContainer) suggestedContainer.classList.add('d-none');
  if (modeSelection) modeSelection.classList.add('d-none');

  // Remove any existing change-mode buttons first to avoid duplicates
  manualContainer.querySelectorAll('.change-mode-btn-wrapper').forEach(el => el.remove());

  // Show loading
  calendarGrid.innerHTML = `
    <div class="ent-calendar">
      <div class="ent-cal-loading">
        <div class="spinner-border" role="status"></div>
        <span>Retrieving available dates...</span>
      </div>
    </div>
  `;

    try {
      // Calculate total duration for backend query
      // Each service's contribution = duration × quantity
      const serviceDuration = BookingState.selectedServices?.reduce((total, service) => {
        return total + ((service.duration || 60) * (service.quantity || 1));
      }, 0) || 60;
      const travelDuration = BookingState.travelDuration || 30;
      const totalDuration = serviceDuration + travelDuration;
      const totalEstimatedMinutes = serviceDuration; // quantity × per-unit duration (excludes travel)

      // Calculate total quantity across all selected services
      const totalQuantity = BookingState.selectedServices?.reduce((total, service) => {
        return total + (service.quantity || 1);
      }, 0) || 1;

      // Initialize enterprise calendar with per-unit duration and total quantity
      // Backend will calculate: capacityPerSlot = (duration × quantity) + travelTime + bufferTime
      await EnterpriseCalendar.init({
        serviceId: BookingState.selectedServiceId,
        duration: serviceDuration / totalQuantity,
        quantity: totalQuantity,
        totalEstimatedMinutes: totalEstimatedMinutes
      });

    setTimeout(() => {
      manualContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);

  } catch (error) {
    console.error('❌ Error rendering manual calendar:', error);
    calendarGrid.innerHTML = `
      <div class="ent-calendar">
        <div class="ent-cal-loading" style="color: #dc2626;">
          <i class="bi bi-exclamation-triangle-fill" style="font-size: 1.5rem;"></i>
          <span>Failed to load calendar. Please try again.</span>
        </div>
      </div>
    `;
  }
}

/**
 * Render actual calendar month view
 */
function renderCalendarMonth(scheduleData, holidaysData, bookedDatesData) {
  const calendarGrid = document.getElementById('calendarGrid');
  const currentMonth = BookingState.calendarCurrentMonth;

  // Get month details
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Get first day of month and total days
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const daysInMonth = lastDay.getDate();
  const startingDayOfWeek = firstDay.getDay();

  // Check if capacity mode (no technician selected)
  const isCapacityMode = !BookingState.selectedTechnicianId;
  const workingDaysText = isCapacityMode
    ? "Monday to Saturday"
    : (scheduleData.workingDays || []).map(wd => dayNames[wd.dayOfWeek]).join(', ');
  const workingHoursText = isCapacityMode
    ? "8:00 AM - 5:00 PM"
    : `${Math.floor(scheduleData.workingDays?.[0]?.startMinutes / 60 || 8)}:00 - ${Math.floor(scheduleData.workingDays?.[0]?.endMinutes / 60 || 17)}:00`;

  // Create calendar HTML
  let calendarHTML = `
    <div class="calendar-wrapper">
      <!-- Weekly Working Days Display -->
      <div class="mb-3 p-2 bg-light rounded text-center small">
        <strong>Working Days:</strong> ${workingDaysText} | 
        <strong>Hours:</strong> ${workingHoursText}
      </div>
      
      <!-- Legend at Top -->
      <div class="mb-3 d-flex flex-wrap gap-3 justify-content-center small">
        <div><span class="badge" style="background-color: #28a745;">●</span> Available</div>
        <div><span class="badge" style="background-color: #dc3545;">●</span> Fully Booked</div>
        <div><span class="badge" style="background-color: #6c757d;">●</span> Holiday/Closed</div>
        <div><span class="badge" style="background-color: #adb5bd;">●</span> Past</div>
      </div>
      
      <!-- Month Header -->
      <div class="d-flex justify-content-between align-items-center mb-3">
        <button type="button" class="btn btn-sm btn-outline-primary" onclick="BookingSystem.previousMonth()">
          <i class="bi bi-chevron-left"></i> Previous
        </button>
        <h5 class="mb-0 fw-bold">${monthNames[month]} ${year}</h5>
        <button type="button" class="btn btn-sm btn-outline-primary" onclick="BookingSystem.nextMonth()">
          Next <i class="bi bi-chevron-right"></i>
        </button>
      </div>
      
      <!-- Day of Week Headers -->
      <div class="calendar-grid mb-2">
        ${dayNames.map(day => `<div class="calendar-day-header text-center fw-bold small">${day}</div>`).join('')}
      </div>
      
      <!-- Calendar Days -->
      <div class="calendar-grid">
  `;

  // Create map of available dates
  const availableDatesMap = {};
  scheduleData.availableDates?.forEach(dateInfo => {
    availableDatesMap[dateInfo.date] = dateInfo;
  });

  // Create map of booked dates with booking counts
  const bookedDatesMap = bookedDatesData?.bookedDates || {};

  // Create map of holidays and non-working days
  const holidaysMap = {};
  holidaysData.holidays?.forEach(holiday => {
    const dateKey = formatDateKey(new Date(holiday.date));
    holidaysMap[dateKey] = { type: 'holiday', name: holiday.name };
  });
  holidaysData.nonWorkingDays?.forEach(nwd => {
    const dateKey = formatDateKey(new Date(nwd.date));
    if (!holidaysMap[dateKey]) {
      holidaysMap[dateKey] = { type: 'nonworking', name: nwd.reason || 'Non-working day' };
    }
  });

  // Add empty cells for days before month starts
  for (let i = 0; i < startingDayOfWeek; i++) {
    calendarHTML += '<div class="calendar-day empty"></div>';
  }

  // Add days of the month
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let day = 1; day <= daysInMonth; day++) {
    const currentDate = new Date(year, month, day);
    const dateKey = formatDateKey(currentDate);

    // Compare using UTC date keys to avoid timezone offset issues
    const todayKey = formatDateKey(today);
    const isPast = dateKey < todayKey;

    const dateInfo = availableDatesMap[dateKey];
    const holidayInfo = holidaysMap[dateKey];
    const bookingCount = dateInfo?.reservedSlots ?? 0;

    // Check if this day is a working day based on schedule
    const dayOfWeek = currentDate.getDay(); // 0 = Sunday, 6 = Saturday

    // In capacity mode, we treat any day that has slots/data returned by backend as a working day
    const isWorkingDay = !isCapacityMode
      ? BookingState.scheduleState?.workingDays?.some(wd => wd.dayOfWeek === dayOfWeek)
      : (!!dateInfo);

    const isNonWorkingWeekday = !isCapacityMode
      ? BookingState.scheduleState?.nonWorkingWeekdays?.some(nwd => nwd.dayOfWeek === dayOfWeek)
      : false;

    let dayClass = 'calendar-day';
    let dayStyle = '';
    let dayContent = '';
    let clickable = false;

    const selectedDateKey = BookingState.selectedDate ? formatDateKey(BookingState.selectedDate) : null;
    const isSelected = dateKey === selectedDateKey;

    if (isPast) {
      // Past dates - gray and disabled
      dayClass += ' past-day';
      dayStyle = 'background-color: #f8f9fa; color: #adb5bd; cursor: not-allowed;';
      dayContent = `<div class="day-number">${day}</div><div class="day-info small text-muted">Past</div>`;
    } else if (holidayInfo) {
      // Holidays and non-working days - gray
      dayClass += ' holiday-day';
      dayStyle = 'background-color: #6c757d; color: white; cursor: not-allowed;';
      dayContent = `<div class="day-number">${day}</div><div class="day-info small">Holiday</div>`;
    } else if (!isWorkingDay || isNonWorkingWeekday) {
      // Non-working days based on schedule - gray
      dayClass += ' non-working-day';
      dayStyle = 'background-color: #6c757d; color: white; cursor: not-allowed;';
      dayContent = `<div class="day-number">${day}</div><div class="day-info small">Closed</div>`;
    } else if (dateInfo && dateInfo.availableSlots === 0) {
      // Fully booked - RED (from backend calculation)
      dayClass += ' fully-booked-day';
      dayStyle = 'background-color: #dc3545; color: white; cursor: not-allowed; box-shadow: 0 2px 8px rgba(220, 53, 69, 0.3);';
      dayContent = `<div class="day-number fw-bold">${day}</div><div class="day-info small"><i class="bi bi-x-circle-fill"></i> Fully Booked</div>`;
    } else if (dateInfo && dateInfo.availableSlots > 0) {
      // Available dates - GREEN with slot count
      dayClass += ' available-day';
      if (isSelected) dayClass += ' selected-day';
      const slotsText = dateInfo.availableSlots === 1 ? '1 slot' : `${dateInfo.availableSlots} slots`;
      const badgeColor = dateInfo.availableSlots <= 2 ? '#ffc107' : '#28a745';
      dayStyle = isSelected ? '' : `background-color: #28a745; color: white; cursor: pointer; box-shadow: 0 2px 8px rgba(40, 167, 69, 0.3);`;
      dayContent = `<div class="day-number fw-bold">${day}</div><div class="day-info small">${bookingCount > 0 ? `<span style="background:rgba(255,255,255,0.25);padding:1px 5px;border-radius:3px;font-size:0.65rem;">${bookingCount} booked</span> ` : ''}${slotsText}</div>`;
      clickable = true;
    } else if (isWorkingDay && !isNonWorkingWeekday) {
      // Working day not in availableDates - might have slots, show as available
      dayClass += ' available-day';
      if (isSelected) dayClass += ' selected-day';
      dayStyle = isSelected ? '' : 'background-color: #28a745; color: white; cursor: pointer; box-shadow: 0 2px 8px rgba(40, 167, 69, 0.3);';
      dayContent = `<div class="day-number fw-bold">${day}</div><div class="day-info small">${bookingCount > 0 ? `<span style="background:rgba(255,255,255,0.25);padding:1px 5px;border-radius:3px;font-size:0.65rem;">${bookingCount} booked</span>` : 'Open'}</div>`;
      clickable = true;
    } else {
      // Default - not available
      dayClass += ' unavailable-day';
      dayStyle = 'background-color: #f8f9fa; border: 1px solid #dee2e6;';
      dayContent = `<div class="day-number">${day}</div><div class="day-info small text-muted">N/A</div>`;
    }

    calendarHTML += `
      <div class="${dayClass}" 
           style="${dayStyle}" 
           data-date="${dateKey}"
           ${clickable ? `role="button" tabindex="0"` : ''}>
        ${dayContent}
      </div>
    `;
  }

  calendarHTML += `
      </div>
    </div>
    
    <style>
      .calendar-grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 8px;
      }
      .calendar-day-header {
        padding: 8px;
        background-color: #f8f9fa;
        border-radius: 4px;
        font-size: 0.85rem;
      }
      .calendar-day {
        min-height: 80px;
        padding: 8px;
        border-radius: 6px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        transition: all 0.2s;
      }
      .calendar-day.empty {
        background-color: transparent;
        border: none;
      }
      .calendar-day.available-day:hover {
        transform: scale(1.05);
        box-shadow: 0 6px 16px rgba(40, 167, 69, 0.4);
      }
      .calendar-day.fully-booked-day {
        animation: fullyBookedPulse 3s ease-in-out infinite;
      }
      @keyframes fullyBookedPulse {
        0%, 100% { box-shadow: 0 2px 8px rgba(220, 53, 69, 0.3); }
        50% { box-shadow: 0 4px 16px rgba(220, 53, 69, 0.5); }
      }
      .calendar-day .day-number {
        font-size: 1.15rem;
        margin-bottom: 4px;
      }
      .calendar-day .day-info {
        font-size: 0.68rem;
        line-height: 1.3;
      }
      .calendar-day.selected-day {
        background: linear-gradient(135deg, #0d6efd, #0b5ed7) !important;
        color: white !important;
        border: 2px solid #0a58ca !important;
        box-shadow: 0 4px 15px rgba(13, 110, 253, 0.4) !important;
        transform: scale(1.05);
      }
    </style>
  `;

  calendarGrid.innerHTML = calendarHTML;

  // Add click handlers to available days
  document.querySelectorAll('.calendar-day.available-day').forEach(dayEl => {
    dayEl.addEventListener('click', () => {
      const dateKey = dayEl.dataset.date;
      selectDate(new Date(dateKey));
    });
    dayEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const dateKey = dayEl.dataset.date;
        selectDate(new Date(dateKey));
      }
    });
  });
}

/**
 * Navigate to previous month
 */
function previousMonth() {
  if (window.EnterpriseCalendar) {
    // EnterpriseCalendar handles its own navigation
    return;
  }
  BookingState.calendarCurrentMonth.setMonth(BookingState.calendarCurrentMonth.getMonth() - 1);
  renderManualCalendar();
}

/**
 * Navigate to next month
 */
function nextMonth() {
  if (window.EnterpriseCalendar) {
    // EnterpriseCalendar handles its own navigation
    return;
  }
  BookingState.calendarCurrentMonth.setMonth(BookingState.calendarCurrentMonth.getMonth() + 1);
  renderManualCalendar();
}

/**
 * Select a date and load time slots
 */
async function selectDate(date) {
  console.log('📅 Date selected:', date);
  console.log('📅 Active scheduling mode:', BookingState.schedulingMode);

  // Store selected date
  BookingState.selectedDate = date;

  // Highlight selected date
  document.querySelectorAll('.suggested-date-card, .calendar-date-card, .calendar-day, .ent-cal-cell').forEach(card => {
    card.classList.remove('selected-day', 'border-success', 'border-3', 'selected');
  });

  const dateKey = EnterpriseCalendar.formatDateKey(date);
  const selectedCard = document.querySelector(`[data-date="${dateKey}"]`);
  if (selectedCard) {
    if (selectedCard.classList.contains('ent-cal-cell')) {
      selectedCard.classList.add('selected');
    } else if (selectedCard.classList.contains('calendar-day')) {
      selectedCard.classList.add('selected-day');
    } else {
      selectedCard.classList.add('border-success', 'border-3');
    }
  }

  // Load time slots via enterprise calendar
  if (window.EnterpriseCalendar) {
    // EnterpriseCalendar handles slot rendering internally
    return;
  }

  // Fallback: legacy time slot rendering
  await renderTimeSlotsProfessional(date);
}

/**
 * Render time slots from capacity-based API response (all technicians aggregated)
 */
function renderCapacityTimeSlots(apiSlots, totalDuration) {
  const timeSelection = document.getElementById('timeSelection');
  const timeSlots = document.getElementById('timeSlots');
  if (!timeSelection || !timeSlots) return;

  timeSelection.classList.remove('d-none');
  timeSlots.innerHTML = '';

  const availableSlots = apiSlots.filter(s => s.available && !s.isPast);
  const bookedSlots = apiSlots.filter(s => !s.available && !s.isPast);
  const pastSlots = apiSlots.filter(s => s.isPast);

  if (apiSlots.length === 0) {
    timeSlots.innerHTML = `
      <div class="alert alert-warning">
        <i class="bi bi-exclamation-triangle me-2"></i>
        No time slots available for this date. Please select a different date.
      </div>
    `;
    return;
  }

  const slotsContainer = document.createElement('div');
  slotsContainer.className = 'time-slots-horizontal';
  slotsContainer.innerHTML = `
    <style>
      .time-slots-horizontal { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 1rem; }
      .time-slot-btn { flex: 0 0 auto; min-width: 200px; padding: 20px 16px; border-radius: 10px; border: 2px solid #dee2e6; background: white; transition: all 0.2s; cursor: pointer; text-align: center; }
      .time-slot-btn:hover:not(:disabled):not(.occupied):not(.past) { border-color: #0d6efd; background: #f8f9fa; transform: translateY(-2px); box-shadow: 0 4px 8px rgba(13, 110, 253, 0.15); }
      .time-slot-btn.active { border-color: #0d6efd; background: #0d6efd; color: white; }
      .time-slot-btn.active .text-muted { color: rgba(255,255,255,0.8) !important; }
      .time-slot-btn.occupied { border-color: #dc3545; background: linear-gradient(135deg, #fff5f5, #ffe3e3); cursor: not-allowed; opacity: 0.85; }
      .time-slot-btn.occupied:hover { transform: none; box-shadow: none; }
      .time-slot-btn.past { border-color: #e9ecef; background: #f8f9fa; cursor: not-allowed; opacity: 0.6; }
      .time-slot-btn.past:hover { transform: none; box-shadow: none; }
      .time-slot-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .time-slot-time { font-size: 1.1rem; font-weight: 600; margin-bottom: 4px; }
      .time-slot-duration { font-size: 0.85rem; color: #6c757d; }
      .time-slot-status { font-size: 0.75rem; margin-top: 4px; }
    </style>
  `;

  apiSlots.forEach(slot => {
    const slotBtn = document.createElement('button');
    slotBtn.type = 'button';
    slotBtn.className = 'time-slot-btn';
    slotBtn.dataset.slotStart = slot.startTime;

    if (slot.isPast) {
      slotBtn.classList.add('past');
      slotBtn.disabled = true;
      slotBtn.innerHTML = `
        <div class="d-flex flex-column align-items-center">
          <div class="time-slot-time text-muted" style="text-decoration: line-through;">${slot.startTime}</div>
          <div class="time-slot-status text-muted"><i class="bi bi-clock-history"></i> Passed</div>
        </div>
      `;
    } else if (!slot.available) {
      slotBtn.classList.add('occupied');
      slotBtn.disabled = true;
      const techCount = slot.availableCount || 0;
      const statusText = techCount > 0 ? `${techCount} tech${techCount !== 1 ? 's' : ''} available` : 'Fully Booked';
      slotBtn.innerHTML = `
        <div class="d-flex flex-column align-items-center">
          <div class="time-slot-time" style="color: #dc3545; text-decoration: line-through;">${slot.startTime}</div>
          <div class="time-slot-status" style="color: #dc3545;"><i class="bi bi-x-circle-fill"></i> ${statusText}</div>
        </div>
      `;
    } else {
      const techCount = slot.availableCount || 0;
      const statusText = techCount > 0 ? `${techCount} tech${techCount !== 1 ? 's' : ''}` : 'Available';
      slotBtn.innerHTML = `
        <div class="d-flex flex-column align-items-center">
          <div class="time-slot-time">${slot.startTime}</div>
          <div class="time-slot-status text-success"><i class="bi bi-check-circle-fill"></i> ${statusText}</div>
        </div>
      `;
      slotBtn.addEventListener('click', function () {
        selectTimeSlot({
          startTime: slot.startTime,
          label: slot.startTime,
          startMinutes: timeToMinutesLocal(slot.startTime),
          availableCount: techCount
        }, slotBtn);
      });
    }
    slotsContainer.appendChild(slotBtn);
  });

  timeSlots.appendChild(slotsContainer);

  // Summary — labeled as preferred start times
  const summaryDiv = document.createElement('div');
  summaryDiv.className = availableSlots.length > 0 ? 'alert alert-info mt-3' : 'alert alert-warning mt-3';
  let summaryText = `<strong>${availableSlots.length}</strong> available`;
  if (bookedSlots.length > 0) summaryText += `, <strong>${bookedSlots.length}</strong> fully booked`;
  if (pastSlots.length > 0) summaryText += `, <strong>${pastSlots.length}</strong> passed`;
  summaryDiv.innerHTML = `
    <i class="bi bi-${availableSlots.length > 0 ? 'info-circle' : 'exclamation-triangle'} me-2"></i>
    ${summaryText} preferred start times on this date.
    ${availableSlots.length === 0 ? ' All slots are taken or passed — please select a different date.' : ' Select your preferred start time to continue.'}
  `;
  timeSlots.appendChild(summaryDiv);

  // Scheduling disclaimer
  const disclaimerDiv = document.createElement('div');
  disclaimerDiv.className = 'alert alert-light mt-2 small text-muted';
  disclaimerDiv.innerHTML = '<i class="bi bi-info-circle me-1"></i>' +
    'Estimated service duration may vary depending on site conditions, service requirements, ' +
    'travel conditions, and technician availability. Selected times represent preferred service ' +
    'start times and are used for scheduling purposes.';
  timeSlots.appendChild(disclaimerDiv);

  setTimeout(() => { timeSelection.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
}

function timeToMinutesLocal(timeStr) {
  if (!timeStr) return 0;
  const ampmMatch = timeStr.match(/\s*(AM|PM)\s*$/i);
  let clean = timeStr.replace(/\s*(AM|PM)\s*$/i, '').trim();
  const [h, m] = clean.split(':').map(Number);
  let hours = h;
  if (ampmMatch) {
    const isPM = ampmMatch[1].toUpperCase() === 'PM';
    if (isPM && hours < 12) hours += 12;
    else if (!isPM && hours === 12) hours = 0;
  }
  return hours * 60 + (m || 0);
}

/**
 * Professional time slot generation with service duration + travel time
 */
async function renderTimeSlotsProfessional(date) {
  console.log('🔧 renderTimeSlotsProfessional CALLED with date:', date);
  console.log('🔧 Current time:', new Date().toTimeString());

  const timeSelection = document.getElementById('timeSelection');
  const timeSlots = document.getElementById('timeSlots');

  if (!timeSelection || !timeSlots) {
    console.warn('⚠️ Time slot container not found');
    return;
  }

  timeSelection.classList.remove('d-none');
  timeSlots.innerHTML = `
    <div class="text-center py-3">
      <div class="spinner-border text-primary mb-2" role="status">
        <span class="visually-hidden">Loading...</span>
      </div>
      <p class="text-muted small">Calculating preferred time options...</p>
    </div>
  `;

  try {
    // Ensure technician schedule is loaded (only if technician is selected)
    if (BookingState.selectedTechnicianId && (!BookingState.scheduleState || !BookingState.scheduleState.workingDays || BookingState.scheduleState.workingDays.length === 0)) {
      console.log('📅 Loading technician schedule...');
      await loadTechnicianScheduleEnhanced();
    }
    // Get service duration from Step 2
    const serviceDuration = BookingState.selectedServices?.reduce((total, service) => {
      return total + (service.duration || 60);
    }, 0) || 60; // Default 60 minutes

    // Get travel duration from Step 4 (distance calculation)
    const travelDuration = BookingState.travelDuration || 30; // Default 30 minutes

    // Total duration = service duration + travel time
    const totalDuration = serviceDuration + travelDuration;

    console.log('⏱️ Duration calculation:', {
      serviceDuration: `${serviceDuration} min`,
      travelDuration: `${travelDuration} min`,
      totalDuration: `${totalDuration} min`
    });

    // Fetch existing bookings for this date
    let existingBookings = [];
    if (BookingState.selectedTechnicianId) {
      const bookingsResponse = await fetch(
        `/api/schedule/bookings/technician/${BookingState.selectedTechnicianId}/date/${formatDateKey(date)}`
      );
      existingBookings = bookingsResponse.ok ? await bookingsResponse.json() : [];
    }
    console.log('📋 Existing bookings:', existingBookings);

    // When no technician is selected (capacity mode), use server-side aggregation
    // to properly account for ALL technicians' bookings
    if (!BookingState.selectedTechnicianId && BookingState.selectedServiceId) {
      try {
        const apiUrl = `/api/schedule/time-slots?serviceId=${BookingState.selectedServiceId}&date=${formatDateKey(date)}`;
        const apiResponse = await fetch(apiUrl);
        if (apiResponse.ok) {
          const apiData = await apiResponse.json();
          if (apiData.timeSlots && apiData.timeSlots.length > 0) {
            console.log('📋 Capacity-mode slots from API:', apiData.timeSlots.length);
            renderCapacityTimeSlots(apiData.timeSlots, totalDuration);
            return;
          }
        }
      } catch (apiErr) {
        console.warn('⚠️ Capacity API failed, falling back to client-side:', apiErr);
      }
    }

    // Get technician working hours for this day
    const dayOfWeek = date.getDay();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    console.log('📅 Looking for schedule:', {
      date: formatDateKey(date),
      dayOfWeek: dayOfWeek,
      dayName: dayNames[dayOfWeek],
      scheduleState: BookingState.scheduleState,
      workingDays: BookingState.scheduleState?.workingDays
    });

    let workingDay = BookingState.scheduleState?.workingDays?.find(wd => wd.dayOfWeek === dayOfWeek);

    // If no working day found, use default schedule (8 AM - 5 PM)
    if (!workingDay) {
      console.warn(`⚠️ No working day configured for ${dayNames[dayOfWeek]}, using default schedule`);
      workingDay = {
        dayOfWeek: dayOfWeek,
        startMinutes: 480,  // 8:00 AM
        endMinutes: 1020    // 5:00 PM
      };
    }

    const startMinutes = workingDay.startMinutes || 480; // 8:00 AM
    const endMinutes = workingDay.endMinutes || 1020; // 5:00 PM

    console.log('🕐 Working hours:', {
      start: minutesToTime(startMinutes),
      end: minutesToTime(endMinutes)
    });

    // Generate time slots (professional backend approach - only generate valid slots)
    const slots = generateTimeSlotsWithConflicts(
      startMinutes,
      endMinutes,
      totalDuration,
      existingBookings,
      date  // Pass selected date for past time checking
    );

    console.log(`🔍 Backend generated ${slots.length} slots (${slots.filter(s => s.available).length} available)`);

    timeSlots.innerHTML = '';

    // Show ALL slots (available + occupied/past) for full visibility
    if (slots.length === 0) {
      timeSlots.innerHTML = `
        <div class="alert alert-warning">
          <i class="bi bi-exclamation-triangle me-2"></i>
        No preferred time available for this date. Please select a different date.
        </div>
      `;
      return;
    }

    // Create time slot horizontal container
    const slotsContainer = document.createElement('div');
    slotsContainer.className = 'time-slots-horizontal';
    slotsContainer.innerHTML = `
      <style>
        .time-slots-horizontal {
          display: flex;
          flex-wrap: wrap;
          gap: 12px;
          margin-top: 1rem;
        }
        .time-slot-btn {
          flex: 0 0 auto;
          min-width: 200px;
          padding: 20px 16px;
          border-radius: 10px;
          border: 2px solid #dee2e6;
          background: white;
          transition: all 0.2s;
          cursor: pointer;
          text-align: center;
        }
        .time-slot-btn:hover:not(:disabled):not(.occupied):not(.past) {
          border-color: #0d6efd;
          background: #f8f9fa;
          transform: translateY(-2px);
          box-shadow: 0 4px 8px rgba(13, 110, 253, 0.15);
        }
        .time-slot-btn.active {
          border-color: #0d6efd;
          background: #0d6efd;
          color: white;
        }
        .time-slot-btn.active .text-muted {
          color: rgba(255, 255, 255, 0.8) !important;
        }
        .time-slot-btn.occupied {
          border-color: #dc3545;
          background: linear-gradient(135deg, #fff5f5, #ffe3e3);
          cursor: not-allowed;
          opacity: 0.85;
        }
        .time-slot-btn.occupied:hover {
          transform: none;
          box-shadow: none;
        }
        .time-slot-btn.past {
          border-color: #e9ecef;
          background: #f8f9fa;
          cursor: not-allowed;
          opacity: 0.6;
        }
        .time-slot-btn.past:hover {
          transform: none;
          box-shadow: none;
        }
        .time-slot-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .time-slot-time {
          font-size: 1.1rem;
          font-weight: 600;
          margin-bottom: 4px;
        }
        .time-slot-duration {
          font-size: 0.85rem;
          color: #6c757d;
        }
        .time-slot-status {
          font-size: 0.75rem;
          margin-top: 4px;
        }
      </style>
    `;

    // Render ALL time slots (available + occupied/past)
    const availableCount = slots.filter(s => s.available).length;
    const reservedCount = slots.filter(s => !s.available && s.conflict).length;
    const pastCount = slots.filter(s => !s.available && s.isPast).length;

    slots.forEach(slot => {
      const slotBtn = document.createElement('button');
      slotBtn.type = 'button';
      slotBtn.className = 'time-slot-btn';
      slotBtn.dataset.slotStart = slot.startMinutes;
      slotBtn.dataset.slotEnd = slot.endMinutes;

      if (slot.available) {
        // Available slot — green and clickable
        slotBtn.innerHTML = `
          <div class="d-flex flex-column align-items-center">
            <div class="time-slot-time">${slot.label}</div>
            <div class="time-slot-status text-success">
              <i class="bi bi-check-circle-fill"></i> Available
            </div>
          </div>
        `;
        slotBtn.addEventListener('click', function () {
          selectTimeSlot(slot, slotBtn);
        });
      } else if (slot.isPast) {
        // Past slot — gray and disabled
        slotBtn.classList.add('past');
        slotBtn.disabled = true;
        slotBtn.innerHTML = `
          <div class="d-flex flex-column align-items-center">
            <div class="time-slot-time text-muted" style="text-decoration: line-through;">${slot.label}</div>
            <div class="time-slot-status text-muted">
              <i class="bi bi-clock-history"></i> Passed
            </div>
          </div>
        `;
      } else {
        // Occupied/Reserved slot — red and disabled
        slotBtn.classList.add('occupied');
        slotBtn.disabled = true;
        slotBtn.innerHTML = `
          <div class="d-flex flex-column align-items-center">
            <div class="time-slot-time" style="color: #dc3545; text-decoration: line-through;">${slot.label}</div>
            <div class="time-slot-status" style="color: #dc3545;">
              <i class="bi bi-x-circle-fill"></i> Reserved
            </div>
          </div>
        `;
      }

      slotsContainer.appendChild(slotBtn);
    });

    timeSlots.appendChild(slotsContainer);

    // Add summary info — labeled as preferred start times
    const summaryDiv = document.createElement('div');
    summaryDiv.className = availableCount > 0 ? 'alert alert-info mt-3' : 'alert alert-warning mt-3';

    let summaryText = `<strong>${availableCount}</strong> available`;
    if (reservedCount > 0) summaryText += `, <strong>${reservedCount}</strong> reserved`;
    if (pastCount > 0) summaryText += `, <strong>${pastCount}</strong> passed`;

    summaryDiv.innerHTML = `
      <i class="bi bi-${availableCount > 0 ? 'info-circle' : 'exclamation-triangle'} me-2"></i>
      ${summaryText} preferred start times on this date.
      ${availableCount === 0 ? ' All time slots are taken or passed — please select a different date.' : ' Select your preferred start time to continue.'}
    `;
    timeSlots.appendChild(summaryDiv);

    // Scheduling disclaimer
    const disclaimerDiv = document.createElement('div');
    disclaimerDiv.className = 'alert alert-light mt-2 small text-muted';
    disclaimerDiv.innerHTML = '<i class="bi bi-info-circle me-1"></i>' +
      'Estimated service duration may vary depending on site conditions, service requirements, ' +
      'travel conditions, and technician availability. Selected times represent preferred service ' +
      'start times and are used for scheduling purposes.';
    timeSlots.appendChild(disclaimerDiv);

    // Scroll to time slots
    setTimeout(() => {
      timeSelection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);

  } catch (error) {
    console.error('❌ Error loading time slots:', error);
    timeSlots.innerHTML = `
      <div class="alert alert-danger">
        <i class="bi bi-exclamation-circle me-2"></i>
        Failed to load time slots. Please try again.
      </div>
    `;
  }
}

/**
 * Generate time slots with booking conflict detection and past time blocking
 */
function generateTimeSlotsWithConflicts(startMinutes, endMinutes, durationMinutes, existingBookings, selectedDate) {
  const slots = [];
  const slotInterval = Math.max(30, durationMinutes); // Align with backend slot spacing

  // Get current date and time for past time blocking
  const now = new Date();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Check if selected date is today
  const slotDate = new Date(selectedDate);
  slotDate.setHours(0, 0, 0, 0);
  const isToday = slotDate.getTime() === today.getTime();
  const isPastDate = slotDate.getTime() < today.getTime();

  // Setup buffers for today's time checks
  const bufferMinutes = 30;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const cutoffMinutes = currentMinutes + bufferMinutes;

  console.log(`📅 RAW DATE VALIDATION:`, {
    selectedDate: selectedDate.toDateString(),
    isToday,
    isPastDate,
    startMinutes: minutesToTime(startMinutes),
    endMinutes: minutesToTime(endMinutes)
  });

  for (let currentStart = startMinutes; currentStart + durationMinutes <= endMinutes; currentStart += slotInterval) {
    const currentEnd = currentStart + durationMinutes;

    // Check if this slot conflicts with existing bookings
    // 1. Conflict if the slot STARTS before the booking ENDS AND the slot ENDS after the booking STARTS.
    const hasConflict = existingBookings.some(booking => {
      const bookingStart = minutesFromTime(booking.startTime);
      const bookingEnd = minutesFromTime(booking.endTime);

      return (currentStart < bookingEnd && currentEnd > bookingStart);
    });

    // Explicitly calculate if this time is in the past
    // The slot is past if: (1) date is past OR (2) date is today and slot starts before cutoff
    // OR (3) date is today and slot starts before minimum advance notice window
    let isPastTime = false;
    if (isPastDate) {
      isPastTime = true;
    } else if (isToday) {
      isPastTime = (currentStart < cutoffMinutes);
      // Minimum advance notice: block slots before the earliest bookable time
      const minAdvance = (window.__bookingPolicy && window.__bookingPolicy.minAdvanceNoticeMinutes) || 120;
      const earliestMs = now.getTime() + minAdvance * 60000;
      const earliestDate = new Date(earliestMs);
      const earliestMinutes = earliestDate.getHours() * 60 + earliestDate.getMinutes();
      if (currentStart < earliestMinutes) {
        isPastTime = true;
      }
    }

    // Add slot with explicit availability and conflict flags
    // Label shows only the preferred start time — not a guaranteed completion window
    slots.push({
      start: minutesToTime(currentStart),
      label: minutesToTime(currentStart),
      available: !hasConflict && !isPastTime,
      conflict: hasConflict,
      isPast: isPastTime,
      startMinutes: currentStart,
    });
  }

  console.log(`✅ Generated ${slots.length} total slots (${slots.filter(s => s.available).length} valid, ${slots.filter(s => !s.available && s.conflict).length} conflicted, ${slots.filter(s => !s.available && s.isPast).length} past)`);
  return slots;
}

/**
 * Convert time string (12-hour AM/PM or 24-hour HH:MM) to minutes
 */
function minutesFromTime(timeString) {
  if (!timeString) return 0;

  // Handle 12-hour format with AM/PM (e.g., "02:30 PM", "9:00 AM")
  const ampmMatch = timeString.match(/\s*(AM|PM)\s*$/i);
  let cleanTime = timeString.replace(/\s*(AM|PM)\s*$/i, '').trim();

  const [hoursStr, minutesStr] = cleanTime.split(':');
  let hours = parseInt(hoursStr, 10);
  const minutes = parseInt(minutesStr, 10) || 0;

  if (ampmMatch) {
    const isPM = ampmMatch[1].toUpperCase() === 'PM';
    if (isPM && hours < 12) {
      hours += 12;
    } else if (!isPM && hours === 12) {
      hours = 0;
    }
  }

  return (hours * 60) + minutes;
}

/**
 * Convert minutes to time string (HH:MM)
 */
/**
 * Convert minutes-from-midnight to 12-hour display string (e.g., "2:00 PM")
 */
function minutesToTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours > 12 ? hours - 12 : (hours === 0 ? 12 : hours);
  return `${displayHours}:${mins.toString().padStart(2, '0')} ${period}`;
}

/**
 * Select a time slot
 */
function selectTimeSlot(slot, buttonElement) {
  console.log('🕐 Time slot selected:', slot);

  // Store selected slot
  BookingState.selectedTimeSlot = slot;
  BookingState.selectedTime = slot.label;
  BookingState.selectedDate = BookingState.selectedDate || new Date();

  // Highlight selected slot
  document.querySelectorAll('.time-slot-btn').forEach(btn => {
    btn.classList.remove('active');
  });

  if (buttonElement) {
    buttonElement.classList.add('active');
  }

  console.log('✅ Time slot confirmed:', {
    date: BookingState.selectedDate,
    time: slot.label,
  });

  // Auto-advance to next step
  setTimeout(() => {
    console.log('⏭️ Auto-advancing to Step 6');
    showStep(5);
    updateStepper(5);
  }, 500);
}

/**
 * Display Total Fee in Step 6
 * Professional fee calculation with breakdown
 */
function displayTotalFee() {
  console.log('💰 Calculating total fee...');

  // Get DOM elements
  const servicesTotalDisplay = document.getElementById('servicesTotalDisplay');
  const travelFareDisplay = document.getElementById('travelFareDisplay');
  const totalFeeDisplay = document.getElementById('totalFeeDisplay');
  const feeServiceDetails = document.getElementById('feeServiceDetails');
  const gcashAmountDisplay = document.getElementById('gcashAmountDisplay');

  if (!servicesTotalDisplay || !travelFareDisplay || !totalFeeDisplay) {
    console.error('❌ Fee display elements not found');
    return;
  }

  // Calculate services total
  let servicesTotal = 0;
  let hasRepairServices = false;
  let serviceDetailsHTML = '<div class="mb-2"><strong>Selected Services:</strong></div><ul class="mb-0">';

  if (BookingState.selectedServices && BookingState.selectedServices.length > 0) {
    BookingState.selectedServices.forEach(service => {
      const quantity = service.quantity || 1;
      const unitPrice = service.unitPrice || service.price || 0;
      const serviceTotal = unitPrice * quantity;
      servicesTotal += serviceTotal;

      // Check if it's a repair service
      if (service.type === 'repair' || service.isRepair) {
        hasRepairServices = true;
      }

      // Add to details
      serviceDetailsHTML += `
        <li>
          ${service.name} 
          ${quantity > 1 ? `(${quantity}x ₱${unitPrice.toLocaleString()})` : ''} 
          - ₱${serviceTotal.toLocaleString()}
          ${service.hp ? ` <span class="badge bg-secondary">${service.hp} HP</span>` : ''}
        </li>
      `;
    });
  } else {
    serviceDetailsHTML += '<li class="text-muted">No services selected</li>';
  }
  serviceDetailsHTML += '</ul>';

  // Get travel fare
  const travelFare = BookingState.travelFare || BookingState.fare || 0;

  // Calculate total (labor fee removed — included in service price for core, quoted on-site for repair)
  const totalFee = servicesTotal + travelFare;

  // Update displays
  servicesTotalDisplay.textContent = `₱${servicesTotal.toLocaleString()}`;
  travelFareDisplay.textContent = `₱${travelFare.toLocaleString()}`;
  totalFeeDisplay.textContent = `₱${totalFee.toLocaleString()}`;
  feeServiceDetails.innerHTML = serviceDetailsHTML;

  // Show repair quotation note for repair services
  const repairQuotationNote = document.getElementById('repairQuotationNote');
  if (repairQuotationNote) {
    if (hasRepairServices) {
      repairQuotationNote.classList.remove('d-none');
    } else {
      repairQuotationNote.classList.add('d-none');
    }
  }

  // Update GCash amount display
  if (gcashAmountDisplay) {
    gcashAmountDisplay.textContent = `₱${totalFee.toLocaleString()}`;
  }

  // Store in BookingState
  BookingState.totalFee = totalFee;
  BookingState.servicesTotal = servicesTotal;

  console.log('💰 Total fee calculated:', {
    servicesTotal: `₱${servicesTotal}`,
    travelFare: `₱${travelFare}`,
    totalFee: `₱${totalFee}`,
    hasRepairServices
  });
}

/**
 * Initialize Payment Step (Step 7)
 * Set up payment method selection and form handling
 */
function initializePaymentStep() {
  console.log('💳 Initializing payment step...');

  // Get payment method buttons
  const paymentTabs = document.querySelectorAll('.payment-tab, .ent-payment-tab');
  const gcashFields = document.getElementById('gcashFields');
  const cashFields = document.getElementById('cashFields');
  const confirmBookingBtn = document.getElementById('confirmBookingBtn');

  if (!paymentTabs || paymentTabs.length === 0) {
    console.warn('⚠️ Payment tabs not found');
    return;
  }

  // Payment method selection
  paymentTabs.forEach(tab => {
    tab.addEventListener('click', function () {
      const method = this.dataset.method;
      console.log(`💳 Payment method selected: ${method}`);

      // Update active state
      paymentTabs.forEach(t => t.setAttribute('aria-pressed', 'false'));
      this.setAttribute('aria-pressed', 'true');

      // Show/hide payment forms
      if (gcashFields) gcashFields.classList.add('d-none');
      if (cashFields) cashFields.classList.add('d-none');

      if (method === 'gcash' && gcashFields) {
        gcashFields.classList.remove('d-none');
        BookingState.paymentMethod = 'gcash';
      } else if (method === 'cash' && cashFields) {
        cashFields.classList.remove('d-none');
        BookingState.paymentMethod = 'cod';
      }

      // Update GCash/Cash amount displays
      updatePaymentAmounts();
    });
  });

  // Confirm booking button
  if (confirmBookingBtn) {
    confirmBookingBtn.addEventListener('click', handleBookingSubmission);
  }

  console.log('✅ Payment step initialized');
}

/**
 * Update payment amount displays
 */
function updatePaymentAmounts() {
  const totalFee = BookingState.totalFee || 0;
  const gcashAmountDisplay = document.getElementById('gcashAmountDisplay');
  const cashTotalDisplay = document.getElementById('cashTotalDisplay');
  const cashDownDisplay = document.getElementById('cashDownDisplay');
  const cashBalanceDisplay = document.getElementById('cashBalanceDisplay');
  const cashBreakdown = document.getElementById('cashBreakdown');

  if (gcashAmountDisplay) {
    gcashAmountDisplay.textContent = `₱${totalFee.toLocaleString()}`;
  }

  if (cashTotalDisplay && cashDownDisplay && cashBalanceDisplay) {
    const downpayment = 400;
    const balance = totalFee - downpayment;

    cashTotalDisplay.textContent = `₱${totalFee.toLocaleString()}`;
    cashDownDisplay.textContent = `₱${downpayment.toLocaleString()}`;
    cashBalanceDisplay.textContent = `₱${balance.toLocaleString()}`;

    if (cashBreakdown) {
      cashBreakdown.style.display = 'block';
    }
  }
}

/**
 * Handle booking submission
 * Professional validation and submission to backend with car loading animation
 */
async function handleBookingSubmission() {
  console.log('📤 Submitting booking...');

  const confirmBtn = document.getElementById('confirmBookingBtn');
  const paymentError = document.getElementById('paymentError');

  // Hide any previous errors
  if (paymentError) {
    paymentError.style.display = 'none';
  }

  // Disable button to prevent double submission
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Processing...';
  }

  try {
    // Validate booking data
    const validationResult = validateBookingData();
    if (!validationResult.valid) {
      throw new Error(validationResult.error);
    }

    // Show car loading animation
    showCarLoadingModal();

    // Prepare booking data
    const bookingData = await prepareBookingData();
    console.log('📋 Booking data prepared:', bookingData);
    console.log('📋 Services type:', typeof bookingData.services);
    console.log('📋 Services is array:', Array.isArray(bookingData.services));
    console.log('📋 First service:', bookingData.services[0]);

    // Submit to backend using simplified endpoint
    const response = await fetch('/api/bookings/create-new', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(bookingData)
    });

    if (response.ok) {
      const result = await response.json();
      console.log('✅ Booking created successfully:', result);

      // Hide car loading modal
      hideCarLoadingModal();

      // Prepare data for the enterprise confirmation modal
      const isProjectResult = Boolean(result.isProject) ||
        (EnterpriseCalendar.isProjectMode && EnterpriseCalendar.isProjectMode()) ||
        BookingState.isProject === true || !!BookingState.projectScheduling;

      let serviceName;
      if (result.serviceNames && result.serviceNames.length) {
        serviceName = result.serviceNames.join(', ');
      } else if (BookingState.selectedServices && BookingState.selectedServices.length) {
        serviceName = BookingState.selectedServices.map(s => s.name).join(', ');
      } else {
        serviceName = result.serviceName || 'Selected Service';
      }

      let timeLabel;
      if (isProjectResult) {
        const ps = result.projectScheduling || BookingState.projectScheduling || {};
        timeLabel = 'Project scheduling — start date only';
      } else {
        timeLabel = result.timeLabel || BookingState.selectedTimeSlot?.label || 'Selected Time';
      }

      const modalData = {
        bookingReference: result.bookingReference,
        serviceName,
        isProject: isProjectResult,
        projectScheduling: result.projectScheduling || BookingState.projectScheduling || undefined,
        dateLabel: result.dateLabel || new Date(BookingState.selectedDate).toLocaleDateString('en-PH', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        }),
        timeLabel,
        locationAddress: result.locationAddress || BookingState.customerLocation?.address || 'Service Location',
        customerName: result.customerName || (window.currentUser && window.currentUser.name) || '',
        customerEmail: result.customerEmail || (window.currentUser && window.currentUser.email) || '',
        technicianName: result.technicianName || '',
        technicianEmail: result.technicianEmail || '',
        estimatedFee: result.estimatedFee || BookingState.totalFee || 0,
        paymentMethod: result.paymentMethod || BookingState.paymentMethod || 'cod'
      };

      // Show enterprise booking confirmation modal
      if (typeof showBookingConfirmationModal === 'function') {
        showBookingConfirmationModal(modalData);
      } else {
        console.warn('⚠️ showBookingConfirmationModal function not available, falling back to default success');
        showBookingSuccessModal(result);
      }

    } else {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Failed to create booking');
    }

  } catch (error) {
    console.error('❌ Booking submission error:', error);

    // Always hide car loading modal on error
    hideCarLoadingModal();

    // Show error message
    if (paymentError) {
      paymentError.textContent = error.message || 'Failed to create booking';
      paymentError.style.display = 'block';
      paymentError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      alert('Booking failed: ' + (error.message || 'Unknown error'));
    }

  } finally {
    // Re-enable button
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="bi bi-check-circle me-2"></i>Confirm Booking';
    }
  }
}

/**
 * Show car loading animation modal
 */
function showCarLoadingModal() {
  const modal = document.getElementById('carLoadingModal');
  if (!modal) {
    console.warn('⚠️ Car loading modal not found');
    return;
  }

  // Dispose any stale instance first to avoid duplicates
  const existing = bootstrap.Modal.getInstance(modal);
  if (existing) existing.dispose();

  const bsModal = new bootstrap.Modal(modal, {
    backdrop: 'static',
    keyboard: false
  });

  bsModal.show();
}

/**
 * Hide car loading animation modal
 */
function hideCarLoadingModal() {
  const modal = document.getElementById('carLoadingModal');
  if (!modal) return;

  const bsModal = bootstrap.Modal.getInstance(modal);
  if (bsModal) {
    bsModal.hide();
  } else {
    // Fallback: force-remove Bootstrap modal classes
    modal.classList.remove('show');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    modal.removeAttribute('aria-modal');
    document.body.classList.remove('modal-open');
    // Remove ALL backdrops (stale ones included)
    document.querySelectorAll('.modal-backdrop').forEach(bd => bd.remove());
  }
}

/**
 * Validate booking data before submission
 */
function validateBookingData() {
  // Check services
  if (!BookingState.selectedServices || BookingState.selectedServices.length === 0) {
    return { valid: false, error: 'Please select at least one service' };
  }

  // Check technician
  if (false && !BookingState.selectedTechnicianId) {
    return { valid: false, error: 'Please select a technician' };
  }

  // Check location
  if (!BookingState.customerLocation || !BookingState.customerLocation.lat) {
    return { valid: false, error: 'Please set your location' };
  }

  // Check date and time
  if (!BookingState.selectedDate) {
    return { valid: false, error: 'Please select a date' };
  }

  // In large-scale / project mode only a start date is chosen (no fixed time
  // slot), so skip the time-slot requirement there.
  const isProjectMode =
    (EnterpriseCalendar.isProjectMode && EnterpriseCalendar.isProjectMode()) ||
    BookingState.isProject === true ||
    !!BookingState.projectScheduling;
  if (!isProjectMode && !BookingState.selectedTimeSlot) {
    return { valid: false, error: 'Please select a time slot' };
  }

  // Check payment method
  if (!BookingState.paymentMethod) {
    return { valid: false, error: 'Please select a payment method' };
  }

  // Validate payment fields
  if (BookingState.paymentMethod === 'gcash') {
    const gcashNumber = document.getElementById('gcashNumber')?.value;
    const gcashProof = document.getElementById('gcashProof')?.files[0];

    if (!gcashNumber || !gcashProof) {
      return { valid: false, error: 'Please fill in all GCash payment fields (number and receipt)' };
    }
  } else if (BookingState.paymentMethod === 'cod') {
    const cashNumber = document.getElementById('cashNumber')?.value;

    if (!cashNumber) {
      return { valid: false, error: 'Please fill in all cash payment fields' };
    }
  }

  return { valid: true };
}

/**
 * Helper to convert file to base64
 */
const toBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.readAsDataURL(file);
  reader.onload = () => resolve(reader.result);
  reader.onerror = error => reject(error);
});

/**
 * Prepare booking data for submission
 */
async function prepareBookingData() {
  const bookingData = {
    // Multi-service booking
    isMultiService: true,
    services: BookingState.selectedServices.map(service => ({
      serviceId: service.serviceId || service._id,
      name: service.name,
      type: service.type || (service.isRepair ? 'repair' : 'core'),
      quantity: service.quantity || 1,
      unitPrice: service.unitPrice || service.price || 0,
      totalPrice: (service.unitPrice || service.price || 0) * (service.quantity || 1),
      hp: service.hp,
      hpDescription: service.hpDescription,
      airconType: service.airconType,
      airconTypeName: service.airconTypeName,
      applianceType: service.applianceType,
      applianceTypeName: service.applianceTypeName,
      brand: service.brand,
      duration: service.duration,
      isAirconService: service.isAirconService,
      repairIssue: service.repairIssue,
      initialCost: service.type === 'repair' ? (service.unitPrice || service.price || 0) : undefined
    })),

    // Totals
    totalPrice: BookingState.totalFee || 0,
    totalInitialCost: BookingState.servicesTotal || 0,
    travelFare: BookingState.travelFare || 0,
    travelDurationMinutes: BookingState.travelDuration || 0,
    distanceKm: BookingState.distance || 0,

    // Technician
    technicianId: BookingState.selectedTechnicianId,

    // Location
    location: {
      address: BookingState.customerLocation.address,
      lat: BookingState.customerLocation.lat,
      lng: BookingState.customerLocation.lng,
      coordinates: {
        type: 'Point',
        coordinates: [BookingState.customerLocation.lng, BookingState.customerLocation.lat]
      }
    },

    technicianLocation: BookingState.technicianLocation ? {
      address: BookingState.technicianLocation.address,
      lat: BookingState.technicianLocation.lat,
      lng: BookingState.technicianLocation.lng,
      coordinates: {
        type: 'Point',
        coordinates: [BookingState.technicianLocation.lng, BookingState.technicianLocation.lat]
      }
    } : undefined,

    // Date and time — startTime is the customer's requested start time.
    // The server computes the capacity end point (service + travel + buffer)
    // for overlap checks on future bookings. In project mode there is no
    // fixed time slot, so these are left undefined and overridden below.
    bookingDate: formatDateKey(new Date(BookingState.selectedDate)),
    startTime: BookingState.selectedTimeSlot
      ? (BookingState.selectedTimeSlot.startTime || BookingState.selectedTimeSlot.label)
      : undefined,
    selectedTimeLabel: BookingState.selectedTimeSlot
      ? (BookingState.selectedTimeSlot.startTime || BookingState.selectedTimeSlot.label)
      : undefined,

    // Payment
    paymentMethod: BookingState.paymentMethod,
    paymentStatus: 'pending',
    status: 'pending'
  };

  // ── Large-scale / project scheduling ──────────────────────────────────
  const isProjectMode =
    (EnterpriseCalendar.isProjectMode && EnterpriseCalendar.isProjectMode()) ||
    BookingState.isProject === true ||
    !!BookingState.projectScheduling;
  if (isProjectMode && BookingState.projectScheduling) {
    const ps = BookingState.projectScheduling;
    bookingData.isProject = true;
    bookingData.status = 'pending_project_scheduling';
    bookingData.bookingDate = formatDateKey(new Date(ps.preferredStartDate || ps.date));
    bookingData.startTime = undefined;
    bookingData.selectedTimeLabel = undefined;
    const serviceDuration = BookingState.selectedServices?.reduce((t, s) => t + ((s.duration || 60) * (s.quantity || 1)), 0) || 0;
    bookingData.projectScheduling = {
      preferredStartDate: formatDateKey(new Date(ps.preferredStartDate || ps.date)),
      preferredWorkingDays: (ps.preferences && ps.preferences.workingDays) || [],
      preferredWorkingHours: ps.preferences ? { start: ps.preferences.preferredWorkingHours || 'morning', end: '' } : undefined,
      preferredCompletionDeadline: ps.preferences && ps.preferences.completionDeadline ? formatDateKey(new Date(ps.preferences.completionDeadline)) : undefined,
      estimatedTotalHours: Math.round((serviceDuration / 60) * 10) / 10
    };
    // Project-level unit count (drives totalUnits on the admin project).
    // Default to the customer's actual selected service quantities so the
    // per-service quantity entered in the UI is never lost.
    const customerQtySum = BookingState.selectedServices?.reduce((t, s) => t + (Number(s.quantity) || 1), 0) || 0;
    const psUnits = ps.preferences && ps.preferences.totalUnits ? parseInt(ps.preferences.totalUnits, 10) : 0;
    bookingData.quantity = psUnits > 0 ? psUnits : (customerQtySum > 0 ? customerQtySum : 1);
  }

  // Add payment-specific fields
  if (BookingState.paymentMethod === 'gcash') {
    bookingData.gcashNumber = document.getElementById('gcashNumber')?.value;

    // Process file upload dynamically
    const proofFile = document.getElementById('gcashProof')?.files[0];
    if (proofFile) {
      try {
        bookingData.proofImageBase64 = await toBase64(proofFile);
      } catch (e) {
        console.error("Failed to parse proof image:", e);
      }
    }
  } else if (BookingState.paymentMethod === 'cod') {
    bookingData.gcashNumber = document.getElementById('cashNumber')?.value;
    bookingData.downpaymentAmount = 400;
    bookingData.paymentNotes = document.getElementById('cashNotes')?.value;

    // Process Cash proof file upload
    const proofFile = document.getElementById('cashProof')?.files[0];
    if (proofFile) {
      try {
        bookingData.proofImageBase64 = await toBase64(proofFile);
      } catch (e) {
        console.error("Failed to parse proof image:", e);
      }
    }
  }

  return bookingData;
}

/**
 * Show booking success receipt modal
 */
function showBookingSuccessModal(result) {
  console.log('🎉 Showing booking success modal');

  // Update receipt details
  const bookingRef = document.getElementById('receiptBookingRef');
  const serviceName = document.getElementById('receiptServiceName');
  const date = document.getElementById('receiptDate');
  const time = document.getElementById('receiptTime');
  const location = document.getElementById('receiptLocation');
  const paymentMethod = document.getElementById('receiptPaymentMethod');
  const total = document.getElementById('receiptTotal');

  // Fill receipt data
  if (bookingRef) bookingRef.textContent = result.bookingReference || 'BK-XXXXXX';

  // Show ALL selected services (not just the first)
  if (serviceName) {
    const allServices = BookingState.selectedServices?.map(s => s.name).join(', ') || 'Service';
    serviceName.textContent = allServices;
  }

  // Detailed per-service breakdown: brand, type, quantity, fee, duration
  const breakdown = document.getElementById('receiptServiceBreakdown');
  if (breakdown && BookingState.selectedServices && BookingState.selectedServices.length) {
    const fmt = (n) => `₱${Number(n || 0).toLocaleString()}`;
    const rows = BookingState.selectedServices.map((s, i) => {
      const brand = s.brand ? s.brand : '—';
      const type = s.applianceTypeName || (s.applianceType ? s.applianceType : '—');
      const qty = s.quantity || 1;
      const unit = s.totalPrice ? fmt(s.totalPrice / qty) : fmt(s.totalPrice || 0);
      const durMin = (s.duration || 60) * qty;
      const durH = durMin >= 60 ? `${(durMin / 60).toFixed(1)} hr` : `${durMin} min`;
      return `
        <div class="receipt-svc-item border rounded p-2 mb-2" style="background:#f8fafc;">
          <div class="d-flex justify-content-between align-items-center">
            <span class="fw-semibold" style="font-size:0.9rem;color:#0f172a;">${i + 1}. ${s.name}</span>
            <span class="fw-bold" style="color:#059669;">${fmt(s.totalPrice || 0)}</span>
          </div>
          <div class="text-muted small mt-1" style="font-size:0.78rem;line-height:1.6;">
            <div><i class="bi bi-upc-scan me-1 text-primary"></i><strong>Brand:</strong> ${brand}</div>
            <div><i class="bi bi-tag-fill me-1 text-primary"></i><strong>Type:</strong> ${type}</div>
            <div><i class="bi bi-hash me-1 text-primary"></i><strong>Quantity:</strong> ${qty} &nbsp;·&nbsp; <strong>Unit Price:</strong> ${unit}</div>
            <div><i class="bi bi-clock me-1 text-primary"></i><strong>Est. Service Duration:</strong> ${durH}</div>
          </div>
        </div>`;
    }).join('');
    breakdown.innerHTML = rows;
    breakdown.style.display = '';
  } else if (breakdown) {
    breakdown.style.display = 'none';
  }

  // Format date nicely
  if (date) {
    try {
      const d = new Date(BookingState.selectedDate);
      date.textContent = d.toLocaleDateString('en-PH', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      });
    } catch (e) {
      date.textContent = BookingState.selectedDate ? new Date(BookingState.selectedDate).toLocaleDateString() : 'Date';
    }
  }

  if (time) time.textContent = BookingState.selectedTimeSlot?.label || 'Time';
  if (location) location.textContent = BookingState.customerLocation?.address || 'Location';
  if (paymentMethod) paymentMethod.textContent = BookingState.paymentMethod === 'gcash' ? 'GCash' : 'Cash on Delivery';

  // Show payment breakdown
  const totalFee = BookingState.totalFee || 0;
  const isCOD = BookingState.paymentMethod === 'cod';
  const downpayment = 400;
  const balance = Math.max(0, totalFee - downpayment);

  const breakdownEl = document.getElementById('receiptPaymentBreakdown');
  const fullPayEl = document.getElementById('receiptFullPayment');

  if (isCOD && breakdownEl) {
    breakdownEl.style.display = '';
    if (fullPayEl) fullPayEl.style.display = 'none';
    document.getElementById('receiptTotalFee').textContent = `₱${totalFee.toLocaleString()}`;
    document.getElementById('receiptDownpayment').textContent = `-₱${downpayment.toLocaleString()}`;
    document.getElementById('receiptBalance').textContent = `₱${balance.toLocaleString()}`;
  } else if (fullPayEl) {
    fullPayEl.style.display = '';
    if (breakdownEl) breakdownEl.style.display = 'none';
    document.getElementById('receiptTotal').textContent = `₱${totalFee.toLocaleString()}`;
  }

  // Show success modal
  const modal = document.getElementById('bookingSuccessModal');
  if (modal) {
    const existing = bootstrap.Modal.getInstance(modal);
    if (existing) existing.dispose();
    const bsModal = new bootstrap.Modal(modal, {
      backdrop: 'static',
      keyboard: false
    });
    modal.addEventListener('hidden.bs.modal', () => { window.location.reload(); }, { once: true });
    bsModal.show();
    console.log('✅ Booking success modal shown');
  }
}

/**
 * View booking history (redirect to book history page)
 */
function viewBookingHistory() {
  console.log('📚 Redirecting to booking history...');

  // Close modal first
  const modal = bootstrap.Modal.getInstance(document.getElementById('bookingSuccessModal'));
  if (modal) {
    modal.hide();
  }

  // Redirect to book history page
  setTimeout(() => {
    window.location.href = '/customer/bookings';
  }, 300);
}

/**
 * Close booking success modal
 */
function closeBookingSuccessModal() {
  console.log('❌ Closing booking success modal');

  const modal = bootstrap.Modal.getInstance(document.getElementById('bookingSuccessModal'));
  if (modal) {
    modal.hide();
  }

  // Reset booking state
  resetBookingState();
}

/**
 * Show booking success message (fallback)
 */
function showBookingSuccess(result) {
  console.log('🎉 Showing success message');

  // Try to show modal first
  try {
    showBookingSuccessModal(result);
  } catch (error) {
    console.warn('⚠️ Could not show modal, using fallback:', error);

    // Fallback to alert
    alert(`Booking created successfully!\nReference: ${result.bookingReference || result._id}\n\nYou will be redirected to your bookings page.`);

    // Redirect to bookings page
    setTimeout(() => {
      window.location.href = '/customer/bookings';
    }, 2000);
  }
}

/**
 * Helper: Convert time string to minutes
 */
function timeToMinutes(timeStr) {
  const [time, period] = timeStr.split(' ');
  const [hours, minutes] = time.split(':').map(Number);
  let totalMinutes = minutes;

  if (period === 'PM' && hours !== 12) {
    totalMinutes += (hours + 12) * 60;
  } else if (period === 'AM' && hours === 12) {
    totalMinutes += 0;
  } else {
    totalMinutes += hours * 60;
  }

  return totalMinutes;
}

/**
 * Initialize when DOM is ready
 */
// DOMContentLoaded is already handled inside initMultiServiceBooking (line 80-82)
// No duplicate registration needed here.

// Export for use in other scripts
window.BookingSystem = {
  getBookingData,
  selectedServices: () => BookingState.selectedServices,
  totalPrice: () => BookingState.totalEstimatedPrice,
  hasRepairServices: () => BookingState.hasRepairServices,
  continueToServices,
  loadTechnicianOptions,
  // Step 5 Scheduling Functions
  initializeSchedulingModes,
  switchSchedulingMode,
  showModeSelection,
  renderAISuggestedDates,
  renderManualCalendar,
  selectDate,
  renderTimeSlotsProfessional,
  previousMonth,
  nextMonth,
  // Step 6 Fee Display
  displayTotalFee,
  // Step 7 Payment Functions
  initializePaymentStep,
  handleBookingSubmission,
  validateBookingData,
  prepareBookingData,
  testTechnicians: async () => {
    console.log('🧪 Testing technician API...');
    try {
      const resp = await fetch("/api/services/technicians");
      const data = await resp.json();
      console.log('Technician API response:', data);
      return data;
    } catch (err) {
      console.error('Technician API error:', err);
      return null;
    }
  },
  testAdvance: () => {
    advanceToNextStep();
  },
  testShowStep: (step) => {
    showStep(step);
  }
};

// Also expose continueToServices globally for inline onclick handlers
window.continueToServices = continueToServices;
window.loadTechnicianOptions = loadTechnicianOptions;
window.showModeSelection = showModeSelection;
window.viewBookingHistory = viewBookingHistory;
