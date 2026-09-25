import User from "../models/user.model.js";

export const deleteUnverifiedAccounts = async () => {
  try {
    console.log("=== Starting Automated Unverified Accounts Cleanup ===");
    
    // Condition 1: User is not verified (isVerified: false)
    // Condition 2: The verification token's expiration date has passed (less than current time)
    const result = await User.deleteMany({
      isVerified: false,
      verificationTokenExpiresAt: { $lt: new Date() }
    });

    console.log(`[Cleanup Success] Deleted ${result.deletedCount} unverified expired accounts.`);
    console.log("=====================================================");
  } catch (error) {
    console.error("Error running unverified accounts cleanup task:", error.message);
  }
};
