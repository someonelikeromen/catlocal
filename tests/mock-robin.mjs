// 测试用「假 robin 引擎」：模仿 Summeretto 的端点（/healthz、/v1beta/…、/admin/*）。
import http from "node:http";

const PORT = Number(process.env.PORT || 13000);
const ADMIN_KEY = process.env.ADMIN_KEY || "test-admin";
const DELAY = Number(process.env.MOCK_DELAY_MS || 120);

let state = {
  email: process.env.GSA_EMAIL || "",
  masterToken: process.env.GSA_MASTER_TOKEN || "",
  thirdParty: "",
  binds: [],
  peak: 0,
  active: 0,
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function gemini(text, model) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 9, totalTokenCount: 30 },
    modelVersion: model,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path === "/healthz") {
    const bound = Boolean(state.masterToken || state.thirdParty);
    return json(res, 200, {
      ok: true,
      service: "summeretto-mock",
      stage: "connected",
      auth: bound ? "configured (gpsoauth)" : "missing",
      credential: { verdict: bound ? "valid" : "unbound", usable: bound },
      inflight: { inflight: state.active, peak: state.peak },
      modes: { source: "static", count: 4 },
    });
  }

  if (path.startsWith("/admin/")) {
    if (req.headers["x-admin-key"] !== ADMIN_KEY) {
      return json(res, 401, { error: { code: 401, message: "admin key 无效", status: "UNAUTHENTICATED" } });
    }
    if (path === "/admin/gpsoauth") {
      if (req.method === "GET") {
        return json(res, 200, {
          source: state.masterToken ? "gpsoauth" : state.thirdParty ? "injected" : "none",
          email: state.email || null,
          tokenTail: state.masterToken ? `…${String(state.masterToken).slice(-6)}` : null,
          credential: { verdict: state.masterToken || state.thirdParty ? "valid" : "unbound", usable: Boolean(state.masterToken || state.thirdParty) },
        });
      }
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.oauthToken || !body.email) return json(res, 400, { detail: "缺少 email/oauthToken" });
      if (String(body.oauthToken).startsWith("bad-")) return json(res, 400, { detail: "BadAuthentication（oauth_token 已过期）" });
      state.email = String(body.email).toLowerCase();
      state.masterToken = `oauth2rt_1/mock-${Math.random().toString(36).slice(2, 10)}`;
      state.binds.push({ email: state.email, at: Date.now() });
      return json(res, 200, {
        ok: true,
        email: state.email,
        androidId: "0123456789abcdef",
        masterToken: state.masterToken,
        service: "oauth2:https://www.googleapis.com/auth/assistant",
        tokenTail: `…${state.masterToken.slice(-6)}`,
      });
    }
    if (path === "/admin/token") {
      if (req.method === "GET") return json(res, 200, { source: state.thirdParty ? "injected" : "none" });
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!String(body.token || "").startsWith("ya29.")) return json(res, 400, { detail: "需要 ya29. 开头的令牌" });
      state.thirdParty = body.token;
      return json(res, 200, { ok: true, source: "injected", tokenTail: `…${String(body.token).slice(-6)}` });
    }
    return json(res, 404, { error: { message: "no admin route" } });
  }

  if (path === "/v1beta/models") {
    return json(res, 200, {
      models: [
        { name: "models/gemini-4-argon", displayName: "4 Argon（Gemini App 通道）" },
        { name: "models/gemini-3.1-pro", displayName: "3.1 Pro（Gemini App 通道）" },
        { name: "models/gemini-3.8-flash", displayName: "3.8 Flash（Gemini App 通道）" },
        { name: "models/gemini-3.5-flash-lite", displayName: "3.5 Flash-Lite（Gemini App 通道）" },
        { name: "models/default", displayName: "账号默认档位（Gemini App 通道）" },
      ],
      modesMeta: { source: "static", count: 4, refreshOk: true },
    });
  }

  if (path === "/v1beta/modes") {
    return json(res, 200, { source: "static", entries: [{ id: "95a4c0abcba24364", label: "4 Argon" }] });
  }

  const m = /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/.exec(path);
  if (m && req.method === "POST") {
    const model = decodeURIComponent(m[1]);
    const verb = m[2];
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!state.masterToken && !state.thirdParty) {
      return json(res, 401, { error: { code: 401, message: "凭证未绑定：请先在 cat 脚本里推送 Robin 凭证", status: "UNAUTHENTICATED" } });
    }
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      state.active--;
    };
    try {
      if (verb === "countTokens") {
        release();
        return json(res, 200, { totalTokens: 33 });
      }
      const prompt = (body.contents || []).map((c) => (c.parts || []).map((p) => p.text || "").join("")).join(" ");
      const text = `[robin:${model}] 收到 ${prompt.slice(0, 60)} | 活动并发=${state.active}`;
      if (verb === "generateContent") {
        await new Promise((r) => setTimeout(r, DELAY));
        release();
        return json(res, 200, gemini(text, model));
      }
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      const pieces = ["[robin:", model, "] ", ...Array.from(text.replace(`[robin:${model}] `, "")).slice(0, 40)];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= pieces.length) {
          clearInterval(timer);
          res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 21, candidatesTokenCount: 9, totalTokenCount: 30 } })}\n\n`);
          res.end();
          release();
          return;
        }
        res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: pieces[i] }] }, index: 0 }] })}\n\n`);
        i++;
      }, 15);
      res.on("close", () => {
        clearInterval(timer);
        release();
      });
      return;
    } catch (err) {
      release();
      throw err;
    }
  }

  if (path === "/__state") return json(res, 200, { ...state, masterToken: state.masterToken ? "***" : "" });
  json(res, 404, { error: { message: `mock robin: no route ${path}` } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-robin] http://127.0.0.1:${PORT} admin=${ADMIN_KEY}`);
});