const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");
const ejs = require("ejs");

const viewsRoot = path.join(__dirname, "../views/pages/admin");

test("secretary layout does not trap Bootstrap modals in an AOS stacking context", () => {
  const layout = fs.readFileSync(path.join(__dirname, "../views/layouts/secretary.ejs"), "utf8");
  assert.match(layout, /<main class="p-4"><%- body %><\/main>/);
  assert.doesNotMatch(layout, /<main[^>]+data-aos=/);
});

test("admin and secretary routes render the same dashboard view", () => {
  const pages = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");
  const sharedRenders = pages.match(/res\.render\("pages\/admin\/admin-dashboard"/g) || [];
  assert.equal(sharedRenders.length, 2);
  assert.doesNotMatch(pages, /res\.render\("pages\/secretary\/secretary-dashboard"/);
});

test("secretary dashboard renders role-safe endpoints and links", async () => {
  const html = await ejs.renderFile(path.join(viewsRoot, "admin-dashboard.ejs"), {
    dashboardRole: "secretary",
    user: { role: "secretary" },
  });

  assert.match(html, /\/api\/secretary\/dashboard\/operations/);
  assert.match(html, /\/api\/secretary\/analytics\/summary/);
  assert.match(html, /href="\/secretary\/staff"/);
  assert.match(html, /href="\/secretary\/operations\/resolution-center"/);
  assert.doesNotMatch(html, /<div class="dash-card" id="prepIssuesCard"/);
  assert.doesNotMatch(html, /href="\/admin\//);
});

test("shared staff directory is read-only for secretary", async () => {
  const html = await ejs.renderFile(path.join(viewsRoot, "Staff/StaffList.ejs"), {
    staffApiBase: "/api/secretary/staff",
    staffCanManage: false,
    user: { role: "secretary" },
  });

  assert.match(html, /Read-only directory/);
  assert.match(html, /const staffCanManage = false/);
  assert.doesNotMatch(html, /<button id="btnOpenAddStaff"/);
});

test("customers, payments, and technicians use shared role-aware views", async () => {
  const customerHtml = await ejs.renderFile(path.join(viewsRoot, "Customers/CustomerList.ejs"), {
    customerApiBase: "/api/secretary/customers",
    customerCanManage: false,
    customerCanBlock: false,
    customerCanUnblock: false,
  });
  assert.match(customerHtml, /const customerApiBase = "\/api\/secretary\/customers"/);
  assert.match(customerHtml, /const customerCanBlock = false/);

  const paymentsHtml = await ejs.renderFile(path.join(viewsRoot, "Payments/Payments.ejs"), {
    paymentsApiBase: "/api/secretary/payments",
    paymentsCanManage: false,
  });
  assert.match(paymentsHtml, /apiBase: "\/api\/secretary\/payments"/);
  assert.match(paymentsHtml, /canManage: false/);

  const techniciansHtml = await ejs.renderFile(path.join(viewsRoot, "Technicians/TechnicianList.ejs"), {
    techniciansApiBase: "/api/secretary/technicians",
    techniciansCanManageAccounts: false,
  });
  assert.match(techniciansHtml, /Account changes are admin-only/);
  assert.match(techniciansHtml, /const techniciansCanManageAccounts = false/);
  assert.doesNotMatch(techniciansHtml, /> Add Technician<\/a>/);
});

test("secretary shared-page routes do not expose admin-only management pages", () => {
  const pages = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");
  for (const sharedView of [
    "pages/admin/Customers/CustomerList",
    "pages/admin/Payments/Payments",
    "pages/admin/Technicians/TechnicianList",
  ]) {
    const matches = pages.match(new RegExp(`res\\.render\\("${sharedView.replaceAll("/", "\\/")}"`, "g")) || [];
    assert.equal(matches.length, 2, sharedView);
  }
  assert.doesNotMatch(pages, /"\/secretary\/payroll\/manage"/);
  assert.doesNotMatch(pages, /"\/secretary\/(roles|audit-trail|settings\/system)"/);
  const secretaryRoutes = pages.slice(pages.indexOf("// Secretary dashboard"));
  assert.doesNotMatch(secretaryRoutes, /res\.redirect\("\/admin\//);
});

test("core services and repair categories use the same admin-grade views", async () => {
  const coreHtml = await ejs.renderFile(path.join(viewsRoot, "Services/CoreServices.ejs"), {
    coreServices: [],
    coreServicesApiBase: "/api/secretary/core-services",
  });
  assert.match(coreHtml, /let url = "\/api\/secretary\/core-services"/);

  const repairHtml = await ejs.renderFile(path.join(viewsRoot, "Services/ServiceCategories.ejs"), {
    serviceCategories: [],
    serviceCategoriesApiBase: "/api/secretary/service-categories",
    serviceCategoriesCorePath: "/secretary/services/core",
    serviceCategoriesCanManage: true,
  });
  assert.match(repairHtml, /const API = "\/api\/secretary\/service-categories"/);
  assert.match(repairHtml, /const CAN_MANAGE = true/);
  assert.match(repairHtml, /href="\/secretary\/services\/core"/);
  assert.doesNotMatch(repairHtml, /\/api\/admin\/service-categories/);
  for (const script of [...repairHtml.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean)) {
    assert.doesNotThrow(() => new vm.Script(script));
  }

  const pages = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");
  assert.doesNotMatch(pages, /pages\/secretary\/Services\/(Coreservices|Repairservices)/);
  const secretaryServices = pages.slice(pages.indexOf('"/secretary/services/core"'), pages.indexOf("// Secretary inventory routes"));
  assert.match(secretaryServices, /res\.render\("pages\/admin\/Services\/ServiceCategories"/);
  assert.doesNotMatch(secretaryServices, /res\.render\("pages\/admin\/Services\/RepairServices"/);
});

test("admin and secretary repair category APIs share one RBAC-governed contract", () => {
  const adminApi = fs.readFileSync(path.join(__dirname, "../routes/adminApi.js"), "utf8");
  const secretaryApi = fs.readFileSync(path.join(__dirname, "../routes/secretaryApi.js"), "utf8");
  const permissions = fs.readFileSync(path.join(__dirname, "../middleware/requirePermission.js"), "utf8");
  for (const api of [adminApi, secretaryApi]) {
    assert.match(api, /controllers\/serviceCategoryController/);
    assert.match(api, /router\.get\("\/service-categories", serviceCategories\.list\)/);
    assert.match(api, /router\.post\("\/service-categories", serviceCategories\.create\)/);
    assert.match(api, /router\.patch\("\/service-categories\/:id", serviceCategories\.update\)/);
  }
  assert.match(permissions, /path\.startsWith\("\/api\/secretary\/service-categories"\).*read \? "services\.view" : "services\.manage"/);
});

test("secretary navigation mirrors the admin workspace structure without admin-only links", async () => {
  const sidebar = path.join(__dirname, "../views/partials/secretary-sidebar.ejs");
  const html = await ejs.renderFile(sidebar, {
    user: { role: "secretary", name: "Secretary User" },
    effectivePermissions: [
      "dashboard.view", "appointments.view", "appointments.manage",
      "booking_requests.view", "orders.view", "services.view",
      "inventory.view", "customers.view", "technicians.view", "staff.view",
      "attendance.self.manage", "payments.view", "payroll.self.view", "reports.view",
    ],
  });

  for (const section of ["Core", "Operations", "People", "Finance", "Analytics"]) {
    assert.match(html, new RegExp(`class="section-label">${section}<`));
  }
  assert.match(html, /href="\/secretary\/appointments"/);
  assert.match(html, /href="\/secretary\/inventory\/ordered-products"/);
  assert.match(html, /href="\/secretary\/payments"/);
  assert.match(html, /href="\/secretary\/appointments\/repair-scheduling"/);
  assert.match(html, /href="\/secretary\/appointments\/expenses"/);
  assert.match(html, /href="\/secretary\/projects"/);
  assert.match(html, /href="\/secretary\/appointments\/cancellation-log"/);
  assert.match(html, /href="\/secretary\/operations\/resolution-center"/);
  assert.doesNotMatch(html, /href="\/admin\//);
  assert.doesNotMatch(html, /(Roles &amp; Permissions|Audit Trail|Payment Remittance|Add Staff|Warranty|Maintenance)/);
  assert.doesNotMatch(html, /(Booking Requests|Service Tracking)/);
});

test("secretary navbar reuses the complete role-aware admin notification center", async () => {
  const navbar = path.join(__dirname, "../views/partials/secretary-navbar.ejs");
  const html = await ejs.renderFile(navbar, {
    user: { _id: "secretary-user-id", role: "secretary", name: "Secretary User" },
  });

  assert.match(html, /href="\/secretary"/);
  assert.match(html, /<span class="role">Secretary<\/span>/);
  assert.match(html, /id="notifBadge"/);
  assert.match(html, /id="notifPanel"/);
  assert.match(html, /id="notifModal"/);
  assert.match(html, /fetch\('\/api\/notifications\?limit=15'/);
  assert.match(html, /fetch\('\/api\/notifications\/unread-count'/);
  assert.match(html, /socket\.on\('notification:new'/);
  assert.doesNotMatch(html, /href="\/admin"/);

  for (const script of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean)) {
    assert.doesNotThrow(() => new vm.Script(script));
  }

  const secretaryLayout = fs.readFileSync(path.join(__dirname, "../views/layouts/secretary.ejs"), "utf8");
  const adminLayout = fs.readFileSync(path.join(__dirname, "../views/layouts/admin.ejs"), "utf8");
  assert.match(secretaryLayout, /src="\/socket\.io\/socket\.io\.js"/);
  assert.match(adminLayout, /src="\/socket\.io\/socket\.io\.js"/);
});

test("secretary navigation badges use the shared scoped operational counts", async () => {
  const sidebar = path.join(__dirname, "../views/partials/secretary-sidebar.ejs");
  const html = await ejs.renderFile(sidebar, {
    user: { role: "secretary" },
    effectivePermissions: ["appointments.view", "appointments.manage", "orders.view"],
  });

  for (const badgeId of [
    "pendingReviewCount",
    "appointmentsBadge",
    "ordersBadge",
    "repairSchedBadge",
    "expensesBadge",
    "projectsBadge",
    "attentionBadge",
    "escalatedBadge",
  ]) {
    assert.match(html, new RegExp(`id="${badgeId}"`));
  }
  assert.match(html, /fetch\('\/api\/notifications\/counts'/);
  assert.match(html, /fetch\('\/api\/orders\/badge'/);
  assert.match(html, /fetch\('\/api\/projects\/dashboard'/);
  assert.match(html, /fetch\('\/api\/secretary\/operations\/repair-scheduling-queue\/stats'/);
  assert.doesNotMatch(html, /fetch\('\/api\/admin\//);
});

test("operational admin notifications receive secretary-safe destinations", () => {
  const Notification = require("../models/Notification");
  const { toSecretaryNotificationLink } = require("../utils/notify");

  assert.equal(toSecretaryNotificationLink("/admin/appointments/queue"), "/secretary/appointments?tab=queue");
  assert.equal(toSecretaryNotificationLink("/admin/appointments/attention?status=no-show"), "/secretary/operations/resolution-center?status=no-show");
  assert.equal(toSecretaryNotificationLink("/admin/appointments/orders?status=pending"), "/secretary/inventory/ordered-products?status=pending");
  assert.equal(toSecretaryNotificationLink("/admin/operations/calendar?date=2026-09-14"), "/secretary/operations/calendar?date=2026-09-14");
  assert.equal(toSecretaryNotificationLink("/admin/payments/remittance"), "");
  assert.equal(toSecretaryNotificationLink("/admin/roles"), "");

  const supportedTypes = Notification.schema.path("type").enumValues;
  for (const emittedType of ["assignment_expired", "booking_reschedule_request", "parts_request", "payment_collected", "resource_issue"]) {
    assert.ok(supportedTypes.includes(emittedType), emittedType);
  }

  const notifySource = fs.readFileSync(path.join(__dirname, "../utils/notify.js"), "utf8");
  assert.match(notifySource, /role === "admin" \? toSecretaryNotificationLink\(link\)/);
  assert.match(notifySource, /role: "secretary"/);
});

test("sidebar renders the current navigation group open across page loads", async () => {
  const secretarySidebar = path.join(__dirname, "../views/partials/secretary-sidebar.ejs");
  const secretaryHtml = await ejs.renderFile(secretarySidebar, {
    currentPath: "/secretary/appointments/walk-in",
    user: { role: "secretary" },
    effectivePermissions: ["appointments.view", "appointments.manage", "orders.view"],
  });
  assert.match(secretaryHtml, /class="btn btn-toggle nav-link active"[^>]+data-bs-target="#appointment-mgmt-collapse"[^>]+aria-expanded="true"/);
  const secretaryWorkLabel = secretaryHtml.indexOf('<span class="nav-label">Work</span>');
  const secretaryBookingsLink = secretaryHtml.indexOf('href="/secretary/appointments"', secretaryWorkLabel);
  assert.ok(secretaryWorkLabel >= 0 && secretaryBookingsLink > secretaryWorkLabel);
  assert.match(secretaryHtml, /class="collapse show" id="appointment-mgmt-collapse"/);

  const ordersHtml = await ejs.renderFile(secretarySidebar, {
    currentPath: "/secretary/inventory/ordered-products",
    user: { role: "secretary" },
    effectivePermissions: ["orders.view", "inventory.view"],
  });
  assert.match(ordersHtml, /class="collapse show" id="appointment-mgmt-collapse"/);
  assert.doesNotMatch(ordersHtml, /class="collapse show" id="inventory-collapse"/);

  const adminHtml = await ejs.renderFile(path.join(__dirname, "../views/partials/admin-sidebar.ejs"), {
    currentPath: "/admin/appointments/walk-in",
    user: { role: "admin" },
  });
  assert.match(adminHtml, /class="collapse show" id="appointment-mgmt-collapse"/);
  const adminWorkLabel = adminHtml.indexOf('<span class="nav-label">Work</span>');
  const adminBookingsLink = adminHtml.indexOf('href="/admin/appointments"', adminWorkLabel);
  assert.ok(adminWorkLabel >= 0 && adminBookingsLink > adminWorkLabel);

  const secretaryLayout = fs.readFileSync(path.join(__dirname, "../views/layouts/secretary.ejs"), "utf8");
  assert.doesNotMatch(secretaryLayout, /src="\/js\/sidebar\.js"/);

  const sharedSidebarScript = fs.readFileSync(path.join(__dirname, "../public/js/admin.js"), "utf8");
  assert.match(sharedSidebarScript, /getOrCreateInstance\([\s\S]*?parentCollapse,[\s\S]*?\{ toggle: false \}/);
  assert.match(sharedSidebarScript, /if \(!parentCollapse\.classList\.contains\("show"\)\) bsCollapse\.show\(\)/);
});

test("secretary bookings and calendar render the same views as admin", async () => {
  const pages = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");
  assert.equal((pages.match(/res\.render\("pages\/admin\/Appointments\/AppointmentsUnified"/g) || []).length, 2);
  // One shared renderer serves admin/secretary; the second render is the
  // technician's ownership-scoped version of the same calendar view.
  assert.equal((pages.match(/res\.render\("pages\/admin\/Appointments\/Calendar"/g) || []).length, 2);
  assert.match(pages, /"\/admin\/operations\/calendar"[\s\S]*?renderOperationsCalendar\(res, "admin"\)/);
  assert.match(pages, /"\/secretary\/operations\/calendar"[\s\S]*?renderOperationsCalendar\(res, "secretary"\)/);
  assert.match(pages, /"\/admin\/appointments\/calendar"[\s\S]*?res\.redirect\("\/admin\/operations\/calendar"\)/);
  assert.match(pages, /"\/secretary\/calendar"[\s\S]*?res\.redirect\("\/secretary\/operations\/calendar"\)/);
  assert.doesNotMatch(pages, /res\.render\("pages\/secretary\/Appointments\/(Appointments|Calendar|BookingRequest)"/);

  const bookingHtml = await ejs.renderFile(path.join(viewsRoot, "Appointments/AppointmentsUnified.ejs"), {
    appointmentsWorkspaceRole: "secretary",
    appointmentsApiBase: "/api/secretary/appointments",
    appointmentsToolsApiBase: "/api/secretary/tools",
    appointmentsCanResolve: true,
    appointmentsResolutionPath: "/secretary/operations/resolution-center",
    appointmentsResolutionApiBase: "/api/secretary/operations",
  });
  assert.match(bookingHtml, /var APPOINTMENTS_IS_ADMIN = false/);
  assert.match(bookingHtml, /var APPOINTMENTS_API = "\/api\/secretary\/appointments"/);
  assert.match(bookingHtml, /var APPOINTMENTS_TOOLS_API = "\/api\/secretary\/tools"/);
  assert.match(bookingHtml, /var APPOINTMENTS_CAN_RESOLVE = true/);
  assert.match(bookingHtml, /href="\/secretary\/operations\/resolution-center\?source=booking"/);
  assert.match(bookingHtml, /href="\/secretary\/operations\/calendar"/);
  assert.match(bookingHtml, /var APPOINTMENTS_RESOLUTION_API = "\/api\/secretary\/operations"/);
  assert.doesNotMatch(bookingHtml, /\/api\/admin\/appointments/);
  assert.match(bookingHtml, /id="bookingResolutionCount"/);

  const calendarHtml = await ejs.renderFile(path.join(viewsRoot, "Appointments/Calendar.ejs"), {
    calendarTechniciansApi: "/api/secretary/technicians",
    calendarSchedulesApi: "/api/secretary/technician-schedules",
    calendarAppointmentsApi: "/api/secretary/appointments",
    calendarAppointmentsListApi: "/api/appointments",
    calendarOrdersApi: "/api/orders",
    calendarBookingsPath: "/secretary/appointments",
    calendarOrdersPath: "/secretary/inventory/ordered-products",
  });
  assert.match(calendarHtml, /const calendarTechniciansApi = "\/api\/secretary\/technicians"/);
  assert.match(calendarHtml, /const calendarSchedulesApi = "\/api\/secretary\/technician-schedules"/);
  assert.match(calendarHtml, /const calendarAppointmentsApi = "\/api\/secretary\/appointments"/);
  assert.match(calendarHtml, /const calendarAppointmentsListApi = "\/api\/appointments"/);
  assert.match(calendarHtml, /const calendarOrdersApi = "\/api\/orders"/);
  assert.match(calendarHtml, /href="\/secretary\/appointments"/);
});

test("secretary walk-in exposes the same service and aircon order workflows as admin", async () => {
  const pages = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");
  const secretaryWalkInRoute = pages.slice(
    pages.indexOf('"/secretary/appointments/walk-in"'),
    pages.indexOf('"/secretary/pointofsale"'),
  );
  assert.match(secretaryWalkInRoute, /res\.render\("pages\/admin\/Appointments\/WalkIn"/);
  assert.match(secretaryWalkInRoute, /airconOrdersEnabled: true/);
  assert.doesNotMatch(secretaryWalkInRoute, /airconOrdersEnabled: false/);

  const html = await ejs.renderFile(path.join(viewsRoot, "Appointments/WalkIn.ejs"), {
    user: { role: "secretary" },
    airconOrdersEnabled: true,
  });
  assert.match(html, /data-walkin-mode="services"/);
  assert.match(html, /data-walkin-mode="aircon"/);
  assert.match(html, /id="walkinAirconPane"/);
  assert.match(html, /\/api\/walk-in-aircon\/checkout/);
  assert.match(html, /href="\/secretary\/appointments"/);
});

test("secretary appointments API mounts the shared RBAC-protected routers", () => {
  const index = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  assert.match(index, /app\.use\("\/api\/secretary\/appointments", equipmentReturnRoutes\)/);
  assert.match(index, /app\.use\("\/api\/secretary\/appointments", appointmentManagement\)/);
});

test("secretary operational routes reuse admin-grade views with scoped endpoints", async () => {
  const pages = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");
  for (const view of [
    "pages/admin/Appointments/RepairSchedulingQueue",
    "pages/admin/Appointments/ExpenseApproval",
    "pages/admin/Appointments/CancellationLog",
    "pages/admin/Projects/ProjectList",
    "pages/admin/Projects/ProjectDetail",
  ]) {
    assert.equal((pages.match(new RegExp(`res\\.render\\("${view.replaceAll("/", "\\/")}"`, "g")) || []).length, 2, view);
  }

  const repairHtml = await ejs.renderFile(path.join(viewsRoot, "Appointments/RepairSchedulingQueue.ejs"), {
    repairOperationsApiBase: "/api/secretary/operations",
    repairPartsPath: "/secretary/inventory/repair-parts",
  });
  assert.match(repairHtml, /const REPAIR_OPERATIONS_API = "\/api\/secretary\/operations"/);
  assert.match(repairHtml, /const REPAIR_PARTS_PATH = "\/secretary\/inventory\/repair-parts"/);
  assert.doesNotMatch(repairHtml, /\/api\/admin\/repair/);

  const expenseHtml = await ejs.renderFile(path.join(viewsRoot, "Appointments/ExpenseApproval.ejs"), {
    expensesApiBase: "/api/secretary/appointments",
    expensesCanApprove: false,
  });
  assert.match(expenseHtml, /const EXPENSES_API = "\/api\/secretary\/appointments"/);
  assert.match(expenseHtml, /const EXPENSES_CAN_APPROVE = false/);

  const cancellationHtml = await ejs.renderFile(path.join(viewsRoot, "Appointments/CancellationLog.ejs"), {
    cancellationApiBase: "/api/secretary/appointments",
    cancellationQueuePath: "/secretary/appointments?tab=queue",
  });
  assert.match(cancellationHtml, /const CANCELLATION_API = "\/api\/secretary\/appointments"/);
  assert.match(cancellationHtml, /const CANCELLATION_QUEUE_PATH = "\/secretary\/appointments\?tab=queue"/);

  const projectHtml = await ejs.renderFile(path.join(viewsRoot, "Projects/ProjectList.ejs"), {
    projectWorkspaceBase: "/secretary/projects",
  });
  assert.match(projectHtml, /const PROJECT_WORKSPACE_BASE = "\/secretary\/projects"/);
  assert.doesNotMatch(projectHtml, /\/admin\/projects\//);
});

test("secretary shared operations APIs are narrowly mounted and permission protected", () => {
  const index = fs.readFileSync(path.join(__dirname, "../index.js"), "utf8");
  const adminApi = fs.readFileSync(path.join(__dirname, "../routes/adminApi.js"), "utf8");
  assert.match(index, /app\.use\("\/api\/secretary\/operations", adminApi\)/);
  assert.match(adminApi, /req\.baseUrl === "\/api\/secretary\/operations"/);
  assert.match(adminApi, /isResolutionWorkflowPath/);
  assert.match(adminApi, /"payments\.manage"/);
  assert.match(adminApi, /"appointments\.manage"/);
  assert.match(adminApi, /return res\.status\(403\)\.json\(\{ error: "Forbidden" \}\)/);
});

test("secretary inventory routes render the admin-grade inventory views", () => {
  const pages = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");
  const secretaryInventory = pages.slice(pages.indexOf("// Secretary inventory routes"), pages.indexOf("// Secretary reports routes"));

  for (const view of [
    "pages/admin/Inventory/InventoryList",
    "pages/admin/Inventory/AirconOrders",
    "pages/admin/Inventory/StockHistory",
  ]) {
    assert.match(secretaryInventory, new RegExp(`res\\.render\\("${view.replaceAll("/", "\\/")}"`));
  }
  assert.match(secretaryInventory, /"\/secretary\/inventory\/deliveries"[\s\S]*?res\.redirect\("\/secretary\/operations\/calendar"\)/);
  assert.doesNotMatch(secretaryInventory, /pages\/secretary\/Inventory\//);
});

test("shared inventory views use secretary-safe endpoints and role-aware resolution controls", async () => {
  const inventoryHtml = await ejs.renderFile(path.join(viewsRoot, "Inventory/InventoryList.ejs"), {
    inventoryApiBase: "/api/secretary/hvac",
  });
  assert.match(inventoryHtml, /const inventoryApiBase = "\/api\/secretary\/hvac"/);

  const historyHtml = await ejs.renderFile(path.join(viewsRoot, "Inventory/StockHistory.ejs"), {
    stockAdjustmentsApiBase: "/api/secretary/stock-adjustments",
  });
  assert.match(historyHtml, /const stockAdjustmentsApiBase = "\/api\/secretary\/stock-adjustments"/);

  const partsHtml = await ejs.renderFile(path.join(viewsRoot, "Inventory/RepairParts.ejs"), {
    repairPartsApiBase: "/api/secretary/tools",
    repairPartsPosPath: "/secretary/pointofsale",
  });
  assert.match(partsHtml, /const repairPartsApiBase = "\/api\/secretary\/tools"/);
  assert.match(partsHtml, /href="\/secretary\/pointofsale"/);

  const posHtml = await ejs.renderFile(path.join(viewsRoot, "Inventory/POS.ejs"), {
    posOrdersPath: "/secretary/inventory/ordered-products",
    user: { role: "secretary" },
  });
  assert.match(posHtml, /const posOrdersPath = "\/secretary\/inventory\/ordered-products"/);

  const ordersHtml = await ejs.renderFile(path.join(viewsRoot, "Inventory/AirconOrders.ejs"), {
    ordersWorkspaceRole: "secretary",
    ordersCanResolve: true,
    ordersResolutionPath: "/secretary/operations/resolution-center",
    ordersResolutionApiBase: "/api/secretary/operations",
  });
  assert.match(ordersHtml, /role: "secretary"/);
  assert.match(ordersHtml, /canResolve: true/);
  assert.match(ordersHtml, /href="\/secretary\/operations\/resolution-center\?source=order"/);
  assert.match(ordersHtml, /href="\/secretary\/operations\/calendar"/);
  assert.match(ordersHtml, /resolutionApiBase: "\/api\/secretary\/operations"/);
});

test("secretary resolution center reuses the admin workspace with scoped paths", async () => {
  const html = await ejs.renderFile(path.join(viewsRoot, "Appointments/AttentionQueue.ejs"), {
    resolutionWorkspaceRole: "secretary",
    resolutionApiBase: "/api/secretary/operations",
    resolutionAppointmentsApiBase: "/api/secretary/appointments",
    resolutionBookingsPath: "/secretary/appointments",
    resolutionOrdersPath: "/secretary/inventory/ordered-products",
    resolutionCanViewOrders: true,
  });
  assert.match(html, /const RESOLUTION_WORKSPACE_ROLE = "secretary"/);
  assert.match(html, /const RESOLUTION_API_BASE = "\/api\/secretary\/operations"/);
  assert.match(html, /const RESOLUTION_APPOINTMENTS_API = "\/api\/secretary\/appointments"/);
  assert.match(html, /const RESOLUTION_BOOKINGS_PATH = "\/secretary\/appointments"/);
  assert.match(html, /const RESOLUTION_ORDERS_PATH = "\/secretary\/inventory\/ordered-products"/);
  assert.doesNotMatch(html, /fetch\(`\/api\/admin/);
  for (const script of [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]).filter(Boolean)) {
    assert.doesNotThrow(() => new vm.Script(script));
  }

  const pages = fs.readFileSync(path.join(__dirname, "../routes/pages.js"), "utf8");
  const secretaryRoute = pages.slice(
    pages.indexOf('"/secretary/operations/resolution-center"'),
    pages.indexOf('"/secretary/appointments/completed"'),
  );
  assert.match(secretaryRoute, /res\.render\("pages\/admin\/Appointments\/AttentionQueue"/);
  assert.match(secretaryRoute, /resolutionApiBase: "\/api\/secretary\/operations"/);
});
