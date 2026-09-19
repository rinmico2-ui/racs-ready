"use strict";

function normalizeServiceName(value) {
  return String(value || "").trim().toLowerCase();
}

function buildServiceBookingCountPipeline(services) {
  const catalog = (services || [])
    .filter((service) => service && service._id)
    .map((service) => ({
      _id: service._id,
      normalizedName: normalizeServiceName(service.name),
    }));
  const nameFrequency = catalog.reduce((counts, service) => {
    if (service.normalizedName) {
      counts.set(
        service.normalizedName,
        (counts.get(service.normalizedName) || 0) + 1,
      );
    }
    return counts;
  }, new Map());
  const idBranches = catalog.map((service) => ({
    case: { $eq: ["$bookingService.serviceId", service._id] },
    then: service._id,
  }));
  const nameBranches = catalog
    .filter((service) => (
      service.normalizedName
      && nameFrequency.get(service.normalizedName) === 1
    ))
    .map((service) => ({
      case: {
        $eq: ["$normalizedBookingServiceName", service.normalizedName],
      },
      then: service._id,
    }));

  return [
    {
      $project: {
        bookingServices: {
          $let: {
            vars: {
              legacyServiceId: {
                $ifNull: [
                  "$serviceId",
                  { $ifNull: ["$service._id", null] },
                ],
              },
              embeddedServices: {
                $filter: {
                  input: { $ifNull: ["$services", []] },
                  as: "service",
                  cond: {
                    $or: [
                      {
                        $ne: [
                          { $ifNull: ["$$service.serviceId", null] },
                          null,
                        ],
                      },
                      {
                        $ne: [
                          { $ifNull: ["$$service.name", ""] },
                          "",
                        ],
                      },
                    ],
                  },
                },
              },
            },
            in: {
              $cond: [
                { $gt: [{ $size: "$$embeddedServices" }, 0] },
                "$$embeddedServices",
                {
                  $cond: [
                    {
                      $or: [
                        { $ne: ["$$legacyServiceId", null] },
                        { $ne: [{ $ifNull: ["$service.name", ""] }, ""] },
                      ],
                    },
                    [{
                      serviceId: "$$legacyServiceId",
                      name: { $ifNull: ["$service.name", ""] },
                    }],
                    [],
                  ],
                },
              ],
            },
          },
        },
      },
    },
    { $unwind: "$bookingServices" },
    {
      $set: {
        bookingService: "$bookingServices",
        normalizedBookingServiceName: {
          $toLower: {
            $trim: {
              input: { $ifNull: ["$bookingServices.name", ""] },
            },
          },
        },
      },
    },
    {
      $set: {
        matchedServiceId: {
          $switch: {
            // Exact current IDs win. The unique-name branches reconcile
            // historical snapshots whose catalog record was later recreated.
            branches: [...idBranches, ...nameBranches],
            default: null,
          },
        },
      },
    },
    { $match: { matchedServiceId: { $ne: null } } },
    {
      $group: {
        _id: {
          bookingId: "$_id",
          serviceId: "$matchedServiceId",
        },
      },
    },
    {
      $group: {
        _id: "$_id.serviceId",
        count: { $sum: 1 },
      },
    },
  ];
}

async function getServiceBookingCounts(BookingService, services) {
  const catalog = (services || []).filter((service) => service && service._id);
  if (!catalog.length) return new Map();

  const counts = await BookingService.aggregate(
    buildServiceBookingCountPipeline(catalog),
  );

  return new Map(
    counts.map((row) => [String(row._id), Number(row.count) || 0]),
  );
}

function applyServiceBookingCounts(services, counts) {
  for (const service of services || []) {
    service.bookingCount = counts.get(String(service._id)) || 0;
  }
  return services;
}

module.exports = {
  applyServiceBookingCounts,
  buildServiceBookingCountPipeline,
  getServiceBookingCounts,
  normalizeServiceName,
};
