// payment-gateway-axcess.js
// Node adapter for Axcess (OPPWA) — Copy&Pay widget + Server-to-Server + encrypted webhooks.
// IMPORTANT: This class NEVER touches your DB directly. It ONLY talks to the injected `paymentGatewayService`.
//
// Conventions & Dependencies
// - Validation/Sanitization: Formatting.sanitizeValidate({ field: { value, type, required, default } })
// - Logging: Logger.writeLog({ flag, action, message, data })
// - Error Handling: ErrorHandler.add_error(message, meta)
// - Time/Date helpers: DateTime (optional; used for session expiry calculations if needed)
//
// Axcess / OPPWA Docs referenced in JSDoc by method:
// - Widget (Copy&Pay): https://axcessms.docs.oppwa.com/integrations/widget
// - Widget API: https://axcessms.docs.oppwa.com/integrations/widget/api
// - Widget customization: https://axcessms.docs.oppwa.com/integrations/widget/customization
// - Widget advanced options: https://axcessms.docs.oppwa.com/integrations/widget/advanced-options
// - Widget registration tokens: https://axcessms.docs.oppwa.com/integrations/widget/registration-tokens
// - Card on file: https://axcessms.docs.oppwa.com/tutorials/card-on-file
// - Webhooks config: https://axcessms.docs.oppwa.com/tutorials/webhooks/configuration
// - Webhooks payload: https://axcessms.docs.oppwa.com/tutorials/webhooks/payload
// - Webhooks decryption: https://axcessms.docs.oppwa.com/tutorials/webhooks/decryption
// - Server-to-server: https://axcessms.docs.oppwa.com/integrations/server-to-server
// - S2S registration tokens: https://axcessms.docs.oppwa.com/integrations/server-to-server/registrationtokens
// - S2S network tokens: https://axcessms.docs.oppwa.com/integrations/server-to-server/networktokens
// - Standalone 3DS: https://axcessms.docs.oppwa.com/integrations/server-to-server/standalone3DS
// - Standalone exemptions: https://axcessms.docs.oppwa.com/integrations/server-to-server/standaloneexemption
// - Backoffice (refund/reverse): https://axcessms.docs.oppwa.com/integrations/backoffice
// - Subscriptions: https://axcessms.docs.oppwa.com/integrations/subscriptions
// - Reporting (transaction): https://axcessms.docs.oppwa.com/integrations/reporting/transaction
// - Parameters: https://axcessms.docs.oppwa.com/reference/parameters
// - Result codes: https://axcessms.docs.oppwa.com/reference/resultCodes
// - Workflows: https://axcessms.docs.oppwa.com/reference/workflows
// - 3DS Parameters: https://axcessms.docs.oppwa.com/tutorials/threeDSecure/Parameters
// - 3DS Response Parameters: https://axcessms.docs.oppwa.com/tutorials/threeDSecure/Parameters#Response-Parameters
// - 3DS Testing Guide: https://axcessms.docs.oppwa.com/tutorials/threeDSecure/TestingGuide
//
// Style Requirements
// - Descriptive constants only. No abbreviated or lazy names.
// - Complete code; no placeholders that would cause runtime errors.
// - If a required config is missing, throw early with a descriptive error.
//

"use strict";

const https = require("https");
const http = require("http");
const { URL } = require("url");
const crypto = require("crypto");

// Utilities you provided
const Logger = require("./Logger Final.js");
const ErrorHandler = require("./ErrorHandler.js");
const DateTime = (require("./DateTime (2).js")?.default) || require("./DateTime (2).js");
const Formatting = (require("./formatting.js")?.default) || require("./formatting.js");

const DEFAULT_HTTP_TIMEOUT_MS = 12000;
const DEFAULT_CHECKOUT_EXPIRY_MINUTES = 25;

/**
 * Small helper to form-encode a flat object.
 */
function toFormUrlEncoded(paramsObj = {}) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(paramsObj)) {
    if (v === undefined || v === null) continue;
    search.set(k, String(v));
  }
  return search.toString();
}

/**
 * Internal HTTP client (supports JSON or form-encoded), with Bearer auth.
 */
