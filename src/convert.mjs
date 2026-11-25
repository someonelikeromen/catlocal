// OpenAI ⇄ Gemini 协议转换（请求、响应、流式分块）。
// 只依赖标准 JSON 结构，不做任何网络动作，便于单测。
import { rememberSignature, signatureOfToolCall } from "./signature-cache.mjs";

const FINISH_MAP = {
  STOP: "stop",
  FINISH_REASON_UNSPECIFIED: "stop",
  MAX_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  BLOCKLIST: "content_filter",
  LANGUAGE: "content_filter",
  OTHER: "stop",
  MALFORMED_FUNCTION_CALL: "tool_calls",
  TOOL_CALLS: "tool_calls",
};

export function mapFinishReason(reason) {
  if (!reason) return null;
  return FINISH_MAP[String(reason).toUpperCase()] || "stop";
}

function dataUriToInline(url) {
  const m = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(String(url || ""));
  if (!m) return null;
  return { mimeType: m[1] || "application/octet-stream", data: m[2] };
}

function guessMimeFromUrl(url) {
  const clean = String(url).split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return "image/png";
  if (clean.endsWith(".jpg") || clean.endsWith(".jpeg")) return "image/jpeg";
  if (clean.endsWith(".webp")) return "image/webp";
  if (clean.endsWith(".gif")) return "image/gif";
  if (clean.endsWith(".pdf")) return "application/pdf";
  if (clean.endsWith(".mp3")) return "audio/mpeg";
  if (clean.endsWith(".wav")) return "audio/wav";
  if (clean.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

function convertContentParts(content) {
  const parts = [];
  if (content == null) return parts;
  if (typeof content === "string") {
    if (content.length) parts.push({ text: content });
    return parts;
  }
  if (!Array.isArray(content)) return [{ text: String(content) }];
  for (const item of content) {
    if (!item) continue;
    if (typeof item === "string") {
      parts.push({ text: item });
      continue;
    }
    const type = item.type || (item.image_url ? "image_url" : "text");
    if (type === "text" || type === "input_text") {
      parts.push({ text: String(item.text ?? "") });
    } else if (type === "image_url" || type === "input_image") {
      const url = item.image_url?.url ?? item.image_url ?? item.url ?? "";
      const inline = dataUriToInline(url);
      if (inline) parts.push({ inlineData: inline });
      else if (/^https?:\/\//.test(url)) {
        parts.push({ fileData: { mimeType: guessMimeFromUrl(url), fileUri: url } });
      }
    } else if (type === "file" || type === "input_file") {
      const fileId = item.file?.file_id || item.file_id;
      const url = item.file?.url || item.file?.file_url || item.url;
      if (url && /^https?:\/\//.test(url)) {
        parts.push({ fileData: { mimeType: guessMimeFromUrl(url), fileUri: url } });
      } else if (fileId && /^https?:\/\//.test(String(fileId))) {
        parts.push({ fileData: { mimeType: guessMimeFromUrl(String(fileId)), fileUri: String(fileId) } });
      }
    } else if (type === "audio_url" || type === "input_audio") {
      const url = item.audio_url?.url ?? item.audio_url ?? item.input_audio?.data ?? "";
      const inline = dataUriToInline(url);
      if (inline) parts.push({ inlineData: inline });
    }
  }
  return parts;
}

/**
 * OpenAI Chat Completions 请求 → Gemini generateContent 请求体。
 */
export function openaiToGemini(body, { defaultModel = "" } = {}) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const contents = [];
  const systemTexts = [];
  const toolNameById = new Map();

  const pushContent = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    // 连续同角色合并（Gemini 要求 user/model 交替）
    if (last && last.role === role) {
      last.parts.push(...parts);
    } else {
      contents.push({ role, parts });
    }
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = String(msg.role || "user").toLowerCase();
    if (role === "system" || role === "developer") {
      const parts = convertContentParts(msg.content);
      const text = parts.map((p) => p.text || "").join("\n");
      if (text.trim()) systemTexts.push(text);
      continue;
    }
    if (role === "assistant") {
      const parts = convertContentParts(msg.content);
      for (const call of msg.tool_calls || []) {
        const fn = call?.function || {};
        const name = fn.name || "tool";
        if (call.id) toolNameById.set(call.id, name);
        let args = fn.arguments;
        if (typeof args === "string") {
          try {
            args = args ? JSON.parse(args) : {};
          } catch {
            args = { raw: args };
          }
        }
        const part = { functionCall: { name, args: args || {} } };
        // Gemini 3 回灌 functionCall 必须带当初下发的 thoughtSignature（否则上游 400）。
        // 客户端一般不带，所以先看它有没有原样回传，没有就按 tool_call id 从缓存补。
        const sig = signatureOfToolCall(call);
        if (sig) part.thoughtSignature = sig;
        parts.push(part);
      }
      pushContent("model", parts);
      continue;
    }
    if (role === "tool") {
      const name = toolNameById.get(msg.tool_call_id) || msg.name || "tool";
      const parts = convertContentParts(msg.content);
      const resultText = parts.map((p) => p.text || "").join("\n");
      pushContent("user", [
        {
          functionResponse: {
            name,
            response: { result: resultText || "ok" },
          },
        },
      ]);
      continue;
    }
    // user（含历史里的其它角色，一律当 user）
    pushContent("user", convertContentParts(msg.content));
  }

  if (!contents.length && !systemTexts.length) {
    contents.push({ role: "user", parts: [{ text: "" }] });
  }

  const out = { contents };
  if (systemTexts.length) {
    out.systemInstruction = { role: "system", parts: [{ text: systemTexts.join("\n\n") }] };
  }

  const gc = {};
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  if (num(body?.temperature) != null) gc.temperature = body.temperature;
  if (num(body?.top_p) != null) gc.topP = body.top_p;
  const maxTok = num(body?.max_completion_tokens) ?? num(body?.max_tokens);
  if (maxTok != null) gc.maxOutputTokens = Math.max(1, Math.trunc(maxTok));
  if (num(body?.top_k) != null) gc.topK = body.top_k;
  if (num(body?.presence_penalty) != null) gc.presencePenalty = body.presence_penalty;
  if (num(body?.frequency_penalty) != null) gc.frequencyPenalty = body.frequency_penalty;
  if (body?.stop != null) {
    gc.stopSequences = Array.isArray(body.stop) ? body.stop.filter((s) => typeof s === "string") : [String(body.stop)];
  }
  if (body?.response_format?.type === "json_object") {
    gc.responseMimeType = "application/json";
  }
  if (body?.response_format?.type === "json_schema") {
    gc.responseMimeType = "application/json";
    const schema = body.response_format.json_schema?.schema;
    if (schema) gc.responseSchema = schema;
  }
  if (body?.reasoning_effort) {
    const map = { low: "low", medium: "medium", high: "high", minimal: "low" };
    const lvl = map[String(body.reasoning_effort).toLowerCase()];
    if (lvl) gc.thinkingConfig = { thinkingLevel: lvl };
  }
  if (Object.keys(gc).length) out.generationConfig = gc;

  const tools = [];
  for (const t of body?.tools || []) {
    if (t?.type !== "function" || !t.function?.name) continue;
    const decl = {
      name: t.function.name,
      description: t.function.description || "",
    };
    if (t.function.parameters && typeof t.function.parameters === "object") {
      decl.parameters = t.function.parameters;
    }
    tools.push(decl);
  }
  if (tools.length) out.tools = [{ functionDeclarations: tools }];

  return out;
}

