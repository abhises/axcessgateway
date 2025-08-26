// test/createRegistrationTokenTest.js
import PaymentGatewayAxcess from "../service/AxcessPaymentGateway.js";
import baseConfig from "../configs/config.js";

/**
 * Test case for createRegistrationToken
 */
export default async function testCreateRegistrationToken() {
  try {
    // Fake DB service
    const paymentGatewayService = {
      async saveToken(token) {
        console.log("✅ Token saved to DB:", token);
      },
    };

    // Initialize gateway
    const ax = new PaymentGatewayAxcess({
      paymentGatewayService,
      config: baseConfig,
    });

    // Card details for registration
    const params = {
      card: {
        number: "4111111111111111",
        holder: "Jane Jones",
        expiryMonth: "12",
        expiryYear: "2034",
        cvv: "123",
      },
      customer: {
        email: "jane@example.com",
      },
    };

    // Call the method
    const result = await ax.createRegistrationToken(params);

    console.log("🎉 Registration token created:", result);
    return result;
  } catch (err) {
    console.error("❌ Error in createRegistrationToken test:", err.message);
    throw err;
  }
}

// Run directly with `node test/createRegistrationTokenTest.js`
// if (import.meta.url === `file://${process.argv[1]}`) {
//   testCreateRegistrationToken();
// }
testCreateRegistrationToken();
