const Notification = require("../models/Notification");

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
    const notification = await Notification.create({
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
    });

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

    return notification;
  } catch (error) {
    console.error("Failed to create notification:", error);
    return null;
  }
}

module.exports = { createNotification };
