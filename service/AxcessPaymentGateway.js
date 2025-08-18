import { ErrorHandler, SafeUtils, Logger, ScyllaDb } from "../utils/index.js";
import { URL } from "url";
import crypto from "crypto";
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_CHECKOUT_EXPIRY_MINUTES,
  CONFIG,
} from "../constants/constant.js";
import { toFormUrlEncoded, httpRequestWithBearer } from "../helper/helper.js";
import { testhttpRequest, testtoFormUrlEncoded } from "../helper/testHelper.js";

export default class PaymentGatewayAxcess {
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
      throw new Error(
        "PaymentGatewayAxcess: paymentGatewayService is required"
      );
    }
    this.svc = paymentGatewayService;

    // Validate config eagerly
    const cleaned = SafeUtils.sanitizeValidate({
      environment: {
        value: config?.environment,
        type: "string",
        required: true,
      },
      baseUrl: { value: config?.baseUrl, type: "url", required: true },
      entityId: { value: config?.entityId, type: "string", required: true },
      bearerToken: {
        value: config?.bearerToken,
        type: "string",
        required: true,
      },
      webhook: {
        value: config?.webhook || {},
        type: "object",
        required: false,
        default: {},
      },
      ui: {
        value: config?.ui || {},
        type: "object",
        required: false,
        default: {},
      },
      locales: {
        value: config?.locales || {},
        type: "object",
        required: false,
        default: {},
      },
      threeDS: {
        value: config?.threeDS || {},
        type: "object",
        required: false,
        default: {},
      },
      session: {
        value: config?.session || {},
        type: "object",
        required: false,
        default: {},
      },
    });

    this.environmentLabel = cleaned.environment;
    this.apiBaseUrl = cleaned.baseUrl.replace(/\/+$/, ""); // trim trailing slash
    this.entityId = cleaned.entityId;
    this.apiBearerToken = cleaned.bearerToken;

    this.webhookConfig = {
      secretKey: cleaned.webhook.secretKey || null,
      ivHeaderName: cleaned.webhook.ivHeaderName || "x-axcess-iv",
      sigHeaderName: cleaned.webhook.sigHeaderName || "x-axcess-signature",
      idempotencyStoreTtlHours: Number(
        cleaned.webhook.idempotencyStoreTtlHours || 48
      ),
    };

    this.uiConfig = {
      widgetBrands: Array.isArray(cleaned.ui.widgetBrands)
        ? cleaned.ui.widgetBrands
        : ["VISA", "MASTER"],
      defaultLocale: cleaned.ui.defaultLocale || "en",
    };

    this.localeMap = { ...cleaned.locales };
    this.threeDSDefaults = {
      challengeWindowSize: cleaned.threeDS.challengeWindowSize || "05",
      attemptExemption: !!cleaned.threeDS.attemptExemption,
    };
    this.sessionConfig = {
      checkoutExpiryMinutes: Number(
        cleaned.session.checkoutExpiryMinutes || DEFAULT_CHECKOUT_EXPIRY_MINUTES
      ),
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
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: params.userId, type: "string", required: true },
      orderId: { value: params.orderId, type: "string", required: true },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      paymentType: {
        value: params.paymentType || "DB",
        type: "string",
        required: true,
      },
      customer: {
        value: params.customer || {},
        type: "object",
        required: false,
        default: {},
      },
      metadata: {
        value: params.metadata || {},
        type: "object",
        required: false,
        default: {},
      },
    });

    // Reuse any existing “pending” session within TTL
    const existing =
      (await this.svc.getSessionsBy?.("orderId", cleaned.orderId)) || [];
    const reusable = existing.find((s) => this.isCheckoutSessionValid(s));
    if (reusable) {
      Logger.writeLog({
        flag: "payment",
        action: "Reuse checkout session",
        message: "Using existing pending Axcess checkout session",
        data: {
          sessionId: reusable.id,
          orderId: cleaned.orderId,
          userId: cleaned.userId,
        },
      });
      return {
        checkoutId: reusable.checkoutId,
        redirectUrl: `${this.apiBaseUrl}/v1/checkouts/${encodeURIComponent(
          reusable.checkoutId
        )}/payment`,
        sessionId: reusable.id,
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
      merchantTransactionId: cleaned.orderId,
    };
    const body = toFormUrlEncoded(bodyParams);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    // console.log("res", res);

    if (res.status < 200 || res.status >= 300 || !res.data?.id) {
      ErrorHandler.add_error("Axcess create checkout failed", {
        status: res.status,
        data: res.raw,
      });
      throw new Error("Failed to create Axcess checkout session");
    }

    const checkoutId = res.data.id;
    const redirectUrl = `${this.apiBaseUrl}/v1/checkouts/${encodeURIComponent(
      checkoutId
    )}/payment`;

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
      createdAt: Date.now(),
    };

    await this.svc.saveSession?.(sessionRecord);

    Logger.writeLog({
      flag: "payment",
      action: "Create checkout session",
      message: "Axcess checkout created",
      data: {
        checkoutId,
        sessionId: sessionRecord.id,
        orderId: cleaned.orderId,
      },
    });

    return { checkoutId, redirectUrl, sessionId: sessionRecord.id };
  }

  /**
   * Check if a checkout session is still valid (“pending” and within configured TTL).
   * @param {object} session - session record
   * @returns {boolean}
   */
  isCheckoutSessionValid(session) {
    if (!session || session.status !== "pending" || !session.createdAt)
      return false;
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
    const cleaned = SafeUtils.sanitizeValidate({
      by: { value: params.by, type: "string", required: true },
      value: { value: params.value, type: "string", required: true },
    });
    const sessions =
      (await this.svc.getSessionsBy?.(cleaned.by, cleaned.value)) || [];
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
    const cleaned = SafeUtils.sanitizeValidate({
      checkoutId: { value: params.checkoutId, type: "string", required: true },
      locale: {
        value: params.locale || this.uiConfig.defaultLocale,
        type: "string",
        required: true,
      },
      brands: {
        value: params.brands || this.uiConfig.widgetBrands,
        type: "array",
        required: false,
        default: this.uiConfig.widgetBrands,
      },
    });

    const widgetLang =
      this.resolveWidgetLanguage(cleaned.locale) || this.uiConfig.defaultLocale;
    const brandsParam =
      Array.isArray(cleaned.brands) && cleaned.brands.length
        ? `data-brands="${cleaned.brands.join(" ")}"`
        : "";

    // The actual DOM insertion is up to the caller; we return a string.
    // IMPORTANT: Copy&Pay is script-based; not an <iframe>.
    return [
      `<script src="${
        this.apiBaseUrl
      }/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(
        cleaned.checkoutId
      )}" async></script>`,
      `<form action="/payments/axcess/callback" class="paymentWidgets" data-lang="${widgetLang}" ${brandsParam}></form>`,
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
    const cleaned = SafeUtils.sanitizeValidate({
      resourcePath: {
        value: params.resourcePath,
        type: "string",
        required: true,
      },
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
      status: normalized.approved
        ? "success"
        : normalized.pending
        ? "pending"
        : "failed",
      code: normalized.resultCode || null,
      uiMessage: this.mapResultCodeToUiMessage(normalized.resultCode).uiMessage,
      raw: statusRes.data,
      createdAt: Date.now(),
    };
    await this.svc.saveTransaction?.(txn);

    // Entitlements
    if (txn.status === "success") {
      await this.svc.grantAccess?.({ txn });
    } else if (txn.status === "failed") {
      await this.svc.denyAccess?.({ txn });
    }

    // Update session if any (by orderId)
    const sessions =
      (await this.svc.getSessionsBy?.("orderId", cleaned.orderId)) || [];
    for (const s of sessions) {
      if (s.checkoutId && normalized.id && s.status === "pending") {
        await this.svc.saveSession?.({
          ...s,
          status: txn.status,
          updatedAt: Date.now(),
        });
      }
    }

    return {
      status: txn.status.toUpperCase(),
      resultCode: normalized.resultCode || "",
      payload: statusRes.data,
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
    const cleaned = SafeUtils.sanitizeValidate({
      resourcePath: { value: resourcePath, type: "string", required: true },
    });

    const url = new URL(this.apiBaseUrl + cleaned.resourcePath);
    url.searchParams.set("entityId", this.entityId);

    const res = await httpRequestWithBearer({
      urlString: url.toString(),
      method: "GET",
      bearerToken: this.apiBearerToken,
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error("Axcess getPaymentStatus failed", {
        status: res.status,
        raw: res.raw,
      });
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
    const cleaned = SafeUtils.sanitizeValidate({
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      paymentBrand: {
        value: params.paymentBrand,
        type: "string",
        required: true,
      },
      card: { value: params.card, type: "object", required: true },
      customer: {
        value: params.customer || {},
        type: "object",
        required: false,
        default: {},
      },
      threeDSParams: {
        value: params.threeDSParams || {},
        type: "object",
        required: false,
        default: {},
      },
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
      body,
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
    const cleaned = SafeUtils.sanitizeValidate({
      paymentId: { value: params.paymentId, type: "string", required: true },
      amount: { value: params.amount, type: "float", required: false },
    });

    const endpoint = `${this.apiBaseUrl}/v1/payments/${encodeURIComponent(
      cleaned.paymentId
    )}`;
    const bodyParams = {
      entityId: this.entityId,
      paymentType: "CP",
      ...(cleaned.amount ? { amount: cleaned.amount } : {}),
    };
    const body = toFormUrlEncoded(bodyParams);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
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
    const cleaned = SafeUtils.sanitizeValidate({
      paymentId: { value: params.paymentId, type: "string", required: true },
    });

    const endpoint = `${this.apiBaseUrl}/v1/payments/${encodeURIComponent(
      cleaned.paymentId
    )}`;
    const body = toFormUrlEncoded({
      entityId: this.entityId,
      paymentType: "RV",
    });

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
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
    const cleaned = SafeUtils.sanitizeValidate({
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      paymentBrand: {
        value: params.paymentBrand,
        type: "string",
        required: true,
      },
      card: { value: params.card, type: "object", required: true },
      customer: {
        value: params.customer || {},
        type: "object",
        required: false,
        default: {},
      },
      threeDSParams: {
        value: params.threeDSParams || {},
        type: "object",
        required: false,
        default: {},
      },
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
      body,
    });
    // console.log("s2sDebit res", res);
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
    const cleaned = SafeUtils.sanitizeValidate({
      paymentId: { value: params.paymentId, type: "string", required: true },
      amount: { value: params.amount, type: "float", required: false },
    });

    const endpoint = `${this.apiBaseUrl}/v1/payments/${encodeURIComponent(
      cleaned.paymentId
    )}`;
    const bodyParams = {
      entityId: this.entityId,
      paymentType: "RF",
      ...(cleaned.amount ? { amount: cleaned.amount } : {}),
    };
    const body = toFormUrlEncoded(bodyParams);

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
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
    const cleaned = SafeUtils.sanitizeValidate({
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      card: { value: params.card, type: "object", required: true },
      customer: {
        value: params.customer || {},
        type: "object",
        required: false,
        default: {},
      },
      threeDSParams: {
        value: params.threeDSParams || {},
        type: "object",
        required: true,
      },
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
      body,
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error("Axcess initiateStandalone3DS failed", {
        status: res.status,
        raw: res.raw,
      });
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
    const cleaned = SafeUtils.sanitizeValidate({
      id: { value: params.id, type: "string", required: true },
      paRes: { value: params.paRes, type: "string", required: false },
      cres: { value: params.cres, type: "string", required: false },
    });
    const endpoint = `${this.apiBaseUrl}/v1/threeDSecure/${encodeURIComponent(
      cleaned.id
    )}`;
    const body = toFormUrlEncoded({
      entityId: this.entityId,
      ...(cleaned.paRes ? { paRes: cleaned.paRes } : {}),
      ...(cleaned.cres ? { cres: cleaned.cres } : {}),
    });

    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error("Axcess continue3DSChallenge failed", {
        status: res.status,
        raw: res.raw,
      });
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
    const cleaned = SafeUtils.sanitizeValidate({
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      paymentBrand: {
        value: params.paymentBrand,
        type: "string",
        required: true,
      },
      cardOrToken: {
        value: params.cardOrToken,
        type: "object",
        required: true,
      },
      exemptionType: {
        value: params.exemptionType,
        type: "string",
        required: true,
      },
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
      body: toFormUrlEncoded(bodyParams),
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error("Axcess requestStandaloneExemption failed", {
        status: res.status,
        raw: res.raw,
      });
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
  async createRegistrationToken(cardWrapper) {
    const card = cardWrapper.card; // extract inner object
    console.log("card", card);
    const bodyParams = {
      entityId: CONFIG.ENTITY_ID,
      "card.number": card.number,
      "card.holder": card.holder,
      "card.expiryMonth": card.expiryMonth,
      "card.expiryYear": card.expiryYear,
      "card.cvv": card.cvv,
      paymentBrand: "VISA", // explicitly add this
    };
    console.log("bodyParams", bodyParams);

    const url = `${CONFIG.API_BASE}/v1/registrations`;
    const res = await testhttpRequest({
      urlString: url,
      method: "POST",
      bearerToken: CONFIG.BEARER_TOKEN,
      body: testtoFormUrlEncoded(bodyParams),
    });
    console.log(res);

    return res;
  }
  // async createRegistrationToken(params = {}) {
  //   const cleaned = SafeUtils.sanitizeValidate({
  //     card: { value: params.card, type: "object", required: true },
  //     customer: {
  //       value: params.customer || {},
  //       type: "object",
  //       required: false,
  //       default: {},
  //     },
  //   });

  //   const endpoint = `${this.apiBaseUrl}/v1/registrations`;
  //   const bodyParams = {
  //     entityId: this.entityId,
  //     "card.number": cleaned.card.number,
  //     "card.holder": cleaned.card.holder,
  //     "card.expiryMonth": cleaned.card.expiryMonth,
  //     "card.expiryYear": cleaned.card.expiryYear,
  //     "card.cvv": cleaned.card.cvv,
  //   };
  //   // console.log("createRegistrationToken bodyParams", bodyParams);
  //   const res = await httpRequestWithBearer({
  //     urlString: endpoint,
  //     method: "POST",
  //     bearerToken: this.apiBearerToken,
  //     headers: { "Content-Type": "application/x-www-form-urlencoded" },
  //     body: toFormUrlEncoded(bodyParams),
  //   });

  //   console.log("createRegistrationToken res", res);

  //   if (res.status < 200 || res.status >= 300 || !res.data?.id) {
  //     ErrorHandler.add_error("Axcess createRegistrationToken failed", {
  //       status: res.status,
  //       raw: res.raw,
  //     });
  //     throw new Error("Failed to create registration token");
  //   }

  //   const tokenRecord = {
  //     id: res.data.id,
  //     gateway: "axcess",
  //     last4: res.data.card?.bin ? undefined : res.data.card?.last4 || null,
  //     brand: res.data.paymentBrand || null,
  //     expiry:
  //       res.data.card?.expiryMonth && res.data.card?.expiryYear
  //         ? `${res.data.card.expiryYear}-${res.data.card.expiryMonth}`
  //         : null,
  //     createdAt: Date.now(),
  //   };
  //   await this.svc.saveToken?.(tokenRecord);

  //   return {
  //     registrationId: res.data.id,
  //     maskedPan: res.data.card?.bin
  //       ? `${res.data.card.bin}******${res.data.card?.last4 || ""}`
  //       : undefined,
  //     brand: res.data.paymentBrand || undefined,
  //     expiry: tokenRecord.expiry || undefined,
  //   };
  // }

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
    const cleaned = SafeUtils.sanitizeValidate({
      registrationId: {
        value: params.registrationId,
        type: "string",
        required: true,
      },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      threeDSParams: {
        value: params.threeDSParams || {},
        type: "object",
        required: false,
        default: {},
      },
    });
    const endpoint = `${this.apiBaseUrl}/v1/registrations/${encodeURIComponent(
      cleaned.registrationId
    )}/payments`;
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
      body: toFormUrlEncoded(bodyParams),
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
    const cleaned = SafeUtils.sanitizeValidate({
      registrationId: {
        value: params.registrationId,
        type: "string",
        required: true,
      },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      threeDSParams: {
        value: params.threeDSParams || {},
        type: "object",
        required: false,
        default: {},
      },
    });
    const endpoint = `${this.apiBaseUrl}/v1/registrations/${encodeURIComponent(
      cleaned.registrationId
    )}/payments`;
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
      body: toFormUrlEncoded(bodyParams),
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
    const cleaned = SafeUtils.sanitizeValidate({
      registrationId: {
        value: params.registrationId,
        type: "string",
        required: true,
      },
    });
    const endpoint = `${this.apiBaseUrl}/v1/registrations/${encodeURIComponent(
      cleaned.registrationId
    )}?entityId=${encodeURIComponent(this.entityId)}`;
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "DELETE",
      bearerToken: this.apiBearerToken,
    });
    if (res.status >= 200 && res.status < 300) {
      await this.svc.deleteToken?.(cleaned.registrationId);
      return true;
    }
    ErrorHandler.add_error("Axcess deleteRegistrationToken failed", {
      status: res.status,
      raw: res.raw,
    });
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
    const cleaned = SafeUtils.sanitizeValidate({
      registrationId: {
        value: params.registrationId,
        type: "string",
        required: true,
      },
      amount: { value: params.amount, type: "float", required: true },
      currency: { value: params.currency, type: "string", required: true },
      interval: { value: params.interval, type: "string", required: true },
      startDate: { value: params.startDate, type: "string", required: false },
      trial: {
        value: params.trial || {},
        type: "object",
        required: false,
        default: {},
      },
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
      ...(cleaned.trial?.lengthDays
        ? { trialLengthDays: cleaned.trial.lengthDays }
        : {}),
    };
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "POST",
      bearerToken: this.apiBearerToken,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: toFormUrlEncoded(bodyParams),
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error("Axcess createSubscriptionFromToken failed", {
        status: res.status,
        raw: res.raw,
      });
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
      createdAt: Date.now(),
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
    const cleaned = SafeUtils.sanitizeValidate({
      subscriptionId: {
        value: params.subscriptionId,
        type: "string",
        required: true,
      },
      reason: { value: params.reason, type: "string", required: false },
    });

    const endpoint = `${this.apiBaseUrl}/v1/subscriptions/${encodeURIComponent(
      cleaned.subscriptionId
    )}?entityId=${encodeURIComponent(this.entityId)}`;
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "DELETE",
      bearerToken: this.apiBearerToken,
    });
    if (res.status >= 200 && res.status < 300) {
      await this.svc.upsertSchedule?.({
        scheduleId: cleaned.subscriptionId,
        status: "canceled",
        updatedAt: Date.now(),
        reason: cleaned.reason || null,
      });
      return { status: "canceled" };
    }
    ErrorHandler.add_error("Axcess cancelSubscription failed", {
      status: res.status,
      raw: res.raw,
    });
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
    const cleaned = SafeUtils.sanitizeValidate({
      subscriptionId: {
        value: params.subscriptionId,
        type: "string",
        required: true,
      },
      resumeAt: { value: params.resumeAt, type: "string", required: true },
    });
    await this.cancelSubscription({
      subscriptionId: cleaned.subscriptionId,
      reason: "pause",
    });
    await this.svc.saveResumeInstruction?.({
      subscriptionId: cleaned.subscriptionId,
      resumeAt: cleaned.resumeAt,
    });
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
    const cleaned = SafeUtils.sanitizeValidate({
      userId: { value: params.userId, type: "string", required: true },
      registrationId: {
        value: params.registrationId,
        type: "string",
        required: true,
      },
      recurringShape: {
        value: params.recurringShape,
        type: "object",
        required: true,
      },
    });
    const res = await this.createSubscriptionFromToken({
      registrationId: cleaned.registrationId,
      amount: cleaned.recurringShape.amount,
      currency: cleaned.recurringShape.currency,
      interval: cleaned.recurringShape.interval,
      startDate: cleaned.recurringShape.startDate || null,
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
    const cleaned = SafeUtils.sanitizeValidate({
      subscriptionId: {
        value: params.subscriptionId,
        type: "string",
        required: true,
      },
      prorationCharge: {
        value: params.prorationCharge,
        type: "float",
        required: true,
      },
      newRecurring: {
        value: params.newRecurring,
        type: "object",
        required: true,
      },
    });

    // Charge proration immediately (token required)
    if (!cleaned.newRecurring.registrationId) {
      throw new Error(
        "upgradeSubscription requires newRecurring.registrationId for proration charge"
      );
    }
    await this.debitWithRegistrationToken({
      registrationId: cleaned.newRecurring.registrationId,
      amount: cleaned.prorationCharge,
      currency: cleaned.newRecurring.currency,
    });

    // Cancel current schedule; create new one
    await this.cancelSubscription({
      subscriptionId: cleaned.subscriptionId,
      reason: "upgrade",
    });
    const newSchedule = await this.createSubscriptionFromToken({
      registrationId: cleaned.newRecurring.registrationId,
      amount: cleaned.newRecurring.amount,
      currency: cleaned.newRecurring.currency,
      interval: cleaned.newRecurring.interval,
      startDate: cleaned.newRecurring.startDate || null,
    });

    return {
      status: "upgrade_scheduled",
      scheduleId: newSchedule.scheduleId || null,
    };
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
    const cleaned = SafeUtils.sanitizeValidate({
      subscriptionId: {
        value: params.subscriptionId,
        type: "string",
        required: true,
      },
      effectiveAt: {
        value: params.effectiveAt,
        type: "string",
        required: true,
      },
      newRecurring: {
        value: params.newRecurring,
        type: "object",
        required: true,
      },
    });

    await this.svc.saveDowngradeInstruction?.({
      subscriptionId: cleaned.subscriptionId,
      effectiveAt: cleaned.effectiveAt,
      newRecurring: cleaned.newRecurring,
      status: "pending",
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
      const ivBase64 =
        headers[this.webhookConfig.ivHeaderName] ||
        headers[this.webhookConfig.ivHeaderName.toLowerCase()];
      const signature =
        headers[this.webhookConfig.sigHeaderName] ||
        headers[this.webhookConfig.sigHeaderName.toLowerCase()];
      const iv = ivBase64 ? Buffer.from(String(ivBase64), "base64") : null;

      // Decrypt AES-256-CBC: ciphertext is base64 in body; alternatively, rawBody may already be decrypted JSON.
      let plaintext = null;
      const bodyStr = Buffer.isBuffer(rawBody)
        ? rawBody.toString("utf8")
        : String(rawBody || "");
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
        const decrypted = Buffer.concat([
          decipher.update(cipherBuf),
          decipher.final(),
        ]);
        plaintext = decrypted.toString("utf8");
      }

      // Optional HMAC verification (if you configure to use HMAC-SHA256)
      let verified = true;
      if (signature) {
        const key = this._coerceKeyTo32Bytes(this.webhookConfig.secretKey);
        const h = crypto
          .createHmac("sha256", key)
          .update(plaintext)
          .digest("hex");
        verified = crypto.timingSafeEqual(
          Buffer.from(h, "hex"),
          Buffer.from(signature.replace(/^0x/, ""), "hex")
        );
      }

      const decryptedJson = JSON.parse(plaintext);
      const idempotencyKey =
        decryptedJson?.id ||
        decryptedJson?.eventId ||
        decryptedJson?.payloadId ||
        null;

      return { decryptedJson, idempotencyKey, verified };
    } catch (e) {
      ErrorHandler.add_error("Axcess webhook decrypt/verify failed", {
        error: e.message,
      });
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
    const { decryptedJson, idempotencyKey, verified } =
      this.decryptAndVerifyWebhook(rawBody, headers);

    // Optional: use your service to dedupe based on idempotency key
    await this.svc.saveWebhook?.({
      payload: decryptedJson,
      event: null,
      createdAt: Date.now(),
      verified,
      idempotencyKey,
    });

    const event = this.mapWebhookEvent(decryptedJson);

    try {
      switch (event.type) {
        case "payment_success":
          await this.onPaymentSuccess(event);
          break;
        case "payment_failed":
          await this.onPaymentFailed(event);
          break;
        case "refund":
          await this.onRefund(event);
          break;
        case "chargeback":
          await this.onChargeback(event);
          break;
        case "registration_created":
          await this.onRegistrationCreated(event);
          break;
        case "registration_updated":
          await this.onRegistrationUpdated(event);
          break;
        case "schedule_created":
        case "schedule_rescheduled":
        case "schedule_canceled":
          await this.onScheduleEvent(event);
          break;
        case "risk_flagged":
        case "risk_cleared":
          await this.onRiskEvent(event);
          break;
        default:
          Logger.writeLog({
            flag: "webhook",
            action: "Axcess webhook unmapped",
            message: "Unknown/ignored webhook event",
            data: {
              sample: decryptedJson?.type || decryptedJson?.eventType || null,
            },
          });
      }

      return { ok: true };
    } catch (e) {
      ErrorHandler.add_error("Axcess handleWebhook routing failed", {
        error: e.message,
        payload: decryptedJson,
      });
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
      pending: String(txn.result?.description || "")
        .toLowerCase()
        .includes("pending"),
      createdAt: Date.now(),
    };

    // Registration (token) info
    const registrationId = payload.registrationId || txn.registrationId || null;

    // Schedule (subscription) info
    const schedule = payload.schedule || payload.subscription || null;

    // Risk signals
    const risk = this.extractRiskSignals(payload);

    if (t.includes("payment") && normalizedTxn.approved) {
      return {
        type: "payment_success",
        txn: normalizedTxn,
        registration: registrationId ? { registrationId } : null,
        raw: payload,
      };
    }
    if (
      t.includes("payment") &&
      !normalizedTxn.approved &&
      !normalizedTxn.pending
    ) {
      return { type: "payment_failed", txn: normalizedTxn, raw: payload };
    }
    if (t.includes("refund")) {
      return { type: "refund", txn: normalizedTxn, raw: payload };
    }
    if (t.includes("chargeback")) {
      return { type: "chargeback", txn: normalizedTxn, raw: payload };
    }
    if (t.includes("registration") && t.includes("create")) {
      return {
        type: "registration_created",
        registration: { registrationId },
        raw: payload,
      };
    }
    if (
      t.includes("registration") &&
      (t.includes("update") || t.includes("upgrade"))
    ) {
      return {
        type: "registration_updated",
        registration: { registrationId },
        raw: payload,
      };
    }
    if (t.includes("schedule") || t.includes("subscription")) {
      if (t.includes("cancel"))
        return { type: "schedule_canceled", schedule, raw: payload };
      if (t.includes("reschedul"))
        return { type: "schedule_rescheduled", schedule, raw: payload };
      return { type: "schedule_created", schedule, raw: payload };
    }
    if (t.includes("risk")) {
      if (t.includes("flag"))
        return { type: "risk_flagged", risk, raw: payload };
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
    await this.svc.saveTransaction?.({
      ...event.txn,
      status: "success",
      uiMessage: ui.uiMessage,
    });
    if (event.registration?.registrationId) {
      await this.svc.saveToken?.({
        id: event.registration.registrationId,
        gateway: "axcess",
        createdAt: Date.now(),
      });
    }
    await this.svc.grantAccess?.({ event });
  }

  /**
   * Persist failed txn, deny access.
   * @param {object} event
   */
  async onPaymentFailed(event) {
    const ui = this.mapResultCodeToUiMessage(event.txn.resultCode);
    await this.svc.saveTransaction?.({
      ...event.txn,
      status: "failed",
      uiMessage: ui.uiMessage,
    });
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
      await this.svc.saveToken?.({
        id: event.registration.registrationId,
        gateway: "axcess",
        createdAt: Date.now(),
      });
    }
  }
  async onRegistrationUpdated(event) {
    if (event.registration?.registrationId) {
      await this.svc.updateToken?.({
        id: event.registration.registrationId,
        gateway: "axcess",
        updatedAt: Date.now(),
      });
    }
  }

  /**
   * Schedule events.
   * @param {object} event
   */
  async onScheduleEvent(event) {
    const status =
      event.type === "schedule_canceled"
        ? "canceled"
        : event.type === "schedule_rescheduled"
        ? "rescheduled"
        : "active";
    await this.svc.upsertSchedule?.({
      ...(event.schedule || {}),
      status,
      updatedAt: Date.now(),
    });
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
      data: { risk: event.risk },
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
    const cleaned = SafeUtils.sanitizeValidate({
      transactionId: {
        value: params.transactionId,
        type: "string",
        required: true,
      },
    });
    const endpoint = `${this.apiBaseUrl}/v1/payments/${encodeURIComponent(
      cleaned.transactionId
    )}?entityId=${encodeURIComponent(this.entityId)}`;
    const res = await httpRequestWithBearer({
      urlString: endpoint,
      method: "GET",
      bearerToken: this.apiBearerToken,
    });

    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error("Axcess getTransactionDetails failed", {
        status: res.status,
        raw: res.raw,
      });
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
    if (code.startsWith("200.300."))
      return M("Payment declined by the issuer.");
    if (code.startsWith("100.396."))
      return M("3-D Secure authentication failed or was canceled.");
    if (code.startsWith("800.400."))
      return M("Invalid card data. Please check the number and expiry.");
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
      rules: Array.isArray(riskObj.rules) ? riskObj.rules : undefined,
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
        "Risk: flagged/cleared",
      ],
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
    if (
      !flat["threeDSecure.challengeWindowSize"] &&
      this.threeDSDefaults.challengeWindowSize
    ) {
      flat["threeDSecure.challengeWindowSize"] =
        this.threeDSDefaults.challengeWindowSize;
    }
    return flat;
  }

  _normalizePaymentResult(data = {}) {
    // Normalize standard fields from Copy&Pay / S2S responses
    const amount = Number(data.amount || data.card?.amount || 0);
    const currency = data.currency || data.card?.currency || null;
    const id = data.id || data.ndc || data.paymentId || null;
    const resultCode = data.result?.code || data.resultCode || null;
    const description =
      data.result?.description || data.resultDescription || "";
    const approved = String(resultCode || "").startsWith("000.");
    const pending = /pending/i.test(description);
    return { id, amount, currency, resultCode, description, approved, pending };
  }

  async _handleS2SResponse(res, label) {
    if (res.status < 200 || res.status >= 300) {
      ErrorHandler.add_error(`Axcess S2S ${label} HTTP error`, {
        status: res.status,
        raw: res.raw,
      });
      throw new Error(`Axcess S2S ${label} failed (HTTP ${res.status})`);
    }
    const normalized = this._normalizePaymentResult(res.data || {});
    const record = {
      gateway: "axcess",
      type: `s2s_${label}`,
      gatewayTxnId: normalized.id || null,
      amount: normalized.amount || null,
      currency: normalized.currency || null,
      status: normalized.approved
        ? "success"
        : normalized.pending
        ? "pending"
        : "failed",
      code: normalized.resultCode || null,
      uiMessage: this.mapResultCodeToUiMessage(normalized.resultCode).uiMessage,
      raw: res.data || {},
      createdAt: Date.now(),
    };
    const results = await this.svc.saveTransaction?.(record);
    console.log("Transaction save results:", results);
    if (record.status === "success")
      await this.svc.grantAccess?.({ txn: record });
    if (record.status === "failed")
      await this.svc.denyAccess?.({ txn: record });
    return { normalized, raw: res.data || {} };
  }
}