function httpRequestWithBearer({
  urlString,
  method = "GET",
  bearerToken,
  headers = {},
  body = null,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
}) {
  return new Promise((resolve, reject) => {
    try {
      const url = new URL(urlString);
      const isHttps = url.protocol === "https:";
      const transport = isHttps ? https : http;

      const requestOptions = {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + (url.search || ""),
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Accept: "application/json",
          ...headers
        },
        timeout: timeoutMs
      };

      const req = transport.request(requestOptions, (res) => {
        let responseData = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (responseData += chunk));
        res.on("end", () => {
          const status = res.statusCode || 0;
          let parsed = null;
          try {
            parsed = responseData ? JSON.parse(responseData) : null;
          } catch {
            // not JSON
          }
          resolve({ status, data: parsed, raw: responseData, headers: res.headers });
        });
      });

      req.on("error", (err) => reject(err));
      if (body) req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

class PaymentGatewayAxcess {
  /**
   * @param {object} deps
   * @param {object} deps.paymentGatewayService - injected persistence/service facade (sessions, txns, schedules, tokens, webhooks, entitlements)
   * @param {object} deps.config - required global config
   * @param {string} deps.config.environment - 'test' | 'live'
   * @param {string} deps.config.baseUrl - e.g., 'https://eu-test.oppwa.com'
   * @param {string} deps.config.entityId - Axcess entityId from portal
   * @param {string} deps.config.bearerToken - Bearer token for REST API
   * @param {object} [deps.config.webhook] - webhook decryption & idempotency config
   * @param {string} [deps.config.webhook.secretKey] - base64 or hex secret for AES-256-CBC
   * @param {string} [deps.config.webhook.ivHeaderName='x-axcess-iv'] - header with base64 IV (if required)
   * @param {string} [deps.config.webhook.sigHeaderName='x-axcess-signature'] - signature header name (optional)
   * @param {number} [deps.config.webhook.idempotencyStoreTtlHours=48] - dedupe TTL
   * @param {object} [deps.config.ui]
   * @param {string[]} [deps.config.ui.widgetBrands] - e.g., ['VISA','MASTER','AMEX']
   * @param {string} [deps.config.ui.defaultLocale='en']
   * @param {object} [deps.config.locales] - map app locale -> widget 'lang'
   * @param {object} [deps.config.threeDS]
   * @param {string} [deps.config.threeDS.challengeWindowSize='05'] - per 3DS docs
   * @param {boolean} [deps.config.threeDS.attemptExemption=false]
   * @param {object} [deps.config.session]
   * @param {number} [deps.config.session.checkoutExpiryMinutes=25]
   * @param {object} [deps.options] - future flags
   */
  constructor({ paymentGatewayService, config, options = {} } = {}) {
    if (!paymentGatewayService) {
      throw new Error("PaymentGatewayAxcess: paymentGatewayService is required");
    }
    this.svc = paymentGatewayService;

    // Validate config eagerly
    const cleaned = Formatting.sanitizeValidate({
      environment: { value: config?.environment, type: "string", required: true },
      baseUrl: { value: config?.baseUrl, type: "url", required: true },
      entityId: { value: config?.entityId, type: "string", required: true },
      bearerToken: { value: config?.bearerToken, type: "string", required: true },
      webhook: { value: config?.webhook || {}, type: "object", required: false, default: {} },
      ui: { value: config?.ui || {}, type: "object", required: false, default: {} },
      locales: { value: config?.locales || {}, type: "object", required: false, default: {} },
      threeDS: { value: config?.threeDS || {}, type: "object", required: false, default: {} },
      session: { value: config?.session || {}, type: "object", required: false, default: {} },
    });

    this.environmentLabel = cleaned.environment;
    this.apiBaseUrl = cleaned.baseUrl.replace(/\/+$/, ""); // trim trailing slash
    this.entityId = cleaned.entityId;
    this.apiBearerToken = cleaned.bearerToken;

    this.webhookConfig = {
      secretKey: cleaned.webhook.secretKey || null,
      ivHeaderName: cleaned.webhook.ivHeaderName || "x-axcess-iv",
      sigHeaderName: cleaned.webhook.sigHeaderName || "x-axcess-signature",
      idempotencyStoreTtlHours: Number(cleaned.webhook.idempotencyStoreTtlHours || 48),
    };

    this.uiConfig = {
      widgetBrands: Array.isArray(cleaned.ui.widgetBrands) ? cleaned.ui.widgetBrands : ["VISA", "MASTER"],
      defaultLocale: cleaned.ui.defaultLocale || "en",
    };

    this.localeMap = { ...cleaned.locales };
    this.threeDSDefaults = {
      challengeWindowSize: cleaned.threeDS.challengeWindowSize || "05",
      attemptExemption: !!cleaned.threeDS.attemptExemption,
    };
    this.sessionConfig = {
      checkoutExpiryMinutes: Number(cleaned.session.checkoutExpiryMinutes || DEFAULT_CHECKOUT_EXPIRY_MINUTES),
    };

    this.httpTimeoutMs = DEFAULT_HTTP_TIMEOUT_MS;
    this.options = { ...options };
  }

  /* ============================================================================
   * SECTION A — Copy&Pay Widget (no iframe; script-based widget)
   * Docs:
   *  - Widget: https://axcessms.docs.oppwa.com/integrations/widget
   *  - Widget API: https://axcessms.docs.oppwa.com/integrations/widget/api
   *  - Customization: https://axcessms.docs.oppwa.com/integrations/widget/customization
   *  - Advanced Options: https://axcessms.docs.oppwa.com/integrations/widget/advanced-options
   * ========================================================================== */

  /**
   * Create (or reuse) a widget checkout session. Persists via paymentGatewayService.
   * @param {object} params
   * @param {string} params.userId - your user id
   * @param {string} params.orderId - your order id
   * @param {number|string} params.amount - e.g., 24.99
   * @param {string} params.currency - ISO 4217 (e.g., 'USD')
   * @param {string} [params.paymentType='DB'] - 'DB' (debit/purchase) | 'PA' (preauth)
   * @param {object} [params.customer] - optional customer fields to include in metadata
   * @param {object} [params.metadata] - optional metadata to attach to session
   * @returns {Promise<{checkoutId:string, redirectUrl:string, sessionId:string}>}
   *
   * Axcess Docs: Widget / API
   * https://axcessms.docs.oppwa.com/integrations/widget
   * https://axcessms.docs.oppwa.com/integrations/widget/api
   */
  async createCheckoutSession(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      userId: { value: params.userId, type: "string", required: true },
      orderId: { value: params.orderId, type: "string", required: true },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      paymentType: { value: params.paymentType || "DB", type: "string", required: true },
      customer: { value: params.customer || {}, type: "object", required: false, default: {} },
      metadata: { value: params.metadata || {}, type: "object", required: false, default: {} },
    });

    // Reuse any existing “pending” session within TTL
    const existing = (await this.svc.getSessionsBy?.("orderId", cleaned.orderId)) || [];
    const reusable = existing.find((s) => this.isCheckoutSessionValid(s));
    if (reusable) {
      Logger.writeLog({
        flag: "payment",
        action: "Reuse checkout session",
        message: "Using existing pending Axcess checkout session",
        data: { sessionId: reusable.id, orderId: cleaned.orderId, userId: cleaned.userId }
      });
      return {
        checkoutId: reusable.checkoutId,
        redirectUrl: `${this.apiBaseUrl}/v1/checkouts/${encodeURIComponent(reusable.checkoutId)}/payment`,
        sessionId: reusable.id
      };
    }

    // Create new checkout
    const endpoint = `${this.apiBaseUrl}/v1/checkouts`;
    const bodyParams = {
      entityId: this.entityId,
      amount: cleaned.amount,
      currency: cleaned.currency,
      paymentType: cleaned.paymentType,
      // You can pass additional fields (customer.*) depending on your needs
      "merchantTransactionId": cleaned.orderId,
    };
    const body = toFormUrlEncoded(bodyParams);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    if (res.status < 200 || res.status >= 300 || !res.data?.id) {
      ErrorHandler.add_error("Axcess create checkout failed", { status: res.status, data: res.raw });
      throw new Error("Failed to create Axcess checkout session");
    }

    const checkoutId = res.data.id;
    const redirectUrl = `${this.apiBaseUrl}/v1/checkouts/${encodeURIComponent(checkoutId)}/payment`;

    const sessionRecord = {
      id: crypto.randomUUID(),
      gateway: "axcess",
      userId: cleaned.userId,
      orderId: cleaned.orderId,
      checkoutId,
      status: "pending",
      amount: cleaned.amount,
      currency: cleaned.currency,
      paymentType: cleaned.paymentType,
      metadata: cleaned.metadata,
      customer: cleaned.customer,
      createdAt: Date.now()
    };

    await this.svc.saveSession?.(sessionRecord);

    Logger.writeLog({
      flag: "payment",
      action: "Create checkout session",
      message: "Axcess checkout created",
      data: { checkoutId, sessionId: sessionRecord.id, orderId: cleaned.orderId }
    });

    return { checkoutId, redirectUrl, sessionId: sessionRecord.id };
  }

  /**
   * Check if a checkout session is still valid (“pending” and within configured TTL).
   * @param {object} session - session record
   * @returns {boolean}
   */
  isCheckoutSessionValid(session) {
    if (!session || session.status !== "pending" || !session.createdAt) return false;
    const ms = Number(this.sessionConfig.checkoutExpiryMinutes) * 60 * 1000;
    return Date.now() - Number(session.createdAt) < ms;
  }

  /**
   * Purge expired sessions for a given user or order id.
   * @param {object} params
   * @param {'userId'|'orderId'} params.by
   * @param {string} params.value
   * @returns {Promise<number>}
   */
  async purgeExpiredSessions(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      by: { value: params.by, type: "string", required: true },
      value: { value: params.value, type: "string", required: true }
    });
    const sessions = await this.svc.getSessionsBy?.(cleaned.by, cleaned.value) || [];
    let purged = 0;
    for (const s of sessions) {
      if (!this.isCheckoutSessionValid(s)) {
        await this.svc.deleteSession?.(s.id);
        purged++;
      }
    }
    return purged;
  }

  /**
   * Return Copy&Pay widget HTML snippet (script + minimal form). No iframe.
   * The consumer should validate DOM presence before inserting this HTML.
   *
   * @param {object} params
   * @param {string} params.checkoutId - ID returned by createCheckoutSession
   * @param {string} [params.locale] - app locale; mapped to widget 'lang'
   * @param {string[]} [params.brands] - e.g., ['VISA','MASTER']
   * @returns {string} HTML snippet
   *
   * Docs: Widget / API / Customization / Advanced Options
   * https://axcessms.docs.oppwa.com/integrations/widget
   */
  getPaymentWidgetHtml(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      checkoutId: { value: params.checkoutId, type: "string", required: true },
      locale: { value: params.locale || this.uiConfig.defaultLocale, type: "string", required: true },
      brands: { value: params.brands || this.uiConfig.widgetBrands, type: "array", required: false, default: this.uiConfig.widgetBrands }
    });

    const widgetLang = this.resolveWidgetLanguage(cleaned.locale) || this.uiConfig.defaultLocale;
    const brandsParam = Array.isArray(cleaned.brands) && cleaned.brands.length
      ? `data-brands="${cleaned.brands.join(" ")}"`
      : "";

    // The actual DOM insertion is up to the caller; we return a string.
    // IMPORTANT: Copy&Pay is script-based; not an <iframe>.
    return [
      `<script src="${this.apiBaseUrl}/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(cleaned.checkoutId)}" async></script>`,
      `<form action="/payments/axcess/callback" class="paymentWidgets" data-lang="${widgetLang}" ${brandsParam}></form>`
    ].join("\n");
  }

  /**
   * Handle the redirect callback from Copy&Pay and persist the transaction result.
   * @param {object} params
   * @param {string} params.resourcePath - provided by Axcess on return
   * @param {string} params.orderId - your order id
   * @param {string} params.userId - your user id
   * @returns {Promise<{status:string, resultCode:string, payload:object}>}
   *
   * Docs: Widget API (reading payment result via resourcePath)
   * https://axcessms.docs.oppwa.com/integrations/widget/api
   */
  async handleRedirectCallback(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      resourcePath: { value: params.resourcePath, type: "string", required: true },
      orderId: { value: params.orderId, type: "string", required: true },
      userId: { value: params.userId, type: "string", required: true },
    });

    const statusRes = await this.getPaymentStatus(cleaned.resourcePath);
    const normalized = this._normalizePaymentResult(statusRes.data);

    // Persist transaction and update any session
    const txn = {
      gateway: "axcess",
      orderId: cleaned.orderId,
      userId: cleaned.userId,
      gatewayTxnId: normalized.id || null,
      amount: normalized.amount || null,
      currency: normalized.currency || null,
      status: normalized.approved ? "success" : (normalized.pending ? "pending" : "failed"),
      code: normalized.resultCode || null,
      uiMessage: this.mapResultCodeToUiMessage(normalized.resultCode).uiMessage,
      raw: statusRes.data,
      createdAt: Date.now()
    };
    await this.svc.saveTransaction?.(txn);

    // Entitlements
    if (txn.status === "success") {
      await this.svc.grantAccess?.({ txn });
    } else if (txn.status === "failed") {
      await this.svc.denyAccess?.({ txn });
    }

    // Update session if any (by orderId)
    const sessions = await this.svc.getSessionsBy?.("orderId", cleaned.orderId) || [];
    for (const s of sessions) {
      if (s.checkoutId && normalized.id && s.status === "pending") {
        await this.svc.saveSession?.({ ...s, status: txn.status, updatedAt: Date.now() });
      }
    }

    return {
      status: txn.status.toUpperCase(),
      resultCode: normalized.resultCode || "",
      payload: statusRes.data
    };
  }

  /**
   * GET payment status by resourcePath returned from Axcess (Copy&Pay).
   * @param {string} resourcePath
   * @returns {Promise<{status:number,data:object,raw:string}>}
   *
   * Docs: Widget API
   * https://axcessms.docs.oppwa.com/integrations/widget/api
   */
  async getPaymentStatus(resourcePath) {
    const cleaned = Formatting.sanitizeValidate({
      resourcePath: { value: resourcePath, type: "string", required: true }
    });

    const url = new URL(this.apiBaseUrl + cleaned.resourcePath);
    url.searchParams.set("entityId", this.entityId);

    const res = await httpRequestWithBearer({
      urlString: url.toString(),
      method: "GET",
      bearerToken: this.apiBearerToken
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error("Axcess getPaymentStatus failed", { status: res.status, raw: res.raw });
      throw new Error("Failed to fetch Axcess payment status");
    }
    return res;
  }

  /* ============================================================================
   * SECTION B — Server-to-Server (S2S) Payments (no widget)
   * Docs:
   *  https://axcessms.docs.oppwa.com/integrations/server-to-server
   *  https://axcessms.docs.oppwa.com/reference/parameters
   *  https://axcessms.docs.oppwa.com/reference/resultCodes
   * ========================================================================== */

  /**
   * Server-to-Server Authorization (paymentType=PA).
   * @param {object} params
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {string} params.paymentBrand - e.g., 'VISA', 'MASTER'
   * @param {object} params.card - { number, holder, expiryMonth, expiryYear, cvv }
   * @param {object} [params.customer] - optional customer details
   * @param {object} [params.threeDSParams] - 3DS fields; see 3DS docs
   * @returns {Promise<object>} normalized result
   *
   * Docs: S2S + 3DS Parameters
   * https://axcessms.docs.oppwa.com/integrations/server-to-server
   * https://axcessms.docs.oppwa.com/tutorials/threeDSecure/Parameters
   */
  async s2sAuthorize(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      paymentBrand: { value: params.paymentBrand, type: "string", required: true },
      card: { value: params.card, type: "object", required: true },
      customer: { value: params.customer || {}, type: "object", required: false, default: {} },
      threeDSParams: { value: params.threeDSParams || {}, type: "object", required: false, default: {} },
    });

    const endpoint = `${this.apiBaseUrl}/v1/payments`;
    const bodyParams = {
      entityId: this.entityId,
      paymentBrand: cleaned.paymentBrand,
      paymentType: "PA",
      amount: cleaned.amount,
      currency: cleaned.currency,
      "card.number": cleaned.card.number,
      "card.holder": cleaned.card.holder,
      "card.expiryMonth": cleaned.card.expiryMonth,
      "card.expiryYear": cleaned.card.expiryYear,
      "card.cvv": cleaned.card.cvv,
      ...this._flattenThreeDS(cleaned.threeDSParams),
    };
    const body = toFormUrlEncoded(bodyParams);
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    return this._handleS2SResponse(res, "authorize");
  }

  /**
   * Server-to-Server Capture (paymentType=CP).
   * @param {object} params
   * @param {string} params.paymentId
   * @param {number|string} [params.amount] - optional partial capture
   * @returns {Promise<object>} normalized result
   *
   * Docs: Backoffice
   * https://axcessms.docs.oppwa.com/integrations/backoffice
   */
  async s2sCapture(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      paymentId: { value: params.paymentId, type: "string", required: true },
      amount: { value: params.amount, type: "float", required: false }
    });

    const endpoint = `${this.apiBaseUrl}/v1/payments/${encodeURIComponent(cleaned.paymentId)}`;
    const bodyParams = { entityId: this.entityId, paymentType: "CP", ...(cleaned.amount ? { amount: cleaned.amount } : {}) };
    const body = toFormUrlEncoded(bodyParams);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    return this._handleS2SResponse(res, "capture");
  }

  /**
   * Server-to-Server Void/Reverse (paymentType=RV).
   * @param {object} params
   * @param {string} params.paymentId
   * @returns {Promise<object>} normalized result
   *
   * Docs: Backoffice
   * https://axcessms.docs.oppwa.com/integrations/backoffice
   */
  async s2sVoid(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      paymentId: { value: params.paymentId, type: "string", required: true }
    });

    const endpoint = `${this.apiBaseUrl}/v1/payments/${encodeURIComponent(cleaned.paymentId)}`;
    const body = toFormUrlEncoded({ entityId: this.entityId, paymentType: "RV" });

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    return this._handleS2SResponse(res, "void");
  }

  /**
   * Server-to-Server Debit/Purchase (paymentType=DB).
   * @param {object} params
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {string} params.paymentBrand
   * @param {object} params.card - { number, holder, expiryMonth, expiryYear, cvv }
   * @param {object} [params.customer]
   * @param {object} [params.threeDSParams]
   * @returns {Promise<object>} normalized result
   *
   * Docs: S2S + 3DS Parameters
   * https://axcessms.docs.oppwa.com/integrations/server-to-server
   * https://axcessms.docs.oppwa.com/tutorials/threeDSecure/Parameters
   */
  async s2sDebit(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      paymentBrand: { value: params.paymentBrand, type: "string", required: true },
      card: { value: params.card, type: "object", required: true },
      customer: { value: params.customer || {}, type: "object", required: false, default: {} },
      threeDSParams: { value: params.threeDSParams || {}, type: "object", required: false, default: {} },
    });

    const endpoint = `${this.apiBaseUrl}/v1/payments`;
    const bodyParams = {
      entityId: this.entityId,
      paymentBrand: cleaned.paymentBrand,
      paymentType: "DB",
      amount: cleaned.amount,
      currency: cleaned.currency,
      "card.number": cleaned.card.number,
      "card.holder": cleaned.card.holder,
      "card.expiryMonth": cleaned.card.expiryMonth,
      "card.expiryYear": cleaned.card.expiryYear,
      "card.cvv": cleaned.card.cvv,
      ...this._flattenThreeDS(cleaned.threeDSParams),
    };
    const body = toFormUrlEncoded(bodyParams);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    return this._handleS2SResponse(res, "debit");
  }

  /**
   * Server-to-Server Refund (paymentType=RF).
   * @param {object} params
   * @param {string} params.paymentId - original captured payment id
   * @param {number|string} [params.amount] - optional partial refund
   * @returns {Promise<object>} normalized result
   *
   * Docs: Backoffice
   * https://axcessms.docs.oppwa.com/integrations/backoffice
   */
  async s2sRefund(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      paymentId: { value: params.paymentId, type: "string", required: true },
      amount: { value: params.amount, type: "float", required: false }
    });

    const endpoint = `${this.apiBaseUrl}/v1/payments/${encodeURIComponent(cleaned.paymentId)}`;
    const bodyParams = { entityId: this.entityId, paymentType: "RF", ...(cleaned.amount ? { amount: cleaned.amount } : {}) };
    const body = toFormUrlEncoded(bodyParams);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });
    return this._handleS2SResponse(res, "refund");
  }

  /**
   * Initiate standalone 3-D Secure authentication (if using separate flow).
   * @param {object} params
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {object} params.card
   * @param {object} params.customer
   * @param {object} params.threeDSParams
   * @returns {Promise<object>} raw/normalized depending on Axcess response
   *
   * Docs: Standalone 3DS
   * https://axcessms.docs.oppwa.com/integrations/server-to-server/standalone3DS
   */
  async initiateStandalone3DS(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      card: { value: params.card, type: "object", required: true },
      customer: { value: params.customer || {}, type: "object", required: false, default: {} },
      threeDSParams: { value: params.threeDSParams || {}, type: "object", required: true }
    });

    const endpoint = `${this.apiBaseUrl}/v1/threeDSecure`;
    const bodyParams = {
      entityId: this.entityId,
      amount: cleaned.amount,
      currency: cleaned.currency,
      "card.number": cleaned.card.number,
      "card.holder": cleaned.card.holder,
      "card.expiryMonth": cleaned.card.expiryMonth,
      "card.expiryYear": cleaned.card.expiryYear,
      "card.cvv": cleaned.card.cvv,
      ...this._flattenThreeDS(cleaned.threeDSParams),
    };
    const body = toFormUrlEncoded(bodyParams);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error("Axcess initiateStandalone3DS failed", { status: res.status, raw: res.raw });
      throw new Error("Failed to initiate standalone 3DS");
    }
    return res.data || {};
  }

  /**
   * Continue 3DS after ACS challenge (PaRes/CRes).
   * @param {object} params
   * @param {string} params.id - 3DS transaction id
   * @param {string} [params.paRes] - for 3DS1
   * @param {string} [params.cres] - for 3DS2
   * @returns {Promise<object>}
   *
   * Docs: 3DS Response Parameters
   * https://axcessms.docs.oppwa.com/tutorials/threeDSecure/Parameters#Response-Parameters
   */
  async continue3DSChallenge(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      id: { value: params.id, type: "string", required: true },
      paRes: { value: params.paRes, type: "string", required: false },
      cres: { value: params.cres, type: "string", required: false },
    });
    const endpoint = `${this.apiBaseUrl}/v1/threeDSecure/${encodeURIComponent(cleaned.id)}`;
    const body = toFormUrlEncoded({
      entityId: this.entityId,
      ...(cleaned.paRes ? { paRes: cleaned.paRes } : {}),
      ...(cleaned.cres ? { cres: cleaned.cres } : {})
    });

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error("Axcess continue3DSChallenge failed", { status: res.status, raw: res.raw });
      throw new Error("Failed to continue 3DS challenge");
    }
    return res.data || {};
  }

  /**
   * Request a Standalone SCA Exemption (if supported for your entity/flows).
   * @param {object} params
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {string} params.paymentBrand
   * @param {object} params.cardOrToken - { card.* } or { registrationId }
   * @param {string} params.exemptionType - e.g., 'TRA', 'LVP' (see docs)
   * @returns {Promise<object>}
   *
   * Docs: Standalone Exemption
   * https://axcessms.docs.oppwa.com/integrations/server-to-server/standaloneexemption
   */
  async requestStandaloneExemption(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      paymentBrand: { value: params.paymentBrand, type: "string", required: true },
      cardOrToken: { value: params.cardOrToken, type: "object", required: true },
      exemptionType: { value: params.exemptionType, type: "string", required: true },
    });

    const endpoint = `${this.apiBaseUrl}/v1/exemptions`;
    const bodyParams = {
      entityId: this.entityId,
      paymentBrand: cleaned.paymentBrand,
      amount: cleaned.amount,
      currency: cleaned.currency,
      exemptionType: cleaned.exemptionType,
    };
    if (cleaned.cardOrToken.registrationId) {
      bodyParams.registrationId = cleaned.cardOrToken.registrationId;
    } else {
      bodyParams["card.number"] = cleaned.cardOrToken.card?.number;
      bodyParams["card.holder"] = cleaned.cardOrToken.card?.holder;
      bodyParams["card.expiryMonth"] = cleaned.cardOrToken.card?.expiryMonth;
      bodyParams["card.expiryYear"] = cleaned.cardOrToken.card?.expiryYear;
      bodyParams["card.cvv"] = cleaned.cardOrToken.card?.cvv;
    }

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toFormUrlEncoded(bodyParams)
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error("Axcess requestStandaloneExemption failed", { status: res.status, raw: res.raw });
      throw new Error("Failed to request 3DS exemption");
    }
    return res.data || {};
  }

  /* ============================================================================
   * SECTION C — Card-on-File / Registration Tokens
   * Docs:
   *  https://axcessms.docs.oppwa.com/tutorials/card-on-file
   *  https://axcessms.docs.oppwa.com/integrations/widget/registration-tokens
   *  https://axcessms.docs.oppwa.com/integrations/server-to-server/registrationtokens
   *  https://axcessms.docs.oppwa.com/integrations/server-to-server/networktokens
   * ========================================================================== */

  /**
   * Create a registration token for later charges (card-on-file).
   * @param {object} params
   * @param {object} params.card - { number, holder, expiryMonth, expiryYear, cvv }
   * @param {object} [params.customer]
   * @returns {Promise<{registrationId:string, maskedPan?:string, brand?:string, expiry?:string}>}
   */
  async createRegistrationToken(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      card: { value: params.card, type: "object", required: true },
      customer: { value: params.customer || {}, type: "object", required: false, default: {} },
    });

    const endpoint = `${this.apiBaseUrl}/v1/registrations`;
    const bodyParams = {
      entityId: this.entityId,
      "card.number": cleaned.card.number,
      "card.holder": cleaned.card.holder,
      "card.expiryMonth": cleaned.card.expiryMonth,
      "card.expiryYear": cleaned.card.expiryYear,
      "card.cvv": cleaned.card.cvv,
      // Some entities require additional flags; consult docs.
    };
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toFormUrlEncoded(bodyParams)
    });

    if (res.status < 200 || res.status >= 300 || !res.data?.id) {
      ErrorHandler.add_error("Axcess createRegistrationToken failed", { status: res.status, raw: res.raw });
      throw new Error("Failed to create registration token");
    }

    const tokenRecord = {
      id: res.data.id,
      gateway: "axcess",
      last4: res.data.card?.bin ? undefined : (res.data.card?.last4 || null),
      brand: res.data.paymentBrand || null,
      expiry: (res.data.card?.expiryMonth && res.data.card?.expiryYear) ? `${res.data.card.expiryYear}-${res.data.card.expiryMonth}` : null,
      createdAt: Date.now()
    };
    await this.svc.saveToken?.(tokenRecord);

    return {
      registrationId: res.data.id,
      maskedPan: res.data.card?.bin ? `${res.data.card.bin}******${res.data.card?.last4 || ""}` : undefined,
      brand: res.data.paymentBrand || undefined,
      expiry: tokenRecord.expiry || undefined
    };
  }

  /**
   * Charge with a registration token (paymentType=DB).
   * @param {object} params
   * @param {string} params.registrationId
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {object} [params.threeDSParams]
   * @returns {Promise<object>} normalized result
   */
  async debitWithRegistrationToken(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      registrationId: { value: params.registrationId, type: "string", required: true },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      threeDSParams: { value: params.threeDSParams || {}, type: "object", required: false, default: {} },
    });
    const endpoint = `${this.apiBaseUrl}/v1/registrations/${encodeURIComponent(cleaned.registrationId)}/payments`;
    const bodyParams = {
      entityId: this.entityId,
      paymentType: "DB",
      amount: cleaned.amount,
      currency: cleaned.currency,
      ...this._flattenThreeDS(cleaned.threeDSParams),
    };
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toFormUrlEncoded(bodyParams)
    });
    return this._handleS2SResponse(res, "debit_token");
  }

  /**
   * Authorize with a registration token (paymentType=PA).
   * @param {object} params
   * @param {string} params.registrationId
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {object} [params.threeDSParams]
   * @returns {Promise<object>} normalized result
   */
  async authorizeWithRegistrationToken(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      registrationId: { value: params.registrationId, type: "string", required: true },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      threeDSParams: { value: params.threeDSParams || {}, type: "object", required: false, default: {} },
    });
    const endpoint = `${this.apiBaseUrl}/v1/registrations/${encodeURIComponent(cleaned.registrationId)}/payments`;
    const bodyParams = {
      entityId: this.entityId,
      paymentType: "PA",
      amount: cleaned.amount,
      currency: cleaned.currency,
      ...this._flattenThreeDS(cleaned.threeDSParams),
    };
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toFormUrlEncoded(bodyParams)
    });
    return this._handleS2SResponse(res, "authorize_token");
  }

  /**
   * Delete a registration token (if supported for your entity).
   * @param {object} params
   * @param {string} params.registrationId
   * @returns {Promise<boolean>}
   */
  async deleteRegistrationToken(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      registrationId: { value: params.registrationId, type: "string", required: true }
    });
    const endpoint = `${this.apiBaseUrl}/v1/registrations/${encodeURIComponent(cleaned.registrationId)}?entityId=${encodeURIComponent(this.entityId)}`;
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "DELETE",
      bearerToken: this.apiBearerToken
    });
    if (res.status >= 200 && res.status < 300) {
      await this.svc.deleteToken?.(cleaned.registrationId);
      return true;
    }
    ErrorHandler.add_error("Axcess deleteRegistrationToken failed", { status: res.status, raw: res.raw });
    return false;
  }

  /**
   * List tokens for a user (pass-through to service).
   * @param {string} userId
   * @returns {Promise<Array>}
   */
  async listUserTokens(userId) {
    return this.svc.getTokensByUser?.(userId);
  }

  /**
   * Tokens expiring in a given YYYY-MM.
   * @param {string} yyyymm
   * @returns {Promise<Array>}
   */
  async getTokensExpiring(yyyymm) {
    return this.svc.getTokensByExpiry?.(yyyymm);
  }

  /* ============================================================================
   * SECTION D — Subscriptions
   * Docs:
   *  https://axcessms.docs.oppwa.com/integrations/subscriptions
   * ========================================================================== */

  /**
   * Create a subscription schedule using a registration token.
   * @param {object} params
   * @param {string} params.registrationId
   * @param {number|string} params.amount
   * @param {string} params.currency
   * @param {string} params.interval - e.g., 'P1M' (ISO 8601 period) or provider-specific
   * @param {string} [params.startDate] - yyyy-MM-dd
   * @param {object} [params.trial] - { amount, lengthDays }
   * @returns {Promise<{status:string, scheduleId?:string}>}
   *
   * Docs: Subscriptions
   * https://axcessms.docs.oppwa.com/integrations/subscriptions
   */
  async createSubscriptionFromToken(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      registrationId: { value: params.registrationId, type: "string", required: true },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      interval: { value: params.interval, type: "string", required: true },
      startDate: { value: params.startDate, type: "string", required: false },
      trial: { value: params.trial || {}, type: "object", required: false, default: {} },
    });

    // Placeholder API call — consult your Axcess contract for exact subscription endpoint/fields
    const endpoint = `${this.apiBaseUrl}/v1/subscriptions`;
    const bodyParams = {
      entityId: this.entityId,
      registrationId: cleaned.registrationId,
      amount: cleaned.amount,
      currency: cleaned.currency,
      interval: cleaned.interval,
      ...(cleaned.startDate ? { startDate: cleaned.startDate } : {}),
      ...(cleaned.trial?.amount ? { trialAmount: cleaned.trial.amount } : {}),
      ...(cleaned.trial?.lengthDays ? { trialLengthDays: cleaned.trial.lengthDays } : {}),
    };
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toFormUrlEncoded(bodyParams)
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error("Axcess createSubscriptionFromToken failed", { status: res.status, raw: res.raw });
      throw new Error("Failed to create subscription");
    }

    const schedule = {
      registrationId: cleaned.registrationId,
      scheduleId: res.data?.id || null,
      status: "active",
      amount: cleaned.amount,
      currency: cleaned.currency,
      interval: cleaned.interval,
      startDate: cleaned.startDate || null,
      createdAt: Date.now()
    };
    await this.svc.upsertSchedule?.(schedule);
    return { status: "active", scheduleId: schedule.scheduleId };
  }

  /**
   * Cancel subscription (future billings).
   * @param {object} params
   * @param {string} params.subscriptionId
   * @param {string} [params.reason]
   * @returns {Promise<{status:string}>}
   */
  async cancelSubscription(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      subscriptionId: { value: params.subscriptionId, type: "string", required: true },
      reason: { value: params.reason, type: "string", required: false }
    });

    const endpoint = `${this.apiBaseUrl}/v1/subscriptions/${encodeURIComponent(cleaned.subscriptionId)}?entityId=${encodeURIComponent(this.entityId)}`;
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "DELETE",
      bearerToken: this.apiBearerToken
    });
    if (res.status >= 200 && res.status < 300) {
      await this.svc.upsertSchedule?.({ scheduleId: cleaned.subscriptionId, status: "canceled", updatedAt: Date.now(), reason: cleaned.reason || null });
      return { status: "canceled" };
    }
    ErrorHandler.add_error("Axcess cancelSubscription failed", { status: res.status, raw: res.raw });
    throw new Error("Failed to cancel subscription");
  }

  /**
   * Pause subscription (policy: cancel now, store resume instruction)
   * @param {object} params
   * @param {string} params.subscriptionId
   * @param {string} params.resumeAt - yyyy-MM-dd
   * @returns {Promise<{status:string, resumeAt:string}>}
   */
  async pauseSubscription(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      subscriptionId: { value: params.subscriptionId, type: "string", required: true },
      resumeAt: { value: params.resumeAt, type: "string", required: true },
    });
    await this.cancelSubscription({ subscriptionId: cleaned.subscriptionId, reason: "pause" });
    await this.svc.saveResumeInstruction?.({ subscriptionId: cleaned.subscriptionId, resumeAt: cleaned.resumeAt });
    return { status: "paused", resumeAt: cleaned.resumeAt };
  }

  /**
   * Resume subscription = create new schedule from token (your policy).
   * @param {object} params
   * @param {string} params.userId
   * @param {string} params.registrationId
   * @param {object} params.recurringShape - { amount, currency, interval, startDate? }
   * @returns {Promise<{status:string, scheduleId?:string}>}
   */
  async resumeSubscription(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      userId: { value: params.userId, type: "string", required: true },
      registrationId: { value: params.registrationId, type: "string", required: true },
      recurringShape: { value: params.recurringShape, type: "object", required: true }
    });
    const res = await this.createSubscriptionFromToken({
      registrationId: cleaned.registrationId,
      amount: cleaned.recurringShape.amount,
      currency: cleaned.recurringShape.currency,
      interval: cleaned.recurringShape.interval,
      startDate: cleaned.recurringShape.startDate || null
    });
    return { status: "resumed", scheduleId: res.scheduleId || null };
  }

  /**
   * Upgrade subscription = immediate proration debit + recreate schedule with higher price.
   * @param {object} params
   * @param {string} params.subscriptionId
   * @param {number|string} params.prorationCharge
   * @param {object} params.newRecurring - { registrationId, amount, currency, interval, startDate? }
   * @returns {Promise<{status:string, scheduleId?:string}>}
   */
  async upgradeSubscription(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      subscriptionId: { value: params.subscriptionId, type: "string", required: true },
      prorationCharge: { value: params.prorationCharge, type: "float", required: true },
      newRecurring: { value: params.newRecurring, type: "object", required: true }
    });

    // Charge proration immediately (token required)
    if (!cleaned.newRecurring.registrationId) {
      throw new Error("upgradeSubscription requires newRecurring.registrationId for proration charge");
    }
    await this.debitWithRegistrationToken({
      registrationId: cleaned.newRecurring.registrationId,
      amount: cleaned.prorationCharge,
      currency: cleaned.newRecurring.currency
    });

    // Cancel current schedule; create new one
    await this.cancelSubscription({ subscriptionId: cleaned.subscriptionId, reason: "upgrade" });
    const newSchedule = await this.createSubscriptionFromToken({
      registrationId: cleaned.newRecurring.registrationId,
      amount: cleaned.newRecurring.amount,
      currency: cleaned.newRecurring.currency,
      interval: cleaned.newRecurring.interval,
      startDate: cleaned.newRecurring.startDate || null
    });

    return { status: "upgrade_scheduled", scheduleId: newSchedule.scheduleId || null };
  }

  /**
   * Downgrade subscription = schedule for next period.
   * @param {object} params
   * @param {string} params.subscriptionId
   * @param {string} params.effectiveAt - yyyy-MM-dd
   * @param {object} params.newRecurring - { registrationId, amount, currency, interval }
   * @returns {Promise<{status:string, effectiveAt:string}>}
   */
  async downgradeSubscription(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      subscriptionId: { value: params.subscriptionId, type: "string", required: true },
      effectiveAt: { value: params.effectiveAt, type: "string", required: true },
      newRecurring: { value: params.newRecurring, type: "object", required: true }
    });

    await this.svc.saveDowngradeInstruction?.({
      subscriptionId: cleaned.subscriptionId,
      effectiveAt: cleaned.effectiveAt,
      newRecurring: cleaned.newRecurring,
      status: "pending"
    });
    return { status: "downgrade_scheduled", effectiveAt: cleaned.effectiveAt };
  }

  /* ============================================================================
   * SECTION E — Webhooks (Encrypted)
   * Docs:
   *  https://axcessms.docs.oppwa.com/tutorials/webhooks/configuration
   *  https://axcessms.docs.oppwa.com/tutorials/webhooks/payload
   *  https://axcessms.docs.oppwa.com/tutorials/webhooks/decryption
   * ========================================================================== */

  /**
   * Decrypt and (optionally) verify webhook payload using AES-256-CBC.
   * NOTE: Header names and signature algorithm can vary; configure in this.webhookConfig.
   * @param {string|Buffer} rawBody - the raw request body as received
   * @param {object} headers - incoming headers
   * @returns {{ decryptedJson: object, idempotencyKey?: string, verified: boolean }}
   */
  decryptAndVerifyWebhook(rawBody, headers = {}) {
    if (!this.webhookConfig.secretKey) {
      throw new Error("Webhook secretKey is not configured");
    }

    try {
      const ivBase64 = headers[this.webhookConfig.ivHeaderName] || headers[this.webhookConfig.ivHeaderName.toLowerCase()];
      const signature = headers[this.webhookConfig.sigHeaderName] || headers[this.webhookConfig.sigHeaderName.toLowerCase()];
      const iv = ivBase64 ? Buffer.from(String(ivBase64), "base64") : null;

      // Decrypt AES-256-CBC: ciphertext is base64 in body; alternatively, rawBody may already be decrypted JSON.
      let plaintext = null;
      const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "");
      const maybeJson = bodyStr.trim().startsWith("{") ? bodyStr : null;

      if (maybeJson) {
        plaintext = maybeJson; // already plaintext JSON
      } else {
        const cipherBuf = Buffer.from(bodyStr, "base64");
        const key = this._coerceKeyTo32Bytes(this.webhookConfig.secretKey);
        if (!iv) {
          throw new Error("Missing IV header for webhook decryption");
        }
        const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
        const decrypted = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
        plaintext = decrypted.toString("utf8");
      }

      // Optional HMAC verification (if you configure to use HMAC-SHA256)
      let verified = true;
      if (signature) {
        const key = this._coerceKeyTo32Bytes(this.webhookConfig.secretKey);
        const h = crypto.createHmac("sha256", key).update(plaintext).digest("hex");
        verified = crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(signature.replace(/^0x/, ""), "hex"));
      }

      const decryptedJson = JSON.parse(plaintext);
      const idempotencyKey = decryptedJson?.id || decryptedJson?.eventId || decryptedJson?.payloadId || null;

      return { decryptedJson, idempotencyKey, verified };
    } catch (e) {
      ErrorHandler.add_error("Axcess webhook decrypt/verify failed", { error: e.message });
      throw e;
    }
  }

  /**
   * Handle webhook: decrypt → map → route → persist.
   * @param {string|Buffer} rawBody
   * @param {object} headers
   * @returns {Promise<{ok:true}>}
   */
  async handleWebhook(rawBody, headers = {}) {
    const { decryptedJson, idempotencyKey, verified } = this.decryptAndVerifyWebhook(rawBody, headers);

    // Optional: use your service to dedupe based on idempotency key
    await this.svc.saveWebhook?.({ payload: decryptedJson, event: null, createdAt: Date.now(), verified, idempotencyKey });

    const event = this.mapWebhookEvent(decryptedJson);

    try {
      switch (event.type) {
        case "payment_success":
          await this.onPaymentSuccess(event); break;
        case "payment_failed":
          await this.onPaymentFailed(event); break;
        case "refund":
          await this.onRefund(event); break;
        case "chargeback":
          await this.onChargeback(event); break;
        case "registration_created":
          await this.onRegistrationCreated(event); break;
        case "registration_updated":
          await this.onRegistrationUpdated(event); break;
        case "schedule_created":
        case "schedule_rescheduled":
        case "schedule_canceled":
          await this.onScheduleEvent(event); break;
        case "risk_flagged":
        case "risk_cleared":
          await this.onRiskEvent(event); break;
        default:
          Logger.writeLog({
            flag: "webhook",
            action: "Axcess webhook unmapped",
            message: "Unknown/ignored webhook event",
            data: { sample: decryptedJson?.type || decryptedJson?.eventType || null }
          });
      }

      return { ok: true };
    } catch (e) {
      ErrorHandler.add_error("Axcess handleWebhook routing failed", { error: e.message, payload: decryptedJson });
      throw e;
    }
  }

  /**
   * Map the decrypted webhook JSON to a normalized event.
   * @param {object} payload
   * @returns {{type:string, txn?:object, registration?:object, schedule?:object, risk?:object, raw:object}}
   *
   * Docs: Webhooks payload
   * https://axcessms.docs.oppwa.com/tutorials/webhooks/payload
   */
  mapWebhookEvent(payload = {}) {
    const t = String(payload.type || payload.eventType || "").toLowerCase();

    // Build normalized txn shape if present
    const txn = payload.payment || payload.transaction || payload.txn || {};
    const normalizedTxn = {
      gateway: "axcess",
      gatewayTxnId: txn.id || txn.transactionId || null,
      amount: Number(txn.amount || 0),
      currency: txn.currency || "USD",
      resultCode: txn.result?.code || txn.resultCode || null,
      approved: (txn.result?.code || "").startsWith("000."),
      pending: String(txn.result?.description || "").toLowerCase().includes("pending"),
      createdAt: Date.now()
    };

    // Registration (token) info
    const registrationId = payload.registrationId || txn.registrationId || null;

    // Schedule (subscription) info
    const schedule = payload.schedule || payload.subscription || null;

    // Risk signals
    const risk = this.extractRiskSignals(payload);

    if (t.includes("payment") && normalizedTxn.approved) {
      return { type: "payment_success", txn: normalizedTxn, registration: registrationId ? { registrationId } : null, raw: payload };
    }
    if (t.includes("payment") && !normalizedTxn.approved && !normalizedTxn.pending) {
      return { type: "payment_failed", txn: normalizedTxn, raw: payload };
    }
    if (t.includes("refund")) {
      return { type: "refund", txn: normalizedTxn, raw: payload };
    }
    if (t.includes("chargeback")) {
      return { type: "chargeback", txn: normalizedTxn, raw: payload };
    }
    if (t.includes("registration") && t.includes("create")) {
      return { type: "registration_created", registration: { registrationId }, raw: payload };
    }
    if (t.includes("registration") && (t.includes("update") || t.includes("upgrade"))) {
      return { type: "registration_updated", registration: { registrationId }, raw: payload };
    }
    if (t.includes("schedule") || t.includes("subscription")) {
      if (t.includes("cancel")) return { type: "schedule_canceled", schedule, raw: payload };
      if (t.includes("reschedul")) return { type: "schedule_rescheduled", schedule, raw: payload };
      return { type: "schedule_created", schedule, raw: payload };
    }
    if (t.includes("risk")) {
      if (t.includes("flag")) return { type: "risk_flagged", risk, raw: payload };
      return { type: "risk_cleared", risk, raw: payload };
    }
    return { type: "unknown", raw: payload };
  }

  // ---- Webhook event handlers ----

  /**
   * Persist success txn, grant access, store token if any.
   * @param {object} event
   */
  async onPaymentSuccess(event) {
    const ui = this.mapResultCodeToUiMessage(event.txn.resultCode);
    await this.svc.saveTransaction?.({ ...event.txn, status: "success", uiMessage: ui.uiMessage });
    if (event.registration?.registrationId) {
      await this.svc.saveToken?.({ id: event.registration.registrationId, gateway: "axcess", createdAt: Date.now() });
    }
    await this.svc.grantAccess?.({ event });
  }

  /**
   * Persist failed txn, deny access.
   * @param {object} event
   */
  async onPaymentFailed(event) {
    const ui = this.mapResultCodeToUiMessage(event.txn.resultCode);
    await this.svc.saveTransaction?.({ ...event.txn, status: "failed", uiMessage: ui.uiMessage });
    await this.svc.denyAccess?.({ event });
  }

  /**
   * Persist refund result.
   * @param {object} event
   */
  async onRefund(event) {
    await this.svc.saveTransaction?.({ ...event.txn, status: "refunded" });
    await this.svc.denyAccess?.({ event });
  }

  /**
   * Persist chargeback result.
   * @param {object} event
   */
  async onChargeback(event) {
    await this.svc.saveTransaction?.({ ...event.txn, status: "chargeback" });
    await this.svc.denyAccess?.({ event });
  }

  /**
   * Persist new/updated token as needed.
   * @param {object} event
   */
  async onRegistrationCreated(event) {
    if (event.registration?.registrationId) {
      await this.svc.saveToken?.({ id: event.registration.registrationId, gateway: "axcess", createdAt: Date.now() });
    }
  }
  async onRegistrationUpdated(event) {
    if (event.registration?.registrationId) {
      await this.svc.updateToken?.({ id: event.registration.registrationId, gateway: "axcess", updatedAt: Date.now() });
    }
  }

  /**
   * Schedule events.
   * @param {object} event
   */
  async onScheduleEvent(event) {
    const status = event.type === "schedule_canceled"
      ? "canceled"
      : (event.type === "schedule_rescheduled" ? "rescheduled" : "active");
    await this.svc.upsertSchedule?.({ ...(event.schedule || {}), status, updatedAt: Date.now() });
  }

  /**
   * Risk events (flagged/cleared).
   * @param {object} event
   */
  async onRiskEvent(event) {
    Logger.writeLog({
      flag: "risk",
      action: `Axcess risk ${event.type}`,
      message: "Risk webhook",
      data: { risk: event.risk }
    });
  }

  /* ============================================================================
   * SECTION F — Reporting / Verification
   * Docs:
   *  https://axcessms.docs.oppwa.com/integrations/reporting/transaction
   * ========================================================================== */

  /**
   * Retrieve canonical transaction details from Axcess.
   * @param {object} params
   * @param {string} params.transactionId
   * @returns {Promise<object>}
   */
  async getTransactionDetails(params = {}) {
    const cleaned = Formatting.sanitizeValidate({
      transactionId: { value: params.transactionId, type: "string", required: true }
    });
    const endpoint = `${this.apiBaseUrl}/v1/payments/${encodeURIComponent(cleaned.transactionId)}?entityId=${encodeURIComponent(this.entityId)}`;
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "GET",
      bearerToken: this.apiBearerToken
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error("Axcess getTransactionDetails failed", { status: res.status, raw: res.raw });
      throw new Error("Failed to get transaction details");
    }

    await this.svc.saveVerification?.(res.data);
    return res.data;
  }

  /**
   * Convenience: retrieve full order history from your persistence layer.
   * @param {string} orderId
   * @returns {Promise<object>}
   */
  async findOrderHistory(orderId) {
    return this.svc.getOrderHistory?.(orderId);
  }

  /* ============================================================================
   * SECTION G — Errors, Risk, Locales & Test Plan
   * Docs:
   *  https://axcessms.docs.oppwa.com/reference/resultCodes
   *  https://axcessms.docs.oppwa.com/reference/parameters
   *  https://axcessms.docs.oppwa.com/reference/workflows
   *  https://axcessms.docs.oppwa.com/reference/regression-testing
   * ========================================================================== */

  /**
   * Map Axcess result code to user-friendly message.
   * @param {string} resultCode
   * @returns {{code:string, uiMessage:string}}
   */
  mapResultCodeToUiMessage(resultCode) {
    const code = String(resultCode || "").trim();
    const M = (msg) => ({ code, uiMessage: msg });

    if (code.startsWith("000.")) return M("Payment approved.");
    if (code.startsWith("200.300.")) return M("Payment declined by the issuer.");
    if (code.startsWith("100.396.")) return M("3-D Secure authentication failed or was canceled.");
    if (code.startsWith("800.400.")) return M("Invalid card data. Please check the number and expiry.");
    if (code.startsWith("700.")) return M("Payment expired or timed out.");
    return M("Payment failed. Please try another card or contact support.");
  }

  /**
   * Extract risk signals if present in payload.
   * @param {object} payload
   * @returns {{score?:number, reason?:string, rules?:string[]}}
   */
  extractRiskSignals(payload = {}) {
    const riskObj = payload.risk || payload.fraud || {};
    return {
      score: riskObj.score !== undefined ? Number(riskObj.score) : undefined,
      reason: riskObj.reason || undefined,
      rules: Array.isArray(riskObj.rules) ? riskObj.rules : undefined
    };
  }

  /**
   * Map app locale to widget 'lang'.
   * @param {string} appLocale
   * @returns {string|null}
   */
  resolveWidgetLanguage(appLocale) {
    if (!appLocale) return null;
    const lc = String(appLocale).toLowerCase();
    return this.localeMap[lc] || null;
  }

  /**
   * Emit a set of regression test scenarios (widget + S2S + 3DS).
   * @returns {{env:string, cases:string[]}}
   */
  buildRegressionTestPlan() {
    return {
      env: this.environmentLabel,
      cases: [
        "Widget: DB approved",
        "Widget: DB declined (issuer)",
        "Widget: 3DS challenge → approved",
        "Widget: 3DS challenge → failed",
        "S2S: PA → CP",
        "S2S: PA → RV",
        "S2S: DB approved",
        "S2S: DB declined",
        "S2S: RF partial",
        "Token: create → debit → delete",
        "Subscriptions: create → cancel → resume",
        "Webhook: payment_success",
        "Webhook: payment_failed",
        "Webhook: refund",
        "Webhook: chargeback",
        "Webhook: schedule_created/canceled",
        "Risk: flagged/cleared"
      ]
    };
  }

  /* ============================================================================
   * Private helpers
   * ========================================================================== */

  _coerceKeyTo32Bytes(secret) {
    // Accept base64 or hex or utf8 string and coerce to 32 bytes key
    if (!secret) throw new Error("Missing secret key");
    try {
      // try base64
      const b64 = Buffer.from(secret, "base64");
      if (b64.length === 32) return b64;
    } catch {}
    try {
      // try hex
      const hex = Buffer.from(secret.replace(/^0x/, ""), "hex");
      if (hex.length === 32) return hex;
    } catch {}
    // fallback: use sha256 of string
    return crypto.createHash("sha256").update(String(secret), "utf8").digest();
  }

  _flattenThreeDS(threeDSParams = {}) {
    // Axcess uses assorted threeDSecure.* parameters; pass through known keys directly
    const flat = {};
    for (const [k, v] of Object.entries(threeDSParams)) {
      flat[`threeDSecure.${k}`] = v;
    }
    // apply defaults if not provided
    if (!flat["threeDSecure.challengeWindowSize"] && this.threeDSDefaults.challengeWindowSize) {
      flat["threeDSecure.challengeWindowSize"] = this.threeDSDefaults.challengeWindowSize;
    }
    return flat;
  }

  _normalizePaymentResult(data = {}) {
    // Normalize standard fields from Copy&Pay / S2S responses
    const amount = Number(data.amount || data.card?.amount || 0);
    const currency = data.currency || data.card?.currency || null;
    const id = data.id || data.ndc || data.paymentId || null;
    const resultCode = data.result?.code || data.resultCode || null;
    const description = data.result?.description || data.resultDescription || "";
    const approved = String(resultCode || "").startsWith("000.");
    const pending = /pending/i.test(description);
    return { id, amount, currency, resultCode, description, approved, pending };
  }

  async _handleS2SResponse(res, label) {
    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error(`Axcess S2S ${label} HTTP error`, { status: res.status, raw: res.raw });
      throw new Error(`Axcess S2S ${label} failed (HTTP ${res.status})`);
    }
    const normalized = this._normalizePaymentResult(res.data || {});
    const record = {
      gateway: "axcess",
      type: `s2s_${label}`,
      gatewayTxnId: normalized.id || null,
      amount: normalized.amount || null,
      currency: normalized.currency || null,
      status: normalized.approved ? "success" : (normalized.pending ? "pending" : "failed"),
      code: normalized.resultCode || null,
      uiMessage: this.mapResultCodeToUiMessage(normalized.resultCode).uiMessage,
      raw: res.data || {},
      createdAt: Date.now()
    };
    await this.svc.saveTransaction?.(record);
    if (record.status === "success") await this.svc.grantAccess?.({ txn: record });
    if (record.status === "failed") await this.svc.denyAccess?.({ txn: record });
    return { normalized, raw: res.data || {} };
  }
}

