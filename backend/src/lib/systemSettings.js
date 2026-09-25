import SystemSettings from "../models/systemSettings.model.js";

export const SETTINGS_KEY = "global";

export const getSystemSettings = async () => SystemSettings.findOneAndUpdate(
  { key: SETTINGS_KEY },
  { $setOnInsert: { key: SETTINGS_KEY } },
  { new: true, upsert: true }
);
