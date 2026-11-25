// 通道基类：把「限流 + 健康检查 + 模型清单 + 上游调用」收口在一个地方。
// studio / robin 两个具体通道只实现各自的「怎么调上游」。
import { Limiter } from "./limiter.mjs";
import { httpText, httpStream } from "./upstream.mjs";
import { gwErr } from "./util.mjs";
import { isCredentialFailure } from "./auto-recover.mjs";

export class Channel {
  constructor(name, cfg, log) {
    this.name = name;
    this.log = log;
    this.applyConfig(cfg);
    this.limiter = new Limiter(name, {
      concurrency: this.cfg.concurrency,
      maxQueue: this.cfg.maxQueue,
      queueTimeoutMs: this.cfg.queueTimeoutMs,
    });
    this.health = { ok: null, checkedAt: null, latencyMs: null, error: null, info: null };
    this.models = { at: 0, list: [], error: null };
    this.inflight = 0;
  }

  applyConfig(cfg) {
    this.cfg = cfg || {};
  }

  get enabled() {
    return this.cfg.enabled !== false;
  }

  get baseUrl() {
    return String(this.cfg.baseUrl || "").replace(/\/+$/, "");
  }

  get label() {
    return this.cfg.label || this.name;
  }

  /** 通道内部鉴权头（对上游引擎，不是对客户端） */
  authHeaders() {
    const key = this.cfg.apiKey;
    if (!key) return {};
    return { "x-goog-api-key": key, authorization: `Bearer ${key}`, "x-api-key": key };
  }

  /** 健康检查：各通道实现 */
  async checkHealth() {
    throw new Error("not implemented");
  }

  /** 模型清单：各通道实现；统一返回 [{id, displayName, ...}] */
  async listModels({ force = false } = {}) {
    const ttl = Number(this.cfg.modelsCacheMs) || 300000;
    if (!force && this.models.list.length && Date.now() - this.models.at < ttl) {
      return this.models.list;
    }
    try {
      const models = await this.fetchModels();
      this.models = { at: Date.now(), list: models, error: null };
      return models;
    } catch (err) {
      this.models.error = err.message;
      if (this.models.list.length) return this.models.list; // 有旧缓存就先兜着
      throw err;
    }
  }

  async fetchModels() {
    const { status, text } = await httpText(this.baseUrl, "/v1beta/models", {
      headers: this.authHeaders(),
      timeoutMs: 20000,
    });
    if (status >= 400) throw gwErr(status, "models_failed", `模型清单获取失败：${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    return (data.models || []).map((m) => ({
      id: String(m.name || "").replace(/^models\//, ""),
      rawName: m.name,
      displayName: m.displayName || String(m.name || "").replace(/^models\//, ""),
      description: m.description || "",
      inputTokenLimit: m.inputTokenLimit,
      outputTokenLimit: m.outputTokenLimit,
      channel: this.name,
    }));
  }

  /**
   * 统一调用入口：限流 → 上游（含重试/凭证自愈）→ 结果。
   * kind ∈ generate | stream | countTokens
   */
  async call({ kind, model, body, signal, requestId, onRetry }) {
    if (!this.enabled) throw gwErr(503, "channel_disabled", `通道 ${this.name} 已禁用`);
    const release = await this.limiter.acquire(`${kind}:${model}`);
    this.inflight++;
    try {
      const attemptOnce = () => this.request(kind, model, body, signal, requestId);
      const retries = Number(this.cfg.retries) || 0;
      let lastErr = null;
      let attempt = 0;
      let recoveryTried = false;

      for (;;) {
        try {
          return await attemptOnce();
        } catch (err) {
          lastErr = err;
          const status = err?.status ?? 0;

          // 凭证类失败（账号会话过期/冷却）：先自愈再重来，不吃 retries 预算。
          // 每次请求最多自愈一次，避免「永远失败 → 永远采集」的循环。
          if (!recoveryTried && typeof this.recoverCredentials === "function" && isCredentialFailure(err)) {
            recoveryTried = true;
            const outcome = await this.recoverCredentials(err);
            if (outcome?.recovered) {
              this.log.warn(`通道 ${this.name} 凭证已自动刷新，重试本次请求`, { requestId, model, cookies: outcome.cookies });
              continue;
            }
            this.log.warn(`通道 ${this.name} 自动刷新凭证未成功，按普通失败处理`, {
              requestId,
              model,
              reason: outcome?.reason || outcome?.error || "unknown",
            });
          }

          if (attempt >= retries) throw lastErr;
          const retriable =
            status === 429 || status === 500 || status === 502 || status === 503 || status === 504 ||
            err?.code === "upstream_unreachable" || err?.code === "upstream_idle";
          if (!retriable) throw err;

          attempt++;
          const wait = Math.min(8000, (Number(this.cfg.retryBackoffMs) || 700) * Math.pow(2, attempt - 1));
          await new Promise((r) => setTimeout(r, wait + Math.random() * 200));
          if (signal?.aborted) throw gwErr(499, "cancelled", "请求已取消");
          onRetry?.(attempt, lastErr);
          this.log.warn(`通道 ${this.name} 重试 #${attempt}`, { model, err: lastErr?.message });
        }
      }
    } finally {
      this.inflight--;
      release();
    }
  }

  async request() {
    throw new Error("not implemented");
  }

  snapshot() {
    return {
      name: this.name,
      label: this.label,
      enabled: this.enabled,
      baseUrl: this.baseUrl,
      health: this.health,
      models: { count: this.models.list.length, at: this.models.at, error: this.models.error },
      inflight: this.inflight,
      limiter: this.limiter.snapshot(),
      managed: this.cfg.managed || null,
    };
  }
}

/** 便捷：解析上游 JSON 响应体（带 XSSI 兜底） */
export function parseJsonBody(text) {
  const t = String(text || "").replace(/^\)\]\}'?\s*\n?/, "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export { httpStream };