module.exports = PaymentGatewayAxcess;







JEST
// payment-gateway-axcess.test.js
// Jest tests for payment-gateway-axcess.js (Axcess / OPPWA adapter)
// - NO real network calls. We fully mock `https.request`.
// - We also provide an in-test mock `PaymentGatewayServiceMock` that the class will use
//   for all persistence and side effects (sessions, transactions, tokens, schedules, webhooks).
//
// Run:  npx jest payment-gateway-axcess.test.js
//

"use strict";

/* ---------------------------------------------
 * Mock https to avoid real network calls
 * -------------------------------------------*/
jest.mock("https", () => {
  const { EventEmitter } = require("events");

  let rules = [];

  function respond({ options }) {
    // Find a rule by matcher (function or string prefix)
    const path = options.path || "";
    const method = (options.method || "GET").toUpperCase();

    for (const r of rules) {
      const matched =
        typeof r.matcher === "function"
          ? r.matcher({ options, path, method })
          : String(path).startsWith(String(r.matcher));
      if (matched) {
        const out = r.responder({ options, path, method }) || {};
        // default response if responder returns nothing
        return {
          status: out.status ?? 200,
          json: out.json ?? { ok: true },
          headers: out.headers ?? { "content-type": "application/json" },
        };
      }
    }

    // Default fallback
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

      // Simulate async I/O
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = status;
        res.headers = headers;
        res.setEncoding = () => {};
        callback(res);

        const bodyStr =
          headers["content-type"]?.includes("application/json")
            ? JSON.stringify(json)
            : String(json);

        res.emit("data", bodyStr);
        res.emit("end");
      });
    };
    req.on = req.addListener; // compatibility
    req.setTimeout = () => {};
    req.abort = () => {};
    req.destroy = () => {};
    return req;
  }

  // Helpers to control rules from tests
  request.__setMockResponse = (matcher, responder) => {
    rules.push({ matcher, responder });
  };
  request.__resetMock = () => {
    rules = [];
  };

  return { request };
});

