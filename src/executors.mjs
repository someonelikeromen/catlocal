// 浏览器执行器池（catiecli 用户脚本的 WS 模式）。
//
// 本地化后它的职责变了：不再需要浏览器去跑 GenerateContent（studio 无头通道更快、
// 断网/关页面都不影响），但「浏览器里的真人会话」仍然是宝贵的凭证来源。
// 因此这里支持：
//   1. register / ping-pong 心跳 / 顶替与拒绝（复用 cat 的关闭码语义）
//   2. collect（从浏览器拉 Cookie + 请求头 + 指纹）→ 交给 studio 引擎建档
//   3. raw 直通（可选）：调用方自带 wire/binding 时，把请求原样下发到浏览器执行
import { randomId } from "./util.mjs";

const CLOSE = {
  replaced: 4001,
  keyChanged: 4002,
  rejected: 4008,
};

export class Executor {
  constructor(conn, { token, clientVersion, executorType, requestId }) {
    this.id = randomId("ex", 5);
    this.conn = conn;
    this.token = token;
    this.clientVersion = clientVersion || "unknown";
    this.executorType = executorType || "playground";
    this.connectedAt = Date.now();
    this.lastSeen = Date.now();
    this.inflight = 0;
    this.requests = 0;
    this.errors = 0;
    this.pending = new Map(); // requestId -> {resolve, reject, onChunk, timer, stream}
    this.conn.meta = { executorId: this.id };
  }

  get silentMs() {
    return Date.now() - this.lastSeen;
  }

  send(obj) {
    return this.conn.send(obj);
  }
}

export class ExecutorPool {
  constructor({
    log,
    heartbeatTimeoutMs = 75000,
    maxExecutors = 32,
    collectTimeoutMs = 30000,
    // 连接建立后必须在此时限内发 register，否则关闭。自测会调小它来验证超时路径。
    registerTimeoutMs = 10000,
    // 心跳巡检间隔（默认 15s）。同样为了自测可调。
    sweepIntervalMs = 15000,
  }) {
    this.log = log;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.maxExecutors = maxExecutors;
    this.collectTimeoutMs = collectTimeoutMs;
    this.registerTimeoutMs = registerTimeoutMs;
    this.sweepIntervalMs = sweepIntervalMs;
    this.executors = new Map(); // id -> Executor
    this.byToken = new Map(); // token -> id
    // 池级计数：面板/接口据此观察「注册了多少、顶替了多少、踢了多少」
    this.stats = { registered: 0, rejected: 0, replaced: 0, evicted: 0, collected: 0, dispatched: 0 };
    this.timer = setInterval(() => this._sweep(), sweepIntervalMs);
    this.timer.unref?.();
  }

  get size() {
    return this.executors.size;
  }

  /** 接到一条 WS 连接：先等 register 帧，再决定去留 */
  handleConnection(conn, authorize) {
    let registered = false;
    const registerTimeout = setTimeout(() => {
      if (registered) return;
      this.stats.rejected++;
      conn.close(CLOSE.rejected, `未在 ${Math.round(this.registerTimeoutMs / 1000)}s 内发送 register`);
    }, this.registerTimeoutMs);
    registerTimeout.unref?.();

    conn.onmessage = (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;

      if (!registered) {
        if (msg.type !== "register") return;
        const auth = authorize(String(msg.apiKey || ""));
        if (!auth.ok) {
          clearTimeout(registerTimeout);
          this.stats.rejected++;
          conn.close(auth.code || CLOSE.rejected, auth.reason || "注册被拒绝");
          return;
        }
        // 同一 token 只保留最新连接（与 cat 的 4001 语义一致）
        const existingId = this.byToken.get(auth.token);
        if (existingId) {
          const old = this.executors.get(existingId);
          if (old) {
            this.stats.replaced++;
            old.conn.close(CLOSE.replaced, "被新的浏览器连接顶替");
            this._drop(old, CLOSE.replaced);
          }
        }
        if (this.executors.size >= this.maxExecutors) {
          clearTimeout(registerTimeout);
          this.stats.rejected++;
          conn.close(CLOSE.rejected, "执行器数量已达上限");
          return;
        }
        const ex = new Executor(conn, {
          token: auth.token,
          clientVersion: msg.clientVersion,
          executorType: msg.executorType,
        });
        this.executors.set(ex.id, ex);
        this.byToken.set(auth.token, ex.id);
        registered = true;
        this.stats.registered++;
        clearTimeout(registerTimeout);
        conn.send({ type: "registered", executorId: ex.id, serverVersion: "catlocal" });
        this.log.info("浏览器执行器上线", {
          id: ex.id,
          version: ex.clientVersion,
          type: ex.executorType,
          remote: conn.remoteAddress,
          online: this.executors.size,
        });
        return;
      }

      // 已注册：路由各类消息
      const ex = this._find(conn);
      if (!ex) return;
      ex.lastSeen = Date.now();
      switch (msg.type) {
        case "ping":
          conn.send({ type: "pong", ts: Date.now() });
          break;
        case "response":
        case "stream-end":
        case "error":
        case "stream-chunk":
          this._settle(ex, msg);
          break;
        case "collect-result":
          this._settleCollect(ex, msg);
          break;
        case "log":
          this.log.debug("执行器日志", { id: ex.id, msg: msg.message });
          break;
        default:
          break;
      }
    };

    conn.onclose = (code, reason) => {
      clearTimeout(registerTimeout);
      if (!registered) return;
      const ex = this._find(conn);
      if (ex) this._drop(ex, code);
      this.log.info("浏览器执行器下线", { code, reason, online: this.executors.size });
    };
  }

