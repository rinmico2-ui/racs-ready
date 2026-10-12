"use strict";

const { normalizeServiceLocation } = require("./maintenanceLocation");

function cleanLocationText(value) {
  let text = String(value || "");
  // Repair UTF-8 bytes previously read as Latin-1, without changing already
  // valid Spanish/Filipino letters or replacing invalid sequences with '?'.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let pass = 0; pass < 2; pass++) {
    const repaired = text.replace(/[\u00c2-\u00f4][\u0080-\u00bf]{1,3}/g, sequence => {
      try { return decoder.decode(Uint8Array.from(sequence, char => char.charCodeAt(0))); }
      catch { return sequence; }
    });
    if (repaired === text) break;
    text = repaired;
  }
  return text;
}

function relocationLocations(move, bookingLocation) {
  const sameAddress = place => !place?.address || cleanLocationText(place.address).trim().toLowerCase()
    === cleanLocationText(bookingLocation?.address).trim().toLowerCase();
  const origin = { ...(sameAddress(move?.from) ? bookingLocation || {} : {}), ...(move?.from || {}),
    address: move?.from?.address || bookingLocation?.address || "" };
  const sameProperty = move?.scope === "same_property";
  const destination = sameProperty
    ? { ...(sameAddress(move?.to) ? bookingLocation || {} : {}), ...(move?.to || {}), address: move?.to?.address || bookingLocation?.address || "" }
    : move?.to || {};
  const present = location => ({ ...normalizeServiceLocation({ ...location, address: cleanLocationText(location.address) }),
    details: cleanLocationText(location.details) });
  return { from: present(origin), to: present(destination), sameProperty };
}

module.exports = { cleanLocationText, relocationLocations };
