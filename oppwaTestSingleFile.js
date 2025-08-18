// oppwaTestSingleFile.js
import fetch from "node-fetch"; // npm i node-fetch@3

(async () => {
  const CONFIG = {
    AUTH_INPUT:
      "Authorization:Bearer OGFjN2E0Yzc5M2FlOGZhYTAxOTNhZmUzZjEwYzAyOTl8P05nSzVwPzllPz10eFRNZVd3V0hgf0",
    ENTITY_ID: "8ac7a4c793ae8faa0193afe46836029d",
    AMOUNT: "10.00",
    CURRENCY: "EUR",
    TEST_MODE: "EXTERNAL",
    API_BASE: "https://eu-test.oppwa.com",
  };

  const log = (...a) => console.log("[OPPWA]", ...a);
  const warn = (...a) => console.warn("[OPPWA]", ...a);
  const err = (...a) => console.error("[OPPWA]", ...a);

  // Normalize token
  const token = (() => {
    const s = CONFIG.AUTH_INPUT.trim();
    if (/^Authorization\s*:/i.test(s)) {
      const m = s.match(/Authorization\s*:\s*Bearer\s+(.+)$/i);
      return m ? m[1].trim() : "";
    }
    if (/^Bearer\s+/i.test(s)) return s.replace(/^Bearer\s+/i, "").trim();
    return s;
  })();

  if (!token) {
    err("Missing token. Set AUTH_INPUT.");
    return;
  }

  // Step 1: Create checkout
  const body = new URLSearchParams();
  body.set("entityId", CONFIG.ENTITY_ID);
  body.set("amount", CONFIG.AMOUNT);
  body.set("currency", CONFIG.CURRENCY);
  body.set("paymentType", "DB");
  body.set("testMode", CONFIG.TEST_MODE);

  log("Creating checkout…", {
    entityId: CONFIG.ENTITY_ID,
    amount: CONFIG.AMOUNT,
    currency: CONFIG.CURRENCY,
  });

  let checkoutId = "";
  try {
    const res = await fetch(`${CONFIG.API_BASE}/v1/checkouts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
      },
      body: body.toString(),
    });

    const text = await res.text();
    const json = JSON.parse(text);

    if (!res.ok)
      throw new Error(`${res.status}: ${json.result?.description || text}`);

    checkoutId = json.id;
    if (!checkoutId) throw new Error("No checkoutId returned.");
    log("✔ checkoutId:", checkoutId);
  } catch (e) {
    err("Checkout creation failed:", e.message || e);
    return;
  }

  // Step 2: Fetch widget JS
  const widgetUrl = `${
    CONFIG.API_BASE
  }/v1/paymentWidgets.js?checkoutId=${encodeURIComponent(checkoutId)}`;
  log("Widget URL:", widgetUrl);

  let widgetText = "";
  try {
    const res = await fetch(widgetUrl);
    if (!res.ok)
      throw new Error(`Widget fetch failed: ${res.status} ${res.statusText}`);
    widgetText = await res.text();
    log(
      `Widget JS head (first 200 chars):\n${widgetText.slice(0, 200)}${
        widgetText.length > 200 ? " …" : ""
      }`
    );
  } catch (e) {
    err("Widget fetch failed:", e.message || e);
    return;
  }

  // Return / log everything
  const result = {
    checkoutId,
    widgetUrl,
    widgetHead: widgetText.slice(0, 200),
  };
  log("Final result:", result);

  return result;
})();
