const Notification = require("../models/Notification");
const { getSystemConfiguration, priorityMeetsThreshold } = require("./systemConfiguration");

function toSecretaryNotificationLink(link) {
  if (!link || typeof link !== "string") return "";
  const queryIndex = link.search(/[?#]/);
  const pathname = queryIndex >= 0 ? link.slice(0, queryIndex) : link;
  const suffix = queryIndex >= 0 ? link.slice(queryIndex) : "";

  if (pathname === "/admin/payments/remittance" || pathname.startsWith("/admin/payments/remittance/")) {
    return "";
  }

  const exactMappings = new Map([
    ["/admin/appointments/pending", "/secretary/appointments?tab=pending"],
    ["/admin/appointments/active", "/secretary/appointments?tab=active"],
    ["/admin/appointments/queue", "/secretary/appointments?tab=queue"],
    ["/admin/appointments/completed", "/secretary/appointments?tab=completed"],
    ["/admin/appointments/waiting-reassign", "/secretary/appointments?tab=waiting"],
    ["/admin/appointments/attention", "/secretary/operations/resolution-center"],
    ["/admin/appointments/review-reschedule", "/secretary/operations/resolution-center"],
  ]);
  if (exactMappings.has(pathname)) {
    const mapped = exactMappings.get(pathname);
    if (!suffix) return mapped;
    return mapped + (mapped.includes("?") && suffix.startsWith("?") ? `&${suffix.slice(1)}` : suffix);
  }

  const prefixMappings = [
    ["/admin/appointments/orders", "/secretary/inventory/ordered-products"],
    ["/admin/inventory/ordered-products", "/secretary/inventory/ordered-products"],
    ["/admin/inventory/aircon-orders", "/secretary/inventory/ordered-products"],
    ["/admin/operations/resolution-center", "/secretary/operations/resolution-center"],
    ["/admin/operations/calendar", "/secretary/operations/calendar"],
    ["/admin/appointments/calendar", "/secretary/operations/calendar"],
    ["/admin/appointments", "/secretary/appointments"],
    ["/admin/projects", "/secretary/projects"],
    ["/admin/payments", "/secretary/payments"],
    ["/admin/inventory/repair-parts", "/secretary/inventory/repair-parts"],
    ["/admin/inventory/history", "/secretary/inventory/history"],
    ["/admin/inventory", "/secretary/inventory"],
    ["/admin/services", "/secretary/services"],
    ["/admin/customers/list", "/secretary/customers"],
    ["/admin/technicians", "/secretary/technicians"],
  ];
  const match = prefixMappings.find(([adminPath]) => pathname === adminPath || pathname.startsWith(`${adminPath}/`));
  return match ? match[1] + pathname.slice(match[0].length) + suffix : "";
}

async function sendConfiguredAdminEmail({ role, userId, title, message, priority, link }) {
  if (userId || role !== "admin") return;
  const configuration = await getSystemConfiguration();
  const preferences = configuration.notifications;
  if (!preferences.criticalEmailAlerts || !preferences.adminAlertEmail) return;
  if (!priorityMeetsThreshold(priority, preferences.minimumPriority)) return;

  const mailer = require("./mailer");
  const destination = preferences.adminAlertEmail;
  const baseUrl = String(process.env.APP_BASE_URL || process.env.APP_URL || "").replace(/\/$/, "");
  const target = link && baseUrl ? `${baseUrl}${link.startsWith("/") ? link : `/${link}`}` : "";
  await mailer.sendMail({
    to: destination,
    subject: `[CALIDRO RACS] ${title}`,
    text: `${message}${target ? `\n\nReview: ${target}` : ""}`,
  });
}

/**
 * Create a notification and optionally emit via Socket.io
 * @param {Object} params
 * @param {String} params.type - Notification type (booking_created, assignment_new, etc.)
 * @param {String} params.title - Short title
 * @param {String} params.message - Description
 * @param {ObjectId} [params.userId] - Specific user to notify
 * @param {String} [params.role] - Role to notify (admin, secretary, technician)
 * @param {ObjectId} [params.referenceId] - Related document ID
 * @param {String} [params.referenceModel] - Related model name
 * @param {String} [params.link] - Navigation link
 * @param {String} [params.priority] - low, normal, high, urgent
 * @param {Object} [params.io] - Socket.io instance (app.get("io"))
 */
async function createNotification({
  type,
  title,
  message,
  userId = null,
  role = null,
  referenceId = null,
  referenceModel = null,
  link = "",
  priority = "normal",
  io = null,
}) {
  try {
    const requestedUserId = userId;
    let technicianRoomId = null;
    if (userId && role === "technician") {
      const Technician = require("../models/Technician");
      const technician = await Technician.findById(userId).select("user").lean().catch(() => null);
      if (technician?.user) {
        technicianRoomId = technician._id;
        userId = technician.user;
      }
    }
    const notificationData = {
      userId,
      // A notification is either targeted to one account or broadcast to a
      // role. Storing both made private technician updates visible to everyone
      // with the same role because the inbox uses an OR filter.
      role: userId ? null : role,
      type,
      title,
      message,
      referenceId,
      referenceModel,
      link,
      priority,
    };
    const notificationsToCreate = [notificationData];
    const secretaryLink = !userId && role === "admin" ? toSecretaryNotificationLink(link) : "";
    if (secretaryLink) {
      notificationsToCreate.push({
        ...notificationData,
        role: "secretary",
        link: secretaryLink,
      });
    }
    const [notification] = await Notification.create(notificationsToCreate);

    // Emit via Socket.io if available
    if (io) {
      // Emit to admin room
      if (!userId && (!role || role === "admin" || role === "secretary")) {
        io.to("admin-room").emit("notification:new", {
          _id: notification._id,
          type,
          title,
          message,
          link,
          priority,
          createdAt: notification.createdAt,
        });
      }

      // Emit to specific user
      if (userId) {
        io.to("user:" + userId.toString()).emit("notification:new", {
          _id: notification._id,
          type,
          title,
          message,
          link,
          priority,
          createdAt: notification.createdAt,
        });

        // Technicians join room "tech:<technicianId>", not "user:<userId>"
        if (role === "technician" && (technicianRoomId || requestedUserId)) {
          io.to("tech:" + String(technicianRoomId || requestedUserId)).emit("notification:new", {
            _id: notification._id,
            type,
            title,
            message,
            link,
            priority,
            createdAt: notification.createdAt,
          });
        }
      }
    }

    await sendConfiguredAdminEmail({ role, userId, title, message, priority, link }).catch((error) => {
      console.warn("Failed to send configured admin alert email:", error && error.message);
    });

    return notification;
  } catch (error) {
    console.error("Failed to create notification:", error);
    return null;
  }
}

module.exports = { createNotification, toSecretaryNotificationLink };
