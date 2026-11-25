// 测试用「假 studio 引擎」：模仿 aistudio-api 的关键端点，供离线自测网关。
// 不是真实 AI Studio 客户端，只负责协议形状与可观测的并发行为。
import http from "node:http";

const PORT = Number(process.env.PORT || 18080);
const DELAY = Number(process.env.MOCK_DELAY_MS || 120);
let active = 0;
let peak = 0;
const accounts = [];
const imported = [];
// 「第一次 503 账号不可用、从第二次起正常」的一次性账号故障，用于验证凭证自愈
let recoverHits = 0;
// 计数：页面转发通道只该调 encodeWire/parseWire，不该让引擎自己发 GenerateContent
let wireCounter = 0;
let generateCount = 0;

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

function geminiText(text, model) {
  return {
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
    modelVersion: model,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  if (path === "/health") return json(res, 200, { status: "ok" });

  if (path === "/stats") return json(res, 200, { totals: { requests: 0 } });

  if (path === "/api/accounts" && req.method === "GET") return json(res, 200, accounts);

  // 真实 aistudio-api 的路由是 /api/accounts/import-cookies（少一层就 404，
  // 曾因网关写成 /api/import-cookies 而线上不可用，这里必须与真实路由一致）
  if (path === "/api/accounts/import-cookies" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const cookies = JSON.parse(body.cookies || "[]");
    const acct = {
      id: `cookie_test${accounts.length}`,
      name: body.name || "测试账号",
      email: body.email || null,
      tier: body.tier || "Free",
      auth_user: String(body.auth_user || "0"),
      is_active: accounts.length === 0,
      enabled: true,
      cookie_count: Array.isArray(cookies) ? cookies.length : 0,
    };
    accounts.push(acct);
    imported.push(acct);
    return json(res, 200, { account_id: acct.id, name: acct.name, cookie_count: acct.cookie_count, auth_user: acct.auth_user, tier: acct.tier });
  }

  if (/^\/api\/accounts\/[^/]+\/activate$/.test(path)) {
    const id = path.split("/")[3];
    for (const a of accounts) a.is_active = a.id === id;
    return json(res, 200, accounts.find((a) => a.id === id) || null);
  }
  if (/^\/api\/accounts\/[^/]+\/toggle$/.test(path)) {
    const id = path.split("/")[3];
    const a = accounts.find((x) => x.id === id);
    if (a) a.enabled = !a.enabled;
    return json(res, 200, a || null);
  }
  if (/^\/api\/accounts\/[^/]+$/.test(path) && req.method === "DELETE") {
    const id = path.split("/")[3];
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx >= 0) accounts.splice(idx, 1);
    return json(res, 200, { ok: true });
  }

  if (path === "/v1beta/models" && req.method === "GET") {
    return json(res, 200, {
      models: [
        { name: "models/gemini-3.7-flash", displayName: "Gemini 3.7 Flash" },
        { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash" },
        { name: "models/gemini-4-argon", displayName: "Gemini 4 Argon" },
      ],
    });
  }

  // ── 页面转发通道的编解码端点（对齐 aistudio-api 的 routes_bridge）──
  // 网关把 Gemini 请求体丢进来换 {wire, binding}，再把浏览器回的 raw 换回响应；
  // 这两个端点不发上游、不碰账号。
  if (/:encodeWire$/.test(path) && req.method === "POST") {
    const model = decodeURIComponent(path.slice("/v1beta/models/".length).replace(/:encodeWire$/, ""));
    const body = JSON.parse((await readBody(req)) || "{}");
    const text = (body.contents || []).map((c) => (c.parts || []).map((p) => p.text || "").join("")).join(" ");
    wireCounter++;
    return json(res, 200, {
      wire: ["models/" + model, [[[[null, text]], "user"]], null, null, null],
      binding: text,
      digest: "mock-digest",
      model: "models/" + model,
    });
  }

  if (path === "/v1beta:parseWire" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const raw = String(body.raw || "");
    // raw 约定："MOCKRAW:<文本>"，模拟上游原始响应文本；"CALL:<name>" 模拟函数调用
    const mm = /^MOCKRAW:([\s\S]*)$/.exec(raw);
    const text = mm ? mm[1] : "";
    const parts = [];
    if (text.startsWith("CALL:")) {
      parts.push({ functionCall: { name: text.slice(5) || "tool", args: { q: "mock" }, id: "call_mock_pw" }, thoughtSignature: "SIG_MOCK_PW" });
    } else if (text) {
      parts.push({ text });
    }
    return json(res, 200, {
      candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
      modelVersion: body.model || null,
      responseId: "resp_mock",
    });
  }

  const m = /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/.exec(path);
  if (m && req.method === "POST") {
    const model = decodeURIComponent(m[1]);
    const verb = m[2];
    if (verb === "generateContent" || verb === "streamGenerateContent") generateCount++;
    const body = JSON.parse((await readBody(req)) || "{}");
    active++;
    peak = Math.max(peak, active);
    // 每条路径都要恰好释放一次，否则活跃计数泄漏、峰值统计失真
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active--;
    };
    try {
      if (verb === "countTokens") {
        release();
        return json(res, 200, { totalTokens: 42 });
      }
      const prompt = (body.contents || []).map((c) => (c.parts || []).map((p) => p.text || "").join("")).join(" ");
      const text = `[studio:${model}] 收到 ${prompt.slice(0, 60)} | 活动并发=${active} 峰值=${peak}`;

      // ── 夹具：一次性账号故障（第一次 503，之后正常）──
      // 用来验证：网关失败 → 自动从浏览器采集 Cookie → 重试成功
      if (prompt.includes("RECOVER_ONCE") && recoverHits++ === 0) {
        await new Promise((r) => setTimeout(r, 20));
        release();
        return json(res, 503, { error: { code: 503, message: "No available accounts for this request.", status: "UNAVAILABLE" } });
      }

      // ── 夹具：函数调用 / 流内错误 ───────────────────────────────
      // 真实上游的形态是「先一帧 functionCall（无 finishReason），再一帧空 parts + STOP + usage」，
      // 以及「账号不可用时发一帧 {"error":{code:503}}」。这两条正是网关最易出错的形状。
      if (prompt.includes("TOOLCALL")) {
        // 真实上游会给 functionCall 附带 thoughtSignature（Gemini 3 回灌时必须原样带回）
        const call = {
          content: {
            role: "model",
            parts: [{ thoughtSignature: "SIG_MOCK_1", functionCall: { name: "WebSearch", args: { query: "mock" }, id: "call_mock1" } }],
          },
          index: 0,
        };
        if (verb === "generateContent") {
          await new Promise((r) => setTimeout(r, DELAY));
          release();
          return json(res, 200, { candidates: [call], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 12 }, modelVersion: model });
        }
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ candidates: [call], modelVersion: model })}\n\n`);
        res.write(
          `data: ${JSON.stringify({
            candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
            usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 3, totalTokenCount: 12 },
          })}\n\n`
        );
        res.end();
        release();
        return;
      }

      if (prompt.includes("STREAMERR")) {
        if (verb === "generateContent") {
          release();
          return json(res, 503, { error: { code: 503, message: "No available accounts for this request.", status: "UNAVAILABLE" } });
        }
        // 真实引擎就是「200 头 + 流内 error 事件」，网关必须把它转成错误而不是空回答
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ error: { code: 503, message: "No available accounts for this request.", status: "UNAVAILABLE" } })}\n\n`);
        res.end();
        release();
        return;
      }

      if (verb === "generateContent") {
        await new Promise((r) => setTimeout(r, DELAY));
        release();
        if (body.contents?.[0]?.parts?.[0]?.text === "BOOM") {
          return json(res, 500, { error: { code: 500, message: "mock upstream error", status: "INTERNAL" } });
        }
        return json(res, 200, geminiText(text, model));
      }

      // 流式 SSE
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      const pieces = ["[studio:", model, "] ", ...Array.from(text.replace(`[studio:${model}] `, "")).slice(0, 40)];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= pieces.length) {
          clearInterval(timer);
          res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 } })}\n\n`);
          res.end();
          release();
          return;
        }
        const chunk = { candidates: [{ content: { parts: [{ text: pieces[i] }] }, index: 0 }] };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
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

  if (path === "/__stats")
    return json(res, 200, {
      active,
      peak,
      imported: imported.length,
      accounts: accounts.length,
      generateCount,
      wireCounter,
    });
  json(res, 404, { error: { message: `mock studio: no route ${path}` } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-studio] http://127.0.0.1:${PORT}`);
});