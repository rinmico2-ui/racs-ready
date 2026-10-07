"use strict";

const { isUnsupportedMongoWriteFeature } = require("./mongoWriteSupport");

function isKnownStandalone(connection) {
  const servers = connection?.getClient?.()?.topology?.description?.servers;
  const descriptions = servers && typeof servers.values === "function" ? [...servers.values()] : [];
  return descriptions.length > 0 && descriptions.every(server => server.type === "Standalone");
}

async function bookingSubmissionIsComplete({ booking, submissionId, Payment, UnitAssistanceRequest, RelocationRequest }) {
  if (!await Payment.exists({ bookingId: booking._id, clientSubmissionId: `booking:${submissionId}` })) return false;
  for (const service of booking.services || []) {
    if (service.assistanceRequestId && !await UnitAssistanceRequest.exists({
      _id: service.assistanceRequestId, bookingId: booking._id, status: "converted",
    })) return false;
    if (service.relocation?.scope === "custom_quote" && !await RelocationRequest.exists({
      _id: service.relocation.requestId, bookingId: booking._id, status: "converted",
    })) return false;
  }
  return true;
}

async function persistBookingSubmission({
  mongoose, BookingService, Payment, UnitAssistanceRequest, RelocationRequest,
  booking, payment, services, customerId,
}) {
  const bookingId = booking._id;
  const assistance = services.filter(service => service.assistanceRequestId);
  const relocations = services.filter(service => service.relocation?.scope === "custom_quote");

  async function claimQuotes(session) {
    const options = session ? { session, returnDocument: "after" } : { returnDocument: "after" };
    for (const service of assistance) {
      const accepted = await UnitAssistanceRequest.findOneAndUpdate({
        _id: service.assistanceRequestId, customerId,
        status: "accepted", bookingId: null, existingBookingId: null,
        "quote.unitPrice": service.unitPrice,
        "quote.brand": service.brand,
        "quote.hp": service.hp,
        "quote.airconType": service.airconType,
        "quote.expiresAt": { $gt: new Date() },
      }, {
        $set: { status: "converted", bookingId },
        $push: { events: { action: "converted", actorId: customerId, unitPrice: service.unitPrice } },
      }, options);
      if (!accepted) throw Object.assign(new Error("The unit quote was already used or changed. Review your request."), { status: 409 });
    }
    for (const service of relocations) {
      const accepted = await RelocationRequest.findOneAndUpdate({
        _id: service.relocation.requestId, customerId, status: "accepted", bookingId: null,
        "quote.total": service.unitPrice, "quote.expiresAt": { $gt: new Date() },
      }, {
        $set: { status: "converted", bookingId },
        $push: { events: { action: "converted", actorId: customerId } },
      }, options);
      if (!accepted) throw Object.assign(new Error("This relocation quote was already used or changed. Review your request."), { status: 409 });
    }
  }

  function newDocuments() {
    return {
      bookingAttempt: new BookingService(booking.toObject({ depopulate: true, versionKey: false })),
      paymentAttempt: new Payment(payment.toObject({ depopulate: true, versionKey: false })),
    };
  }

  async function writeWithoutTransaction() {
    const { bookingAttempt, paymentAttempt } = newDocuments();
    try {
      await bookingAttempt.save();
      await paymentAttempt.save();
      await claimQuotes(null);
      return bookingAttempt;
    } catch (error) {
      // On standalone deployments, use conditional reversals instead of a
      // transaction. The submission ID remains safe to retry after cleanup.
      const cleanupErrors = [];
      const undo = async work => { try { await work(); } catch (cleanupError) { cleanupErrors.push(cleanupError); } };
      for (const service of assistance) {
        await undo(() => UnitAssistanceRequest.updateOne(
          { _id: service.assistanceRequestId, bookingId, status: "converted" },
          { $set: { status: "accepted", bookingId: null },
            $pull: { events: { action: "converted", actorId: customerId } } },
        ));
      }
      for (const service of relocations) {
        await undo(() => RelocationRequest.updateOne(
          { _id: service.relocation.requestId, bookingId, status: "converted" },
          { $set: { status: "accepted", bookingId: null },
            $pull: { events: { action: "converted", actorId: customerId } } },
        ));
      }
      await undo(() => Payment.deleteOne({ _id: paymentAttempt._id, bookingId }));
      await undo(() => BookingService.deleteOne({ _id: bookingId, customerId }));
      if (cleanupErrors.length) {
        error.cleanupErrors = cleanupErrors;
        error.status = 503;
      }
      throw error;
    }
  }

  if (!isKnownStandalone(mongoose.connection)) {
    let session;
    try {
      session = await mongoose.startSession();
      let committed;
      await session.withTransaction(async () => {
        const { bookingAttempt, paymentAttempt } = newDocuments();
        await bookingAttempt.save({ session });
        await paymentAttempt.save({ session });
        await claimQuotes(session);
        committed = bookingAttempt;
      });
      return committed;
    } catch (error) {
      if (!isUnsupportedMongoWriteFeature(error)) throw error;
      // Unsupported transactions fail before commit. Check the unique booking
      // ID before retrying without a session in case a compatible server did
      // commit but the acknowledgement was lost.
      const existing = await BookingService.findById(bookingId);
      if (existing) {
        const complete = await bookingSubmissionIsComplete({
          booking: existing, submissionId: booking.clientSubmissionId,
          Payment, UnitAssistanceRequest, RelocationRequest,
        });
        if (complete) return existing;
        throw Object.assign(new Error("Booking write status is uncertain. Please contact support before retrying."), { status: 503 });
      }
    } finally {
      await session?.endSession().catch(() => {});
    }
  }

  return writeWithoutTransaction();
}

module.exports = { isKnownStandalone, bookingSubmissionIsComplete, persistBookingSubmission };
