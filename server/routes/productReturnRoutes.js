const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { authenticate, requireRole } = require("../middleware/authenticate");
const { requirePermission } = require("../middleware/requirePermission");
const { imageExtensionFor, isAllowedImage, hasValidStoredImageSignature } = require("../utils/uploadSecurity");
const { createNotification } = require("../utils/notify");
const audit = require("../utils/audit");
const Order = require("../models/Order");
const WalkInSale = require("../models/WalkInSale");
const BookingService = require("../models/BookingService");
const ProductReturn = require("../models/ProductReturn");
const ProductRefund = require("../models/ProductRefund");
const ProductReturnMovement = require("../models/ProductReturnMovement");
const WarrantyClaim = require("../models/WarrantyClaim");
const Payment = require("../models/Payment");
const HVACProduct = require("../models/HVACProduct");
const Inventory = require("../models/Inventory");
const Tool = require("../models/Tool");
const CustomerAsset = require("../models/CustomerAsset");
const MaintenanceSchedule = require("../models/MaintenanceSchedule");
const SiteSetting = require("../models/SiteSetting");
const policy = require("../utils/productReturnPolicy");

const router = express.Router();
const evidenceDir = path.join(__dirname, "../private/product-returns");
fs.mkdirSync(evidenceDir, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, evidenceDir),
    filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${imageExtensionFor(file) || ""}`),
  }),
  limits: { files: 5, fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => isAllowedImage(file) ? cb(null, true) : cb(error("Only JPG, PNG, or WEBP images are allowed.")),
});
const requestLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false });
router.use(authenticate);

function error(message, status = 400) { return Object.assign(new Error(message), { status }); }
function sendError(res, err) {
  if (err?.code === 11000) return res.status(409).json({ error: "This return or refund was already recorded. Refresh the page." });
  if (err?.code === 112 || /WriteConflict/.test(err?.message || "")) return res.status(409).json({ error: "The sale changed. Refresh and try again." });
  if (!err?.status || err.status >= 500) console.error("Product return error:", err);
  return res.status(err?.status || 500).json({ error: err?.status ? err.message : "Unable to process this return right now." });
}
function files(req, field) { return (req.files || []).filter(file => file.fieldname === field); }
async function removeFiles(req) { await Promise.all((req.files || []).map(file => fs.promises.unlink(file.path).catch(() => {}))); }
function receiveFiles(req, res, next) {
  upload.any()(req, res, async err => {
    if (err || (req.files || []).some(file => !["evidence", "proof"].includes(file.fieldname))) {
      await removeFiles(req);
      return res.status(400).json({ error: "Upload up to five JPG, PNG, or WEBP images, each under 5 MB." });
    }
    for (const file of req.files || []) {
      if (!await hasValidStoredImageSignature(file)) {
        await removeFiles(req);
        return res.status(400).json({ error: "An uploaded file is not a valid image." });
      }
    }
    next();
  });
}
function text(value, max = 2000) { return String(value || "").trim().slice(0, max); }
function actorName(req) { return req.user.name || req.user.email || "Staff"; }
function record(returnDoc, req, to, action, note = "") {
  if (!policy.canTransition(returnDoc.status, to)) throw error(`Cannot ${action} while return is ${returnDoc.status}.`, 409);
  const from = returnDoc.status;
  returnDoc.status = to;
  returnDoc.history.push({ action, from, to, actorId: req.user._id, actorRole: req.user.role, note: text(note), at: new Date() });
}
async function notify(req, row, title, message) {
  if (row.customerId) await createNotification({
    type: "product_return_update", title, message, userId: row.customerId,
    referenceId: row._id, referenceModel: "ProductReturn",
    link: `/my-orders/${row.sourceId}`, priority: "normal", io: req.app.get("io"),
  }).catch(err => console.error("Return notification error:", err));
}
async function auditAction(req, row, action) {
  await audit.logEvent({ actor: req.user._id, actorRole: req.user.role, actorName: actorName(req),
    action: `order.return.${action}`, module: "ProductReturn", category: "order", entityType: "ProductReturn",
    entityId: row._id, details: { rmaNumber: row.rmaNumber, sourceReference: row.sourceReference, itemIndex: row.itemIndex, quantity: row.quantity, status: row.status }, req,
  }).catch(err => console.error("Return audit error:", err));
}
async function sourceFor(type, id, session = null) {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  const query = type === "order" ? Order.findById(id) : type === "walk_in" ? WalkInSale.findById(id) : null;
  if (!query) return null;
  return (session ? query.session(session) : query).lean();
}
async function getReturn(id, session = null) {
  if (!mongoose.Types.ObjectId.isValid(id)) throw error("Invalid return ID.", 400);
  const query = ProductReturn.findById(id);
  const row = await (session ? query.session(session) : query);
  if (!row) throw error("Return request not found.", 404);
  return row;
}
function canView(req, row) { return req.user.role === "admin" || (req.user.role === "customer" && String(row.customerId) === String(req.user._id)); }
function saleSnapshot(type, source, item, index, quantity, evaluated) {
  return {
    sourceType: type, sourceId: source._id,
    sourceReference: type === "order" ? (source.orderReference || String(source._id)) : source.invoiceNumber,
    customerId: type === "order" ? source.userId : null,
    customerName: type === "order" ? (source.customer?.name || "") : source.customerName,
    customerPhone: type === "order" ? (source.customer?.phone || "") : source.customerPhone,
    itemIndex: index, productId: type === "order" ? item.inventoryId : item.toolId,
    productName: evaluated.productName, sku: evaluated.sku,
    quantity, originalQuantity: Number(item.quantity), unitPrice: Number(item.unitPrice || 0),
    purchaseDate: policy.purchaseDate(type, source), eligibleUntil: evaluated.eligibleUntil,
    coverageType: evaluated.coverageType,
    bookingId: type === "order" ? source.bookingId || null : null,
    serialNumbers: [],
  };
}
function serialSelection(raw, item, quantity) {
  const known = (item.serialNumbers || []).map(value => String(value).trim()).filter(Boolean);
  const submitted = (Array.isArray(raw) ? raw : raw ? String(raw).split(",") : []).map(value => String(value).trim()).filter(Boolean);
  if (new Set(submitted.map(value => value.toLowerCase())).size !== submitted.length) throw error("Choose each serial number only once.");
  if (known.length) {
    if (submitted.length !== quantity || submitted.some(value => !known.some(serial => serial.toLowerCase() === value.toLowerCase()))) throw error(`Choose exactly ${quantity} serial number(s) from this sale.`);
  } else if (submitted.length > quantity) throw error("Too many serial numbers for this return.");
  return known.length ? submitted.map(value => known.find(serial => serial.toLowerCase() === value.toLowerCase())) : submitted.map(value => value.toUpperCase());
}

router.get("/eligibility/:sourceType/:sourceId", async (req, res) => {
  try {
    const { sourceType, sourceId } = req.params;
    if (sourceType === "walk_in" && req.user.role !== "admin") throw error("Only staff can review counter sales.", 403);
    if (sourceType === "order" && !["customer", "admin"].includes(req.user.role)) throw error("Forbidden.", 403);
    const source = await sourceFor(sourceType, sourceId);
    if (!source || (req.user.role === "customer" && String(source.userId) !== String(req.user._id))) throw error("Sale not found.", 404);
    const context = await policy.loadContext(sourceType, source);
    return res.json({ sourceReference: sourceType === "order" ? source.orderReference : source.invoiceNumber,
      items: (source.items || []).map((_item, index) => ({ index, ...policy.evaluateItem(sourceType, source, index, context) })),
      returns: context.returns.map(row => ({ _id: row._id, rmaNumber: row.rmaNumber, itemIndex: row.itemIndex, quantity: row.quantity, status: row.status, resolution: row.resolution?.type })) });
  } catch (err) { return sendError(res, err); }
});

router.post("/", (req, res, next) => req.user.role === "customer" ? requestLimiter(req, res, next) : next(), receiveFiles, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const type = text(req.body.sourceType, 20);
    if (type !== "order" && type !== "walk_in") throw error("Choose a valid sale.");
    if (type === "walk_in" && req.user.role !== "admin") throw error("Only staff can file returns for counter sales.", 403);
    if (type === "order" && !["customer", "admin"].includes(req.user.role)) throw error("Forbidden.", 403);
    const index = Number(req.body.itemIndex);
    const quantity = Number(req.body.quantity);
    const reason = text(req.body.reason, 50);
    const description = text(req.body.description, 3000);
    const requestedResolution = text(req.body.requestedResolution, 30);
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(quantity) || quantity < 1) throw error("Choose a product and valid quantity.");
    if (!ProductReturn.REASONS.includes(reason)) throw error("Choose a return reason.");
    if (description.length < 10) throw error("Describe the problem in at least 10 characters.");
    if (!["refund", "replacement", "repair"].includes(requestedResolution)) throw error("Choose the help you prefer.");
    if (files(req, "proof").length || files(req, "evidence").length > 5) throw error("Upload up to five evidence photos.");
    session.startTransaction();
    const source = await sourceFor(type, req.body.sourceId, session);
    if (!source || (req.user.role === "customer" && String(source.userId) !== String(req.user._id))) throw error("Sale not found.", 404);
    const item = policy.itemFor(type, source, index);
    const context = await policy.loadContext(type, source, session);
    const evaluated = policy.evaluateItem(type, source, index, context);
    if (!evaluated.eligible) throw error(evaluated.reason, 409);
    if (quantity > evaluated.remaining) throw error(`Only ${evaluated.remaining} unit(s) can be requested.`, 409);
    if (type === "order" && await WarrantyClaim.exists({ sourceType: "order", sourceId: source._id, "affectedItem.itemKey": String(item.inventoryId), claimType: { $in: ["product_defect", "replacement_part", "safety_defect"] }, active: true }).session(session)) {
      throw error("A warranty request is already open for this product. Please follow that request instead.", 409);
    }
    const serialNumbers = serialSelection(req.body.serialNumbers, { serialNumbers: evaluated.serialNumbers }, quantity);
    const maxRefundable = policy.allocationCap(type, source, item, quantity, evaluated.paid);
    if (maxRefundable <= 0) throw error("No confirmed payment is available for this item.", 409);
    let relatedBookingId = null;
    if (type === "walk_in" && text(req.body.bookingReference, 100)) {
      const reference = text(req.body.bookingReference, 100);
      const relatedBooking = await BookingService.findOne(mongoose.Types.ObjectId.isValid(reference)
        ? { _id: reference } : { bookingReference: reference }).select("_id").session(session).lean();
      if (!relatedBooking) throw error("Related service booking not found. Check its booking number.");
      relatedBookingId = relatedBooking._id;
    }
    const model = type === "order" ? Order : WalkInSale;
    const versionFilter = source.returnVersion == null
      ? { $or: [{ returnVersion: { $exists: false } }, { returnVersion: 0 }] }
      : { returnVersion: source.returnVersion };
    const touched = await model.updateOne({ _id: source._id, ...versionFilter }, { $inc: { returnVersion: 1 } }, { session });
    if (!touched.modifiedCount) throw error("The sale changed. Refresh and try again.", 409);
    const [row] = await ProductReturn.create([{
      rmaNumber: `RMA-${new Date().getFullYear()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`,
      ...saleSnapshot(type, source, item, index, quantity, evaluated), bookingId: relatedBookingId || (type === "order" ? source.bookingId || null : null), serialNumbers, maxRefundable,
      reason, description, requestedResolution,
      priority: ["dead_on_arrival", "delivery_damage"].includes(reason) ? "high" : "normal",
      evidenceUrls: files(req, "evidence").map(file => `/api/product-returns/evidence/${file.filename}`),
      history: [{ action: "requested", from: "", to: "requested", actorId: req.user._id, actorRole: req.user.role, note: "Product return requested", at: new Date() }],
    }], { session });
    await session.commitTransaction();
    await auditAction(req, row, "requested");
    await createNotification({ type: "product_return_update", title: "New product return", message: `${row.rmaNumber} was filed for ${row.productName}.`, role: "admin", referenceId: row._id, referenceModel: "ProductReturn", link: "/admin/product-returns", priority: "high", io: req.app.get("io") }).catch(err => console.error("Return admin notification error:", err));
    await notify(req, row, "Return request received", `${row.rmaNumber}: We received your request for ${row.productName}.`);
    return res.status(201).json({ return: row });
  } catch (err) { await session.abortTransaction().catch(() => {}); await removeFiles(req); return sendError(res, err); }
  finally { await session.endSession(); }
});

router.get("/my", requireRole("customer"), async (req, res) => {
  try { return res.json({ returns: await ProductReturn.find({ customerId: req.user._id }).sort({ createdAt: -1 }).lean() }); }
  catch (err) { return sendError(res, err); }
});
router.get("/admin", requireRole("admin"), async (req, res) => {
  try {
    const filter = ProductReturn.STATUSES.includes(req.query.status) ? { status: req.query.status } : {};
    const returns = await ProductReturn.find(filter).sort({ createdAt: -1 }).limit(500).lean();
    returns.sort((left, right) => {
      const leftOpen = !["completed", "rejected", "cancelled"].includes(left.status);
      const rightOpen = !["completed", "rejected", "cancelled"].includes(right.status);
      if (leftOpen !== rightOpen) return leftOpen ? -1 : 1;
      if (leftOpen && left.priority !== right.priority) return left.priority === "high" ? -1 : 1;
      return leftOpen ? new Date(left.createdAt) - new Date(right.createdAt) : new Date(right.createdAt) - new Date(left.createdAt);
    });
    return res.json({ returns });
  } catch (err) { return sendError(res, err); }
});
router.get("/policy", requireRole("admin"), async (_req, res) => {
  try {
    const setting = await SiteSetting.findOne({ key: "productReturnPolicy" }).lean();
    return res.json({ returnDays: Number(setting?.value?.returnDays) || 30 });
  } catch (err) { return sendError(res, err); }
});
router.patch("/policy", requireRole("admin"), async (req, res) => {
  try {
    const returnDays = Number(req.body.returnDays);
    if (!Number.isInteger(returnDays) || returnDays < 1 || returnDays > 3650) throw error("Return period must be 1 to 3650 days.");
    await SiteSetting.findOneAndUpdate({ key: "productReturnPolicy" }, { $set: { value: { returnDays } } }, { upsert: true, new: true });
    await audit.logEvent({ actor: req.user._id, actorRole: req.user.role, actorName: actorName(req), action: "settings.product_return_policy", module: "ProductReturn", category: "settings", details: { returnDays }, req });
    return res.json({ returnDays });
  } catch (err) { return sendError(res, err); }
});
router.get("/counter-sale/:invoice", requireRole("admin"), async (req, res) => {
  try {
    const invoice = text(req.params.invoice, 40).toUpperCase();
    if (!/^WIS-[A-Z0-9-]{6,30}$/.test(invoice)) throw error("Enter a valid counter-sale receipt number.");
    const sale = await WalkInSale.findOne({ invoiceNumber: invoice }).lean();
    if (!sale) throw error("Counter-sale receipt not found.", 404);
    const context = await policy.loadContext("walk_in", sale);
    return res.json({ sale: { _id: sale._id, invoiceNumber: sale.invoiceNumber, customerName: sale.customerName },
      items: sale.items.map((_item, index) => ({ index, ...policy.evaluateItem("walk_in", sale, index, context) })) });
  } catch (err) { return sendError(res, err); }
});
router.get("/evidence/:fileName", async (req, res) => {
  try {
    const fileName = path.basename(req.params.fileName || "");
    if (fileName !== req.params.fileName || !/^[a-f0-9-]{36}\.(jpg|jpeg|png|webp)$/i.test(fileName)) throw error("Invalid file.", 400);
    const url = `/api/product-returns/evidence/${fileName}`;
    const row = await ProductReturn.findOne({ $or: [{ evidenceUrls: url }, { "inspection.evidenceUrls": url }] }).lean();
    const refund = await ProductRefund.findOne({ proofUrl: url }).lean();
    const ownerRow = row || (refund ? await ProductReturn.findById(refund.returnId).lean() : null);
    if (!ownerRow || !canView(req, ownerRow)) throw error("File not found.", 404);
    return res.sendFile(fileName, { root: evidenceDir });
  } catch (err) { return sendError(res, err); }
});
router.get("/:id", async (req, res) => {
  try {
    const row = await getReturn(req.params.id);
    if (!canView(req, row)) throw error("Return request not found.", 404);
    const refund = req.user.role === "admin" || String(row.customerId) === String(req.user._id)
      ? await ProductRefund.findOne({ returnId: row._id }).lean() : null;
    return res.json({ return: row, refund });
  } catch (err) { return sendError(res, err); }
});

async function changeReturn(req, res, handler, title, message) {
  const session = await mongoose.startSession();
  let row;
  try {
    session.startTransaction();
    row = await getReturn(req.params.id, session);
    await handler(row, session);
    await row.save({ session });
    await session.commitTransaction();
    await auditAction(req, row, row.history[row.history.length - 1].action);
    if (title) await notify(req, row, title, message || `${row.rmaNumber} is now ${row.status.replace(/_/g, " ")}.`);
    return res.json({ return: row });
  } catch (err) { await session.abortTransaction().catch(() => {}); await removeFiles(req); return sendError(res, err); }
  finally { await session.endSession(); }
}

router.post("/:id/cancel", requireRole("customer"), (req, res) => changeReturn(req, res, async row => {
  if (String(row.customerId) !== String(req.user._id)) throw error("Return request not found.", 404);
  record(row, req, "cancelled", "cancelled", text(req.body.reason, 500) || "Customer cancelled the request");
}, "Return request cancelled"));

router.post("/:id/link-booking", requireRole("admin"), (req, res) => changeReturn(req, res, async (row, session) => {
  if (row.sourceType !== "walk_in" || !["requested", "under_review", "awaiting_return", "received", "inspected"].includes(row.status)) throw error("A service booking cannot be linked at this stage.", 409);
  const reference = text(req.body.bookingReference, 100);
  if (!reference) throw error("Enter the related booking number.");
  const booking = await BookingService.findOne(mongoose.Types.ObjectId.isValid(reference)
    ? { _id: reference } : { bookingReference: reference }).select("_id bookingReference").session(session).lean();
  if (!booking) throw error("Booking not found. Check the booking number.", 404);
  row.bookingId = booking._id;
  row.history.push({ action: "booking_linked", from: row.status, to: row.status, actorId: req.user._id, actorRole: req.user.role, note: `Linked service booking ${booking.bookingReference || booking._id}`, at: new Date() });
}, "Related service linked"));

router.post("/:id/review", requireRole("admin"), (req, res) => changeReturn(req, res, async row => {
  row.reviewerId = req.user._id;
  row.reviewerName = actorName(req);
  record(row, req, "under_review", "review_started", text(req.body.note, 1000) || "Staff is reviewing the request");
}, "Return under review"));

router.post("/:id/approve-return", requireRole("admin"), (req, res) => changeReturn(req, res, async row => {
  record(row, req, "awaiting_return", "approved_for_return", text(req.body.note, 1000) || "Please bring the item for inspection");
}, "Return approved for inspection", "Please bring the item to CALIDRO RACS. We will inspect it before deciding the next step."));

router.post("/:id/reject", requireRole("admin"), (req, res) => changeReturn(req, res, async row => {
  const reason = text(req.body.reason, 2000);
  if (reason.length < 10) throw error("Explain the rejection in at least 10 characters.");
  record(row, req, "rejected", "rejected", reason);
}, "Return request declined"));

router.post("/:id/return-to-customer", requireRole("admin"), (req, res) => changeReturn(req, res, async (row, session) => {
  if (row.status !== "rejected" || !row.receivedAt || row.inventoryDisposition === "customer_held") throw error("This item is not waiting to be returned to the customer.", 409);
  await ProductReturnMovement.create([{
    returnId: row._id, productId: row.productId, sourceType: row.sourceType,
    type: "return_to_customer", quantity: row.quantity, serialNumbers: row.serialNumbers,
    actorId: req.user._id, note: text(req.body.note, 1000) || "Rejected item handed back to customer",
  }], { session });
  row.inventoryDisposition = "customer_held";
  row.history.push({ action: "returned_to_customer", from: "rejected", to: "rejected", actorId: req.user._id, actorRole: req.user.role, note: "Item handed back to customer", at: new Date() });
}, "Item returned", "Your item was returned to you after the inspection decision."));

router.post("/:id/receive", requireRole("admin"), (req, res) => changeReturn(req, res, async (row, session) => {
  if (!row.productId) throw error("Original product reference is missing. Do not receive without review.", 409);
  row.receivedAt = new Date();
  row.inventoryDisposition = "quarantined";
  record(row, req, "received", "received_quarantined", text(req.body.note, 1000) || "Item received and placed in quarantine");
  await ProductReturnMovement.create([{
    returnId: row._id, productId: row.productId, sourceType: row.sourceType,
    type: "quarantine", quantity: row.quantity, serialNumbers: row.serialNumbers,
    actorId: req.user._id, note: "Returned stock is not sellable",
  }], { session });
}, "Item received", "We received your item and will inspect it. It is not returned to sale stock."));

router.post("/:id/inspect", requireRole("admin"), receiveFiles, (req, res) => changeReturn(req, res, async (row, session) => {
  if (files(req, "proof").length) throw error("Upload inspection photos using the evidence field.");
  if (row.status === "inspected" && row.inspection?.result !== "further_diagnosis") throw error("This inspection is already complete.", 409);
  const result = text(req.body.result, 50);
  const notes = text(req.body.notes, 3000);
  const allowed = ["defect_confirmed", "not_confirmed", "customer_damage", "misuse", "missing_components", "wrong_item", "warranty_covered", "warranty_not_covered", "further_diagnosis"];
  if (!allowed.includes(result)) throw error("Choose an inspection result.");
  if (notes.length < 10) throw error("Record inspection findings in at least 10 characters.");
  const resellable = req.body.resellable === true || req.body.resellable === "true";
  if (resellable && (result !== "not_confirmed" || !(req.body.accessoriesComplete === true || req.body.accessoriesComplete === "true")
      || req.body.signsOfMisuse === true || req.body.signsOfMisuse === "true"
      || (row.serialNumbers.length && !(req.body.serialVerified === true || req.body.serialVerified === "true")))) {
    throw error("Restockable items must have no confirmed defect, all accessories, no misuse, and a verified serial number when recorded.");
  }
  row.inspection = {
    result, notes, condition: text(req.body.condition, 500),
    serialVerified: req.body.serialVerified === true || req.body.serialVerified === "true",
    accessoriesComplete: req.body.accessoriesComplete === true || req.body.accessoriesComplete === "true",
    signsOfMisuse: req.body.signsOfMisuse === true || req.body.signsOfMisuse === "true",
    resellable,
    inspectedBy: req.user._id, inspectedAt: new Date(),
    evidenceUrls: [...(row.inspection?.evidenceUrls || []), ...files(req, "evidence").map(file => `/api/product-returns/evidence/${file.filename}`)],
  };
  if (["defect_confirmed", "customer_damage", "misuse", "missing_components", "wrong_item"].includes(result)) {
    row.inventoryDisposition = "defective";
    await ProductReturnMovement.create([{
      returnId: row._id, productId: row.productId, sourceType: row.sourceType,
      type: "mark_defective", quantity: row.quantity, serialNumbers: row.serialNumbers,
      actorId: req.user._id, note: result,
    }], { session });
  }
  record(row, req, "inspected", "inspection_completed", `${result}: ${notes}`);
}, "Inspection finished"));

router.post("/:id/decision", requireRole("admin"), (req, res) => changeReturn(req, res, async row => {
  const type = text(req.body.resolution, 30);
  const reason = text(req.body.reason, 2000);
  if (!["refund", "replacement", "repair"].includes(type)) throw error("Choose refund, replacement, or repair.");
  if (type === "repair" && !row.bookingId) throw error("Link a service booking before approving a warranty repair. Refund or replacement can still be considered.", 409);
  if (reason.length < 10) throw error("Explain the decision in at least 10 characters.");
  if (!row.inspection?.result || row.inspection.result === "further_diagnosis") throw error("Complete the inspection before deciding.", 409);
  row.resolution.type = type;
  row.resolution.reason = reason;
  row.resolution.approvedBy = req.user._id;
  row.resolution.approvedAt = new Date();
  const next = type === "refund" ? "refund_pending" : type === "replacement" ? "replacement_pending" : "repair_pending";
  record(row, req, next, `${type}_decided`, reason);
}, "Return decision recorded"));

router.post("/:id/refund-approve", requireRole("admin"), requirePermission("payments.manage"), (req, res) => changeReturn(req, res, async (row, session) => {
  if (row.status !== "refund_pending" || row.resolution.type !== "refund") throw error("This return is not waiting for refund approval.", 409);
  const source = await sourceFor(row.sourceType, row.sourceId, session);
  if (!source) throw error("Original sale not found.", 409);
  const context = await policy.loadContext(row.sourceType, source, session);
  const max = policy.refundApprovalLimit(row.sourceType, source, context, row);
  const requested = Number(req.body.amount);
  if (!Number.isFinite(requested) || requested <= 0 || policy.money(requested) !== requested || requested > max) {
    throw error(`Approved refund must be between ₱0.01 and ₱${max.toFixed(2)}.`, 409);
  }
  let originalPaymentId = null;
  if (row.sourceType === "order") {
    const availablePayment = policy.paymentForRefund(context.payments, context.refunds, requested);
    if (!availablePayment) throw error("No single verified payment can cover this refund. Review split payments before proceeding.", 409);
    originalPaymentId = availablePayment._id;
    const lockedPayment = await Payment.updateOne(
      { _id: originalPaymentId, status: { $in: ["verified", "paid", "remitted"] } },
      { $inc: { rmaRefundVersion: 1 } }, { session },
    );
    if (!lockedPayment.modifiedCount) throw error("The original payment changed. Refresh this return before approving.", 409);
  }
  const [refund] = await ProductRefund.create([{
    returnId: row._id, sourceType: row.sourceType, sourceId: row.sourceId,
    itemIndex: row.itemIndex, originalPaymentId, amount: requested, approvedBy: req.user._id,
  }], { session });
  row.resolution.refundAmount = requested;
  row.resolution.refundTransactionId = refund._id;
  record(row, req, "refund_approved", "refund_approved", `₱${requested.toFixed(2)} approved for this product only`);
}, "Refund approved", "Your product refund was approved. We will update you when the money has been sent."));

router.post("/:id/refund-processing", requireRole("admin"), requirePermission("payments.manage"), (req, res) => changeReturn(req, res, async (row, session) => {
  const refund = await ProductRefund.findOne({ returnId: row._id }).session(session);
  if (!refund || refund.status !== "approved") throw error("Refund approval is missing.", 409);
  refund.status = "processing";
  await refund.save({ session });
  record(row, req, "refund_processing", "refund_processing", "Manual refund is being processed");
}, "Refund being processed"));

router.post("/:id/refund-complete", requireRole("admin"), requirePermission("payments.manage"), receiveFiles, async (req, res) => {
  if (files(req, "evidence").length || files(req, "proof").length > 1) { await removeFiles(req); return res.status(400).json({ error: "Upload one refund proof image." }); }
  const session = await mongoose.startSession();
  try {
    const method = text(req.body.method, 30);
    const reference = text(req.body.reference, 120);
    const notes = text(req.body.notes, 2000);
    if (!["gcash", "maya", "bank", "cash", "card", "other"].includes(method)) throw error("Choose the refund method.");
    if (reference.length < 4) throw error("Enter the transfer reference or signed cash receipt number.");
    if (method !== "cash" && !files(req, "proof").length) throw error("Upload proof that the refund was sent.");
    session.startTransaction();
    const row = await getReturn(req.params.id, session);
    if (row.status !== "refund_processing" || row.resolution.type !== "refund") throw error("This refund is not being processed.", 409);
    const refund = await ProductRefund.findOne({ returnId: row._id, status: "processing" }).session(session);
    if (!refund) throw error("Refund ledger entry not found.", 409);
    refund.status = "completed";
    refund.method = method;
    refund.reference = reference;
    refund.proofUrl = files(req, "proof").length ? `/api/product-returns/evidence/${files(req, "proof")[0].filename}` : "";
    refund.notes = notes;
    refund.processedBy = req.user._id;
    refund.processedAt = new Date();
    await refund.save({ session });
    row.resolution.completedAt = new Date();
    record(row, req, "completed", "refund_completed", `₱${refund.amount.toFixed(2)} refunded by ${method}; reference ${reference}`);
    await row.save({ session });
    const sourceModel = row.sourceType === "order" ? Order : WalkInSale;
    const updated = await sourceModel.updateOne({ _id: row.sourceId }, { $inc: { productRefundAmount: refund.amount } }, { session });
    if (!updated.modifiedCount) throw error("Original sale could not be updated; refund was not recorded.", 409);
    if (row.sourceType === "order" && row.serialNumbers.length) {
      const assets = await CustomerAsset.find({ originType: "order", originId: row.sourceId, "equipment.serialNumber": { $in: row.serialNumbers } }).select("_id").session(session).lean();
      if (assets.length) {
        const assetIds = assets.map(asset => asset._id);
        await CustomerAsset.updateMany({ _id: { $in: assetIds } }, { $set: { status: "retired" } }, { session });
        await MaintenanceSchedule.updateMany({ assetId: { $in: assetIds }, status: { $in: ["upcoming", "due", "overdue"] } }, { $set: { status: "cancelled" } }, { session });
      }
    }
    await session.commitTransaction();
    await auditAction(req, row, "refund_completed");
    await notify(req, row, "Refund sent", `${row.rmaNumber}: ₱${refund.amount.toFixed(2)} was refunded via ${method}.`);
    return res.json({ return: row, refund });
  } catch (err) { await session.abortTransaction().catch(() => {}); await removeFiles(req); return sendError(res, err); }
  finally { await session.endSession(); }
});

router.post("/:id/replacement-complete", requireRole("admin"), (req, res) => changeReturn(req, res, async (row, session) => {
  if (row.status !== "replacement_pending" || row.resolution.type !== "replacement") throw error("This return is not waiting for a replacement.", 409);
  const source = await sourceFor(row.sourceType, row.sourceId, session);
  const item = source && policy.itemFor(row.sourceType, source, row.itemIndex);
  if (!item || policy.itemIdentity(row.sourceType, item) !== String(row.productId)) throw error("Original product record changed. Review this return.", 409);
  const newSerials = serialSelection(req.body.newSerialNumbers, { serialNumbers: [] }, row.quantity);
  if (row.serialNumbers.length && newSerials.length !== row.quantity) throw error(`Enter ${row.quantity} replacement serial number(s).`);
  if (newSerials.some(serial => row.serialNumbers.includes(serial))) throw error("Replacement serials must differ from the returned units.");
  await policy.assertNoReturnSerialConflict(newSerials, session);
  const serialPatterns = newSerials.map(serial => new RegExp(`^${serial.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"));
  if (newSerials.length && (await Order.exists({ "items.serialNumbers": { $in: serialPatterns } }).session(session)
      || await ProductReturn.exists({ "resolution.replacementSerialNumbers": { $in: serialPatterns } }).session(session))) {
    throw error("A replacement serial number is already assigned.", 409);
  }
  let reserved;
  if (row.sourceType === "order" && item.isHvac && item.parentHvacId) {
    const hvac = await HVACProduct.findOne({ _id: item.parentHvacId, "variants._id": item.inventoryId }).session(session);
    const variant = hvac?.variants.id(item.inventoryId);
    if (newSerials.length && variant?.serialNumbers?.length && newSerials.some(serial => !variant.serialNumbers.includes(serial.toUpperCase()))) throw error("Replacement serial number is not in the available product registry.", 409);
    reserved = await HVACProduct.updateOne({ _id: item.parentHvacId, variants: { $elemMatch: { _id: item.inventoryId, quantity: { $gte: row.quantity }, active: { $ne: false }, status: { $nin: ["out_of_stock", "discontinued", "coming_soon"] } } } }, { $inc: { "variants.$.quantity": -row.quantity } }, { session });
  } else if (row.sourceType === "order") {
    reserved = await Inventory.updateOne({ _id: item.inventoryId, quantity: { $gte: row.quantity }, active: { $ne: false }, status: { $nin: ["out_of_stock", "discontinued", "coming_soon"] } }, { $inc: { quantity: -row.quantity } }, { session });
  } else {
    const tool = await Tool.findById(item.toolId).session(session);
    if (!tool || Tool.effectiveInventoryClass(tool) !== "merchandise") throw error("This part is no longer available as merchandise.", 409);
    reserved = await Tool.updateOne({ _id: item.toolId, active: true, $expr: { $gte: [{ $subtract: ["$quantity", { $ifNull: ["$reservedQuantity", 0] }] }, row.quantity] } }, { $inc: { quantity: -row.quantity } }, { session });
  }
  if (!reserved?.modifiedCount) throw error("No sellable replacement stock is available. Restock before completing this replacement.", 409);
  await ProductReturnMovement.create([{
    returnId: row._id, productId: row.productId, sourceType: row.sourceType,
    type: "replacement_out", quantity: row.quantity, serialNumbers: newSerials,
    actorId: req.user._id, note: "Replacement released to customer",
  }], { session });
  row.resolution.replacementProductId = row.productId;
  row.resolution.replacementSerialNumbers = newSerials;
  row.resolution.completedAt = new Date();
  if (row.sourceType === "order" && row.serialNumbers.length && newSerials.length === row.serialNumbers.length) {
    for (let index = 0; index < row.serialNumbers.length; index += 1) {
      await CustomerAsset.updateOne({ originType: "order", originId: row.sourceId, "equipment.serialNumber": row.serialNumbers[index] }, { $set: { "equipment.serialNumber": newSerials[index] } }, { session });
    }
  }
  record(row, req, "completed", "replacement_released", text(req.body.note, 1000) || "Replacement released to customer");
}, "Replacement ready", "Your replacement has been recorded and released."));

