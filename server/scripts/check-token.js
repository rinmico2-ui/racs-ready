const mongoose = require("mongoose");
const dotenv = require("dotenv");
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/appointment_scheduler";

mongoose.connect(MONGODB_URI).then(async () => {
  console.log("Connected to DB");
  const SiteSetting = require("../models/SiteSetting");
  const tokenSetting = await SiteSetting.findOne({ key: "attendance_qr_token" });
  console.log("Token Setting:", tokenSetting);
  process.exit(0);
}).catch(err => {
  console.error(err);
  process.exit(1);
});
