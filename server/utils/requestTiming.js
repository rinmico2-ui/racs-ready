"use strict";

// Only fixed stage names and elapsed time are recorded, never request bodies.
async function measureRequest(req, stage, producer) {
  const started = process.hrtime.bigint();
  try { return await producer(); }
  finally {
    req.performanceTimings = req.performanceTimings || {};
    req.performanceTimings[stage] = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(2));
  }
}

module.exports = { measureRequest };
