"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = relativePath => fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
const view = read("views/pages/services.ejs");
const script = read("public/js/services-multi.js");
const calendar = read("public/js/enterprise-calendar.js");
const styles = read("public/css/services-mobile-ux.css");
const psgcRoutes = read("routes/psgcRoutes.js");

test("booking journey uses six customer-facing stages without login as a progress step", () => {
  for (const label of ["Service", "Details", "Location", "Schedule", "Review", "Payment"]) {
    assert.match(view, new RegExp(`<span>${label}<\\/span>`));
  }
  assert.doesNotMatch(view, /class="ent-n[^>]*>[\s\S]*?<span>Login<\/span>/);
  assert.match(script, /Signed-in customers land[\s\S]*?showStep\(2\)/);
});

test("hero gives first-time customers one obvious path into the booking form", () => {
  assert.match(view, /href="#bookingContainer" class="ent-hero-cta"/);
  assert.match(view, /Start Booking/);
  assert.match(styles, /\.ent-hero-cta\s*\{[\s\S]*?min-height:\s*50px/);
});

test("service and repair questions use clear simple English", () => {
  assert.match(view, /What service do you need\?/);
  assert.match(view, /Which appliance needs repair\?/);
  assert.match(view, /What is wrong\?/);
  assert.match(view, /Do you have a photo\?/);
  assert.match(view, /This is optional/);
  assert.doesNotMatch(script, /Duration TBD|>HP-based</);
});

test("selected services behave like a responsive booking cart", () => {
  assert.match(view, /class="service-selection-layout"/);
  assert.match(view, /id="selectedServicesSummary"[\s\S]*?Your Booking/);
  assert.match(view, /id="bookingNextActionText"[\s\S]*?Choose a service/);
  assert.match(view, /id="mobileBookingBar"[\s\S]*?Next[\s\S]*?Add Location/);
  assert.match(styles, /\.booking-cart-panel\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(styles, /\.mobile-booking-bar\.has-services\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(script, /function toggleBookingSummary\(forceOpen\)/);
  assert.match(script, /function syncServiceCardSelectionState\(\)/);
});

test("booking review opens on demand from responsive launchers", () => {
  assert.doesNotMatch(view, /id="selectedServicesGuide"/);
  assert.match(view, /id="serviceListGuide"[\s\S]*?id="serviceListGuideText"/);
  assert.match(view, /id="serviceGuideReview"[\s\S]*?Check Your Booking[\s\S]*?id="serviceGuideReviewText"/);
  assert.match(view, /id="mobileBookingSummaryButton"[\s\S]*?Check Booking/);
  assert.match(script, /document\.body\.appendChild\(summary\)/);
  assert.match(script, /reviewButton\.classList\.toggle\('has-selection', count > 0\)/);
  assert.match(script, /function openSelectedServiceSummary\(event\)[\s\S]*?toggleBookingSummary\(true\)/);
  assert.match(script, /summary\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(styles, /#serviceSelection\.step-active\s*\{\s*transform:\s*none !important/);
  assert.match(styles, /\.booking-cart-panel\s*\{[\s\S]*?visibility:\s*hidden/);
  assert.match(styles, /\.service-guide-review\.has-selection\s*\{[\s\S]*?background:\s*#f0fdf4/);
  assert.match(styles, /\.mobile-booking-bar\.has-services\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(styles, /\.booking-cart-panel\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column/);
  assert.match(view, /class="booking-cart-footer"[\s\S]*?id="continueActionLabel"/);
});

test("service cards show a clear selected state and booking actions", () => {
  assert.match(script, /<span>Add<\/span>/);
  assert.match(script, /<span>Selected<\/span>/);
  assert.match(script, /Change \$\{esc\(service\.name\)\}/);
  assert.match(script, /Remove \$\{esc\(service\.name\)\}/);
  assert.match(styles, /\.service-card\.is-selected[\s\S]*?border:\s*2px solid #16a34a/);
});

test("step two shows four services per page without clearing selections", () => {
  assert.match(script, /const CORE_SERVICES_PER_PAGE = 4/);
  assert.match(script, /coreServices\.slice\(pageStart, pageStart \+ CORE_SERVICES_PER_PAGE\)/);
  assert.match(script, /function changeCoreServicePage\(direction\)/);
  assert.doesNotMatch(script, /function changeCoreServicePage[\s\S]*?BookingState\.selectedServices\s*=\s*\[\]/);
  assert.match(view, /id="coreServicePrev"[\s\S]*?Previous/);
  assert.match(view, /id="coreServiceNext"[\s\S]*?Next/);
  assert.match(view, /id="coreServicePageLabel"[^>]*>Page 1 of 1/);
  assert.match(view, /id="coreServicePrev"[\s\S]*?bi-chevron-left[\s\S]*?id="coreServicePageLabel"[\s\S]*?id="coreServiceNext"[\s\S]*?bi-chevron-right/);
  assert.match(view, /class="service-list-jump"[\s\S]*?View Service List[\s\S]*?bi-arrow-down/);
  assert.match(view, /class="service-list-jump-wrap"[\s\S]*?class="service-list-jump"/);
  assert.match(styles, /\.service-list-jump-wrap\s*\{[^}]*justify-content:\s*center/);
  assert.match(script, /function scrollToCoreServiceList\(\)/);
});

test("service cards keep one primary choice while repair appliances paginate", () => {
  assert.doesNotMatch(view, /id="serviceDetailsModal"/);
  assert.doesNotMatch(script, /service-card-detail-link|openServiceDetails/);
  assert.match(script, /const REPAIR_UNITS_PER_PAGE = 4/);
  assert.match(script, /function changeRepairUnitPage\(direction\)/);
  assert.match(script, /I don't know/);
  assert.match(styles, /\.sub-unit-chips\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2/);
});

test("step two guides customers through selection and repair one field at a time", () => {
  assert.match(view, /class="service-picker-guide"[\s\S]*?Choose a Service[\s\S]*?Add[\s\S]*?Check Your Booking/);
  assert.match(view, /id="serviceGuideChoose"[\s\S]*?Choose a Service[\s\S]*?See the list below[\s\S]*?bi-arrow-down/);
  assert.match(view, /id="repairGuide"[\s\S]*?Appliance[\s\S]*?Type[\s\S]*?Details[\s\S]*?Problem[\s\S]*?Photo/);
  assert.match(script, /function getRepairGuideStep\(\)/);
  assert.match(script, /function goToRepairGuideStep\(requestedStep, options = \{\}\)/);
  assert.match(script, /selectUnitCategory\(category\)[\s\S]*?goToRepairGuideStep\(2/);
  assert.match(script, /selectSubUnit\(value, element\)[\s\S]*?goToRepairGuideStep\(3/);
  assert.match(script, /select\.addEventListener\('change',[\s\S]*?document\.getElementById\('unitModel'\)\?\.focus\(\)/);
  assert.match(script, /qtyInput\.addEventListener\('blur',[\s\S]*?continueRepairDetails\(\)/);
  assert.match(script, /problemEl\.addEventListener\('blur',[\s\S]*?continueRepairProblem\(\)/);
  assert.match(script, /function toggleSymptom\(element, symptom\)[\s\S]*?textarea\.focus\(\{ preventScroll: true \}\)/);
  assert.match(view, /id="repairDetailsNext"[\s\S]*?Next: Describe the Problem/);
  assert.match(view, /id="repairProblemNext"[\s\S]*?Next: Photo \(Optional\)/);
  assert.match(view, /id="repairReviewSummary"[\s\S]*?Inspection fee/);
  assert.match(styles, /\.rp-section\[data-rp-step\]\.is-locked\s*\{\s*display:\s*none/);
  assert.match(styles, /\.repair-guide\s*\{[\s\S]*?position:\s*sticky/);
});

test("location, price, payment, and success states answer the customer's key questions", () => {
  assert.match(view, /Where should the technician go\?/);
  assert.match(view, /id="locationInput"/);
  assert.match(view, /Use This Address/);
  assert.match(view, /Loading your saved address/);
  assert.match(script, /function resolveSavedAccountAddress\(button\)[\s\S]*?\/api\/psgc\/resolve/);
  assert.match(script, /geocodeAddress\(address, finalize = false, mapReadyAttempt = 0\)/);
  assert.match(script, /function guideToSavedAddressRoute\(attempt = 0\)[\s\S]*?fitServiceRouteBtn[\s\S]*?scrollIntoView/);
  assert.match(view, /id="servicePinConfirm"[\s\S]*?Yes, this is the place/);
  assert.match(view, /id="pinTypedAddressBtn"[^>]*>[\s\S]*?Place a pin on the map/);
  assert.match(script, /function getTypedServiceAddressForPin\(\)[\s\S]*?return typed/);
  assert.match(script, /map\.on\('click',[\s\S]*?const manualAddress = getTypedServiceAddressForPin\(\)/);
  assert.match(script, /const address = manualAddress \|\| data\.display_name/);
  assert.match(script, /reverseGeocode\(lat, lng, requestToken, \{ preserveManualAddress: Boolean\(manualAddress\), requirePinConfirmation: true \}\)/);
  assert.match(script, /location: \{\s*address: BookingState\.customerLocation\.address,[\s\S]*?coordinates: \[BookingState\.customerLocation\.lng, BookingState\.customerLocation\.lat\]/);
  assert.match(script, /location\.pinConfirmed === false[\s\S]*?Check Map Pin/);
  assert.match(script, /BookingState\.guideToSavedAddressRoute = true[\s\S]*?setSavedAddressActionState\('loading'\)/);
  assert.match(styles, /\.service-checkout-map-card\.route-result-arrival\s*\{[^}]*animation:\s*locationRouteArrival/);
  assert.match(script, /function showLocationTurnOnPrompt\(retryButton, reason = 'unavailable'\)/);
  assert.match(script, /title: 'Turn On Your Location'[\s\S]*?Turn on <strong>Location<\/strong> or <strong>GPS<\/strong>/);
  assert.match(script, /confirmButtonText: '[^']*Try Again'[\s\S]*?cancelButtonText: 'Enter Address Instead'/);
  assert.match(script, /if \(error\.code === 1\)[\s\S]*?if \(error\.code === 2\)/);
  assert.match(psgcRoutes, /router\.get\('\/resolve'[\s\S]*?const addressCityCodes = codes\.filter/);
  assert.ok(view.indexOf('id="locationDetailsTitle"') < view.indexOf('id="technicianMap"'));
  assert.match(view, /id="locationContinueButton"[\s\S]*?id="locationContinueLabel"/);
  assert.match(script, /function syncLocationContinueAction\(\)[\s\S]*?Checking Route[\s\S]*?Continue to Schedule/);
  assert.match(styles, /\.location-next-action\.is-visible\s*\{[\s\S]*?position:\s*fixed/);
  assert.match(view, /Estimated Price/);
  assert.match(view, /Amount to pay now/);
  assert.match(view, /Booking Request Submitted!/);
  assert.match(view, /What happens next\?/);
  assert.match(script, /addr\.barangay, addr\.city, addr\.province, addr\.postalCode/);
});

test("mobile actions stay reachable and unavailable schedules provide a next action", () => {
  assert.match(styles, /\.booking-primary-action\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?bottom:\s*0/);
  assert.match(calendar, /No times are available on this date/);
  assert.match(calendar, /Choose another highlighted date/);
});

test("adding a service reveals a specific next-step action on desktop and mobile", () => {
  assert.match(view, /id="mobileBookingBar"[\s\S]*?Next[\s\S]*?Add Location/);
  assert.match(styles, /\.mobile-booking-bar\.has-services\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?display:\s*grid/);
  assert.match(styles, /\.mobile-booking-bar\.is-guiding\s*\{[^}]*animation:\s*bookingNextActionPop/);
  assert.match(script, /function showServiceAddedConfirmation\(serviceName\)[\s\S]*?revealNextBookingAction\(\)/);
  assert.match(script, /function syncBookingActionBarLayer\(\)[\s\S]*?document\.body\.appendChild\(actionBar\)/);
  assert.match(script, /actionBar\.querySelector\('\.mobile-booking-continue'\)\?\.focus\(\{ preventScroll: true \}\)/);
  assert.match(script, /bookingNextStepAnnouncement/);
  assert.match(script, /\$\{serviceName\} was added\. Next: add the service location\./);
});