/** 从一个 Gemini candidate 里抽出文本与工具调用 */
export function extractCandidate(candidate) {
  const parts = candidate?.content?.parts || [];
  let text = "";
  let reasoning = "";
  const toolCalls = [];
  for (const p of parts) {
    if (typeof p?.text === "string") {
      if (p.thought === true) reasoning += p.text;
      else text += p.text;
    }
    if (p?.functionCall) {
      const id = p.functionCall.id || `call_${toolCalls.length}`;
      const sig = p.thoughtSignature || p.thought_signature || null;
      const call = {
        id,
        type: "function",
        function: {
          name: p.functionCall.name || "tool",
          arguments: JSON.stringify(p.functionCall.args ?? {}),
        },
      };
      if (sig) {
        // 把签名一并交给客户端（OpenRouter 同款位置），同时按 id 记进缓存：
        // 客户端即便丢掉这个非标准字段，下一轮回灌也能按 id 补回来。
        call.extra_content = { google: { thought_signature: sig } };
        rememberSignature(id, sig);
      }
      toolCalls.push(call);
    }
  }
  return { text, reasoning, toolCalls, finishReason: candidate?.finishReason ?? null };
}

export function usageFromGemini(usage) {
  if (!usage) return null;
  const prompt = usage.promptTokenCount ?? 0;
  const completion = (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: usage.totalTokenCount ?? prompt + completion,
    ...(usage.thoughtsTokenCount ? { completion_tokens_details: { reasoning_tokens: usage.thoughtsTokenCount } } : {}),
  };
}

