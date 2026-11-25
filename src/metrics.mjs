// 指标与近期请求记录：给面板与 /admin/api/overview 提供数据。
// 只保留内存态（重启归零），持久化统计另由 store 的 stats 负责（跨重启累计）。

const MAX_RECENT = 400;

export class Metrics {
  constructor() {
    this.startedAt = Date.now();
    this.total = { requests: 0, ok: 0, error: 0, cancelled: 0, upstreamCalls: 0 };
    this.byChannel = new Map(); // channel -> {requests, ok, error, latency: [], tokens}
    this.byModel = new Map(); // model -> {requests, ok, error}
    this.recent = []; // 环形：最近请求
    this.latencyAll = []; // 最近 500 个延迟样本（毫秒）
    this.streaming = { active: 0 };
    this.dispatch = { pool: { requests: 0, ok: 0, error: 0 } };
  }

  _bucket(map, key) {
    let b = map.get(key);
    if (!b) {
      b = { requests: 0, ok: 0, error: 0, cancelled: 0, latency: [], tokensIn: 0, tokensOut: 0 };
      map.set(key, b);
    }
    return b;
  }

  /** 记录一次请求结果 */
  record({
    channel,
    model,
    ok,
    status,
    latencyMs,
    stream = false,
    cancelled = false,
    tokensIn = 0,
    tokensOut = 0,
    source = "api",
    error = null,
    requestId = null,
    clientKey = null,
    bytes = 0,
  }) {
    this.total.requests++;
    if (ok) this.total.ok++;
    else if (cancelled) this.total.cancelled++;
    else this.total.error++;

    const cb = this._bucket(this.byChannel, channel || "-");
    cb.requests++;
    if (ok) cb.ok++;
    else if (cancelled) cb.cancelled++;
    else cb.error++;
    cb.tokensIn += tokensIn;
    cb.tokensOut += tokensOut;
    if (latencyMs != null) {
      cb.latency.push(latencyMs);
      if (cb.latency.length > 200) cb.latency.shift();
    }

    if (model) {
      const mb = this._bucket(this.byModel, model);
      mb.requests++;
      if (ok) mb.ok++;
      else if (cancelled) mb.cancelled++;
      else mb.error++;
      if (latencyMs != null) {
        mb.latency.push(latencyMs);
        if (mb.latency.length > 100) mb.latency.shift();
      }
    }

    if (latencyMs != null) {
      this.latencyAll.push(latencyMs);
      if (this.latencyAll.length > 500) this.latencyAll.shift();
    }

    const rec = {
      at: Date.now(),
      channel: channel || "-",
      model: model || "-",
      ok,
      cancelled,
      status,
      latencyMs,
      stream,
      source,
      tokensIn,
      tokensOut,
      bytes,
      clientKey,
      error: error ? String(error).slice(0, 400) : null,
      requestId,
    };
    this.recent.push(rec);
    if (this.recent.length > MAX_RECENT) this.recent.shift();
    return rec;
  }

  static pct(arr, p) {
    if (!arr.length) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return Math.round(sorted[idx]);
  }

  snapshot() {
    const now = Date.now();
    const upMs = now - this.startedAt;
    const channelStats = {};
    for (const [name, b] of this.byChannel) {
      channelStats[name] = {
        requests: b.requests,
        ok: b.ok,
        error: b.error,
        cancelled: b.cancelled,
        successRate: b.requests ? +(b.ok / b.requests).toFixed(3) : null,
        p50: Metrics.pct(b.latency, 50),
        p95: Metrics.pct(b.latency, 95),
        tokensIn: b.tokensIn,
        tokensOut: b.tokensOut,
      };
    }
    const modelStats = {};
    for (const [m, b] of this.byModel) {
      modelStats[m] = {
        requests: b.requests,
        ok: b.ok,
        error: b.error,
        p50: Metrics.pct(b.latency, 50),
      };
    }
    return {
      uptimeMs: upMs,
      total: { ...this.total },
      channels: channelStats,
      models: modelStats,
      latency: {
        p50: Metrics.pct(this.latencyAll, 50),
        p90: Metrics.pct(this.latencyAll, 90),
        p95: Metrics.pct(this.latencyAll, 95),
        max: this.latencyAll.length ? Math.max(...this.latencyAll) : null,
      },
      inflight: this.streaming.active,
      recent: this.recent.slice(-60).reverse(),
    };
  }
}