/* ---------------------------------------------
 * Local mock paymentGatewayService (in-memory)
 * -------------------------------------------*/
class PaymentGatewayServiceMock {
  constructor() {
    this.sessions = [];
    this.transactions = [];
    this.schedules = new Map();
    this.tokens = new Map();
    this.webhooks = [];
    this.verifications = [];
    this.grants = [];
    this.denials = [];
    this.resume = [];
    this.downgrades = [];
    this.orderHistory = new Map();
  }

  // sessions
  async saveSession(s) {
    const existingIndex = this.sessions.findIndex((x) => x.id === s.id);
    if (existingIndex >= 0) this.sessions[existingIndex] = s;
    else this.sessions.push(s);
    return s;
  }
  async getSessionsBy(key, val) {
    return this.sessions.filter((s) => s[key] === val);
  }
  async deleteSession(id) {
    const i = this.sessions.findIndex((s) => s.id === id);
    if (i >= 0) this.sessions.splice(i, 1);
    return true;
  }

  // transactions
  async saveTransaction(t) {
    this.transactions.push(t);
    return t;
  }
  async updateTransactionStatus(t) {
    this.transactions.push({ ...t, updated: true });
  }
  async cancelTransaction(t) {
    this.transactions.push({ ...t, status: "canceled" });
  }
  async refundTransaction(t) {
    this.transactions.push({ ...t, status: "refunded" });
  }