router.post("/:id/repair-complete", requireRole("admin"), (req, res) => changeReturn(req, res, async (row, session) => {
  if (row.status !== "repair_pending" || row.resolution.type !== "repair") throw error("This return is not waiting for repair.", 409);
  const workOrderId = text(req.body.workOrderId, 50);
  const notes = text(req.body.notes, 2000);
  if (!mongoose.Types.ObjectId.isValid(workOrderId) || notes.length < 10) throw error("Select a completed work order and describe the repair.");
  const WorkOrder = require("../models/WorkOrder");
  const workOrder = await WorkOrder.findOne({ _id: workOrderId, status: "completed" }).session(session);
  if (!workOrder || (row.bookingId && String(workOrder.bookingId) !== String(row.bookingId))) throw error("Completed work order does not match this return.", 409);
  row.workOrderId = workOrder._id;
  row.resolution.completedAt = new Date();
  record(row, req, "completed", "repair_completed", notes);
}, "Repair complete"));

router.post("/:id/restock", requireRole("admin"), (req, res) => changeReturn(req, res, async (row, session) => {
  if (row.status !== "completed" || !["refund", "replacement"].includes(row.resolution?.type)) throw error("Complete the refund or replacement first.", 409);
  if (!row.receivedAt || !row.inspection?.resellable || row.inventoryDisposition === "restocked") throw error("This item was not confirmed safe to restock.", 409);
  const source = await sourceFor(row.sourceType, row.sourceId, session);
  const item = source && policy.itemFor(row.sourceType, source, row.itemIndex);
  if (!item || policy.itemIdentity(row.sourceType, item) !== String(row.productId)) throw error("Original product could not be verified.", 409);
  let updated;
  if (row.sourceType === "order" && item.isHvac && item.parentHvacId) {
    updated = await HVACProduct.updateOne({ _id: item.parentHvacId, "variants._id": item.inventoryId }, { $inc: { "variants.$.quantity": row.quantity } }, { session });
  } else if (row.sourceType === "order") {
    updated = await Inventory.updateOne({ _id: item.inventoryId }, { $inc: { quantity: row.quantity } }, { session });
  } else {
    updated = await Tool.updateOne({ _id: item.toolId }, { $inc: { quantity: row.quantity } }, { session });
  }
  if (!updated?.modifiedCount) throw error("Stock record not found. Do not mark this item restocked.", 409);
  await ProductReturnMovement.create([{
    returnId: row._id, productId: row.productId, sourceType: row.sourceType,
    type: "restock", quantity: row.quantity, serialNumbers: row.serialNumbers,
    actorId: req.user._id, note: text(req.body.note, 1000) || "Inspected item confirmed resellable",
  }], { session });
  row.inventoryDisposition = "restocked";
  row.history.push({ action: "restocked", from: "completed", to: "completed", actorId: req.user._id, actorRole: req.user.role, note: "Inspected item returned to sellable stock", at: new Date() });
}, "Product restocked"));

module.exports = router;

