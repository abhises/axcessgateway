// import https from "https";
// async function createRegistration() {
//   const data = new URLSearchParams({
//     entityId: "8a8294184e736012014e78c4c4cb17dc", // replace with your entityId
//     paymentBrand: "VISA", // or MASTER, AMEX etc.
//     "card.number": "4111111111111111", // test card
//     "card.holder": "Jane Jones",
//     "card.expiryMonth": "12",
//     "card.expiryYear": "2034",
//     "card.cvv": "123",
//   }).toString();

//   const options = {
//     host: "eu-test.oppwa.com",
//     path: "/v1/registrations",
//     method: "POST",
//     headers: {
//       Authorization:
//         "Bearer OGE4Mjk0MTg0ZTczNjAxMjAxNGU3OGM0YzRlNDE3ZTB8NHRKQ21qMkJ0Mw==", // replace with your real token
//       "Content-Type": "application/x-www-form-urlencoded",
//       "Content-Length": Buffer.byteLength(data),
//     },
//   };

//   return new Promise((resolve, reject) => {
//     const req = https.request(options, (res) => {
//       let body = "";
//       res.on("data", (chunk) => (body += chunk));
//       res.on("end", () => {
//         try {
//           resolve(JSON.parse(body));
//         } catch (err) {
//           reject(err);
//         }
//       });
//     });

//     req.on("error", reject);
//     req.write(data);
//     req.end();
//   });
// }

// // test run
// createRegistration()
//   .then((res) => console.log("✅ Response:", res))
//   .catch((err) => console.error("❌ Error:", err));

// import fetch from "node-fetch";
// const CONFIG = {
//   API_BASE: "https://eu-test.oppwa.com",
//   ENTITY_ID: "8ac7a4c793ae8faa0193afe46836029d",
//   BEARER_TOKEN:
//     "Bearer OGFjN2E0Yzc5M2FlOGZhYTAxOTNhZmUzZjEwYzAyOTl8P05nSzVwPzllPz10eFRNZVd3V0hgf0", // replace with your real token
// };

// async function createRegistrationToken(card) {
//   const body = new URLSearchParams({
//     entityId: CONFIG.ENTITY_ID,
//     "card.number": card.number,
//     "card.holder": card.holder,
//     "card.expiryMonth": card.expiryMonth,
//     "card.expiryYear": card.expiryYear,
//     "card.cvv": card.cvv,
//   });

//   const res = await fetch(`${CONFIG.API_BASE}/v1/registrations`, {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/x-www-form-urlencoded",
//       Authorization: `Bearer ${CONFIG.BEARER_TOKEN}`,
//     },
//     body: body.toString(),
//   });

//   const json = await res.json();
//   console.log("createRegistrationToken res", json);
//   return json;
// }

// // Example:
// createRegistrationToken({
//   number: "4111111111111111",
//   holder: "Test User",
//   expiryMonth: "12",
//   expiryYear: "2030",
//   cvv: "123",
// });

// import https from "https";
// import { URLSearchParams } from "url";

// const API_BASE = "https://eu-test.oppwa.com";
// const ENTITY_ID = "8ac7a4c793ae8faa0193afe46836029d";
// const BEARER_TOKEN =
//   "Bearer OGFjN2E0Yzc5M2FlOGZhYTAxOTNhZmUzZjEwYzAyOTl8P05nSzVwPzllPz10eFRNZVd3V0hgf0";

// async function createRegistrationToken(card) {
//   const bodyParams = {
//     entityId: ENTITY_ID,
//     "card.number": card.number,
//     "card.holder": card.holder,
//     "card.expiryMonth": card.expiryMonth,
//     "card.expiryYear": card.expiryYear,
//     "card.cvv": card.cvv,
//   };
//   const body = new URLSearchParams(bodyParams).toString();

//   const url = new URL(`${API_BASE}/v1/registrations`);
//   const options = {
//     hostname: url.hostname,
//     port: 443,
//     path: url.pathname,
//     method: "POST",
//     headers: {
//       Authorization: `Bearer ${BEARER_TOKEN}`,
//       "Content-Type": "application/x-www-form-urlencoded",
//       "Content-Length": Buffer.byteLength(body),
//     },
//   };

//   return new Promise((resolve, reject) => {
//     const req = https.request(options, (res) => {
//       let data = "";
//       res.on("data", (chunk) => (data += chunk));
//       res.on("end", () => resolve(JSON.parse(data)));
//     });
//     req.on("error", reject);
//     req.write(body);
//     req.end();
//   });
// }

