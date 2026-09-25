import "dotenv/config";

export const app = {
  name: 'Messenger',
  apiURL: `${process.env.BASE_API_URL}`,
  clientURL: process.env.CLIENT_URL
};

export const port = process.env.PORT || 3000;

export const database = {
  url: process.env.MONGO_URI
};

export const jwt = {
  secret: process.env.JWT_SECRET,
  tokenLife: '7d'
};

export const mailtrap = {
  token: process.env.MAILTRAP_TOKEN,
  sender: {
    email: process.env.MAILTRAP_EMAIL_SENDER,
    name: "Shefin"
  }
};

export const google = {
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.GOOGLE_CALLBACK_URL
};

export const cloudinary = {
  cloudName: process.env.CLOUDINARY_CLOUD_NAME,
  apiKey: process.env.CLOUDINARY_API_KEY,
  apiSecret: process.env.CLOUDINARY_API_SECRET
};
