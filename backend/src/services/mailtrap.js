import { MailtrapClient } from "mailtrap";
import template from "../config/templates.js";
import { mailtrap } from "../config/keys.js";

const { token, sender } = mailtrap;

/**
 * Creates the Mailtrap client once at module load.
 * Returns null (not undefined) if the token is missing so the
 * `if (!mailtrapClient)` guard in sendEmail catches it consistently.
 */
const createClient = () => {
  if (!token) {
    console.warn(
      "[mailtrap] MAILTRAP_TOKEN is not set — emails will not be sent. " +
      "Add MAILTRAP_TOKEN to your .env file."
    );
    return null;
  }
  try {
    return new MailtrapClient({ token });
  } catch (error) {
    console.error("[mailtrap] Failed to initialise Mailtrap client:", error.message);
    return null;
  }
};

const mailtrapClient = createClient();

const prepareTemplate = (type, host, data) => {
  switch (type) {
    case "reset":              return template.resetEmail(host, data);
    case "reset-confirmation": return template.confirmResetPasswordEmail();
    case "signup":             return template.signupEmail(data);
    case "send-otp":           return template.sendOneTimePassword(data);
    case "announcement":        return template.announcementEmail(data);
    case "newsletter-subscription": return template.newsletterSubscriptionEmail();
    case "contact":            return template.contactEmail();
    default:
      throw new Error(`Unknown email template type: "${type}"`);
  }
};

const sendEmail = async (email, type, host, data) => {
  if (!mailtrapClient) {
    throw new Error("Mailtrap client is not configured — check MAILTRAP_TOKEN in your .env file.");
  }

  const message = prepareTemplate(type, host, data);

  return mailtrapClient.send({
    from: sender,
    to:   [{ email }],
    subject: message.subject,
    text:    message.text,
  });
};

export default { sendEmail };
