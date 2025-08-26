// testCreateCheckoutSession.js
import PaymentGatewayAxcess from "../service/AxcessPaymentGateway.js"; // adjust path
import baseConfig from "../configs/config.js";

/**
 * Creates and returns a checkout session using PaymentGatewayAxcess
 */
export default async function testCreateCheckoutSession() {
  try {
    const paymentGatewayService = {
      async getSessionsBy(field, value) {
        console.log(`DB lookup: ${field}=${value}`);
        return []; // return [] to force new session creation
      },
      async saveSession(session) {
        console.log("Saving session to DB:", session);
      },
    };

    const ax = new PaymentGatewayAxcess({
      paymentGatewayService,
      config: baseConfig,
    });

    const out = await ax.createCheckoutSession({
      userId: "U1",
      orderId: "ORD-1",
      amount: 24.99,
      currency: "USD",
      paymentType: "DB",
    });

    console.log("Checkout session result:", out);
    return out;
  } catch (err) {
    console.error("Error:", err);
    throw err;
  }
}

testCreateCheckoutSession();
