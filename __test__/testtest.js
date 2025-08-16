// __test__/PaymentGatewayAxcess.test.mjs
import { jest } from "@jest/globals";
import crypto from "crypto";
import { EventEmitter } from "events";

// -------------------------------
// Mock HTTPS
// -------------------------------
const httpsMock = {
  __rules: [],
  request(options, callback) {
    const { path = "", method = "GET" } = options;
    const matchedRule = httpsMock.__rules.find((r) =>
      typeof r.matcher === "function" ? r.matcher({ path, method }) : false
    );

    const { status, json, headers } = matchedRule
      ? matchedRule.responder({ path, method })
      : {
          status: 200,
          json: { ok: true },
          headers: { "content-type": "application/json" },
        };

    const res = new EventEmitter();
    res.statusCode = status;
    res.headers = headers;
    res.setEncoding = () => {};
    setImmediate(() => {
      callback(res);
      const body = headers["content-type"].includes("application/json")
        ? JSON.stringify(json)
        : String(json);
      res.emit("data", body);
      res.emit("end");
    });

    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {};
    req.on = req.addListener;
    req.setTimeout = () => {};
    req.abort = () => {};
    req.destroy = () => {};
    return req;
  },
  __setMockResponse(matcher, responder) {
    httpsMock.__rules.push({ matcher, responder });
  },
  __resetMock() {
    httpsMock.__rules = [];
  },
};

// Mock the "https" module for Jest
jest.unstable_mockModule("https", async () => httpsMock);

// -------------------------------
// Import your modules
// -------------------------------
import PaymentGatewayAxcess from "../service/AxcessPaymentGateway.js";
import PaymentGatewayServiceMock from "../__mocks__/PaymentGatewayServiceMock.js";

// -------------------------------
// Setup mock responders

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
function setDefaultHttpsResponders(request) {
  request.__resetMock();

  // Mock POST /v1/checkouts
  request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path.startsWith("/v1/checkouts"),
    () => ({ status: 200, json: { id: "CHK-1" } })
  );
}
setDefaultHttpsResponders(httpsMock);

// -------------------------------
// Tests
// -------------------------------
describe("PaymentGatewayAxcess – createCheckoutSession", () => {
  let svc, ax;

  beforeEach(() => {
    svc = new PaymentGatewayServiceMock();
    ax = new PaymentGatewayAxcess({
      paymentGatewayService: svc,
      config: baseConfig,
    });
  });

  test("should create a new checkout session", async () => {
    const result = await ax.createCheckoutSession({
      userId: "U1",
      orderId: "ORD-1",
      amount: 24.99,
      currency: "USD",
      environment: "test", // <-- required parameter
    });

    expect(result.checkoutId).toBe("CHK-1");
    expect(result.redirectUrl).toContain("CHK-1");
    expect(result.sessionId).toBeDefined();
  });
});