  // entitlements
  async grantAccess(payload) {
    this.grants.push(payload);
  }
  async denyAccess(payload) {
    this.denials.push(payload);
  }
  async applyGrace(payload) {
    this.denials.push({ ...payload, grace: true });
  }

  // schedules (subscriptions)
  async upsertSchedule(s) {
    const id = s.scheduleId || s.subscriptionId || `S-${this.schedules.size + 1}`;
    this.schedules.set(id, { ...s, scheduleId: id });
  }
  async cancelSchedule(id) {
    if (this.schedules.has(id)) {
      const s = this.schedules.get(id);
      s.status = "canceled";
      this.schedules.set(id, s);
    }
  }
  async saveResumeInstruction(instr) {
    this.resume.push(instr);
  }
  async saveDowngradeInstruction(instr) {
    this.downgrades.push(instr);
  }

  // tokens
  async saveToken(t) {
    this.tokens.set(t.id, t);
  }
  async updateToken(t) {
    this.tokens.set(t.id, { ...(this.tokens.get(t.id) || {}), ...t });
  }
  async deleteToken(id) {
    this.tokens.delete(id);
  }
  async getTokensByUser(userId) {
    return [...this.tokens.values()].filter((t) => t.userId === userId || t.user_id === userId);
  }
  async getTokensByExpiry(yyyymm) {
    return [...this.tokens.values()].filter((t) => (t.expiry || "").startsWith(yyyymm));
  }

  // webhooks & verification
  async saveWebhook(w) {
    this.webhooks.push(w);
  }
  async saveVerification(v) {
    this.verifications.push(v);
  }

  async getOrderHistory(orderId) {
    return this.orderHistory.get(orderId) || { sessions: [], transactions: [], schedules: [] };
  }
}

/* ---------------------------------------------
 * Import the class under test (after mocks)
 * -------------------------------------------*/
const https = require("https"); // mocked
const crypto = require("crypto");
const PaymentGatewayAxcess = require("./payment-gateway-axcess");

/* ---------------------------------------------
 * Shared config for tests
 * -------------------------------------------*/
const baseConfig = {
  environment: "test",
  baseUrl: "https://eu-test.oppwa.com",
  entityId: "ENT-123",
  bearerToken: "BEARER-TOKEN",
  webhook: {
    secretKey: "test-secret-for-webhooks", // arbitrary; class will sha256 it to 32 bytes if needed
    ivHeaderName: "x-axcess-iv",
    sigHeaderName: "x-axcess-signature",
    idempotencyStoreTtlHours: 48
  },
  ui: {
    widgetBrands: ["VISA", "MASTER"],
    defaultLocale: "en"
  },
  locales: { en: "en", fr: "fr" },
  threeDS: { challengeWindowSize: "05", attemptExemption: false },
  session: { checkoutExpiryMinutes: 25 }
};

/* ---------------------------------------------
 * Helper: set mock responders for common endpoints
 * -------------------------------------------*/
