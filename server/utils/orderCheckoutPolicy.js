const axios = require("axios");

// Existing delivery-only orders remain readable, but new checkouts must end
// in either professional installation or an explicit store pickup.
const FULFILLMENT_TYPES = new Set(["delivery_installation", "customer_pickup"]);
const DELIVERY_PAYMENT_METHODS = new Set(["cod", "gcash_full"]);
const PICKUP_PAYMENT_METHODS = new Set(["cash_onsite", "gcash_full"]);
const MAX_CHECKOUT_LINE_ITEMS = 50;
const MAX_CHECKOUT_UNITS = 40;

const DEFAULT_STORE_HOURS = Object.freeze([
  { dayOfWeek: 0, open: false, startMinutes: 0, endMinutes: 0 },
  { dayOfWeek: 1, open: true, startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 2, open: true, startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 3, open: true, startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 4, open: true, startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 5, open: true, startMinutes: 480, endMinutes: 1080 },
  { dayOfWeek: 6, open: true, startMinutes: 480, endMinutes: 1080 },
]);

class OrderCheckoutError extends Error {
  constructor(message, status = 400, code = "ORDER_CHECKOUT_INVALID") {
    super(message);
    this.name = "OrderCheckoutError";
    this.status = status;
    this.code = code;
  }
}

function parseDateOnly(value) {
  const match = String(value || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day, 0, 0, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function normalizeCoordinates(value) {
  const lat = Number(value?.lat ?? value?.[1]);
  const lng = Number(value?.lng ?? value?.[0]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new OrderCheckoutError("Select a valid delivery location on the map.", 400, "ORDER_LOCATION_REQUIRED");
  }
  return { lat, lng };
}

function validateCheckoutItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_CHECKOUT_LINE_ITEMS) {
    throw new OrderCheckoutError(`Add between 1 and ${MAX_CHECKOUT_LINE_ITEMS} products before checkout.`, 400, "ORDER_ITEMS_INVALID");
  }
  const seenInventoryIds = new Set();
  let totalUnits = 0;
  const normalized = items.map(item => {
    const inventoryId = String(item?.inventoryId || "").trim();
    const quantity = Number(item?.quantity);
    if (!/^[a-f\d]{24}$/i.test(inventoryId) || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_CHECKOUT_UNITS) {
      throw new OrderCheckoutError(`Every product requires a valid quantity between 1 and ${MAX_CHECKOUT_UNITS}.`, 400, "ORDER_ITEM_QUANTITY_INVALID");
    }
    if (seenInventoryIds.has(inventoryId)) {
      throw new OrderCheckoutError("Duplicate products are not allowed in checkout. Update the quantity on the existing cart line.", 400, "ORDER_ITEM_DUPLICATE");
    }
    seenInventoryIds.add(inventoryId);
    totalUnits += quantity;
    return { inventoryId, quantity };
  });
  if (totalUnits > MAX_CHECKOUT_UNITS) {
    throw new OrderCheckoutError(`A checkout cannot contain more than ${MAX_CHECKOUT_UNITS} total units.`, 400, "ORDER_UNIT_LIMIT_EXCEEDED");
  }
  return normalized;
}

function isFutureBusinessDate(date, now = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return false;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return date.getTime() > today.getTime();
}

function normalizeStoreHours(value) {
  const source = Array.isArray(value) && value.length ? value : DEFAULT_STORE_HOURS;
  return source.map(row => ({
    dayOfWeek: Number(row.dayOfWeek),
    open: Boolean(row.open),
    startMinutes: Math.max(0, Math.min(1439, Number(row.startMinutes) || 0)),
    endMinutes: Math.max(0, Math.min(1440, Number(row.endMinutes) || 0)),
  }));
}

function validatePickupDate(value, storeHours, now = new Date()) {
  const date = parseDateOnly(value);
  if (!date || !isFutureBusinessDate(date, now)) {
    throw new OrderCheckoutError("Choose a valid future pickup date.", 400, "ORDER_PICKUP_DATE_INVALID");
  }
  const hours = normalizeStoreHours(storeHours);
  const day = hours.find(row => row.dayOfWeek === date.getDay());
  if (!day?.open || day.endMinutes <= day.startMinutes) {
    throw new OrderCheckoutError("The store is closed on the selected pickup date.", 409, "ORDER_PICKUP_STORE_CLOSED");
  }
  return date;
}