/**
 * Gemini generateContent 响应 → OpenAI chat.completion
 */
export function geminiToOpenaiResponse(gemini, { model, id, created }) {
  const cand = gemini?.candidates?.[0];
  const { text, reasoning, toolCalls, finishReason } = extractCandidate(cand);
  const message = { role: "assistant", content: text || (toolCalls.length ? null : "") };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  const usage = usageFromGemini(gemini?.usageMetadata);
  return {
    id: id || `chatcmpl-${Math.random().toString(36).slice(2, 12)}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model: model || gemini?.modelVersion || "unknown",
    choices: [
      {
        index: 0,
        message,
        finish_reason: toolCalls.length ? "tool_calls" : mapFinishReason(finishReason) || "stop",
        logprobs: null,
      },
    ],
    ...(usage ? { usage } : {}),
    ...(gemini?.promptFeedback ? { prompt_feedback: gemini.promptFeedback } : {}),
  };
}

/**
 * Gemini 流式分块 → OpenAI chat.completion.chunk（增量）
 * 返回 {delta, finish_reason, usage} 或 null
 */
export function geminiChunkToOpenaiDelta(chunk, { model, id, created, roleSent }) {
  const cand = chunk?.candidates?.[0];
  const { text, reasoning, toolCalls, finishReason } = extractCandidate(cand);
  const delta = {};
  if (!roleSent) delta.role = "assistant";
  if (text) delta.content = text;
  if (reasoning) delta.reasoning_content = reasoning;
  if (toolCalls.length) delta.tool_calls = toolCalls.map((c, i) => ({ index: i, ...c }));
  const usage = chunk?.usageMetadata ? usageFromGemini(chunk.usageMetadata) : null;
  const hasPayload = Object.keys(delta).length > 0;
  if (!hasPayload && !finishReason && !usage) return null;
  // finish_reason 只认上游给的 finishReason，绝不由「本帧带了 tool_calls」推断：
  // 上游函数调用常常是「先一帧 functionCall、再一帧空 parts + STOP + usage」，
  // 若第一帧就宣告结束，后面那帧的 STOP 又会把 tool_calls 覆盖成 stop，
  // 客户端按最后一帧判断就会把工具调用当成普通停止（表现为"没有响应"）。
  // tool_calls 的收尾判定交给 api/openai.mjs 的流式循环（它知道整条流是否出现过工具调用）。
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta,
        finish_reason: mapFinishReason(finishReason),
        logprobs: null,
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

/** 把 Gemini 请求体里的模型清单相关的字段清洗一下（OpenAI 特有字段丢弃） */
export function sanitizeGeminiBody(body) {
  const out = { ...(body || {}) };
  delete out.model;
  delete out.stream;
  return out;
}