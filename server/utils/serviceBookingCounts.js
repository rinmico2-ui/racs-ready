"use strict";

function buildServiceBookingCountPipeline(serviceIds) {
  return [
    {
      $project: {
        bookingServiceIds: {
          $let: {
            vars: {
              legacyServiceId: {
                $ifNull: [
                  "$serviceId",
                  { $ifNull: ["$service._id", null] },
                ],
              },
              embeddedServiceIds: {
                $map: {
                  input: {
                    $filter: {
                      input: { $ifNull: ["$services", []] },
                      as: "service",
                      cond: {
                        $ne: [
                          { $ifNull: ["$$service.serviceId", null] },
                          null,
                        ],
                      },
                    },
                  },
                  as: "service",
                  in: "$$service.serviceId",
                },
              },
            },
            in: {
              $setUnion: [
                {
                  $cond: [
                    { $gt: [{ $size: "$$embeddedServiceIds" }, 0] },
                    "$$embeddedServiceIds",
                    {
                      $cond: [
                        {
                          $ne: [
                            "$$legacyServiceId",
                            null,
                          ],
                        },
                        ["$$legacyServiceId"],
                        [],
                      ],
                    },
                  ],
                },
                [],
              ],
            },
          },
        },
      },
    },
    { $unwind: "$bookingServiceIds" },
    { $match: { bookingServiceIds: { $in: serviceIds } } },
    {
      $group: {
        _id: {
          bookingId: "$_id",
          serviceId: "$bookingServiceIds",
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
  const serviceIds = (services || []).map((service) => service && service._id).filter(Boolean);
  if (!serviceIds.length) return new Map();

  const counts = await BookingService.aggregate(
    buildServiceBookingCountPipeline(serviceIds),
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
};
