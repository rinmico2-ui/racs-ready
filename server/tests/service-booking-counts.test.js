"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyServiceBookingCounts,
  buildServiceBookingCountPipeline,
  getServiceBookingCounts,
} = require("../utils/serviceBookingCounts");

test("service booking counts prefer the authoritative services array and fall back to legacy serviceId", () => {
  const serviceIds = ["core-a", "core-b"];
  const pipeline = buildServiceBookingCountPipeline(serviceIds);
  const projection = pipeline[0].$project.bookingServiceIds.$let;
  const selectedIds = projection.in.$setUnion[0].$cond;

  assert.deepEqual(
    projection.vars.embeddedServiceIds.$map.input.$filter.input,
    { $ifNull: ["$services", []] },
  );
  assert.deepEqual(projection.vars.legacyServiceId, {
    $ifNull: ["$serviceId", { $ifNull: ["$service._id", null] }],
  });
  assert.deepEqual(selectedIds[0], {
    $gt: [{ $size: "$$embeddedServiceIds" }, 0],
  });
  assert.equal(selectedIds[1], "$$embeddedServiceIds");
  assert.deepEqual(selectedIds[2].$cond[1], ["$$legacyServiceId"]);
  assert.deepEqual(pipeline[2], {
    $match: { bookingServiceIds: { $in: serviceIds } },
  });
  assert.deepEqual(pipeline[3].$group._id, {
    bookingId: "$_id",
    serviceId: "$bookingServiceIds",
  });
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