function setDefaultHttpsResponders() {
  https.request.__resetMock();

  // POST /v1/checkouts
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path.startsWith("/v1/checkouts"),
    () => ({
      status: 200,
      json: { id: "CHK-1" }
    })
  );

  // GET resourcePath (Copy&Pay status) – e.g., /v1/checkouts/CHK-1/payment?entityId=...
  https.request.__setMockResponse(
    (ctx) => ctx.method === "GET" && ctx.path.startsWith("/v1/checkouts/"),
    () => ({
      status: 200,
      json: {
        id: "PAY-OK-1",
        amount: "24.99",
        currency: "USD",
        result: { code: "000.100.110", description: "Request successfully processed" }
      }
    })
  );

  // POST /v1/payments (authorize/debit)
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path === "/v1/payments",
    ({ options }) => {
      // Read paymentType from body to vary response a bit
      const body = options?.__bodyText || ""; // we don't have direct body, but we could enhance the mock if needed
      return {
        status: 200,
        json: {
          id: "PAY-S2S-1",
          amount: "10.00",
          currency: "USD",
          result: { code: "000.100.110", description: "Approved" }
        }
      };
    }
  );

  // POST /v1/payments/{id} (capture/void/refund)
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && /^\/v1\/payments\/[^/]+$/.test(ctx.path),
    () => ({
      status: 200,
      json: {
        id: "PAY-POST-1",
        amount: "10.00",
        currency: "USD",
        result: { code: "000.100.110", description: "Approved" }
      }
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
        card: { last4: "1111", expiryMonth: "12", expiryYear: "2030" }
      }
    })
  );

  // POST /v1/registrations/{id}/payments
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && /^\/v1\/registrations\/[^/]+\/payments$/.test(ctx.path),
    () => ({
      status: 200,
      json: {
        id: "PAY-TOKEN-1",
        amount: "5.00",
        currency: "USD",
        result: { code: "000.100.110", description: "Approved" }
      }
    })
  );

  // DELETE /v1/registrations/{id}
  https.request.__setMockResponse(
    (ctx) => ctx.method === "DELETE" && /^\/v1\/registrations\/[^/]+\?/.test(ctx.path),
    () => ({ status: 204, json: "" })
  );

  // POST /v1/subscriptions
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path === "/v1/subscriptions",
    () => ({ status: 200, json: { id: "SUB-1" } })
  );

  // DELETE /v1/subscriptions/{id}
  https.request.__setMockResponse(
    (ctx) => ctx.method === "DELETE" && /^\/v1\/subscriptions\/[^/]+\?/.test(ctx.path),
    () => ({ status: 204, json: "" })
  );

  // POST /v1/threeDSecure
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && ctx.path === "/v1/threeDSecure",
    () => ({ status: 200, json: { id: "3DS-1", redirect: { url: "https://acs.example/..." } } })
  );

  // POST /v1/threeDSecure/{id}
  https.request.__setMockResponse(
    (ctx) => ctx.method === "POST" && /^\/v1\/threeDSecure\/[^/]+$/.test(ctx.path),
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
        result: { code: "000.100.110", description: "Approved" }
      }
    })
  );
}

/* ---------------------------------------------
 * Tests
 * -------------------------------------------*/
describe("PaymentGatewayAxcess – adapter", () => {
  let svc, ax;

  beforeEach(() => {
    setDefaultHttpsResponders();
    svc = new PaymentGatewayServiceMock();
    ax = new PaymentGatewayAxcess({ paymentGatewayService: svc, config: baseConfig });
  });

  // Constructor validation
  test("constructor: throws when paymentGatewayService missing", () => {
    expect(() => new PaymentGatewayAxcess({ config: baseConfig })).toThrow();
  });

  /* A) Copy&Pay widget */
  test("createCheckoutSession: happy path creates and persists session", async () => {
    const out = await ax.createCheckoutSession({
      userId: "U1",
      orderId: "ORD-1",
      amount: 24.99,
      currency: "USD",
      paymentType: "DB"
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
      createdAt: Date.now()
    };
    await svc.saveSession(s);

    const out = await ax.createCheckoutSession({
      userId: "U1",
      orderId: "ORD-REUSE",
      amount: 10,
      currency: "USD"
    });
    expect(out.checkoutId).toBe("CHK-EXIST");
    expect(out.sessionId).toBe("S-1");
  });

  test("isCheckoutSessionValid + purgeExpiredSessions", async () => {
    const fresh = { id: "S-FRESH", status: "pending", createdAt: Date.now() };
    const old = { id: "S-OLD", status: "pending", createdAt: Date.now() - 60 * 60 * 1000 };
    await svc.saveSession({ ...fresh, userId: "U2" });
    await svc.saveSession({ ...old, userId: "U2" });

    expect(ax.isCheckoutSessionValid(fresh)).toBe(true);
    expect(ax.isCheckoutSessionValid(old)).toBe(false);

    const purged = await ax.purgeExpiredSessions({ by: "userId", value: "U2" });
    expect(purged).toBe(1);
  });

  test("getPaymentWidgetHtml: returns script + form with lang mapping and brands", () => {
    const html = ax.getPaymentWidgetHtml({ checkoutId: "CHK-1", locale: "fr", brands: ["VISA"] });
    expect(html).toContain("paymentWidgets.js?checkoutId=CHK-1");
    expect(html).toContain('data-lang="fr"');
    expect(html).toContain('data-brands="VISA"');
  });

  test("getPaymentStatus + handleRedirectCallback: persists txn and updates session", async () => {
    // create session first
    await ax.createCheckoutSession({ userId: "U3", orderId: "ORD-STAT", amount: 24.99, currency: "USD" });

    const res = await ax.handleRedirectCallback({
      resourcePath: "/v1/checkouts/CHK-1/payment",
      orderId: "ORD-STAT",
      userId: "U3"
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
      card: { number: "4111111111111111", holder: "T", expiryMonth: "12", expiryYear: "2030", cvv: "123" }
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
      card: { number: "4111111111111111", holder: "T", expiryMonth: "12", expiryYear: "2030", cvv: "123" }
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
      card: { number: "4111111111111111", holder: "T", expiryMonth: "12", expiryYear: "2030", cvv: "123" }
    });
    expect(t.registrationId).toBe("REG-1");
    expect(svc.tokens.has("REG-1")).toBe(true);

    const d = await ax.debitWithRegistrationToken({ registrationId: "REG-1", amount: 5, currency: "USD" });
    expect(d.normalized.resultCode).toBe("000.100.110");

    const a = await ax.authorizeWithRegistrationToken({ registrationId: "REG-1", amount: 7, currency: "USD" });
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
      interval: "P1M"
    });
    expect(c.status).toBe("active");
    const createdId = c.scheduleId || "SUB-1";
    expect(svc.schedules.get(createdId)?.status).toBe("active");

    // Cancel
    const cc = await ax.cancelSubscription({ subscriptionId: createdId, reason: "user" });
    expect(cc.status).toBe("canceled");
    expect(svc.schedules.get(createdId)?.status).toBe("canceled");

    // Pause (cancel + save resume instruction)
    const paused = await ax.pauseSubscription({ subscriptionId: "SUB-X", resumeAt: "2025-10-01" });
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
      recurringShape: { amount: 7.99, currency: "USD", interval: "P1M" }
    });
    expect(resumed.status).toBe("resumed");
    expect(svc.schedules.get("SUB-RESUME")?.status).toBe("active");

    // Upgrade (charge proration + cancel old + new schedule)
    https.request.__setMockResponse(
      (ctx) => ctx.method === "POST" && /^\/v1\/registrations\/REG-UP\/payments$/.test(ctx.path),
      () => ({ status: 200, json: { id: "PAY-UP", result: { code: "000.100.110" } } })
    );
    const up = await ax.upgradeSubscription({
      subscriptionId: "SUB-OLD",
      prorationCharge: 2.34,
      newRecurring: { registrationId: "REG-UP", amount: 14.99, currency: "USD", interval: "P1M" }
    });
    expect(up.status).toBe("upgrade_scheduled");

    // Downgrade (save instruction)
    const down = await ax.downgradeSubscription({
      subscriptionId: "SUB-NEW",
      effectiveAt: "2025-11-01",
      newRecurring: { registrationId: "REG-DOWN", amount: 4.99, currency: "USD", interval: "P1M" }
    });
    expect(down.status).toBe("downgrade_scheduled");
    expect(svc.downgrades[0].effectiveAt).toBe("2025-11-01");
  });

  /* E) Webhooks */
  test("decryptAndVerifyWebhook: plaintext JSON w/ signature", () => {
    const payload = { type: "payment.success", payment: { id: "T-1", amount: "10.0", currency: "USD", result: { code: "000.100.110" } } };
    const plaintext = JSON.stringify(payload);

    // Build signature over plaintext using class's secretKey (sha256)
    const key = crypto.createHash("sha256").update(baseConfig.webhook.secretKey, "utf8").digest();
    const signature = crypto.createHmac("sha256", key).update(plaintext).digest("hex");

    const out = ax.decryptAndVerifyWebhook(plaintext, { "x-axcess-signature": signature });
    expect(out.verified).toBe(true);
    expect(out.decryptedJson.payment.id).toBe("T-1");
  });

  test("decryptAndVerifyWebhook: AES-256-CBC base64 body + iv header", () => {
    const payload = { type: "payment.success", payment: { id: "T-2", amount: "11.0", currency: "USD", result: { code: "000.100.110" } } };
    const plaintext = JSON.stringify(payload);
    const key = crypto.createHash("sha256").update(baseConfig.webhook.secretKey, "utf8").digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
    const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
    const bodyBase64 = enc.toString("base64");
    const signature = crypto.createHmac("sha256", key).update(plaintext).digest("hex");

    const out = ax.decryptAndVerifyWebhook(bodyBase64, {
      "x-axcess-iv": iv.toString("base64"),
      "x-axcess-signature": signature
    });
    expect(out.verified).toBe(true);
    expect(out.decryptedJson.payment.id).toBe("T-2");
  });

  test("handleWebhook: routes payment_success and saves transaction + grants", async () => {
    const payload = { type: "payment.success", payment: { id: "TX-OK", amount: "9.00", currency: "USD", result: { code: "000.100.110" } } };
    const plaintext = JSON.stringify(payload);
    await ax.handleWebhook(plaintext, {}); // signature optional in our class
    expect(svc.transactions[svc.transactions.length - 1].status).toBe("success");
    expect(svc.grants.length).toBeGreaterThan(0);
    expect(svc.webhooks.length).toBe(1);
  });

  test("mapWebhookEvent: detects refund, chargeback, registration, schedule, risk", () => {
    const refund = ax.mapWebhookEvent({ type: "payment.refund", payment: { result: { code: "000.100.110" } } });
    expect(refund.type).toBe("refund");
    const cb = ax.mapWebhookEvent({ type: "payment.chargeback", payment: { result: { code: "000.200.000" } } });
    expect(cb.type).toBe("chargeback");
    const regC = ax.mapWebhookEvent({ type: "registration.created", registrationId: "REG-Z" });
    expect(regC.type).toBe("registration_created");
    const schC = ax.mapWebhookEvent({ type: "subscription.created", subscription: { id: "SUB-Z" } });
    expect(schC.type).toBe("schedule_created");
    const riskF = ax.mapWebhookEvent({ type: "risk.flagged", risk: { score: 87, reason: "velocity" } });
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
    expect(ax.mapResultCodeToUiMessage("000.100.110").uiMessage).toMatch(/approved/i);
    expect(ax.mapResultCodeToUiMessage("200.300.404").uiMessage).toMatch(/declined/i);
    expect(ax.mapResultCodeToUiMessage("100.396.103").uiMessage).toMatch(/3-D Secure/i);
    expect(ax.mapResultCodeToUiMessage("800.400.200").uiMessage).toMatch(/invalid card/i);
    expect(ax.mapResultCodeToUiMessage("700.100.100").uiMessage).toMatch(/expired|timed/i);
  });

  test("extractRiskSignals / resolveWidgetLanguage / buildRegressionTestPlan", () => {
    const r = ax.extractRiskSignals({ risk: { score: 70, reason: "velocity", rules: ["R1"] } });
    expect(r.score).toBe(70);
    expect(ax.resolveWidgetLanguage("fr")).toBe("fr");
    expect(ax.resolveWidgetLanguage("xx")).toBeNull();
    const plan = ax.buildRegressionTestPlan();
    expect(Array.isArray(plan.cases)).toBe(true);
    expect(plan.env).toBe("test");
  });
});



FRONT END TESTING

1) Vanilla JS – render Copy&Pay widget (server returns ready-made HTML)
<!-- index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Axcess – Widget Checkout</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    .hidden { display: none; } .spinner { margin: 12px 0; }
    .error { color: #b00020; }
  </style>
</head>
<body>
  <main>
    <button id="startCheckoutBtn">Buy Now ($24.99)</button>
    <div id="spinner" class="spinner hidden">Loading…</div>
    <div id="widgetContainer"></div>
    <p id="err" class="error hidden"></p>
    <button id="fallbackRedirectBtn" class="hidden">Open Payment in a New Tab</button>
  </main>

  <script type="module">
    const $ = (sel) => document.querySelector(sel);
    const startBtn = $('#startCheckoutBtn');
    const spinner = $('#spinner');
    const widgetContainer = $('#widgetContainer');
    const err = $('#err');
    const fallbackBtn = $('#fallbackRedirectBtn');

    const show = (el, on = true) => el ? el.classList.toggle('hidden', !on) : null;

    async function startCheckout() {
      try {
        if (!startBtn || !widgetContainer || !spinner || !fallbackBtn) return;
        show(spinner, true);
        startBtn.disabled = true;
        err && (err.textContent = '');

        // Your backend endpoint that calls PaymentGatewayAxcess.createCheckoutSession()
        // and returns { checkoutId, redirectUrl, widgetHtml }  (widgetHtml is optional)
        const res = await fetch('/api/payments/axcess/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId: 'ORD-123', amount: 24.99, currency: 'USD' })
        });
        if (!res.ok) throw new Error('Failed to start checkout');
        const { checkoutId, redirectUrl, widgetHtml } = await res.json();

        // Always set the fallback redirect in case widget script fails to load
        fallbackBtn.dataset.redirectUrl = redirectUrl;
        show(fallbackBtn, true);

        if (!widgetContainer) return;

        // Pattern A: server already built the widget HTML (via axcess.getPaymentWidgetHtml)
        if (widgetHtml) {
          widgetContainer.innerHTML = widgetHtml;
          show(spinner, false);
          return;
        }

        // Pattern B: build the minimal widget on the client (no iframe)
        // 1) Insert Axcess widget script
        const scriptSrc = `https://eu-test.oppwa.com/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(checkoutId)}`;
        const script = document.createElement('script');
        script.src = scriptSrc; script.async = true;

        // 2) Insert the payment form placeholder
        const form = document.createElement('form');
        form.className = 'paymentWidgets';
        form.setAttribute('data-lang', 'en');            // map your app locale -> widget lang as needed
        form.setAttribute('data-brands', 'VISA MASTER'); // customize brands if you like
        form.action = '/payments/axcess/callback';       // your backend will handle the redirect callback

        widgetContainer.innerHTML = ''; // clear existing
        widgetContainer.appendChild(script);
        widgetContainer.appendChild(form);

        // Toggle spinner off when script loads or after a timeout
        script.addEventListener('load', () => show(spinner, false));
        script.addEventListener('error', () => {
          show(spinner, false);
          err && (err.textContent = 'Could not load payment widget. Use the “Open Payment” button below.');
        });

        // Safety timeout (10s) — show fallback hint if widget hasn’t attached UI
        setTimeout(() => {
          const attached = widgetContainer.querySelector('iframe, .wpwl-container, .wpwl-form, input[name="card.number"]');
          if (!attached) {
            show(spinner, false);
            err && (err.textContent = 'Payment form seems delayed. You can open it in a new tab.');
          }
        }, 10000);

      } catch (e) {
        show(spinner, false);
        startBtn && (startBtn.disabled = false);
        err && (err.classList.remove('hidden'), (err.textContent = e.message || 'Something went wrong'));
      }
    }

    startBtn?.addEventListener('click', startCheckout);

    fallbackBtn?.addEventListener('click', () => {
      const url = fallbackBtn?.dataset?.redirectUrl;
      url ? window.open(url, '_blank', 'noopener') : null;
    });
  </script>
