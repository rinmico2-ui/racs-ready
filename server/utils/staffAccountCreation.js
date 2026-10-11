"use strict";

const { isUnsupportedMongoWriteFeature } = require("./mongoWriteSupport");
const { isKnownStandalone } = require("./bookingSubmissionWrite");

function uncertain() {
  return Object.assign(new Error("Could not confirm the staff account was saved. Check the staff list before trying again."), {
    status: 503, code: "STAFF_CREATION_UNCERTAIN",
  });
}

// Keep the login and its role profile together on replica sets and standalone
// servers. No invitation is delivered until both records have been saved.
async function persistStaffAccount({ connection, startSession, Users, Profiles, user, profile, ensureEmailFree }) {
  await user.validate();
  await profile.validate();
  const userData = user.toObject({ transform: false, depopulate: true });
  const profileData = profile.toObject({ transform: false, depopulate: true });
  const userFilter = {
    _id: userData._id, email: userData.email, role: userData.role,
    accountStatus: "invited", emailVerified: false,
    invitationTokenHash: userData.invitationTokenHash,
  };
  const profileFilter = { _id: profileData._id, user: userData._id };

  async function write(session) {
    await ensureEmailFree(userData.email, session);
    // withTransaction may retry its callback. Rebuild documents with the same
    // IDs so an aborted save cannot turn the next attempt into an update.
    const account = new Users(userData), roleProfile = new Profiles(profileData);
    const options = session ? { session } : {};
    await account.save(options);
    await roleProfile.save(options);
    return { user: account, profile: roleProfile };
  }

  if (!isKnownStandalone(connection)) {
    let session;
    try {
      session = await startSession();
      return await session.withTransaction(() => write(session));
    } catch (error) {
      if (!isUnsupportedMongoWriteFeature(error)) throw error;
      // Never repeat an uncertain or partly acknowledged creation. Fixed IDs
      // let us distinguish our attempt from another account using this email.
      const [existingUser, existingProfile] = await Promise.all([
        Users.findOne(userFilter).select("+invitationTokenHash +invitationExpiresAt"), Profiles.findOne(profileFilter),
      ]);
      if (existingUser && existingProfile) return { user: existingUser, profile: existingProfile };
      if (existingUser || existingProfile) throw uncertain();
    } finally {
      await session?.endSession().catch(() => {});
    }
  }

  // Check duplicates before entering the compensated write, so a rejection
  // never triggers cleanup of an unrelated existing account.
  await ensureEmailFree(userData.email, null);
  try {
    const account = new Users(userData), roleProfile = new Profiles(profileData);
    await account.save();
    await roleProfile.save();
    return { user: account, profile: roleProfile };
  } catch (error) {
    try {
      // Remove only this attempt's records. If profile cleanup fails, retain
      // its login rather than leaving a profile pointing at a deleted user.
      await Profiles.deleteOne(profileFilter);
      await Users.deleteOne(userFilter);
    } catch (_) {
      throw uncertain();
    }
    throw error;
  }
}

module.exports = { persistStaffAccount };
