// 统一执行层：路由解析 → 通道限流 → 上游调用 → 跨通道失败回退 → 指标记账。
// Gemini 与 OpenAI 两条 API 都复用这里，避免两套逻辑漂移。
import { GatewayError, gwErr, randomId } from "./util.mjs";

export class Runner {
  constructor({ config, router, channels, metrics, store, log }) {
    this.config = config;
    this.router = router;
    this.channels = channels;
    this.metrics = metrics;
    this.store = store;
    this.log = log;
  }

  /**
   * @param {object} opts
   * @param {'generate'|'stream'|'countTokens'} opts.kind
   * @param {string} opts.model 调用方给的模型名
   * @param {object} opts.body Gemini 请求体（已转换）
   * @param {AbortSignal} opts.signal
   * @param {boolean} opts.preferChannel 强制优先通道（如 pg-）
   * @param {(chunk:object)=>void} opts.onChunk 仅流式
   * @param {(name:string)=>void} opts.onChannelResolved 通道确定后回调
   * @returns {Promise<{channel, model, result, requestId}>}
   */
  async run({ kind, model, body, signal, preferChannel = null, onChunk, onChannelResolved, source = "api", clientKey = null }) {
    const requestId = randomId("r", 8);
    const route = await this.router.resolve(model, { preferChannel });
    this.log.info(`路由 ${model} → ${route.channel}/${route.model}（${route.reason}）${kind === "stream" ? " [stream]" : ""}`, {
      requestId,
    });
    onChannelResolved?.(route.channel, route.model);

    const candidates = [{ channel: route.channel, model: route.model }, ...route.fallback];
    let lastErr = null;

    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i];
      const ch = this.channels[cand.channel];
      if (!ch || !ch.enabled) continue;
      const startedAt = Date.now();
      const isFallback = i > 0;
      if (isFallback) {
        this.log.warn(`跨通道回退：${cand.channel}/${cand.model}`, { requestId, from: lastErr?.message });
      }
      try {
        const result = await ch.call({
          kind,
          model: cand.model,
          body,
          signal,
          requestId,
          onRetry: (attempt, err) => {
            this.log.warn(`通道内重试 #${attempt}`, { requestId, channel: cand.channel, err: err?.message });
          },
        });

        this.metrics.record({
          channel: cand.channel,
          model: cand.model,
          ok: true,
          status: result.status,
          latencyMs: Date.now() - startedAt,
          stream: kind === "stream",
          source,
          requestId,
          clientKey,
          tokensIn: result.json?.usageMetadata?.promptTokenCount || 0,
          tokensOut:
            (result.json?.usageMetadata?.candidatesTokenCount || 0) +
            (result.json?.usageMetadata?.thoughtsTokenCount || 0),
        });
        this.store.recordStat({
          channel: cand.channel,
          model: cand.model,
          ok: true,
          tokensIn: result.json?.usageMetadata?.promptTokenCount || 0,
          tokensOut:
            (result.json?.usageMetadata?.candidatesTokenCount || 0) +
            (result.json?.usageMetadata?.thoughtsTokenCount || 0),
          latencyMs: Date.now() - startedAt,
        });
        return { channel: cand.channel, model: cand.model, result, requestId, startedAt };
      } catch (err) {
        lastErr = err;
        const status = err?.status ?? 0;
        const cancelled = status === 499;
        if (!cancelled) {
          this.metrics.record({
            channel: cand.channel,
            model: cand.model,
            ok: false,
            cancelled,
            status,
            latencyMs: Date.now() - startedAt,
            stream: kind === "stream",
            source,
            requestId,
            clientKey,
            error: err.message,
          });
          this.store.recordStat({ channel: cand.channel, model: cand.model, ok: false, latencyMs: Date.now() - startedAt });
        }
        // 只有「可重试类」才跨通道回退；4xx 参数错误回退也没意义
        const fallbackable =
          status === 429 || status === 500 || status === 502 || status === 503 || status === 504 ||
          err?.code === "upstream_unreachable" || err?.code === "upstream_idle" || err?.code === "channel_busy" ||
          err?.code === "no_channel";
        if (!fallbackable || cancelled) throw err;
        this.log.warn(`通道 ${cand.channel} 失败，考虑回退`, { requestId, status, err: err.message });
      }
    }

    throw lastErr instanceof GatewayError
      ? lastErr
      : gwErr(502, "all_channels_failed", lastErr?.message || "所有通道均失败");
  }
}