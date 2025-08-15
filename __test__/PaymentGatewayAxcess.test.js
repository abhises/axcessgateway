// __test__/PaymentGatewayAxcess.test.mjs
import { jest } from "@jest/globals";
import crypto from "crypto";
import PaymentGatewayAxcess from "../service/AxcessPaymentGateway.js"; // ESM import
import PaymentGatewayServiceMock from "../__mocks__/PaymentGatewayServiceMock.js";
// -------------------------------
// Mock https module
// -------------------------------
await jest.unstable_mockModule("https", async () => {
  const { EventEmitter } = await import("events");

  let rules = [];

  function respond({ options }) {
    const path = options.path || "";
    const method = (options.method || "GET").toUpperCase();

    for (const r of rules) {
      const matched =
        typeof r.matcher === "function"
          ? r.matcher({ options, path, method })
          : String(path).startsWith(String(r.matcher));
      if (matched) {
        const out = r.responder({ options, path, method }) || {};
        return {
          status: out.status ?? 200,
          json: out.json ?? { ok: true },
          headers: out.headers ?? { "content-type": "application/json" },
        };
      }
    }

    return {
      status: 200,
      json: { ok: true, path, method },
      headers: { "content-type": "application/json" },
    };
  }

  function request(options, callback) {
    const req = new EventEmitter();
    req._body = "";
    req.write = (chunk) => {
      req._body += chunk;
    };
    req.end = () => {
      const { status, json, headers } = respond({ options });
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = headers;
        res.setEncoding = () => {};
        callback(res);
        const bodyStr = headers["content-type"]?.includes("application/json")
          ? JSON.stringify(json)
          : String(json);
        res.emit("data", bodyStr);
        res.emit("end");
      });
    };
    return req;
  }

  request.__setMockResponse = (matcher, responder) =>
    rules.push({ matcher, responder });
  request.__resetMock = () => {
    rules = [];
  };

  return { request };
});

const https = await import("https"); // <- use directly

// -------------------------------
// Base config
// -------------------------------
const baseConfig = {
  environment: "test",
  baseUrl: "https://eu-test.oppwa.com",
  entityId: "ENT-123",
  bearerToken: "BEARER-TOKEN",
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

// -------------------------------
// Helper: set mock responders
// -------------------------------
function setDefaultHttpsResponders() {
  https.request.__resetMock();

  // POST /v1/checkouts
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path.startsWith("/v1/checkouts"),
    () => ({ status: 200, json: { id: "CHK-1" } })
  );

  // GET /v1/checkouts/{id}/payment
  https.request.__setMockResponse(
    (ctx) => ctx.method === "GET" && ctx.path.startsWith("/v1/checkouts/"),
    () => ({
      status: 200,
      json: {
        id: "PAY-OK-1",
        amount: "24.99",
        currency: "USD",
        result: {
          code: "000.100.110",
          description: "Request successfully processed",
        },
      },
    })
  );

  // POST /v1/payments
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path === "/v1/payments",
    () => ({
      status: 200,
      json: {
        id: "PAY-S2S-1",
        amount: "10.00",
        currency: "USD",
        result: { code: "000.100.110", description: "Approved" },
      },
    })
  );

  // POST /v1/payments/{id}
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && /^\/v1\/payments\/[^/]+$/.test(ctx.path),
    () => ({
      status: 200,
      json: {
        id: "PAY-POST-1",
        amount: "10.00",
        currency: "USD",
        result: { code: "000.100.110", description: "Approved" },
      },
    })
  );

  // POST /v1/registrations
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path === "/v1/registrations",
    () => ({
      status: 200,
      json: {
        id: "REG-1",
        paymentBrand: "VISA",
        card: { last4: "1111", expiryMonth: "12", expiryYear: "2030" },
      },
    })
  );

  // POST /v1/registrations/{id}/payments
  https.request.__setMockResponse(
    (ctx) =>
      ctx.method === "POST" &&
      /^\/v1\/registrations\/[^/]+\/payments$/.test(ctx.path),
    () => ({
      status: 200,
      json: {
        id: "PAY-TOKEN-1",
        amount: "5.00",
        currency: "USD",
        result: { code: "000.100.110", description: "Approved" },
      },
    })
  );

  // DELETE /v1/registrations/{id}
  https.request.__setMockResponse(
    (ctx) =>
      ctx.method === "DELETE" && /^\/v1\/registrations\/[^/]+\?/.test(ctx.path),
    () => ({ status: 204, json: "" })
  );

  // POST /v1/subscriptions
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path === "/v1/subscriptions",
    () => ({ status: 200, json: { id: "SUB-1" } })
  );

  // DELETE /v1/subscriptions/{id}
  https.request.__setMockResponse(
    (ctx) =>
      ctx.method === "DELETE" && /^\/v1\/subscriptions\/[^/]+\?/.test(ctx.path),
    () => ({ status: 204, json: "" })
  );

  // POST /v1/threeDSecure
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path === "/v1/threeDSecure",
    () => ({
      status: 200,
      json: { id: "3DS-1", redirect: { url: "https://acs.example/..." } },
    })
  );

  // POST /v1/threeDSecure/{id}
  https.request.__setMockResponse(
    (ctx) =>
      ctx.method === "POST" && /^\/v1\/threeDSecure\/[^/]+$/.test(ctx.path),
    () => ({ status: 200, json: { id: "3DS-1", status: "authenticated" } })
  );

  // GET /v1/payments/{id}?entityId=...
  https.request.__setMockResponse(
    (ctx) => ctx.method === "GET" && /^\/v1\/payments\/[^/]+\?/.test(ctx.path),
    () => ({
      status: 200,
      json: {
        id: "PAY-VER-1",
        amount: "7.77",
        currency: "USD",
        result: { code: "000.100.110", description: "Approved" },
      },
    })
  );
}

