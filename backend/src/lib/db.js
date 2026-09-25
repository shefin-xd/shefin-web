import mongoose from "mongoose";
import { database } from "../config/keys.js";

export const connectDB = async () => {
  try {
    if (!database.url) throw new Error("MongoDB is not set");
    await mongoose.connect(database.url);
    console.log("MongoDB Connected!");
  } catch (error) {
    console.error("Error connection to MongoDB:", error);
    process.exit(1);
  }
};
