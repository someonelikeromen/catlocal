// HTTP 基础设施：极简路由（支持 :param）、请求体读取、JSON 响应、SSE 响应、鉴权。
import { GatewayError, gwErr } from "./util.mjs";

export class HttpError extends GatewayError {}

export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method: method.toUpperCase(), pattern, handler, re: compile(pattern) });
    return this;
  }

  get(pattern, handler) {
    return this.add("GET", pattern, handler);
  }
  post(pattern, handler) {
    return this.add("POST", pattern, handler);
  }
  put(pattern, handler) {
    return this.add("PUT", pattern, handler);
  }
  delete(pattern, handler) {
    return this.add("DELETE", pattern, handler);
  }

  match(method, pathname) {
    const m = method.toUpperCase();
    let pathMatched = false;
    for (const route of this.routes) {
      const hit = route.re.exec(pathname);
      if (!hit) continue;
      pathMatched = true;
      if (route.method !== m && !(route.method === "GET" && m === "HEAD")) continue;
      const params = {};
      for (let i = 1; i < hit.length; i++) params[route.re.keys[i - 1]] = decodeURIComponent(hit[i]);
      return { route, params };
    }
    return pathMatched ? { route: null, params: {} } : null;
  }
}

/** /v1beta/models/:model:generateContent 这类「冒号在段尾」的路径需要宽松编译 */
function compile(pattern) {
  const keys = [];
  let src = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === ":") {
      // 参数名一直到下一个 / 或 - 或 结束（支持 :model:generateContent 的写法）
      let j = i + 1;
      while (j < pattern.length && /[A-Za-z0-9_]/.test(pattern[j])) j++;
      const name = pattern.slice(i + 1, j);
      keys.push(name);
      src += "([^/]+?)";
      i = j;
      continue;
    }
    src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i++;
  }
  const re = new RegExp(`^${src}$`);
  re.keys = keys;
  return re;
}

export async function readBody(req, { limit = 32 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw gwErr(413, "payload_too_large", `请求体超过 ${Math.round(limit / 1024 / 1024)}MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, opts = {}) {
  const buf = await readBody(req, opts);
  const text = buf.toString("utf8").trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") throw new Error("not an object");
    return parsed;
  } catch (err) {
    throw gwErr(400, "invalid_json", `请求体不是合法 JSON：${err.message}`);
  }
}

/**
 * 过滤掉值为 undefined / null 的请求头。
 * Node 的 writeHead 遇到 undefined 会直接抛 TypeError，进而让响应永远不结束。
 */
function cleanHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  return out;
}

export function sendJson(res, status, obj, extraHeaders = {}) {
  const body = JSON.stringify(obj);
  if (res.writableEnded) return;
  res.writeHead(
    status,
    cleanHeaders({
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "access-control-allow-origin": "*",
      ...extraHeaders,
    })
  );
  res.end(body);
}

export function sendText(res, status, text, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  if (res.writableEnded) return;
  res.writeHead(
    status,
    cleanHeaders({
      "content-type": contentType,
      "content-length": Buffer.byteLength(text),
      "access-control-allow-origin": "*",
      ...extraHeaders,
    })
  );
  res.end(text);
}

export function sendHtml(res, status, html) {
  sendText(res, status, html, "text/html; charset=utf-8");
}

export function sendError(res, err, { requestId = null } = {}) {
  const status = err?.status && Number.isFinite(err.status) ? err.status : 500;
  const payload = {
    error: {
      message: err?.message || "internal error",
      type: err?.code || "internal_error",
      code: err?.code || "internal_error",
      status,
      ...(requestId ? { request_id: requestId } : {}),
    },
  };
  // Gemini 风格错误（有 request 的 API 客户端更认这个结构）
  if (err?.geminiStyle) {
    payload.error = {
      code: status,
      message: err.message,
      status: err.code || "INTERNAL",
      ...(requestId ? { request_id: requestId } : {}),
    };
  }
  if (!res.writableEnded) {
    const headers = {};
    if (err?.retryAfterS) headers["retry-after"] = String(err.retryAfterS);
    sendJson(res, status, payload, headers);
  }
}

/** SSE 握手：返回写入器（自动维护 \n\n 分隔与心跳） */
export function openSse(res, extraHeaders = {}) {
  res.writeHead(
    200,
    cleanHeaders({
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    })
  );
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  const heartbeat = setInterval(() => {
    if (!closed) {
      try {
        res.write(": ping\n\n");
      } catch {
        /* ignore */
      }
    }
  }, 15000);
  heartbeat.unref?.();
  return {
    get closed() {
      return closed || res.writableEnded;
    },
    write(data) {
      if (this.closed) return false;
      try {
        res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        closed = true;
        return false;
      }
    },
    comment(text) {
      if (this.closed) return;
      try {
        res.write(`: ${text}\n\n`);
      } catch {
        /* ignore */
      }
    },
    end() {
      clearInterval(heartbeat);
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
    },
    /** Gemini 原始 SSE 直通（上游已是 `data: {...}\n\n` 片段） */
    writeRaw(chunk) {
      if (this.closed) return false;
      try {
        res.write(chunk);
        return true;
      } catch {
        closed = true;
        return false;
      }
    },
  };
}

export function corsPreflight(res) {
  res.writeHead(
    204,
    cleanHeaders({
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "*",
      "access-control-max-age": "86400",
    })
  );
  res.end();
}