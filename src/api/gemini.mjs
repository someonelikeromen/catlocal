// Gemini 原生协议端点：/v1beta/models、generateContent、streamGenerateContent、countTokens。
// 设计原则：Gemini 请求体原样（几乎）透传给对应引擎，响应也尽量原样透出，
// 这样 aistudio-api / Summeretto 各自的高级能力（思考链、图片、函数调用…）不会在网关这一层丢失。
import { sendJson, sendError, openSse } from "../http.mjs";
import { sanitizeGeminiBody } from "../convert.mjs";
import { gwErr, randomId } from "../util.mjs";

const GEMINI_VERB = /^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/;

export function matchGeminiPath(pathname) {
  const m = GEMINI_VERB.exec(pathname);
  if (!m) return null;
  return { model: m[1], verb: m[2] };
}

/** 模型清单（Gemini 格式），同时给出带通道前缀的别名 */
export async function handleModels(ctx, req, res, { alt = "" } = {}) {
  const models = await ctx.router.listAllModels();
  const list = [];
  const seen = new Set();
  const entry = (name, displayName, m, suffix = "") => ({
    name,
    displayName,
    description: m.description || (suffix ? `通道：${m.channel}` : ""),
    inputTokenLimit: m.inputTokenLimit,
    outputTokenLimit: m.outputTokenLimit,
    supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
  });
  for (const m of models) {
    const name = `models/${m.id}`;
    // 规范名（同名只保留一条）
    if (!seen.has(name)) {
      seen.add(name);
      list.push(entry(name, m.displayName, m));
    }
    // 带通道前缀的别名：调用方可以精确指定走哪条通道
    const alias = `models/${m.prefixed}`;
    if (!seen.has(alias) && m.prefixed && m.prefixed !== m.id) {
      seen.add(alias);
      list.push(entry(alias, `${m.displayName}（${m.channel}）`, m, `channel:${m.channel}`));
    }
  }
  sendJson(res, 200, { models: list });
}

/** generateContent / streamGenerateContent / countTokens 的统一入口 */
export async function handleGenerate(ctx, req, res, { model, verb, body, query }) {
  const kind = verb === "countTokens" ? "countTokens" : verb === "streamGenerateContent" ? "stream" : "generate";
  const geminiBody = sanitizeGeminiBody(body);
  const requestId = randomId("g", 6);
  const clientAbort = new AbortController();
  res.on("close", () => clientAbort.abort());

  const startedAt = Date.now();

  if (kind !== "stream") {
    const { channel, model: realModel, result } = await ctx.runner.run({
      kind,
      model,
      body: geminiBody,
      signal: clientAbort.signal,
      source: "gemini",
      requestId,
    });
    const json = result.json || {};
    if (channel) res.setHeader("x-catlocal-channel", channel);
    res.setHeader("x-catlocal-model", realModel);
    if (kind === "countTokens") {
      const usage = json.usageMetadata || {};
      sendJson(res, 200, {
        totalTokens: json.totalTokens ?? usage.promptTokenCount ?? 0,
        ...(usage.promptTokensDetails ? { promptTokensDetails: usage.promptTokensDetails } : {}),
      });
      return;
    }
    sendJson(res, 200, json);
    ctx.log.debug("generateContent 完成", { requestId, model: realModel, ms: Date.now() - startedAt });
    return;
  }

  // ── 流式：先连上上游（拿到 200 再开 SSE），失败时还能回标准 JSON 错误
  let resolved;
  try {
    resolved = await ctx.runner.run({
      kind,
      model,
      body: geminiBody,
      signal: clientAbort.signal,
      source: "gemini",
      requestId,
    });
  } catch (err) {
    ctx.log.error("流式生成失败（未开始推流）", { requestId, model, err: err.message });
    sendError(res, err, { requestId });
    return;
  }

  res.setHeader("x-catlocal-channel", resolved.channel);
  res.setHeader("x-catlocal-model", resolved.model);
  const sse = openSse(res);
  let sentAny = false;
  try {
    for await (const evt of resolved.result.events) {
      if (evt.__done) break;
      if (sse.closed) break;
      // 引擎在流内报错（例如账号冷却时的 503）：原样透出给调用方，
      // 同时顺手采一次浏览器 Cookie，让下一次请求直接恢复
      if (evt.error) {
        ctx.recovery
          ?.recover(
            Object.assign(new Error(evt.error.message || "上游流内错误"), {
              status: Number(evt.error.code) || 502,
              code: evt.error.status || "upstream_error",
            })
          )
          ?.catch?.(() => {});
      }
      sse.write(JSON.stringify(evt));
      sentAny = true;
    }
    sse.end();
    ctx.log.debug("streamGenerateContent 完成", { requestId, model: resolved.model, ms: Date.now() - startedAt });
  } catch (err) {
    ctx.log.error("流式中途失败", { requestId, model: resolved.model, err: err.message });
    if (sentAny) {
      sse.write({ error: { code: err.status || 502, message: err.message, status: err.code || "INTERNAL" } });
    }
    sse.end();
  }
}