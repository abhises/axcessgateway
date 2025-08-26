import dotenv from "dotenv";

dotenv.config();

const config = {
  baseUrl: process.env.AXCESS_BASE_URL,
  entityId: process.env.AXCESS_ENTITY_ID,
  bearerToken: process.env.AXCESS_BEARER_TOKEN,
  environment: process.env.NODE_ENV || "test", // ✅ required
  webhook: {
    secretKey: "test-secret-for-webhooks",
    ivHeaderName: "x-axcess-iv",
    sigHeaderName: "x-axcess-signature",
    idempotencyStoreTtlHours: 48,
  },
  ui: {
    widgetBrands: ["VISA", "MASTER"],
    defaultLocale: "en",
  },
  locales: { en: "en", fr: "fr" },
  threeDS: { challengeWindowSize: "05", attemptExemption: false },
  session: { checkoutExpiryMinutes: 25 },
};

export default config;