// -------------------------------
// Tests
// -------------------------------
describe("PaymentGatewayAxcess – adapter", () => {
  let svc, ax;

  beforeEach(() => {
    setDefaultHttpsResponders();
    svc = new PaymentGatewayServiceMock();
    ax = new PaymentGatewayAxcess({
      paymentGatewayService: svc,
      config: baseConfig,
    });
  });
  // <-- Add the httpRequestWithBearer mock here

  test("constructor: throws when paymentGatewayService missing", () => {
    expect(() => new PaymentGatewayAxcess({ config: baseConfig })).toThrow();
  });

  // ...include all your existing tests here, same as in your previous code...
  // copy & pay, s2s payments, tokens, subscriptions, webhooks, reporting, utilities
  test("createCheckoutSession: happy path creates and persists session", async () => {
    const out = await ax.createCheckoutSession({
      userId: "U1",
      orderId: "ORD-1",
      amount: 24.99,
      currency: "USD",
      paymentType: "DB",
    });
    expect(out.checkoutId).toBe("CHK-1");
    expect(out.redirectUrl).toContain("/v1/checkouts/CHK-1/payment");
    const saved = await svc.getSessionsBy("orderId", "ORD-1");
    expect(saved.length).toBe(1);
    expect(saved[0].status).toBe("pending");
  });

  test("createCheckoutSession: reuses pending session within TTL", async () => {
    const s = {
      id: "S-1",
      gateway: "axcess",
      userId: "U1",
      orderId: "ORD-REUSE",
      checkoutId: "CHK-EXIST",
      status: "pending",
      createdAt: Date.now(),
    };
    await svc.saveSession(s);

    const out = await ax.createCheckoutSession({
      userId: "U1",
      orderId: "ORD-REUSE",
      amount: 10,
      currency: "USD",
    });
    expect(out.checkoutId).toBe("CHK-EXIST");
    expect(out.sessionId).toBe("S-1");
  });

  test("isCheckoutSessionValid + purgeExpiredSessions", async () => {
    const fresh = { id: "S-FRESH", status: "pending", createdAt: Date.now() };
    const old = {
      id: "S-OLD",
      status: "pending",
      createdAt: Date.now() - 60 * 60 * 1000,
    };
    await svc.saveSession({ ...fresh, userId: "U2" });
    await svc.saveSession({ ...old, userId: "U2" });

    expect(ax.isCheckoutSessionValid(fresh)).toBe(true);
    expect(ax.isCheckoutSessionValid(old)).toBe(false);

    const purged = await ax.purgeExpiredSessions({ by: "userId", value: "U2" });
    expect(purged).toBe(1);
  });

  test("getPaymentWidgetHtml: returns script + form with lang mapping and brands", () => {
    const html = ax.getPaymentWidgetHtml({
      checkoutId: "CHK-1",
      locale: "fr",
      brands: ["VISA"],
    });
    expect(html).toContain("paymentWidgets.js?checkoutId=CHK-1");
    expect(html).toContain('data-lang="fr"');
    expect(html).toContain('data-brands="VISA"');
  });

  test("getPaymentStatus + handleRedirectCallback: persists txn and updates session", async () => {
    // create session first
    await ax.createCheckoutSession({
      userId: "U3",
      orderId: "ORD-STAT",
      amount: 24.99,
      currency: "USD",
    });

    const res = await ax.handleRedirectCallback({
      resourcePath: "/v1/checkouts/CHK-1/payment",
      orderId: "ORD-STAT",
      userId: "U3",
    });
    expect(res.status).toBe("SUCCESS");
    expect(svc.transactions[0].status).toBe("success");
    const sessions = await svc.getSessionsBy("orderId", "ORD-STAT");
    expect(sessions[0].status).toBe("success");
    expect(svc.grants.length).toBe(1);
  });

  /* B) S2S payments */
  test("s2sDebit: approved path saves transaction and grants access", async () => {
    const out = await ax.s2sDebit({
      amount: 10,
      currency: "USD",
      paymentBrand: "VISA",
      card: {
        number: "4111111111111111",
        holder: "T",
        expiryMonth: "12",
        expiryYear: "2030",
        cvv: "123",
      },
    });
    expect(out.normalized.resultCode).toBe("000.100.110");
    expect(svc.transactions[0].status).toBe("success");
    expect(svc.grants.length).toBe(1);
  });

  test("s2sAuthorize then s2sCapture, s2sVoid, s2sRefund", async () => {
    const a = await ax.s2sAuthorize({
      amount: 15,
      currency: "USD",
      paymentBrand: "VISA",
      card: {
        number: "4111111111111111",
        holder: "T",
        expiryMonth: "12",
        expiryYear: "2030",
        cvv: "123",
      },
    });
    expect(a.normalized.resultCode).toBe("000.100.110");

    const c = await ax.s2sCapture({ paymentId: "PAY-123", amount: 15 });
    expect(c.normalized.resultCode).toBe("000.100.110");

    const v = await ax.s2sVoid({ paymentId: "PAY-123" });
    expect(v.normalized.resultCode).toBe("000.100.110");

    const r = await ax.s2sRefund({ paymentId: "PAY-123", amount: 5 });
    expect(r.normalized.resultCode).toBe("000.100.110");
  });

  /* C) Tokens */
  test("createRegistrationToken + debit/authorize/delete with token", async () => {
    const t = await ax.createRegistrationToken({
      card: {
        number: "4111111111111111",
        holder: "T",
        expiryMonth: "12",
        expiryYear: "2030",
        cvv: "123",
      },
    });
    expect(t.registrationId).toBe("REG-1");
    expect(svc.tokens.has("REG-1")).toBe(true);

    const d = await ax.debitWithRegistrationToken({
      registrationId: "REG-1",
      amount: 5,
      currency: "USD",
    });
    expect(d.normalized.resultCode).toBe("000.100.110");

    const a = await ax.authorizeWithRegistrationToken({
      registrationId: "REG-1",
      amount: 7,
      currency: "USD",
    });
    expect(a.normalized.resultCode).toBe("000.100.110");

    const del = await ax.deleteRegistrationToken({ registrationId: "REG-1" });
    expect(del).toBe(true);
    expect(svc.tokens.has("REG-1")).toBe(false);
  });

  test("listUserTokens/getTokensExpiring pass-throughs", async () => {
    await svc.saveToken({ id: "TK1", userId: "U5", expiry: "2030-12" });
    const list = await ax.listUserTokens("U5");
    expect(list.length).toBe(1);
    const exp = await ax.getTokensExpiring("2030-12");
    expect(exp.length).toBe(1);
  });

  /* D) Subscriptions */
  test("create/cancel/pause/resume/upgrade/downgrade subscription flows", async () => {
    // Create
    const c = await ax.createSubscriptionFromToken({
      registrationId: "REG-NEW",
      amount: 9.99,
      currency: "USD",
      interval: "P1M",
    });
    expect(c.status).toBe("active");
    const createdId = c.scheduleId || "SUB-1";
    expect(svc.schedules.get(createdId)?.status).toBe("active");

    // Cancel
    const cc = await ax.cancelSubscription({
      subscriptionId: createdId,
      reason: "user",
    });
    expect(cc.status).toBe("canceled");
    expect(svc.schedules.get(createdId)?.status).toBe("canceled");

    // Pause (cancel + save resume instruction)
    const paused = await ax.pauseSubscription({
      subscriptionId: "SUB-X",
      resumeAt: "2025-10-01",
    });
    expect(paused.status).toBe("paused");
    expect(svc.resume[0].resumeAt).toBe("2025-10-01");

    // Resume (creates new schedule)
    https.request.__setMockResponse(
      (ctx) => ctx.method === "POST" && ctx.path === "/v1/subscriptions",
      () => ({ status: 200, json: { id: "SUB-RESUME" } })
    );
    const resumed = await ax.resumeSubscription({
      userId: "U6",
      registrationId: "REG-RES",
      recurringShape: { amount: 7.99, currency: "USD", interval: "P1M" },
    });
    expect(resumed.status).toBe("resumed");
    expect(svc.schedules.get("SUB-RESUME")?.status).toBe("active");

    // Upgrade (charge proration + cancel old + new schedule)
    https.request.__setMockResponse(
      (ctx) =>
        ctx.method === "POST" &&
        /^\/v1\/registrations\/REG-UP\/payments$/.test(ctx.path),
      () => ({
        status: 200,
        json: { id: "PAY-UP", result: { code: "000.100.110" } },
      })
    );
    const up = await ax.upgradeSubscription({
      subscriptionId: "SUB-OLD",
      prorationCharge: 2.34,
      newRecurring: {
        registrationId: "REG-UP",
        amount: 14.99,
        currency: "USD",
        interval: "P1M",
      },
    });
    expect(up.status).toBe("upgrade_scheduled");

    // Downgrade (save instruction)
    const down = await ax.downgradeSubscription({
      subscriptionId: "SUB-NEW",
      effectiveAt: "2025-11-01",
      newRecurring: {
        registrationId: "REG-DOWN",
        amount: 4.99,
        currency: "USD",
        interval: "P1M",
      },
    });
    expect(down.status).toBe("downgrade_scheduled");
    expect(svc.downgrades[0].effectiveAt).toBe("2025-11-01");
  });

  /* E) Webhooks */
  test("decryptAndVerifyWebhook: plaintext JSON w/ signature", () => {
    const payload = {
      type: "payment.success",
      payment: {
        id: "T-1",
        amount: "10.0",
        currency: "USD",
        result: { code: "000.100.110" },
      },
    };
    const plaintext = JSON.stringify(payload);

    // Build signature over plaintext using class's secretKey (sha256)
    const key = crypto
      .createHash("sha256")
      .update(baseConfig.webhook.secretKey, "utf8")
      .digest();
    const signature = crypto
      .createHmac("sha256", key)
      .update(plaintext)
      .digest("hex");

    const out = ax.decryptAndVerifyWebhook(plaintext, {
      "x-axcess-signature": signature,
    });
    expect(out.verified).toBe(true);
    expect(out.decryptedJson.payment.id).toBe("T-1");
  });

  test("decryptAndVerifyWebhook: AES-256-CBC base64 body + iv header", () => {
    const payload = {
      type: "payment.success",
      payment: {
        id: "T-2",
        amount: "11.0",
        currency: "USD",
        result: { code: "000.100.110" },
      },
    };
    const plaintext = JSON.stringify(payload);
    const key = crypto
      .createHash("sha256")
      .update(baseConfig.webhook.secretKey, "utf8")
      .digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const enc = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ]);
    const bodyBase64 = enc.toString("base64");
    const signature = crypto
      .createHmac("sha256", key)
      .update(plaintext)
      .digest("hex");

    const out = ax.decryptAndVerifyWebhook(bodyBase64, {
      "x-axcess-iv": iv.toString("base64"),
      "x-axcess-signature": signature,
    });
    expect(out.verified).toBe(true);
    expect(out.decryptedJson.payment.id).toBe("T-2");
  });

  test("handleWebhook: routes payment_success and saves transaction + grants", async () => {
    const payload = {
      type: "payment.success",
      payment: {
        id: "TX-OK",
        amount: "9.00",
        currency: "USD",
        result: { code: "000.100.110" },
      },
    };
    const plaintext = JSON.stringify(payload);
    await ax.handleWebhook(plaintext, {}); // signature optional in our class
    expect(svc.transactions[svc.transactions.length - 1].status).toBe(
      "success"
    );
    expect(svc.grants.length).toBeGreaterThan(0);
    expect(svc.webhooks.length).toBe(1);
  });

  test("mapWebhookEvent: detects refund, chargeback, registration, schedule, risk", () => {
    const refund = ax.mapWebhookEvent({
      type: "payment.refund",
      payment: { result: { code: "000.100.110" } },
    });
    expect(refund.type).toBe("refund");
    const cb = ax.mapWebhookEvent({
      type: "payment.chargeback",
      payment: { result: { code: "000.200.000" } },
    });
    expect(cb.type).toBe("chargeback");
    const regC = ax.mapWebhookEvent({
      type: "registration.created",
      registrationId: "REG-Z",
    });
    expect(regC.type).toBe("registration_created");
    const schC = ax.mapWebhookEvent({
      type: "subscription.created",
      subscription: { id: "SUB-Z" },
    });
    expect(schC.type).toBe("schedule_created");
    const riskF = ax.mapWebhookEvent({
      type: "risk.flagged",
      risk: { score: 87, reason: "velocity" },
    });
    expect(riskF.type).toBe("risk_flagged");
  });

  /* F) Reporting */
  test("getTransactionDetails: saves verification", async () => {
    const data = await ax.getTransactionDetails({ transactionId: "PAY-VER-1" });
    expect(data.id).toBe("PAY-VER-1");
    expect(svc.verifications.length).toBe(1);
  });

  test("findOrderHistory: pass-through", async () => {
    svc.orderHistory.set("ORD-ABC", { hello: "world" });
    const h = await ax.findOrderHistory("ORD-ABC");
    expect(h.hello).toBe("world");
  });

  /* G) Utilities */
  test("mapResultCodeToUiMessage: variety", () => {
    expect(ax.mapResultCodeToUiMessage("000.100.110").uiMessage).toMatch(
      /approved/i
    );
    expect(ax.mapResultCodeToUiMessage("200.300.404").uiMessage).toMatch(
      /declined/i
    );
    expect(ax.mapResultCodeToUiMessage("100.396.103").uiMessage).toMatch(
      /3-D Secure/i
    );
    expect(ax.mapResultCodeToUiMessage("800.400.200").uiMessage).toMatch(
      /invalid card/i
    );
    expect(ax.mapResultCodeToUiMessage("700.100.100").uiMessage).toMatch(
      /expired|timed/i
    );
  });

  test("extractRiskSignals / resolveWidgetLanguage / buildRegressionTestPlan", () => {
    const r = ax.extractRiskSignals({
      risk: { score: 70, reason: "velocity", rules: ["R1"] },
    });
    expect(r.score).toBe(70);
    expect(ax.resolveWidgetLanguage("fr")).toBe("fr");
    expect(ax.resolveWidgetLanguage("xx")).toBeNull();
    const plan = ax.buildRegressionTestPlan();
    expect(Array.isArray(plan.cases)).toBe(true);
    expect(plan.env).toBe("test");
  });
});
