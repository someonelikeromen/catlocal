// Browser 通道（页面转发）：请求真正在 AI Studio 页面的用户脚本里执行，网关只做编解码转发。
//
// 为什么这样做：无头引擎（studio 通道）是拿导入的 Cookie 在 Node/Python 里冒充浏览器会话，
// 请求体自己拼、WAA proof 自己签。页面转发则完全不同——请求由**浏览器标签页自己**发出：
//   · 出口 IP、UA、客户端提示、TLS 指纹、Cookie 轮换，全都是真人浏览器的那一套
//   · WAA proof 由页面上下文现场取，不用在 Node 侧重放签名
//   · 凭证不落地、不复制，网关手里没有可被复用的会话材料
// 代价是慢（每轮要等浏览器往返 + 取 proof，通常 6~15s），并且要求标签页在线。
//
// 链路（与 aistudio-api 的 encodeWire/parseWire 对齐）：
//   客户端 → 网关 → studio 引擎 :encodeWire 得到 {wire, binding}
//          → WS 下发给浏览器执行器（脚本对 binding 做 sha256、现场取 proof 注入 wire[4]、
//            fetch 到 MakerSuite RPC）
//          → 拿回上游原始文本 raw → studio 引擎 :parseWire 还原成 Gemini 响应 → 客户端
import { Channel, parseJsonBody } from "../channel.mjs";
import { httpText } from "../upstream.mjs";
import { gwErr, upstreamMessage } from "../util.mjs";

// 流式：每收到一块就尝试用「当前累积的 raw」解析一次，把新增文本增量吐给客户端。
// 上游 raw 是 JSPB 分帧的，前缀不完整时解析器会丢掉尾部残帧，所以这里能安全地做增量。
const INCREMENTAL_PARSE_INTERVAL_MS = 350;

export class BrowserChannel extends Channel {
  constructor(name, cfg, log, { executors, studio } = {}) {
    super(name, cfg, log);
    this.executors = executors;
    this.studio = studio; // 编解码权威：encodeWire / parseWire 都在 studio 引擎里
  }

  // ── 健康 ───────────────────────────────────────────────────
  async checkHealth() {
    const started = Date.now();
    const online = this.executors?.size ?? 0;
    const codec = Boolean(this.studio?.baseUrl);
    // 「现在能不能用」的口径就看有没有在线执行器：没有就是不可用（引擎活着也没用）
    this.health = {
      ok: online > 0 && codec,
      checkedAt: Date.now(),
      latencyMs: Date.now() - started,
      error: online > 0 ? (codec ? null : "studio 引擎不可达（编码器缺失）") : "没有在线的浏览器执行器（请打开 AI Studio 页面）",
      info: { executors: online, codecBase: codec ? this.studio.baseUrl : null },
    };
    return this.health;
  }

