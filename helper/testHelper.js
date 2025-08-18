import https from "https";
import { URLSearchParams } from "url";

function testtoFormUrlEncoded(obj) {
  const params = new URLSearchParams();
  for (const key in obj) {
    params.append(key, obj[key]);
  }
  return params.toString();
}

// ---- Make HTTPS request ----
async function testhttpRequest({
  urlString,
  method = "POST",
  bearerToken,
  body,
}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);

    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + (url.search || ""),
      method,
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({
            status: res.statusCode,
            data: JSON.parse(data),
            raw: data,
          });
        } catch {
          resolve({ status: res.statusCode, data: null, raw: data });
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export { testhttpRequest, testtoFormUrlEncoded };
