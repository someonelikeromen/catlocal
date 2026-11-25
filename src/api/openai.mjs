// OpenAI 兼容端点：/v1/models、/v1/chat/completions（含 SSE 流式）。
// 让 NextChat / Cherry Studio / LobeChat / OpenAI SDK 这类客户端直接可用。
import { sendJson, sendError, openSse } from "../http.mjs";
import {
  openaiToGemini,
  geminiToOpenaiResponse,
  geminiChunkToOpenaiDelta,
  usageFromGemini,
  extractCandidate,
  mapFinishReason,
} from "../convert.mjs";
import { gwErr, randomId } from "../util.mjs";

export async function handleOpenaiModels(ctx, req, res) {
  const models = await ctx.router.listAllModels();
  const data = [];
  const seen = new Set();
  for (const m of models) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      data.push({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: m.channel,
      });
    }
    // 带通道前缀的别名（pg/gemini-3.8-flash、robin/gemini-4-argon…）
    data.push({
      id: m.prefixed,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: m.channel,
      root: m.id,
    });
  }
  sendJson(res, 200, { object: "list", data });
}

export async function handleChatCompletions(ctx, req, res, body) {
  const model = String(body?.model || "").trim() || ctx.config.routing.defaultChannel;
  const stream = body?.stream === true;
  const includeUsage = body?.stream_options?.include_usage === true;
  const geminiBody = openaiToGemini(body);
  const requestId = randomId("o", 6);
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const completionId = `chatcmpl-${randomId("x", 8).slice(2)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!stream) {
    const { channel, model: realModel, result } = await ctx.runner.run({
      kind: "generate",
      model,
      body: geminiBody,
      signal: abort.signal,
      source: "openai",
      requestId,
    });
    res.setHeader("x-catlocal-channel", channel);
    res.setHeader("x-catlocal-model", realModel);
    sendJson(
      res,
      200,
      geminiToOpenaiResponse(result.json, { model: body.model || realModel, id: completionId, created })
    );
    return;
  }

  // ── 流式：先连上上游，拿到响应再开 SSE（错误能回标准 JSON） ──
  let resolved;
  try {
    resolved = await ctx.runner.run({
      kind: "stream",
      model,
      body: geminiBody,
      signal: abort.signal,
      source: "openai",
      requestId,
    });
  } catch (err) {
    ctx.log.error("OpenAI 流式失败（未开始推流）", { requestId, model, err: err.message });
    sendError(res, err, { requestId });
    return;
  }

  res.setHeader("x-catlocal-channel", resolved.channel);
  res.setHeader("x-catlocal-model", resolved.model);
  const sse = openSse(res);
  const realModel = resolved.model;
  let sentAny = false;
  let roleSent = false;
  let finishSent = false;
  let sawToolCalls = false;
  let lastUsage = null;
  try {
    for await (const evt of resolved.result.events) {
      if (evt.__done) break;
      if (sse.closed) break;
      // 上游在流内报错（引擎已经把 200 头发出去了，只能走事件）：
      // 例如账号冷却时 aistudio-api 会发 `data: {"error":{code:503,...}}`。
      // 早先这里把它当成「没有候选」直接丢掉，客户端只收到一个空的 finish=stop，
      // 看起来就像「模型没有回应/不接受工具」。现在显式转成 error 事件。
      if (evt.error) {
        const e = evt.error;
        const upstreamErr = Object.assign(new Error(e.message || "上游流内错误"), {
          status: Number(e.code) || 502,
          code: e.status || "upstream_error",
        });
        // 流已经开出去了，本次无法重来；但把凭证重新采一遍，让下一次请求直接能用
        ctx.recovery?.recover(upstreamErr)?.catch?.(() => {});
        throw upstreamErr;
      }
      if (evt.usageMetadata) lastUsage = usageFromGemini(evt.usageMetadata);
      const chunk = geminiChunkToOpenaiDelta(evt, {
        model: body.model || realModel,
        id: completionId,
        created,
        roleSent,
      });
      if (!chunk) continue;
      const choice = chunk.choices?.[0];
      if (choice?.delta?.tool_calls?.length) sawToolCalls = true;
      if (choice?.finish_reason) {
        // 整条流出现过工具调用 → 结束原因必须是 tool_calls，否则客户端会当成普通文本结束
        if (sawToolCalls) choice.finish_reason = "tool_calls";
        // 只宣告一次结束：后续带 usage 的帧不再重复带 finish_reason
        if (finishSent) choice.finish_reason = null;
        else finishSent = true;
      }
      roleSent = true;
      if (!choice?.finish_reason && !Object.keys(choice?.delta || {}).length && !chunk.usage) continue;
      sse.write(chunk);
      sentAny = true;
    }
    // 收尾：确保有 finish_reason 与 usage
    if (!finishSent && !sse.closed) {
      sse.write({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: body.model || realModel,
        choices: [{ index: 0, delta: {}, finish_reason: sawToolCalls ? "tool_calls" : "stop", logprobs: null }],
      });
    }
    if (includeUsage && lastUsage && !sse.closed) {
      sse.write({
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: body.model || realModel,
        choices: [],
        usage: lastUsage,
      });
    }
    if (!sse.closed) sse.write("[DONE]");
    sse.end();
  } catch (err) {
    ctx.log.error("OpenAI 流式中途失败", { requestId, model: realModel, err: err.message });
    if (!sse.closed) {
      // 不论有没有吐过正文都要告诉客户端发生了什么，否则就是一条空回答
      sse.write({ error: { message: err.message, type: err.code || "upstream_error", code: err.status || 502 } });
      sse.write("[DONE]");
    }
    sse.end();
  }
}

/** /v1/responses 之类暂不支持，统一直白拒绝 */
export function notImplemented(feature) {
  return gwErr(501, "not_implemented", `本地网关暂未实现 ${feature}（可用 /v1/chat/completions 或 /v1beta/*）`);
}

export { extractCandidate, mapFinishReason };