  /** 由连接反查执行器：走 conn.meta.executorId（O(1)），不再每次遍历整个池 */
  _find(conn) {
    const id = conn?.meta?.executorId;
    if (!id) return null;
    return this.executors.get(id) || null;
  }

  _drop(ex, code) {
    this.executors.delete(ex.id);
    if (this.byToken.get(ex.token) === ex.id) this.byToken.delete(ex.token);
    for (const [, pending] of ex.pending) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error("执行器连接已断开"), { status: 502, code: "executor_gone" }));
    }
    ex.pending.clear();
    ex.conn._finish?.(code, "dropped");
  }

  _settle(ex, msg) {
    const rid = msg.requestId;
    const pending = ex.pending.get(rid);
    if (!pending) return;
    if (msg.type === "stream-chunk") {
      try {
        pending.onChunk?.(String(msg.chunkBody ?? ""));
      } catch {
        /* ignore */
      }
      return;
    }
    clearTimeout(pending.timer);
    ex.pending.delete(rid);
    ex.inflight = Math.max(0, ex.inflight - 1);
    if (msg.type === "stream-end") {
      pending.resolve({ kind: "stream", status: msg.status || 200 });
    } else if (msg.type === "response") {
      pending.resolve({ kind: "json", status: msg.status || 200, raw: String(msg.rawResponse ?? "") });
    } else {
      const err = Object.assign(new Error(msg.error?.message || "执行器返回错误"), {
        status: msg.status || 502,
        code: msg.error?.code || "executor_error",
      });
      ex.errors++;
      pending.reject(err);
    }
  }

  /** 选择一个执行器：同 token 优先，其次全局最闲的 */
  pick(token) {
    const list = [...this.executors.values()].filter((e) => (token ? e.token === token : true));
    const pool = list.length ? list : [...this.executors.values()];
    if (!pool.length) return null;
    pool.sort((a, b) => a.inflight - b.inflight || a.connectedAt - b.connectedAt);
    return pool[0];
  }

  /**
   * 下发一个原始请求（cat 协议体：{wire, binding}）。
   * @returns {Promise<{kind:'json'|'stream', status:number, raw?:string}>}
   */
  async dispatch({ token, model, stream, payload, timeoutMs = 900000, onChunk, signal }) {
    const ex = this.pick(token);
    if (!ex) {
      throw Object.assign(new Error("没有在线的浏览器执行器"), { status: 503, code: "no_executor" });
    }
    this.stats.dispatched++;
    const requestId = randomId("req", 8);
    ex.inflight++;
    ex.requests++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ex.pending.delete(requestId);
        ex.inflight = Math.max(0, ex.inflight - 1);
        try {
          ex.send({ type: "cancel", requestId });
        } catch {
          /* ignore */
        }
        reject(Object.assign(new Error("执行器请求超时"), { status: 504, code: "executor_timeout" }));
      }, timeoutMs);

      const onAbort = () => {
        clearTimeout(timer);
        ex.pending.delete(requestId);
        ex.inflight = Math.max(0, ex.inflight - 1);
        try {
          ex.send({ type: "cancel", requestId });
        } catch {
          /* ignore */
        }
        reject(Object.assign(new Error("请求已取消"), { status: 499, code: "cancelled" }));
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });

      ex.pending.set(requestId, {
        resolve: (v) => {
          signal?.removeEventListener?.("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          signal?.removeEventListener?.("abort", onAbort);
          reject(e);
        },
        onChunk,
        timer,
      });

      const ok = ex.send({
        type: "request",
        requestId,
        model,
        stream: !!stream,
        requestBody: typeof payload === "string" ? payload : JSON.stringify(payload),
      });
      if (!ok) {
        clearTimeout(timer);
        ex.pending.delete(requestId);
        ex.inflight = Math.max(0, ex.inflight - 1);
        reject(Object.assign(new Error("执行器写入失败"), { status: 502, code: "executor_write_failed" }));
      }
    });
  }

  /**
   * 从浏览器拉取凭证（补丁后的脚本支持 collect）。
   * @returns {Promise<{cookies:Array, headers:Object, email?:string, authuser?:string, fingerprint?:object}>}
   */
  async collect(token, { timeoutMs = this.collectTimeoutMs } = {}) {
    const ex = this.pick(token);
    if (!ex) {
      throw Object.assign(new Error("没有在线的浏览器执行器（请在 AI Studio 页面打开并设置 Key）"), {
        status: 503,
        code: "no_executor",
      });
    }
    const requestId = randomId("col", 6);
    this.stats.collected++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ex.pending.delete(requestId);
        reject(Object.assign(new Error("浏览器采集超时"), { status: 504, code: "collect_timeout" }));
      }, timeoutMs);
      ex.pending.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        onChunk: null,
        timer,
      });
      const ok = ex.send({ type: "collect", requestId });
      if (!ok) {
        clearTimeout(timer);
        ex.pending.delete(requestId);
        reject(Object.assign(new Error("执行器写入失败"), { status: 502, code: "executor_write_failed" }));
      }
    });
  }

  _settleCollect(ex, msg) {
    const pending = ex.pending.get(msg.requestId);
    if (!pending) return;
    ex.pending.delete(msg.requestId);
    clearTimeout(pending.timer);
    if (msg.status && msg.status >= 400) {
      pending.reject(
        Object.assign(new Error(msg.error?.message || "采集失败"), { status: msg.status, code: msg.error?.code || "collect_failed" })
      );
    } else {
      pending.resolve({
        cookies: Array.isArray(msg.cookies) ? msg.cookies : [],
        headers: msg.headers && typeof msg.headers === "object" ? msg.headers : {},
        email: msg.email || null,
        authuser: msg.authuser != null ? String(msg.authuser) : "0",
        fingerprint: msg.fingerprint || null,
        model: msg.model || null,
      });
    }
  }

  /** 心跳：定期发 ping，长时间无任何回应的执行器踢掉（半开连接） */
  _sweep() {
    const now = Date.now();
    for (const ex of [...this.executors.values()]) {
      if (ex.silentMs > this.heartbeatTimeoutMs) {
        this.stats.evicted++;
        this.log.warn("执行器心跳超时，已断开", { id: ex.id, silentMs: ex.silentMs });
        ex.conn.close(CLOSE.rejected, "心跳超时");
        this._drop(ex, CLOSE.rejected);
        continue;
      }
      try {
        ex.send({ type: "ping", ts: now });
      } catch {
        /* ignore */
      }
    }
  }

  snapshot() {
    return [...this.executors.values()].map((e) => ({
      id: e.id,
      executorType: e.executorType,
      clientVersion: e.clientVersion,
      connectedAt: e.connectedAt,
      lastSeen: e.lastSeen,
      inflight: e.inflight,
      requests: e.requests,
      errors: e.errors,
      remote: e.conn.remoteAddress,
      token: e.token ? `${String(e.token).slice(0, 6)}…` : null,
    }));
  }

  /** 池级计数快照（注册/拒绝/顶替/踢出/采集/派发） */
  poolStats() {
    return {
      online: this.executors.size,
      maxExecutors: this.maxExecutors,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      ...this.stats,
    };
  }

  closeAll() {
    for (const ex of [...this.executors.values()]) {
      try {
        ex.conn.close(1001, "网关关闭");
      } catch {
        /* ignore */
      }
    }
    clearInterval(this.timer);
  }
}