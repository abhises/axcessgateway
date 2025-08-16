// const https = await import("https"); // <- use directly

export default function setDefaultHttpsResponders(request) {
  request.__resetMock();

  // POST /v1/checkouts
  request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path.startsWith("/v1/checkouts"),
    () => ({ status: 200, json: { id: "CHK-1" } })
  );

  // GET /v1/checkouts/{id}/payment
  request.__setMockResponse(
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
  request.__setMockResponse(
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
  request.__setMockResponse(
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
  request.__setMockResponse(
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
  request.__setMockResponse(
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
  request.__setMockResponse(
    (ctx) =>
      ctx.method === "DELETE" && /^\/v1\/registrations\/[^/]+\?/.test(ctx.path),
    () => ({ status: 204, json: "" })
  );

  // POST /v1/subscriptions
  request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path === "/v1/subscriptions",
    () => ({ status: 200, json: { id: "SUB-1" } })
  );

  // DELETE /v1/subscriptions/{id}
  request.__setMockResponse(
    (ctx) =>
      ctx.method === "DELETE" && /^\/v1\/subscriptions\/[^/]+\?/.test(ctx.path),
    () => ({ status: 204, json: "" })
  );

  // POST /v1/threeDSecure
  request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path === "/v1/threeDSecure",
    () => ({
      status: 200,
      json: { id: "3DS-1", redirect: { url: "//acs.example/..." } },
    })
  );

  // POST /v1/threeDSecure/{id}
  request.__setMockResponse(
    (ctx) =>
      ctx.method === "POST" && /^\/v1\/threeDSecure\/[^/]+$/.test(ctx.path),
    () => ({ status: 200, json: { id: "3DS-1", status: "authenticated" } })
  );

  // GET /v1/payments/{id}?entityId=...
  request.__setMockResponse(
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
