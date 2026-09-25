const resetEmail = (clientUrl, token) => {
  const resetUrl = `${clientUrl.replace(/\/$/, "")}/reset-password/${token}`;
  return {
  subject: "Reset your Messenger password",
  text:
    "We received a request to reset your Messenger password.\n\n" +
    "For security, this link expires in 15 minutes and can be used only once:\n\n" +
    `${resetUrl}\n\n` +
    "If you did not request this, ignore this email and your password will stay unchanged."
  };
};

const confirmResetPasswordEmail = () => ({
  subject: "Messenger password changed",
  text:
    "Your Messenger password was changed successfully.\n\n" +
    "If you did not make this change, secure your email account and contact support immediately."
});

const signupEmail = name => ({
  subject: "Account Registration",
  text: `Hi ${name.firstName} ${name.lastName}! Thank you for creating a Messenger account.`
});

const newsletterSubscriptionEmail = () => ({
  subject: "Newsletter Subscription",
  text:
    "You are receiving this email because you subscribed to our newsletter. \n\n" +
    "If you did not request this change, please contact us immediately."
});

const contactEmail = () => ({
  subject: "Contact Us",
  text: "We received your message! Our team will contact you soon. \n\n"
});

const sendOneTimePassword = (otp) => ({
  subject: "Messenger email verification",
  text: `Your Messenger OTP is: ${otp}. It is valid for 10 minutes. \n\n`
});

const announcementEmail = ({ subject, message }) => ({
  subject: subject || "Messenger announcement",
  text: `${message}\n\n— Messenger admin team`
});

export default {
  resetEmail,
  confirmResetPasswordEmail,
  signupEmail,
  newsletterSubscriptionEmail,
  contactEmail,
  sendOneTimePassword,
  announcementEmail
};