  // ── 模型清单：与 studio 同一账号，直接借用引擎清单 ─────────
  async fetchModels() {
    const { status, text } = await httpText(this.studio.baseUrl, "/v1beta/models", {
      headers: this.studio.authHeaders(),
      timeoutMs: 25000,
    });
    if (status >= 400) {
      throw gwErr(status, "models_failed", `模型清单获取失败：${upstreamMessage(text, status)}`);
    }
    const data = parseJsonBody(text);
    return (data?.models || []).map((m) => {
      const id = String(m.name || "").replace(/^models\//, "");
      return {
        id,
        rawName: m.name,
        displayName: m.displayName || id,
        description: m.description || "",
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
        channel: this.name,
      };
    });
  }

  // ── countTokens：本地算，不走浏览器（引擎的 countTokens 不消耗上游配额）──
  async _countTokens(model, body, signal) {
    const { status, text } = await httpText(this.studio.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:countTokens`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.studio.authHeaders() },
      body,
      timeoutMs: 30000,
      signal,
    });
    if (status >= 400) {
      throw gwErr(status, "count_tokens_failed", upstreamMessage(text, status));
    }
    return { type: "json", status, json: parseJsonBody(text) || {} };
  }

  /** 让 studio 引擎把 Gemini 请求体编码成浏览器要的 {wire, binding} */
  async _encodeWire(model, body, signal) {
    const { status, text } = await httpText(this.studio.baseUrl, `/v1beta/models/${encodeURIComponent(model)}:encodeWire`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.studio.authHeaders() },
      body,
      timeoutMs: 60000,
      signal,
    });
    const json = parseJsonBody(text);
    if (status >= 400 || !json?.wire) {
      throw gwErr(status >= 400 ? status : 502, "encode_failed", `请求编码失败：${upstreamMessage(text, status)}`);
    }
    return json;
  }

  /** 把浏览器回传的上游原始文本还原成 Gemini 响应 */
  async _parseWire(raw, model, signal) {
    const { status, text } = await httpText(this.studio.baseUrl, "/v1beta:parseWire", {
      method: "POST",
      headers: { "content-type": "application/json", ...this.studio.authHeaders() },
      body: { raw, model },
      timeoutMs: 60000,
      signal,
    });
    const json = parseJsonBody(text);
    if (status >= 400 || !json) {
      throw gwErr(status >= 400 ? status : 502, "parse_failed", `响应解析失败：${upstreamMessage(text, status)}`);
    }
    return json;
  }

  // ── 请求 ───────────────────────────────────────────────────
  async request(kind, model, body, signal, requestId) {
    if (!this.executors?.size) {
      throw gwErr(
        503,
        "no_executor",
        "页面转发通道要求 AI Studio 页面在线（浏览器里运行着 cat 脚本）；当前没有在线执行器。请打开 https://aistudio.google.com/ 再试。"
      );
    }
    if (kind === "countTokens") return this._countTokens(model, body, signal);

    const enc = await this._encodeWire(model, body, signal);
    // 引擎回的 model 形如 models/xxx；脚本只需要裸名（真正的模型在 wire[0] 里）
    const modelName = String(enc.model || model).replace(/^models\//, "");
    const payload = { wire: enc.wire, binding: enc.binding };
    const timeoutMs = Number(this.cfg.timeoutMs) || 900000;

    if (kind === "generate") {
      const r = await this.executors.dispatch({
        model: modelName,
        stream: false,
        payload,
        timeoutMs,
        signal,
      });
      const raw = String(r?.raw ?? "");
      if (!raw) throw gwErr(502, "empty_upstream", "浏览器没有回传上游响应体");
      const json = await this._parseWire(raw, enc.model || model, signal);
      return { type: "json", status: r.status || 200, json };
    }

    // 流式：边收边增量解析，最后用完整 raw 再解析一次补齐尾部
    return {
      type: "stream",
      status: 200,
      headers: null,
      events: this._streamEvents(model, { ...enc, model: enc.model || model, modelName }, payload, signal, timeoutMs),
    };
  }

  async *_streamEvents(model, enc, payload, signal, timeoutMs) {
    const execModel = enc.modelName || String(enc.model || model).replace(/^models\//, "");
    const queue = [];
    let waiters = [];
    let done = false;
    let failure = null;

    const wake = () => {
      const ws = waiters;
      waiters = [];
      for (const w of ws) w();
    };

    const dispatchPromise = this.executors
      .dispatch({
        model: execModel,
        stream: true,
        payload,
        timeoutMs,
        signal,
        onChunk: (piece) => {
          queue.push(String(piece ?? ""));
          wake();
        },
      })
      .then((r) => {
        done = true;
        return r;
      })
      .catch((err) => {
        failure = err;
        done = true;
        wake();
      })
      .finally(wake);

    let raw = "";
    let emittedText = "";
    let emittedCalls = 0;
    let lastParseAt = 0;

    const emitDelta = (parsed) => {
      const out = [];
      const parts = parsed?.candidates?.[0]?.content?.parts || [];
      const fullText = parts.map((p) => (typeof p.text === "string" ? p.text : "")).join("");
      const fullCalls = parts.filter((p) => p.functionCall).length;
      if (fullText.length > emittedText.length) {
        out.push({
          candidates: [
            {
              content: { role: "model", parts: [{ text: fullText.slice(emittedText.length) }] },
              index: 0,
            },
          ],
        });
        emittedText = fullText;
      }
      // 工具调用只在收尾一次性给出（调用是原子的，切一半给客户端反而会解析失败）
      if (fullCalls > emittedCalls) emittedCalls = fullCalls;
      return out;
    };

    try {
      for (;;) {
        if (queue.length) {
          raw += queue.shift();
          // 流式帧尽量快吐：节流解析，避免每块都跑一次 Python 解析
          const now = Date.now();
          if (now - lastParseAt >= INCREMENTAL_PARSE_INTERVAL_MS) {
            lastParseAt = now;
            try {
              const parsed = await this._parseWire(raw, enc.model || model, signal);
              for (const evt of emitDelta(parsed)) yield evt;
            } catch {
              /* 前缀解析失败是常态（帧未收全），忽略 */
            }
          }
        } else if (done) {
          break;
        } else {
          await new Promise((resolve) => {
            waiters.push(resolve);
            // 兜底：即使没有新块也要定期醒来重新判断 done
            setTimeout(resolve, 250).unref?.();
          });
        }
      }

      await dispatchPromise;
      if (failure) throw failure;
      if (!raw) throw gwErr(502, "empty_upstream", "浏览器没有回传上游响应体");

      // 收尾：用完整 raw 解析，补齐增量阶段没来得及吐的尾巴
      const finalParsed = await this._parseWire(raw, enc.model || model, signal);
      for (const evt of emitDelta(finalParsed)) yield evt;
      const cand = finalParsed?.candidates?.[0];
      const finalParts = cand?.content?.parts || [];
      const finalCalls = finalParts.filter((p) => p.functionCall).length;
      if (finalCalls > emittedCalls) {
        yield {
          candidates: [
            {
              content: { role: "model", parts: finalParts.filter((p) => p.functionCall) },
              finishReason: cand?.finishReason || "STOP",
              index: 0,
            },
          ],
          usageMetadata: finalParsed?.usageMetadata,
        };
      } else if (cand?.finishReason || finalParsed?.usageMetadata) {
        yield {
          candidates: [
            {
              content: { role: "model", parts: [] },
              finishReason: cand?.finishReason || "STOP",
              index: 0,
            },
          ],
          usageMetadata: finalParsed?.usageMetadata,
        };
      }
      yield { __done: true };
    } finally {
      // 客户端断开时 signal 会被 abort，dispatch 内部的 onAbort 已经给浏览器回 cancel 帧；
      // 这里不需要额外动作，只要保证不再往已关闭的 SSE 里写东西。
      emittedText = "";
    }
  }

  snapshot() {
    const base = super.snapshot();
    return { ...base, executors: this.executors?.size ?? 0, mode: "页面转发（请求在浏览器里执行）" };
  }
}