</body>
</html>

2) React (functional) – mount widget, cleanup on unmount
import { getBuiltinModule } from "process";
// AxcessWidget.jsx
import { useEffect, useRef, useState } from "react";

export default function AxcessWidget({ orderId, amount, currency = "USD", locale = "en" }) {
  const containerRef = useRef(null);
  const [redirectUrl, setRedirectUrl] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const res = await fetch("/api/payments/axcess/checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId, amount, currency })
        });
        if (!res.ok) throw new Error("Failed to start checkout");
        const { checkoutId, redirectUrl, widgetHtml } = await res.json();
        if (cancelled) return;
        setRedirectUrl(redirectUrl);

        const el = containerRef.current;
        if (!el) return;

        // Render server-provided HTML or build locally
        if (widgetHtml) {
          el.innerHTML = widgetHtml;
          setLoading(false);
          return;
        }

        // Build script + form
        el.innerHTML = "";
        const script = document.createElement("script");
        script.src = `https://eu-test.oppwa.com/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(checkoutId)}`;
        script.async = true;

        const form = document.createElement("form");
        form.className = "paymentWidgets";
        form.setAttribute("data-lang", locale);
        form.setAttribute("data-brands", "VISA MASTER");
        form.action = "/payments/axcess/callback";

        el.appendChild(script);
        el.appendChild(form);
        script.addEventListener("load", () => setLoading(false));
        script.addEventListener("error", () => {
          setLoading(false);
          setErr("Could not load payment widget. Use the fallback button.");
        });
      } catch (e) {
        if (!cancelled) {
          setLoading(false);
          setErr(e.message || "Checkout failed");
        }
      }
    })();

    // Cleanup: remove child nodes (script + form)
    return () => {
      cancelled = true;
      const el = containerRef.current;
      if (el) el.innerHTML = "";
    };
  }, [orderId, amount, currency, locale]);

  return (
    <div>
      {loading ? <div>Loading…</div> : null}
      {err ? <div style={{ color: "#b00020" }}>{err}</div> : null}
      <div ref={containerRef} />
      {redirectUrl ? (
        <button
          type="button"
          onClick={() => window.open(redirectUrl, "_blank", "noopener")}
          style={{ marginTop: 8 }}
        >
          Open Payment in New Tab
        </button>
      ) : null}
    </div>
  );
}

3) Redirect callback page (FE → BE handoff)
// public/thanks.js (optional client-side acknowledgement)
// The Copy&Pay widget posts to /payments/axcess/callback (server).
// After the server verifies resourcePath and records the transaction,
// it can redirect users to /thanks?status=success|failed

(function () {
  const params = new URLSearchParams(window.location.search);
  const status = params.get('status');
  const el = document.getElementById('result');
  if (!el) return;
  el.textContent = status === 'success'
    ? 'Payment successful — access granted.'
    : status === 'failed'
      ? 'Payment failed — please try a different card.'
      : 'Thanks — processing your payment…';
})();

<!-- thanks.html -->
<!doctype html>
<html>
<head><meta charset="utf-8"><title>Thanks</title></head>
<body>
  <h1 id="result">Loading…</h1>
  <script src="/thanks.js"></script>
</body>
</html>

4) Token + S2S flow (frontend → your API; backend uses Axcess S2S)

⚠️ S2S with raw PAN means PCI scope. If you aren’t fully PCI compliant, prefer the widget or a hosted/tokenized input. This snippet shows the client handing card data to your backend over HTTPS; your backend then calls createRegistrationToken and subsequently debitWithRegistrationToken or authorizeWithRegistrationToken.

<!-- minimal-tokenize.html -->
<form id="cardForm" novalidate>
  <input id="cardNumber" autocomplete="cc-number" inputmode="numeric" placeholder="Card number" required />
  <input id="holder" autocomplete="cc-name" placeholder="Name on card" required />
  <input id="expMonth" inputmode="numeric" placeholder="MM" required />
  <input id="expYear" inputmode="numeric" placeholder="YYYY" required />
  <input id="cvv" inputmode="numeric" placeholder="CVV" required />
  <button id="saveCardBtn" type="submit">Save card</button>
</form>
<pre id="out"></pre>
<script>
  const $ = (s) => document.querySelector(s);
  const out = $('#out');
  const f = $('#cardForm');
  f?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const card = {
      number: $('#cardNumber')?.value?.trim(),
      holder: $('#holder')?.value?.trim(),
      expiryMonth: $('#expMonth')?.value?.trim(),
      expiryYear: $('#expYear')?.value?.trim(),
      cvv: $('#cvv')?.value?.trim()
    };
    if (!card.number || !card.holder || !card.expiryMonth || !card.expiryYear || !card.cvv) {
      out && (out.textContent = 'Please fill all fields'); return;
    }
    try {
      // 1) Create registration token
      const tRes = await fetch('/api/payments/axcess/tokens', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card })
      });
      if (!tRes.ok) throw new Error('Tokenization failed');
      const token = await tRes.json(); // { registrationId, brand, expiry, ... }

      // 2) Charge with token
      const pRes = await fetch('/api/payments/axcess/token/charge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registrationId: token.registrationId, amount: 9.99, currency: 'USD' })
      });
      const payment = await pRes.json();
      out && (out.textContent = JSON.stringify({ token, payment }, null, 2));
    } catch (e) {
      out && (out.textContent = e.message || 'Error');
    }
  });
</script>

5) Minimal backend routes (to pair with the FE above)

These are just the thin endpoints your frontend calls. They pass everything to your Axcess adapter which already validates & logs. (Keep them in your API server; not for the browser.)

// api-axcess.routes.js (Express-like pseudo-code)
const express = require('express');
const router = express.Router();
const PaymentGatewayAxcess = require('./payment-gateway-axcess');
const paymentGatewayService = require('./PaymentGatewayService'); // your injected facade
const axcess = new PaymentGatewayAxcess({ paymentGatewayService, config: require('./axcess.config') });

// 1) Start widget checkout
router.post('/payments/axcess/checkout', async (req, res) => {
  try {
    const { orderId, amount, currency, locale = 'en' } = req.body || {};
    const { checkoutId, redirectUrl } = await axcess.createCheckoutSession({ userId: req.user.id, orderId, amount, currency });

    // Option A: return HTML the FE will inject directly:
    const widgetHtml = axcess.getPaymentWidgetHtml({ checkoutId, locale, brands: ['VISA','MASTER'] });

    return res.json({ checkoutId, redirectUrl, widgetHtml });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 2) Widget callback (Copy&Pay posts here with resourcePath)
router.post('/payments/axcess/callback', async (req, res) => {
  try {
    const { resourcePath } = req.body || {};
    const orderId = req.query.orderId || req.body.orderId || 'unknown';
    const out = await axcess.handleRedirectCallback({ resourcePath, orderId, userId: req.user?.id || 'anon' });
    // Redirect the user to a friendly page
    const redirect = `/thanks?status=${encodeURIComponent(out.status.toLowerCase())}`;
    res.redirect(303, redirect);
  } catch (e) {
    res.redirect(303, '/thanks?status=failed');
  }
});

// 3) Tokenization and token charge (S2S)
router.post('/api/payments/axcess/tokens', async (req, res) => {
  try {
    const { card } = req.body || {};
    const token = await axcess.createRegistrationToken({ card, customer: { id: req.user.id } });
    res.json(token);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/payments/axcess/token/charge', async (req, res) => {
  try {
    const { registrationId, amount, currency } = req.body || {};
    const result = await axcess.debitWithRegistrationToken({ registrationId, amount, currency });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;

6) Tiny QA checklist (manual FE testing)
[ ] Widget renders within 3–5s; fallback button appears if not loaded in 10s
[ ] Payment success → redirected to /thanks?status=success
[ ] Decline path → /thanks?status=failed (try a decline test card)
[ ] Language switch: set locale='fr' -> labels change
[ ] Brands filter: only VISA/MASTER shown when configured
[ ] Token flow: create token, then charge with token → success
[ ] Network errors: widget script blocked -> fallback button works



DEVELOPER getBuiltinModuleno stress — i’ll drop the full Axcess Gateway Developer Guide inline so you don’t need to download anything. you can copy-paste this straight into your docs wiki.

Axcess (OPPWA) Gateway – Developer Guide

Adapter: payment-gateway-axcess.js — Copy&Pay widget, Server-to-Server, encrypted webhooks, tokens, subscriptions, reporting. All persistence goes through your injected paymentGatewayService (no direct DB).

Parameter source legend

PORTAL: from Axcess portal (e.g., entityId, webhook secret).

API RESPONSE: returned by Axcess endpoints/webhooks (checkoutId, paymentId, registrationId, subscriptionId).

RUNTIME: from your app (userId, orderId, totals, locale, return URLs).

CONFIG: static integration config (baseUrl, bearerToken, locales, UI).

Global configuration (axcess.config.js)
export default {
  environment: "test",                           // 'test' | 'live'  (CONFIG)
  baseUrl: "https://eu-test.oppwa.com",          // (CONFIG/PORTAL)
  entityId: "YOUR_ENTITY_ID",                    // (PORTAL)
  bearerToken: "YOUR_BEARER_TOKEN",              // (PORTAL)
  webhook: {
    secretKey: "your-256-bit-secret",            // (PORTAL/CONFIG) AES-256-CBC
    ivHeaderName: "x-axcess-iv",
    sigHeaderName: "x-axcess-signature",
    idempotencyStoreTtlHours: 48
  },
  ui: {
    widgetBrands: ["VISA", "MASTER", "AMEX"],    // (CONFIG)
    defaultLocale: "en"
  },
  locales: { en: "en", es: "es", fr: "fr" },     // (CONFIG) app → widget 'lang'
  threeDS: {
    challengeWindowSize: "05",                   // (CONFIG; 3DS docs)
    attemptExemption: false
  },
  session: { checkoutExpiryMinutes: 25 }         // (CONFIG)
};

Official Axcess docs (quick links)

Widget (Copy&Pay): https://axcessms.docs.oppwa.com/integrations/widget

Widget API / Customization / Advanced:
https://axcessms.docs.oppwa.com/integrations/widget/api
https://axcessms.docs.oppwa.com/integrations/widget/customization
https://axcessms.docs.oppwa.com/integrations/widget/advanced-options

Card-on-file: https://axcessms.docs.oppwa.com/tutorials/card-on-file

Webhooks:
https://axcessms.docs.oppwa.com/tutorials/webhooks/configuration
https://axcessms.docs.oppwa.com/tutorials/webhooks/payload
https://axcessms.docs.oppwa.com/tutorials/webhooks/decryption

Server-to-Server: https://axcessms.docs.oppwa.com/integrations/server-to-server
(registrationtokens, networktokens, standalone3DS, standaloneexemption)

Backoffice (refund/void): https://axcessms.docs.oppwa.com/integrations/backoffice

Subscriptions: https://axcessms.docs.oppwa.com/integrations/subscriptions

Reporting – transaction: https://axcessms.docs.oppwa.com/integrations/reporting/transaction

Parameters / Result codes / Workflows / Regression tests:
https://axcessms.docs.oppwa.com/reference/parameters
https://axcessms.docs.oppwa.com/reference/resultCodes
https://axcessms.docs.oppwa.com/reference/workflows
https://axcessms.docs.oppwa.com/reference/regression-testing

Class constructor
// server: payment-gateway-axcess.js
const PaymentGatewayAxcess = require("./payment-gateway-axcess");
const config = require("./axcess.config");
const paymentGatewayService = require("./PaymentGatewayService"); // your facade

const axcess = new PaymentGatewayAxcess({ paymentGatewayService, config });

A) Copy&Pay Widget (no iframe; script widget)

Endpoints:
POST /v1/checkouts (create) → id=checkoutId
Widget script: /v1/paymentWidgets.js?checkoutId={id}
Status: GET {resourcePath}?entityId=...

1) createCheckoutSession({ userId, orderId, amount, currency, paymentType='DB' })

Params: RUNTIME + CONFIG (entityId, bearerToken, baseUrl)

Returns: { checkoutId (API), redirectUrl (composed), sessionId }

Docs: Widget / Widget API

// server
const { checkoutId, redirectUrl, sessionId } = await axcess.createCheckoutSession({
  userId: "U1", orderId: "ORD-1", amount: 24.99, currency: "USD", paymentType: "DB"
});

2) getPaymentWidgetHtml({ checkoutId, locale, brands })

Purpose: Build script+form snippet (insert into DOM).

Docs: Widget / Customization / Advanced

// server
const widgetHtml = axcess.getPaymentWidgetHtml({
  checkoutId, locale: "en", brands: ["VISA","MASTER"]
});

3) handleRedirectCallback({ resourcePath, orderId, userId })

Purpose: Fetch result via resourcePath, normalize & persist, update session, grant/deny.

Returns: { status:'SUCCESS'|'FAILED'|'PENDING', resultCode, payload }

Docs: Widget API (resourcePath)

// server: Express route
app.post("/payments/axcess/callback", async (req, res) => {
  const { resourcePath } = req.body;
  const out = await axcess.handleRedirectCallback({
    resourcePath, orderId: req.query.orderId, userId: req.user.id
  });
  res.redirect(303, `/thanks?status=${out.status.toLowerCase()}`);
});

4) getPaymentStatus(resourcePath)

