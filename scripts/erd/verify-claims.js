/* Spot-checks the specific claims made in docs/erd/ERD.md against the real schemas. */
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const modelDir = path.resolve(__dirname, '..', '..', 'server', 'models');
for (const f of fs.readdirSync(modelDir).filter((f) => f.endsWith('.js')).sort()) require(path.join(modelDir, f));
const M = mongoose.models;
const idx = (n) => M[n].schema.indexes().map(([k, o]) => ({ k, o }));
const has = (n, p) => !!M[n].schema.path(p) || Object.keys(M[n].schema.nested || {}).includes(p);
const out = [];
const chk = (label, cond) => out.push(`${cond ? 'PASS' : 'FAIL'}  ${label}`);

// R1
chk('R1 Purchase.items.productId refs Product',
  JSON.stringify(M.Purchase.schema.path('items.productId').options).includes('Product'));
chk('R1 Product model truly absent', !M.Product);

// R2 userId vs customerId
chk('R2 BookingService has NO userId path', !M.BookingService.schema.path('userId'));
chk('R2 BookingService HAS customerId', !!M.BookingService.schema.path('customerId'));

// R3
chk('R3 ProductReturnMovement unique {returnId,type}',
  idx('ProductReturnMovement').some(i => Object.keys(i.k).sort().join() === 'returnId,type' && i.o.unique));

// R4
chk('R4 ProductRefund.returnId unique', idx('ProductRefund').some(i => i.k.returnId && i.o.unique));

// R5
const airconCartRef = M.AirconCart.schema.path('items.inventoryId').options.ref;
chk('R5 AirconCart.items.inventoryId refs Inventory', airconCartRef === 'Inventory');
chk('R5 Order.items.parentHvacId has NO ref', !M.Order.schema.path('items.parentHvacId').options.ref);
chk('R5 WalkInSale.items.toolId refs Tool', M.WalkInSale.schema.path('items.toolId').options.ref === 'Tool');

// R6
chk('R6 ProjectMaterial.sourceId has no ref', !M.ProjectMaterial.schema.path('sourceId')?.options?.ref);
chk('R6 ProjectMaterial.sourceId IS an ObjectId', M.ProjectMaterial.schema.path('sourceId')?.instance === 'ObjectId');

// R7 cyclic
chk('R7 CustomerAsset.latestScheduleId -> MaintenanceSchedule', M.CustomerAsset.schema.path('latestScheduleId')?.options?.ref === 'MaintenanceSchedule');
chk('R7 MaintenanceSchedule.assetId -> CustomerAsset', M.MaintenanceSchedule.schema.path('assetId')?.options?.ref === 'CustomerAsset');

// R8
chk('R8 NonWorkingDay.service refs Service (legacy)', M.NonWorkingDay.schema.path('service')?.options?.ref === 'Service');

// R9
chk('R9 BookingService.services.serviceId has no ref', !M.BookingService.schema.path('services.serviceId')?.options?.ref);
chk('R9 ...and no refPath either', !M.BookingService.schema.path('services.serviceId')?.options?.refPath);
chk('R9 BookingService.serviceId DOES use refPath', !!M.BookingService.schema.path('serviceId')?.options?.refPath);

// R10 serviceItemId bare on 4+ models
for (const [n, p] of [['Assignment', 'serviceItemId'], ['ServiceReport', 'serviceItemId'], ['EquipmentAssignment', 'serviceItemId'], ['ServiceToolUsage', 'serviceItemId'], ['StockReservation', 'serviceItemId'], ['PartsRequest', 'serviceItemId']]) {
  const f = M[n].schema.path(p);
  chk(`R10 ${n}.${p} bare ObjectId`, f?.instance === 'ObjectId' && !f?.options?.ref);
}

// R13
chk('R13 StockAdjustment only refs Tool', !M.StockAdjustment.schema.path('hvacProductId') && !M.StockAdjustment.schema.path('inventoryId'));
chk('R13 StockAdjustment.referenceId -> BookingService', M.StockAdjustment.schema.path('referenceId')?.options?.ref === 'BookingService');

// R14
chk('R14 Payroll.attendanceSummary is nested (not a ref)', !!(M.Payroll.schema.nested||{}).attendanceSummary);
chk('R14 TechnicianAttendance.userId is OPTIONAL', !M.TechnicianAttendance.schema.path('userId')?.options?.required);

