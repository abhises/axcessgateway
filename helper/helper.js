import http from "http";
import https from "https";
import { DEFAULT_HTTP_TIMEOUT_MS } from "../constants/constant.js";
import { URL } from "url";

function httpRequestWithBearer({
  urlString,
  method = "GET",
  bearerToken,
  headers = {},
  body = null,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
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
          ...headers,
        },
        timeout: timeoutMs,
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
          resolve({
            status,
            data: parsed,
            raw: responseData,
            headers: res.headers,
          });
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

function toFormUrlEncoded(paramsObj = {}) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(paramsObj)) {
    if (v === undefined || v === null) continue;
    search.set(k, String(v));
  }
  return search.toString();
}

export { toFormUrlEncoded, httpRequestWithBearer };