Returns: raw status { result.code, result.description, id, amount, currency, ... }

Docs: Widget API

B) Server-to-Server (no widget)

Endpoints:
POST /v1/payments (DB/PA), POST /v1/payments/{id} (CP/RV/RF). Include entityId, paymentType.

s2sDebit({ amount, currency, paymentBrand, card, threeDSParams? })

Purpose: Direct purchase (paymentType=DB)

Returns: { normalized, raw }

Docs: S2S, 3DS Parameters

const result = await axcess.s2sDebit({
  amount: 10, currency: "USD", paymentBrand: "VISA",
  card: { number:"4111111111111111", holder:"T", expiryMonth:"12", expiryYear:"2030", cvv:"123" },
  threeDSParams: { merchantTransactionId: "ORD-1" }
});

s2sAuthorize({ ... }) → paymentType=PA
const auth = await axcess.s2sAuthorize({
  amount: 15, currency: "USD", paymentBrand: "VISA",
  card: { number:"4111111111111111", holder:"T", expiryMonth:"12", expiryYear:"2030", cvv:"123" }
});

s2sCapture({ paymentId, amount? }) → paymentType=CP
const cp = await axcess.s2sCapture({ paymentId: "PAY-123", amount: 15 });

s2sVoid({ paymentId }) → paymentType=RV
const rv = await axcess.s2sVoid({ paymentId: "PAY-123" });

s2sRefund({ paymentId, amount? }) → paymentType=RF
const rf = await axcess.s2sRefund({ paymentId: "PAY-123", amount: 5 });

3-D Secure (Standalone) & Exemptions

initiateStandalone3DS({ amount, currency, card, threeDSParams })

continue3DSChallenge({ id, paRes|cres })

requestStandaloneExemption({ amount, currency, paymentBrand, cardOrToken, exemptionType })

// 3DS (standalone)
const init3ds = await axcess.initiateStandalone3DS({
  amount: 12.34, currency: "USD",
  card: { number:"4111111111111111", holder:"T", expiryMonth:"12", expiryYear:"2030", cvv:"123" },
  threeDSParams: { merchantTransactionId: "ORD-3" }
});
const cont = await axcess.continue3DSChallenge({ id: init3ds.id, cres: "CResFromACS" });

// Exemption
const ex = await axcess.requestStandaloneExemption({
  amount: 20, currency: "USD", paymentBrand: "VISA",
  cardOrToken: { registrationId: "REG-1" }, exemptionType: "TRA"
});

C) Card-on-File / Tokens

Endpoints:
POST /v1/registrations (create) → id=registrationId
POST /v1/registrations/{id}/payments (DB/PA)
DELETE /v1/registrations/{id}

createRegistrationToken({ card })

Returns: { registrationId, brand?, expiry? }

Docs: Card-on-file; Widget/S2S registration tokens

const token = await axcess.createRegistrationToken({
  card: { number:"4111111111111111", holder:"T", expiryMonth:"12", expiryYear:"2030", cvv:"123" }
});

debitWithRegistrationToken({ registrationId, amount, currency })
const pay = await axcess.debitWithRegistrationToken({
  registrationId: token.registrationId, amount: 9.99, currency: "USD"
});

authorizeWithRegistrationToken({ registrationId, amount, currency })
const auth = await axcess.authorizeWithRegistrationToken({
  registrationId: token.registrationId, amount: 5.00, currency: "USD"
});

deleteRegistrationToken({ registrationId })
await axcess.deleteRegistrationToken({ registrationId: token.registrationId });


(Utility pass-throughs: listUserTokens(userId), getTokensExpiring(yyyyMm).)

D) Subscriptions

Endpoints:
POST /v1/subscriptions (create) → id
DELETE /v1/subscriptions/{id} (cancel)

createSubscriptionFromToken({ registrationId, amount, currency, interval, startDate?, trial? })
const sub = await axcess.createSubscriptionFromToken({
  registrationId: "REG-1",
  amount: 9.99, currency: "USD",
  interval: "P1M",         // monthly
  startDate: "2025-09-01"  // optional
});

cancelSubscription({ subscriptionId, reason? })
await axcess.cancelSubscription({ subscriptionId: "SUB-1", reason: "user_request" });

pauseSubscription({ subscriptionId, resumeAt }) (policy: cancel-now + resume-instruction)
await axcess.pauseSubscription({ subscriptionId: "SUB-1", resumeAt: "2025-10-01" });

resumeSubscription({ userId, registrationId, recurringShape })
const resumed = await axcess.resumeSubscription({
  userId: "U1",
  registrationId: "REG-1",
  recurringShape: { amount: 9.99, currency: "USD", interval: "P1M", startDate: "2025-10-01" }
});

upgradeSubscription({ subscriptionId, prorationCharge, newRecurring })
await axcess.upgradeSubscription({
  subscriptionId: "SUB-OLD",
  prorationCharge: 2.49,
  newRecurring: { registrationId: "REG-1", amount: 19.99, currency: "USD", interval: "P1M" }
});

downgradeSubscription({ subscriptionId, effectiveAt, newRecurring })
await axcess.downgradeSubscription({
  subscriptionId: "SUB-NEW",
  effectiveAt: "2025-11-01",
  newRecurring: { registrationId: "REG-1", amount: 4.99, currency: "USD", interval: "P1M" }
});

E) Webhooks (encrypted)
decryptAndVerifyWebhook(rawBody, headers)

AES-256-CBC decryption (uses webhook.secretKey + IV header), optional HMAC verification if you pass signature header.

handleWebhook(rawBody, headers)

decrypt → mapWebhookEvent → route to handlers → persist via paymentGatewayService.

mapWebhookEvent(payload)

returns { type, txn?, registration?, schedule?, risk?, raw }

types: payment_success|payment_failed|refund|chargeback|registration_created|registration_updated|schedule_created|schedule_rescheduled|schedule_canceled|risk_flagged|risk_cleared

// server (Express)
app.post("/webhooks/axcess", async (req, res) => {
  try {
    const raw = req.rawBody || JSON.stringify(req.body);
    await axcess.handleWebhook(raw, req.headers);
    res.status(200).end();
  } catch (e) {
    res.status(400).end();
  }
});

F) Reporting & Verification
getTransactionDetails({ transactionId })

GET /v1/payments/{id}?entityId=... and persists verification audit.

const detail = await axcess.getTransactionDetails({ transactionId: "PAY-123" });

findOrderHistory({ orderId })

Convenience pass-through → paymentGatewayService.getOrderHistory(orderId).

G) Errors, Locales & Utilities
mapResultCodeToUiMessage(resultCode)

Friendly UI messages (e.g., "000." → approved, 200.300.* → issuer decline, etc.)

const ui = axcess.mapResultCodeToUiMessage("000.100.110"); // { code, uiMessage: "Payment approved." }

extractRiskSignals(payload)
const risk = axcess.extractRiskSignals({ risk: { score: 80, reason: "velocity" } });

resolveWidgetLanguage(appLocale)
const lang = axcess.resolveWidgetLanguage("fr"); // "fr"

buildRegressionTestPlan()
console.log(axcess.buildRegressionTestPlan());

Front-end usage (quick snippets)
Start checkout → render widget (server returns ready-made HTML)
// client
const res = await fetch('/api/payments/axcess/checkout', {
  method:'POST',
  headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ orderId:'ORD-1', amount:24.99, currency:'USD' })
});
const { checkoutId, redirectUrl, widgetHtml } = await res.json();
document.getElementById('widget').innerHTML = widgetHtml || ''; // validate element exists first

Build widget on the client (if backend doesn’t return HTML)
const script = document.createElement('script');
script.src = `https://eu-test.oppwa.com/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(checkoutId)}`;
script.async = true;

const form = document.createElement('form');
form.className = 'paymentWidgets';
form.setAttribute('data-lang', 'en');
form.setAttribute('data-brands', 'VISA MASTER');
form.action = '/payments/axcess/callback';

const el = document.getElementById('widget');
if (el) { el.innerHTML = ''; el.appendChild(script); el.appendChild(form); }

Redirect callback (server)
// Express route
router.post('/payments/axcess/callback', async (req, res) => {
  try {
    const { resourcePath } = req.body;
    const { status } = await axcess.handleRedirectCallback({
      resourcePath,
      orderId: req.query.orderId,
      userId: req.user.id
    });
    res.redirect(303, `/thanks?status=${encodeURIComponent(status.toLowerCase())}`);
  } catch (e) {
    res.redirect(303, '/thanks?status=failed');
  }
});

Token + S2S (client → your API; backend uses Axcess adapter)
// Client: submit card to your API (PCI implications!)
const tRes = await fetch('/api/payments/axcess/tokens', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ card: { number, holder, expiryMonth, expiryYear, cvv } })
});
const token = await tRes.json();

const pRes = await fetch('/api/payments/axcess/token/charge', {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({ registrationId: token.registrationId, amount: 9.99, currency: 'USD' })
});
const payment = await pRes.json();

Flowcharts (text)
[Widget Purchase]
User clicks Buy
  -> Backend: createCheckoutSession() --(checkoutId)--> FE
  -> FE: load widget script + form with checkoutId
  -> Axcess hosted UI collects card
  -> Axcess redirects/POSTs with resourcePath
  -> Backend: handleRedirectCallback(resourcePath)
      -> getPaymentStatus -> map result -> saveTransaction
      -> grant/deny access
  -> Redirect user to /thanks?status=success|failed

[S2S + Token]
FE posts card to /api/payments/axcess/tokens
  -> Backend: createRegistrationToken(card) -> saveToken
  -> FE: POST /api/payments/axcess/token/charge { registrationId, amount, currency }
  -> Backend: debitWithRegistrationToken() -> saveTransaction -> grant/deny
  -> FE shows result

[Subscription Lifecycle]
createSubscriptionFromToken(regId, price, interval)
  -> active
pauseSubscription(subscriptionId, resumeAt)
  -> cancel now + save resume instruction
resumeSubscription(userId, regId, shape)
  -> create new schedule (active)
upgradeSubscription(subscriptionId, proration, newRecurring)
  -> one-time proration charge + cancel old + create new
downgradeSubscription(subscriptionId, effectiveAt, newRecurring)
  -> save instruction; cron applies at next cycle

Appendix – Parameter sources per method
Method	Key Params	Source
createCheckoutSession	userId, orderId, amount, currency	RUNTIME; entityId/bearer/baseUrl from CONFIG/PORTAL
getPaymentWidgetHtml	checkoutId, locale, brands	API (checkoutId), RUNTIME (locale/brands)
handleRedirectCallback	resourcePath, orderId, userId	API (resourcePath), RUNTIME (order/user)
s2sDebit/Authorize	amount, currency, paymentBrand, card, threeDSParams?	RUNTIME; CONFIG; 3DS per docs
s2sCapture/Void/Refund	paymentId, amount?	API (paymentId), RUNTIME (amount?)
createRegistrationToken	card.*	RUNTIME
debit/authorizeWithRegistrationToken	registrationId, amount, currency	API (regId), RUNTIME
createSubscriptionFromToken	registrationId, amount, currency, interval, startDate?	API (regId), RUNTIME
cancel/pause/resume/upgrade/downgrade	subscriptionId / regId / amounts	API + RUNTIME
decryptAndVerifyWebhook	rawBody, headers	API (encrypted payload), CONFIG (secret)
getTransactionDetails	transactionId	API (id)