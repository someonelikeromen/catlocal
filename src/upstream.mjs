// 上游 HTTP 客户端：统一超时 / 空闲超时 / 取消 / SSE 逐块读取。
// 零依赖，基于内置 fetch（undici）。
import { gwErr, isAbortError, sleep } from "./util.mjs";

function joinUrl(baseUrl, pathName) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const p = String(pathName || "");
  return base + (p.startsWith("/") ? p : `/${p}`);
}

function withSignal(controller, signal) {
  if (!signal) return () => {};
  if (signal.aborted) {
    controller.abort();
    return () => {};
  }
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * 非流式请求：一次性拿到文本（JSON 由调用方自解析）。
 * @returns {Promise<{status:number, headers:Headers, text:string}>}
 */
export async function httpText(
  baseUrl,
  pathName,
  { method = "GET", headers = {}, body, timeoutMs = 60000, signal } = {}
) {
  const controller = new AbortController();
  const detach = withSignal(controller, signal);
  const timer = timeoutMs
    ? setTimeout(() => controller.abort(new Error("timeout")), timeoutMs)
    : null;
  const started = Date.now();
  try {
    const resp = await fetch(joinUrl(baseUrl, pathName), {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: controller.signal,
      redirect: "follow",
    });
    const text = await resp.text();
    return { status: resp.status, headers: resp.headers, text, elapsedMs: Date.now() - started };
  } catch (err) {
    if (isAbortError(err)) {
      if (signal?.aborted) throw gwErr(499, "cancelled", "客户端已取消请求");
      throw gwErr(504, "upstream_timeout", `上游响应超时（>${Math.round(timeoutMs / 1000)}s）`);
    }
    throw gwErr(502, "upstream_unreachable", `无法连接上游：${err.message}`);
  } finally {
    if (timer) clearTimeout(timer);
    detach();
  }
}

/**
 * 流式请求：返回裸响应 + 逐块读取器。
 * @returns {Promise<{status:number, headers:Headers, stream:AsyncGenerator<string>, abort:Function, url:string}>}
 */
export async function httpStream(
  baseUrl,
  pathName,
  { method = "POST", headers = {}, body, timeoutMs = 900000, idleTimeoutMs = 300000, signal } = {}
) {
  const controller = new AbortController();
  const detach = withSignal(controller, signal);
  const hardTimer = timeoutMs
    ? setTimeout(() => controller.abort(new Error("hard-timeout")), timeoutMs)
    : null;

  let resp;
  try {
    resp = await fetch(joinUrl(baseUrl, pathName), {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (err) {
    if (hardTimer) clearTimeout(hardTimer);
    detach();
    if (isAbortError(err)) {
      if (signal?.aborted) throw gwErr(499, "cancelled", "客户端已取消请求");
      throw gwErr(504, "upstream_timeout", `上游建连超时（>${Math.round(timeoutMs / 1000)}s）`);
    }
    throw gwErr(502, "upstream_unreachable", `无法连接上游：${err.message}`);
  }

  const url = joinUrl(baseUrl, pathName);

  async function* reader() {
    if (!resp.body) return;
    const dec = new TextDecoder("utf-8");
    const rd = resp.body.getReader();
    try {
      for (;;) {
        let timer = null;
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(gwErr(504, "upstream_idle", `上游 ${Math.round(idleTimeoutMs / 1000)}s 无数据`)),
            idleTimeoutMs
          );
        });
        let chunk;
        try {
          chunk = await Promise.race([rd.read(), timeoutPromise]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (chunk.done) break;
        const piece = dec.decode(chunk.value, { stream: true });
        if (piece) yield piece;
      }
      const tail = dec.decode();
      if (tail) yield tail;
    } finally {
      try {
        await rd.cancel();
      } catch {
        /* ignore */
      }
      if (hardTimer) clearTimeout(hardTimer);
      detach();
    }
  }

  return {
    status: resp.status,
    headers: resp.headers,
    stream: reader(),
    url,
    abort: () => controller.abort(),
  };
}

/**
 * SSE 事件解析：把文本块流还原成 data 负载序列。
 * 兼容 \n\n / \r\n\r\n 分隔，忽略注释行（": ping"）。
 */
export async function* sseEvents(pieces) {
  let buf = "";
  for await (const piece of pieces) {
    buf += piece;
    let idx;
    // 逐个切事件（空行分隔）
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + (buf[idx] === "\r" ? 4 : 2));
      const dataLines = [];
      for (const line of raw.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        const m = /^data:\s?(.*)$/.exec(line);
        if (m) dataLines.push(m[1]);
      }
      if (dataLines.length) yield dataLines.join("\n");
    }
  }
  if (buf.trim()) {
    const dataLines = [];
    for (const line of buf.split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (m) dataLines.push(m[1]);
    }
    if (dataLines.length) yield dataLines.join("\n");
  }
}

/** 重试包装：只对幂等失败重试（429/5xx/网络），并遵守取消信号 */
export async function withRetry(fn, { retries = 0, baseMs = 700, onRetry, signal } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      const status = err?.status ?? 0;
      const retriable =
        status === 429 || status === 502 || status === 503 || status === 504 ||
        err?.code === "upstream_unreachable" || err?.code === "upstream_idle";
      if (attempt >= retries || !retriable || signal?.aborted) throw err;
      attempt++;
      onRetry?.(attempt, err);
      const wait = Math.min(8000, baseMs * Math.pow(2, attempt - 1)) + Math.random() * 250;
      await sleepWithSignal(wait, signal);
    }
  }
}

function sleepWithSignal(ms, signal) {
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

export { sleep };