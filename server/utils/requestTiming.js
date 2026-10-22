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

function timedMiddleware(stage, middleware) {
  return function measuredMiddleware(req, res, next) {
    const started = process.hrtime.bigint();
    let recorded = false;
    const record = () => {
      if (recorded) return;
      recorded = true;
      res.removeListener('finish', record);
      req.performanceTimings = req.performanceTimings || {};
      req.performanceTimings[stage] = Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(2));
    };
    res.prependOnceListener('finish', record);
    const advance = error => { record(); next(error); };
    try {
      const pending = middleware(req, res, advance);
      if (pending?.catch) pending.catch(advance);
    } catch (error) { advance(error); }
  };
}

module.exports = { measureRequest, timedMiddleware };
