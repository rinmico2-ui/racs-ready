'use strict';

const NOTICE = 'DEMONSTRATION DATA: simulated history, not actual work, money received, or stock movement.';
const isDemonstration = record => Boolean(record?.demonstration?.batch);
function demonstrationFields(mongoose) {
  return { demonstration: { type: new mongoose.Schema({
    batch: { type: String, required: true, maxlength: 80 },
    generatedAt: { type: Date, required: true },
    notice: { type: String, default: NOTICE, maxlength: 300 },
    notificationsSuppressed: { type: Boolean, default: true },
    physicalStockMoved: { type: Boolean, default: false },
    moneyReceived: { type: Boolean, default: false },
  }, { _id: false }), default: undefined } };
}
module.exports = { NOTICE, isDemonstration, demonstrationFields };
