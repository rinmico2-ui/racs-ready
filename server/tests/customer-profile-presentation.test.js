"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { customerProfilePresentation } = require("../utils/customerProfilePresentation");

const customer = {
  _id: "507f1f77bcf86cd799439011", firstName: "Maria", lastName: "Santos",
  email: "maria@example.test", phone: "09171234567",
};

test("a customer with contact details can see exactly which address fields are missing", () => {
  const profile = customerProfilePresentation(customer);
  assert.equal(profile.percent, 50);
  assert.equal(profile.filled, 4);
  assert.equal(profile.total, 8);
  assert.deepEqual(profile.groups.filter(group => !group.complete).map(group => group.key), ["address"]);
  assert.deepEqual(profile.groups[2].missingLabels, ["Province", "City / municipality", "Barangay", "ZIP code"]);
  assert.equal(profile.nextTarget, "profile-addressProvince");
});

test("progress guides a nearly complete customer to the one remaining field", () => {
  const address = { province: "Laguna", city: "Calamba", barangay: "Real", postalCode: " " };
  const incomplete = customerProfilePresentation({ ...customer, address });
  assert.equal(incomplete.percent, 88);
  assert.equal(incomplete.nextTarget, "profile-addressPostal");
  assert.deepEqual(incomplete.groups[2].missingLabels, ["ZIP code"]);
  const complete = customerProfilePresentation({ ...customer, address: { ...address, postalCode: "4027" } });
  assert.equal(complete.percent, 100);
  assert.equal(complete.nextTarget, null);
  assert.ok(complete.groups.every(group => group.complete));
});

test("empty and malformed legacy values are not counted as completed details", () => {
  const profile = customerProfilePresentation({ firstName: "  ", lastName: {}, email: [], phone: null, address: { province: {} } });
  assert.equal(profile.percent, 0);
  assert.equal(profile.nextTarget, "profileFirstName");
  assert.equal(customerProfilePresentation(null).percent, 0);
});

test("generated avatars stay stable through profile edits and vary between accounts", () => {
  const original = customerProfilePresentation(customer).avatar;
  const edited = customerProfilePresentation({ ...customer, firstName: "Ana", email: "ana@example.test", phone: "09998887777" }).avatar;
  assert.deepEqual(edited, original);
  const avatars = new Set(Array.from({ length: 20 }, (_, index) => JSON.stringify(customerProfilePresentation({ ...customer, _id: `customer-${index}` }).avatar)));
  assert.ok(avatars.size > 1);
  const untrusted = customerProfilePresentation({ _id: '<svg onload="alert(1)">', email: "private@example.test" }).avatar;
  assert.doesNotMatch(JSON.stringify(untrusted), /onload|private|example/);
  for (const color of [untrusted.background, untrusted.body, untrusted.accent, untrusted.dark]) assert.match(color, /^#[a-f0-9]{6}$/);
});
