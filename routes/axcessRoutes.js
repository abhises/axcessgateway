import express from "express";
import PaymentGatewayAxcess from "../service/AxcessPaymentGateway.js";
import paymentGatewayService from "../service/AxcessPaymentGateway.js"; // your injected facade
import axcessConfig from "../configs/config.js";

const router = express.Router();

// Initialize Axcess gateway
const axcess = new PaymentGatewayAxcess({
  paymentGatewayService,
  config: axcessConfig,
});

// 1) Start widget checkout
router.post("/payments/axcess/checkout", async (req, res) => {
  try {
    const { userId, orderId, amount, currency, locale = "en" } = req.body || {};
    const { checkoutId, redirectUrl } = await axcess.createCheckoutSession({
      userId,
      orderId,
      amount,
      currency,
    });

    // Option A: return HTML the FE will inject directly:
    const widgetHtml = axcess.getPaymentWidgetHtml({
      checkoutId,
      locale,
      brands: ["VISA", "MASTER"],
    });

    res.json({ checkoutId, redirectUrl, widgetHtml });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 2) Widget callback (Copy&Pay posts here with resourcePath)
router.post("/payments/axcess/callback", async (req, res) => {
  try {
    const { resourcePath } = req.body || {};
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

export default router;
