import express from "express";
import PaymentGatewayAxcess from "../service/AxcessPaymentGateway.js";
import paymentGatewayService from "../service/paymentGatewayService.js"; // your injected facade
import axcessConfig from "../configs/config.js";
import scylla_db from "../utils/ScyllaDb.js";
import fs from "fs";

const router = express.Router();

// Initialize Axcess gateway
const axcess = new PaymentGatewayAxcess({
  paymentGatewayService,
  config: axcessConfig,
});

// 1) Start widget checkout
router.post("/payments/axcess/checkout", async (req, res) => {
  try {
    await scylla_db.loadTableConfigs("./tables.json");

    const { userId, orderId, amount, currency, locale = "en" } = req.body || {};
    // console.log("Starting checkout:", {
    //   userId,
    //   orderId,
    //   amount,
    //   currency,
    //   locale,
    // });
    const { checkoutId, redirectUrl } = await axcess.createCheckoutSession({
      userId,
      orderId,
      amount,
      currency,
    });

    // console.log("Checkout session created:", { checkoutId, redirectUrl });

    // Option A: return HTML the FE will inject directly:
    const widgetHtml = axcess.getPaymentWidgetHtml({
      checkoutId,
      locale,
      brands: ["VISA", "MASTER"],
    });
    // console.log("w", widgetHtml);

    res.json({ checkoutId, redirectUrl, widgetHtml });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 2) Widget callback (Copy&Pay posts here with resourcePath)
router.post("/payments/axcess/callback", async (req, res) => {
  try {
    const { resourcePath } = req.body || {};
    console.log("Callback received:", { resourcePath });
    const orderId = req.query.orderId || req.body.orderId || "unknown";
    const out = await axcess.handleRedirectCallback({
      resourcePath,
      orderId,
      userId: req.user?.id || "anon",
    });

    const redirect = `/thanks?status=${encodeURIComponent(
      out.status.toLowerCase()
    )}`;
    res.redirect(303, redirect);
  } catch (e) {
    res.redirect(303, "/thanks?status=failed");
  }
});

// 3) Tokenization
router.post("/api/payments/axcess/tokens", async (req, res) => {
  try {
    const { card, customer } = req.body || {};
    const token = await axcess.createRegistrationToken({
      card,
      customer,
    });
    res.json(token);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 4) Token charge
router.post("/api/payments/axcess/token/charge", async (req, res) => {
  try {
    const { registrationId, amount, currency } = req.body || {};
    const result = await axcess.debitWithRegistrationToken({
      registrationId,
      amount,
      currency,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post("/api/webhooks/axcess", async (req, res) => {
  try {
    await scylla_db.loadTableConfigs("./tables.json");

    // Log to file (Render has an ephemeral disk, so this resets on redeploys
    // console.log(" req_rawBody", req.rawBody, "req.headers", req.headers);
    // Also log to Render’s built-in logging (shows in Render dashboard)
    // console.log("PayPal Webhook:", payload);
    const raw = req.rawBody || JSON.stringify(req.body);
    await axcess.handleWebhook(raw, req.headers);

    // console.log("Webhook processed successfully");
    res.status(200).end();
  } catch (e) {
    res.status(400).end();
  }
});

export default router;