// R15
chk('R15 Payroll.deductions is a plain line item', !!M.Payroll.schema.path('deductions.name') && !M.Payroll.schema.path('deductions.expenseId'));

// R16 / R17 / R18 / R19 / R20 / R21
chk('R16 Secretary.user NOT unique', !idx('Secretary').some(i => i.k.user && i.o.unique));
chk('R17 AuthSession.sessionId NOT unique', !idx('AuthSession').some(i => i.k.sessionId && i.o.unique));
chk('R18 LeaveRequest.technicianId NOT indexed', !idx('LeaveRequest').some(i => Object.keys(i.k).includes('technicianId')));
chk('R19 WorkOrder.bookingId NOT indexed', !idx('WorkOrder').some(i => Object.keys(i.k).includes('bookingId')));
chk('R20 Project.bookingId NOT unique', !idx('Project').some(i => i.o.unique));
chk('R21 Payment.workOrderId NOT indexed', !idx('Payment').some(i => Object.keys(i.k).includes('workOrderId')));

// R22 Inventory.findLowStock filters on a non-field
const src = fs.readFileSync(path.join(modelDir, 'Inventory.js'), 'utf8');
const m = src.match(/findLowStock[\s\S]{0,700}/);
chk('R22 Inventory.findLowStock filters isStockItem', !!m && m[0].includes('isStockItem'));
chk('R22 ...but Inventory has no isStockItem field', !M.Inventory.schema.path('isStockItem'));
chk('R22 Tool DOES have isStockItem', !!M.Tool.schema.path('isStockItem'));

// R23 WarrantyClaim two partial uniques
const wc = idx('WarrantyClaim').filter(i => i.o.partialFilterExpression || i.o.unique);
chk('R23 WarrantyClaim has >=2 unique/partial indexes', wc.length >= 2);

// R27 workOrderNumber non-atomic generation
const bsrc = fs.readFileSync(path.join(modelDir, 'BookingService.js'), 'utf8');
chk('R27 workOrderNumber uses countDocuments()+1', /countDocuments[\s\S]{0,200}\+ 1/.test(bsrc));

// R28 three time parsers
const files = ['server/routes/bookingRoutes.js','server/routes/appointmentManagement.js','server/utils/assignmentPlanner.js'];
const hits = files.filter(f => fs.existsSync(path.resolve(__dirname,'..','..',f)) &&
  /parseTimeToMinutes|_parseMin|minuteValue/.test(fs.readFileSync(path.resolve(__dirname,'..','..',f),'utf8')));
chk(`R28 ${hits.length} distinct time parsers found`, hits.length >= 2);

// R30 both catalogs exist with quantity
chk('R30 Inventory.quantity exists', !!M.Inventory.schema.path('quantity'));
chk('R30 HVACProduct.variants.quantity exists', !!M.HVACProduct.schema.path('variants.quantity'));
chk('R30 Tool.reservedQuantity exists', !!M.Tool.schema.path('reservedQuantity'));
chk('R30 Inventory has NO reservedQuantity', !M.Inventory.schema.path('reservedQuantity'));
chk('R30 HVACProduct has NO reservedQuantity', !M.HVACProduct.schema.path('reservedQuantity'));

// lifecycle mixin users
const L = ['archivedAt','archivedBy','archiveReason','lifecycleHistory'];
const withMixin = Object.values(M).filter(m => L.every(p => m.schema.path(p))).map(m => m.modelName).sort();
chk('lifecycle mixin used by exactly 6 models: ' + withMixin.join(','), withMixin.length === 6);
chk('User uses staffLifecycleHistory (not the mixin name)',
  !!M.User.schema.path('staffLifecycleHistory') && !M.User.schema.path('lifecycleHistory'));
chk('Technician uses staffLifecycleHistory', !!M.Technician.schema.path('staffLifecycleHistory'));

// TTL indexes
const ttl = Object.values(M).filter(m => m.schema.indexes().some(([, o]) => o.expireAfterSeconds !== undefined)).map(m => m.modelName).sort();
chk('TTL collections: ' + ttl.join(','), ttl.length === 4);

// serviceItemId uniqueness on ServiceReport
chk('ServiceReport partial unique (bookingId, serviceItemId)',
  idx('ServiceReport').some(i => Object.keys(i.k).sort().join() === 'bookingId,serviceItemId' && !!i.o.partialFilterExpression));

console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL'));
console.log(`\n${out.length - fails.length}/${out.length} passed`);
if (fails.length) process.exit(1);
