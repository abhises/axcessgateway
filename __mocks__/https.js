// __mocks__/https.js  <-- Jest will use this automatically if you call jest.mock("https")
import { EventEmitter } from "events";

let rules = [];

function respond({ options }) {
  const path = options.path || "";
  const method = (options.method || "GET").toUpperCase();

  for (const r of rules) {
    const matched =
      typeof r.matcher === "function"
        ? r.matcher({ options, path, method })
        : String(path).startsWith(String(r.matcher));

    if (matched) {
      const out = r.responder({ options, path, method }) || {};
      return {
        status: out.status ?? 200,
        json: out.json ?? { ok: true },
        headers: out.headers ?? { "content-type": "application/json" },
      };
    }
  }

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

    setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = status;
      res.headers = headers;
      res.setEncoding = () => {};
      callback(res);

      const bodyStr = headers["content-type"]?.includes("application/json")
        ? JSON.stringify(json)
        : String(json);

      res.emit("data", bodyStr);
      res.emit("end");
    });
  };
  req.on = req.addListener;
  req.setTimeout = () => {};
  req.abort = () => {};
  req.destroy = () => {};
  return req;
}

request.__setMockResponse = (matcher, responder) => {
  rules.push({ matcher, responder });
};
request.__resetMock = () => {
  rules = [];
};

export default { request };