function validateCheckoutSelection(input, { storeHours, now = new Date() } = {}) {
  const fulfillmentType = String(input?.fulfillmentType || "").trim();
  const paymentMethod = String(input?.paymentMethod || "").trim();
  if (!FULFILLMENT_TYPES.has(fulfillmentType)) {
    throw new OrderCheckoutError("Choose a supported fulfillment option.", 400, "ORDER_FULFILLMENT_INVALID");
  }

  const allowedPayments = fulfillmentType === "customer_pickup" ? PICKUP_PAYMENT_METHODS : DELIVERY_PAYMENT_METHODS;
  if (!allowedPayments.has(paymentMethod)) {
    throw new OrderCheckoutError("Choose a payment method available for this fulfillment option.", 400, "ORDER_PAYMENT_METHOD_INVALID");
  }

  if (fulfillmentType === "customer_pickup") {
    return {
      fulfillmentType,
      paymentMethod,
      pickupDate: validatePickupDate(input.pickupDate, storeHours, now),
      delivery: null,
      timeSlot: null,
    };
  }

  const address = String(input?.delivery?.address || "").trim();
  const contactNumber = String(input?.delivery?.contactNumber || "").trim();
  const preferredDate = parseDateOnly(input?.delivery?.preferredDate);
  const timeSlot = String(input?.timeSlot || "").trim();
  if (address.length < 8) {
    throw new OrderCheckoutError("Enter a complete delivery address.", 400, "ORDER_DELIVERY_ADDRESS_REQUIRED");
  }
  const contactDigits = contactNumber.replace(/\D/g, "");
  if (!/^[+\d().\-\s]+$/.test(contactNumber) || contactDigits.length < 7 || contactDigits.length > 15) {
    throw new OrderCheckoutError("Enter a valid delivery contact number.", 400, "ORDER_CONTACT_INVALID");
  }
  if (!preferredDate || !isFutureBusinessDate(preferredDate, now)) {
    throw new OrderCheckoutError("Choose a valid future delivery date.", 400, "ORDER_DELIVERY_DATE_INVALID");
  }
  if (!timeSlot) {
    throw new OrderCheckoutError("Choose an available delivery time.", 400, "ORDER_TIME_REQUIRED");
  }

  return {
    fulfillmentType,
    paymentMethod,
    pickupDate: null,
    timeSlot,
    delivery: {
      address: address.slice(0, 500),
      contactNumber: contactNumber.slice(0, 50),
      preferredDate,
      notes: String(input?.delivery?.notes || "").trim().slice(0, 1000),
      coordinates: normalizeCoordinates(input?.delivery?.coordinates),
    },
  };
}

function haversineDistanceKm(from, to) {
  const earthRadiusKm = 6371;
  const radians = degrees => degrees * Math.PI / 180;
  const dLat = radians(to.lat - from.lat);
  const dLng = radians(to.lng - from.lng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLng / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function authoritativeDeliveryQuote({ origin, destination, farePerKm, httpClient = axios }) {
  const from = normalizeCoordinates(origin);
  const to = normalizeCoordinates(destination);
  const rate = Number(farePerKm);
  if (!Number.isFinite(rate) || rate < 0) {
    throw new OrderCheckoutError("The delivery rate is not configured correctly.", 503, "ORDER_DELIVERY_RATE_INVALID");
  }

  let distanceKm;
  let durationMin;
  let geometry = null;
  let source = "estimated";
  try {
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&alternatives=false&steps=false`;
    const response = await httpClient.get(url, { timeout: 5000 });
    const route = response?.data?.routes?.[0];
    if (!route || !Number.isFinite(Number(route.distance)) || !Number.isFinite(Number(route.duration))) {
      throw new Error("Routing provider returned no usable route");
    }
    distanceKm = Number(route.distance) / 1000;
    durationMin = Math.max(1, Math.round(Number(route.duration) / 60));
    geometry = route.geometry || null;
    source = "road";
  } catch (_) {
    distanceKm = haversineDistanceKm(from, to) * 1.4;
    durationMin = Math.max(1, Math.round(distanceKm * 3 + 10));
  }

  const roundedDistance = Math.round(Math.max(0, distanceKm) * 10) / 10;
  return {
    distanceKm: roundedDistance,
    durationMin,
    transportationFee: Math.round(roundedDistance * rate),
    farePerKm: rate,
    source,
    geometry,
  };
}

function initialOrderLifecycle(fulfillmentType, paymentMethod) {
  const payAtPickup = fulfillmentType === "customer_pickup" && paymentMethod === "cash_onsite";
  return {
    status: payAtPickup ? "preparing_unit" : "pending_payment",
    paymentStatus: "pending",
  };
}

module.exports = {
  DEFAULT_STORE_HOURS,
  OrderCheckoutError,
  authoritativeDeliveryQuote,
  haversineDistanceKm,
  initialOrderLifecycle,
  validateCheckoutItems,
  normalizeStoreHours,
  parseDateOnly,
  validateCheckoutSelection,
  validatePickupDate,
};
