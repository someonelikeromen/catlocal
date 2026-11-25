// 并发限流器：信号量 + FIFO 队列 + 排队超时。
//
// 设计要点（对应「支持并发等能力」）：
//   1. 每个通道独立限流，互不挤占（studio 慢不拖累 robin）。
//   2. 队列满 → 立刻 429（BUSY），避免无界堆积把内存吃光。
//   3. 排队超时 → 429（QUEUE_TIMEOUT），让客户端尽早重试而不是干等。
//   4. 支持运行时改并发度（面板上调整立即生效，正在跑的请求不受影响）。
import { sleep } from "./util.mjs";
import { gwErr } from "./util.mjs";

export class Limiter {
  constructor(name, { concurrency = 4, maxQueue = 64, queueTimeoutMs = 120000 } = {}) {
    this.name = name;
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.maxQueue = Math.max(0, Number(maxQueue) || 0);
    this.queueTimeoutMs = Math.max(1000, Number(queueTimeoutMs) || 120000);
    this.active = 0;
    this.queue = []; // {resolve, reject, enqueuedAt}
    this.stats = { peak: 0, completed: 0, rejected: 0, timeouts: 0, queuedTotal: 0 };
  }

  get queued() {
    return this.queue.length;
  }

  /**
   * 申请一个执行许可。返回 release()，必须且只能调用一次。
   * 队列满/超时抛 GatewayError(429)。
   */
  async acquire(label = "") {
    if (this.active < this.concurrency) {
      this.active++;
      this.stats.peak = Math.max(this.stats.peak, this.active);
      return this._releaseFn();
    }
    if (this.queue.length >= this.maxQueue) {
      this.stats.rejected++;
      throw gwErr(429, "channel_busy", `通道 ${this.name} 队列已满（${this.maxQueue}），请稍后重试`);
    }

    this.stats.queuedTotal++;
    const ticket = { label, enqueuedAt: Date.now(), resolve: null, reject: null, timer: null };
    const waited = new Promise((resolve, reject) => {
      ticket.resolve = resolve;
      ticket.reject = reject;
    });
    this.queue.push(ticket);
    ticket.timer = setTimeout(() => {
      const idx = this.queue.indexOf(ticket);
      if (idx >= 0) {
        this.queue.splice(idx, 1);
        this.stats.timeouts++;
        ticket.reject(
          gwErr(
            429,
            "queue_timeout",
            `通道 ${this.name} 排队超过 ${Math.round(this.queueTimeoutMs / 1000)}s，请稍后重试`
          )
        );
      }
    }, this.queueTimeoutMs);

    await waited;
    clearTimeout(ticket.timer);
    this.active++;
    this.stats.peak = Math.max(this.stats.peak, this.active);
    return this._releaseFn();
  }

  _releaseFn() {
    let released = false;
    return () => {
      if (released) return; // 幂等：finally 里重复调用无害
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.stats.completed++;
      this._wake();
    };
  }

  /** 有槽位释放时按 FIFO 唤醒下一个 */
  _wake() {
    while (this.active < this.concurrency && this.queue.length) {
      const ticket = this.queue.shift();
      clearTimeout(ticket.timer);
      ticket.resolve();
      // 被唤醒方在 await 后自行 active++；这里不占位，交给它做，避免二次计数
      return;
    }
  }

  /** 运行时改并发（缩小时只影响新请求） */
  resize(concurrency, maxQueue, queueTimeoutMs) {
    if (concurrency != null) this.concurrency = Math.max(1, Number(concurrency) || 1);
    if (maxQueue != null) this.maxQueue = Math.max(0, Number(maxQueue) || 0);
    if (queueTimeoutMs != null) this.queueTimeoutMs = Math.max(1000, Number(queueTimeoutMs) || 1000);
    this._wake();
  }

  snapshot() {
    return {
      name: this.name,
      concurrency: this.concurrency,
      active: this.active,
      queued: this.queued,
      maxQueue: this.maxQueue,
      queueTimeoutMs: this.queueTimeoutMs,
      ...this.stats,
    };
  }
}

/**
 * 简单令牌桶：客户端 Key 级别的 RPM 限流（0 = 不限）。
 */
export class RateWindow {
  constructor(perMinute = 0) {
    this.perMinute = Math.max(0, Number(perMinute) || 0);
    this.hits = []; // 时间戳
  }

  allow(now = Date.now()) {
    if (!this.perMinute) return { ok: true, remaining: Infinity };
    const cutoff = now - 60_000;
    while (this.hits.length && this.hits[0] < cutoff) this.hits.shift();
    if (this.hits.length >= this.perMinute) {
      const retryAfterMs = Math.max(0, 60_000 - (now - this.hits[0]));
      return { ok: false, remaining: 0, retryAfterMs };
    }
    this.hits.push(now);
    return { ok: true, remaining: this.perMinute - this.hits.length };
  }

  snapshot(now = Date.now()) {
    const cutoff = now - 60_000;
    const used = this.hits.filter((t) => t >= cutoff).length;
    return { rpm: this.perMinute, used, remaining: Math.max(0, this.perMinute - used) };
  }
}

/** 指数退避（带抖动），用于重试 */
export async function backoff(attempt, baseMs = 500, maxMs = 8000, signal) {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, attempt - 1));
  const jitter = Math.random() * Math.min(400, exp * 0.25);
  await sleepable(exp + jitter, signal);
}

function sleepable(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(gwErr(499, "cancelled", "请求已取消"));
    const t = setTimeout(() => {
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(gwErr(499, "cancelled", "请求已取消"));
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export { sleepable as delay };
export { sleep };