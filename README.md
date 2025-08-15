# Axcess Payment Gateway Adapter

Node.js adapter for Axcess (OPPWA) — supports Copy&Pay widget, Server-to-Server (S2S) payments, encrypted webhooks, card-on-file tokens, and subscriptions. All persistence is handled via an injected `paymentGatewayService` (no direct DB access).

## Features

- **Copy&Pay Widget**: Script-based checkout widget (no iframe)
- **S2S Payments**: Direct API for debit, authorize, capture, void, refund
- **3-D Secure**: Standalone 3DS and exemptions
- **Card-on-File**: Registration tokens for later charges
- **Subscriptions**: Create, cancel, pause, resume, upgrade, downgrade
- **Webhooks**: Encrypted payloads, HMAC verification, event routing
- **Reporting**: Transaction detail fetch, order history
- **Extensive Jest tests**: All network calls are mocked

## Project Structure

```
Axcess Payment Gateway FINAL.js      # Main adapter class and Jest tests
service/AxcessPaymentGateway.js     # (ESM) Service version
utils/                             # Utilities (Logger, ErrorHandler, etc.)
configs/LogRoutes.js                # Logging routes config
__test__/                          # Test files
__mock__/                          # Mocks
```

## Quick Start

### 1. Install dependencies

```sh
npm install
```

### 2. Configure

Create `axcess.config.js`:

```js
export default {
  environment: "test",
  baseUrl: "https://eu-test.oppwa.com",
  entityId: "YOUR_ENTITY_ID",
  bearerToken: "YOUR_BEARER_TOKEN",
  webhook: {
    secretKey: "your-256-bit-secret",
    ivHeaderName: "x-axcess-iv",
    sigHeaderName: "x-axcess-signature",
    idempotencyStoreTtlHours: 48,
  },
  ui: {
    widgetBrands: ["VISA", "MASTER", "AMEX"],
    defaultLocale: "en",
  },
  locales: { en: "en", es: "es", fr: "fr" },
  threeDS: { challengeWindowSize: "05", attemptExemption: false },
  session: { checkoutExpiryMinutes: 25 },
};
```

### 3. Usage

#### Instantiate

```js
const PaymentGatewayAxcess = require("./payment-gateway-axcess");
const config = require("./axcess.config");
const paymentGatewayService = require("./PaymentGatewayService"); // your implementation
const axcess = new PaymentGatewayAxcess({ paymentGatewayService, config });
```

#### Copy&Pay Widget Flow

```js
// 1. Create checkout session
const { checkoutId, redirectUrl, sessionId } =
  await axcess.createCheckoutSession({
    userId: "U1",
    orderId: "ORD-1",
    amount: 24.99,
    currency: "USD",
    paymentType: "DB",
  });

// 2. Get widget HTML (optional)
const widgetHtml = axcess.getPaymentWidgetHtml({
  checkoutId,
  locale: "en",
  brands: ["VISA", "MASTER"],
});

// 3. Handle redirect callback
const result = await axcess.handleRedirectCallback({
  resourcePath: "/v1/checkouts/CHK-1/payment",
  orderId: "ORD-1",
  userId: "U1",
});
```

#### S2S Payments

```js
const result = await axcess.s2sDebit({
  amount: 10,
  currency: "USD",
  paymentBrand: "VISA",
  card: {
    number: "...",
    holder: "...",
    expiryMonth: "...",
    expiryYear: "...",
    cvv: "...",
  },
});
```

#### Card-on-File / Tokens

```js
const token = await axcess.createRegistrationToken({ card: { ... } });
await axcess.debitWithRegistrationToken({ registrationId: token.registrationId, amount: 9.99, currency: "USD" });
await axcess.deleteRegistrationToken({ registrationId: token.registrationId });
```

#### Subscriptions

```js
const sub = await axcess.createSubscriptionFromToken({
  registrationId: "...",
  amount: 9.99,
  currency: "USD",
  interval: "P1M",
});
await axcess.cancelSubscription({ subscriptionId: sub.scheduleId });
```

#### Webhooks

```js
// Express route example
app.post("/webhooks/axcess", async (req, res) => {
  try {
    const raw = req.rawBody || JSON.stringify(req.body);
    await axcess.handleWebhook(raw, req.headers);
    res.status(200).end();
  } catch (e) {
    res.status(400).end();
  }
});
```

## Testing

Run all Jest tests (network calls are mocked):

```sh
npm test
```

## References

- [Axcess Copy&Pay Widget](https://axcessms.docs.oppwa.com/integrations/widget)
- [S2S API](https://axcessms.docs.oppwa.com/integrations/server-to-server)
- [Card-on-File](https://axcessms.docs.oppwa.com/tutorials/card-on-file)
- [Webhooks](https://axcessms.docs.oppwa.com/tutorials/webhooks/configuration)
- [Subscriptions](https://axcessms.docs.oppwa.com/integrations/subscriptions)

---

**See [`Axcess Payment Gateway FINAL.js`](Axcess%20Payment%20Gateway%20FINAL.js) for full implementation and Jest tests.**