// // Test it
// createRegistrationToken({
//   number: "4200000000000000",
//   holder: "Test User",
//   expiryMonth: "12",
//   expiryYear: "2030",
//   cvv: "123",
// })
//   .then(console.log)
//   .catch(console.error);

// testRegistrationToken.js
// import https from "https";
// import querystring from "querystring";

// // Replace these with your sandbox credentials
// const CONFIG = {
//   ENTITY_ID: "8ac7a4c793ae8faa0193afe46836029d", // sandbox entityId
//   BEARER_TOKEN:
//     "OGFjN2E0Yzc5M2FlOGZhYTAxOTNhZmUzZjEwYzAyOTl8P05nSzVwPzllPz10eFRNZVd3V0hgf0", // sandbox token
//   API_BASE: "eu-test.oppwa.com",
// };

// async function createRegistrationToken(card) {
//   const bodyParams = {
//     entityId: CONFIG.ENTITY_ID,
//     "card.number": card.number,
//     "card.holder": card.holder,
//     "card.expiryMonth": card.expiryMonth,
//     "card.expiryYear": card.expiryYear,
//     "card.cvv": card.cvv,
//   };

//   const body = querystring.stringify(bodyParams);

//   const options = {
//     hostname: CONFIG.API_BASE,
//     port: 443,
//     path: "/v1/registrations",
//     method: "POST",
//     headers: {
//       "Content-Type": "application/x-www-form-urlencoded",
//       Authorization: `Bearer ${CONFIG.BEARER_TOKEN}`,
//       "Content-Length": Buffer.byteLength(body),
//     },
//   };

//   return new Promise((resolve, reject) => {
//     const req = https.request(options, (res) => {
//       let data = "";
//       res.on("data", (chunk) => (data += chunk));
//       res.on("end", () => {
//         try {
//           resolve({
//             status: res.statusCode,
//             data: JSON.parse(data),
//             raw: data,
//           });
//         } catch (err) {
//           reject(err);
//         }
//       });
//     });

//     req.on("error", reject);
//     req.write(body);
//     req.end();
//   });
// }

// // Example usage
// (async () => {
//   try {
//     const card = {
//       number: "4111111111111111", // test card
//       holder: "Test User",
//       expiryMonth: "12",
//       expiryYear: "2030",
//       cvv: "123",
//     };

//     const res = await createRegistrationToken(card);
//     console.log("Registration Token Response:", res);
//   } catch (err) {
//     console.error("Error:", err);
//   }
// })();

// testCreateRegistrationToken.js
import https from "https";
import { URLSearchParams } from "url";

// ---- Sandbox configuration ----
const CONFIG = {
  ENTITY_ID: "8a8294184e736012014e78c4c4cb17dc", // official sandbox entity
  BEARER_TOKEN: "OGE4Mjk0MTg0ZTczNjAxMjAxNGU3OGM0YzRlNDE3ZTB8NHRKQ21qMkJ0Mw==", // sandbox token for registration
  API_BASE: "https://eu-test.oppwa.com",
};

// ---- Convert body to x-www-form-urlencoded ----
function toFormUrlEncoded(obj) {
  const params = new URLSearchParams();
  for (const key in obj) {
    params.append(key, obj[key]);
  }
  return params.toString();
}

// ---- Make HTTPS request ----
async function httpRequest({ urlString, method = "POST", bearerToken, body }) {
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

// ---- Create registration token ----
async function createRegistrationToken(card) {
  const bodyParams = {
    entityId: CONFIG.ENTITY_ID,
    "card.number": card.number,
    "card.holder": card.holder,
    "card.expiryMonth": card.expiryMonth,
    "card.expiryYear": card.expiryYear,
    "card.cvv": card.cvv,
    paymentBrand: "VISA", // explicitly add this
  };

  const url = `${CONFIG.API_BASE}/v1/registrations`;
  const res = await httpRequest({
    urlString: url,
    method: "POST",
    bearerToken: CONFIG.BEARER_TOKEN,
    body: toFormUrlEncoded(bodyParams),
  });

  return res;
}

// ---- Run example ----
(async () => {
  try {
    const token = await createRegistrationToken({
      number: "4111111111111111", // test Visa card
      holder: "Jane Jones",
      expiryMonth: "12",
      expiryYear: "2034",
      cvv: "123",
    });

    console.log("Registration token response:", token);
  } catch (err) {
    console.error("Error:", err);
  }
})();
