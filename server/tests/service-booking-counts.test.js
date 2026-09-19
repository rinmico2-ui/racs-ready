"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyServiceBookingCounts,
  buildServiceBookingCountPipeline,
  getServiceBookingCounts,
  normalizeServiceName,
} = require("../utils/serviceBookingCounts");

test("service booking counts reconcile current IDs and historical service names", () => {
  const services = [
    { _id: "core-a", name: "Aircon Installation" },
    { _id: "core-b", name: "Aircon Cleaning" },
  ];
  const pipeline = buildServiceBookingCountPipeline(services);
  const projection = pipeline[0].$project.bookingServices.$let;
  const selection = projection.in.$cond;

  assert.deepEqual(
    projection.vars.embeddedServices.$filter.input,
    { $ifNull: ["$services", []] },
  );
  assert.deepEqual(projection.vars.legacyServiceId, {
    $ifNull: ["$serviceId", { $ifNull: ["$service._id", null] }],
  });
  assert.deepEqual(selection[0], {
    $gt: [{ $size: "$$embeddedServices" }, 0],
  });
  assert.equal(selection[1], "$$embeddedServices");
  assert.equal(selection[2].$cond[1][0].serviceId, "$$legacyServiceId");
  const branches = pipeline[3].$set.matchedServiceId.$switch.branches;
  assert.deepEqual(branches[0], {
    case: { $eq: ["$bookingService.serviceId", "core-a"] },
    then: "core-a",
  });
  assert.deepEqual(branches[2], {
    case: { $eq: ["$normalizedBookingServiceName", "aircon installation"] },
    then: "core-a",
  });
  assert.deepEqual(pipeline[5].$group._id, {
    bookingId: "$_id",
    serviceId: "$matchedServiceId",
  });
});

test("service-name fallback is normalized and disabled for duplicate catalog names", () => {
  assert.equal(normalizeServiceName("  AIRCON Installation  "), "aircon installation");

  const pipeline = buildServiceBookingCountPipeline([
    { _id: "core-a", name: "Aircon Installation" },
    { _id: "core-b", name: " aircon installation " },
  ]);
  const branches = pipeline[3].$set.matchedServiceId.$switch.branches;

  assert.equal(branches.length, 2);
  assert.ok(branches.every((branch) => branch.case.$eq[0] === "$bookingService.serviceId"));
});

test("service booking counts map aggregate results onto catalog services", async () => {
  const services = [{ _id: "core-a" }, { _id: "core-b" }, { _id: "core-c" }];
  let receivedPipeline;
  const BookingService = {
    async aggregate(pipeline) {
      receivedPipeline = pipeline;
      return [
        { _id: "core-a", count: 4 },
        { _id: "core-b", count: 2 },
      ];
    },
  };

  const counts = await getServiceBookingCounts(BookingService, services);
  applyServiceBookingCounts(services, counts);

  assert.ok(Array.isArray(receivedPipeline));
  assert.deepEqual(services.map((service) => service.bookingCount), [4, 2, 0]);
});

test("service booking counts skip the database for an empty catalog", async () => {
  let aggregateCalled = false;
  const counts = await getServiceBookingCounts({
    async aggregate() {
      aggregateCalled = true;
      return [];
    },
  }, []);

  assert.equal(aggregateCalled, false);
  assert.equal(counts.size, 0);
});
