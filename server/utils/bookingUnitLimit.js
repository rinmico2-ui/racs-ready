"use strict";

const MAX_BOOKING_UNITS = 40;

function validateBookingUnitLimit(services) {
  const quantities = services.map(service => Number(service?.quantity));
  if (quantities.some(quantity => !Number.isInteger(quantity) || quantity < 1)) {
    const error = new Error("Every service quantity must be a whole number of at least 1.");
    error.status = 400;
    throw error;
  }
  const total = quantities.reduce((sum, quantity) => sum + quantity, 0);
  if (total > MAX_BOOKING_UNITS) {
    const error = new Error(`A booking can contain at most ${MAX_BOOKING_UNITS} units across all Core and Repair services.`);
    error.status = 400;
    throw error;
  }
  return total;
}

module.exports = { MAX_BOOKING_UNITS, validateBookingUnitLimit };
