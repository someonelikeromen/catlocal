// 通用小工具：ID、时间、深合并、错误归一化等。
// 全部零依赖，只用 node 标准库。

import crypto from "node:crypto";

/** 当前时间 ISO 字符串（本地时区偏移保留） */
export function nowIso() {
  return new Date().toISOString();
}

/** 生成短随机 id，前缀可读 */
export function randomId(prefix = "id", bytes = 6) {
  const hex = crypto.randomBytes(bytes).toString("hex");
  return `${prefix}_${hex}`;
}

/** 生成 API Key（客户端密钥） */
export function randomKey(prefix = "cat") {
  const hex = crypto.randomBytes(18).toString("base64url");
  return `${prefix}-${hex}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** 深合并：对象递归合并，数组与标量直接覆盖（patch 优先） */
export function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch === undefined ? base : patch;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

/** 取对象嵌套值：getDeep(obj, "a.b.c") */
export function getDeep(obj, path) {
  let cur = obj;
  for (const seg of String(path).split(".")) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** 设置对象嵌套值（会自动创建中间对象） */
export function setDeep(obj, path, value) {
  const segs = String(path).split(".");
  let cur = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i];
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[segs[segs.length - 1]] = value;
  return obj;
}

export function safeJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function isAbortError(err) {
  if (!err) return false;
  return (
    err.name === "AbortError" ||
    err.code === "ABORT_ERR" ||
    err.code === "CATLOCAL_ABORTED" ||
    err.code === "CATLOCAL_TIMEOUT" ||
    err.code === "CATLOCAL_QUEUE_TIMEOUT"
  );
}

/** 从上游错误响应里抠出人能看懂的一句话 */
export function upstreamMessage(bodyText, fallbackStatus) {
  if (!bodyText) return `上游 HTTP ${fallbackStatus}`;
  const parsed = safeJson(bodyText, null);
  if (parsed && typeof parsed === "object") {
    const cand =
      getDeep(parsed, "error.message") ??
      parsed.detail ??
      parsed.message ??
      getDeep(parsed, "error");
    if (typeof cand === "string" && cand.trim()) return cand.trim().slice(0, 600);
  }
  return String(bodyText).trim().slice(0, 600) || `上游 HTTP ${fallbackStatus}`;
}

/**
 * 应用级错误：带 HTTP 状态码与机器可读 code，便于对外输出与日志区分。
 */
export class GatewayError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export function gwErr(status, code, message, extra) {
  return new GatewayError(status, code, message, extra);
}

/** 掩码敏感串（日志用） */
export function mask(secret, keep = 6) {
  const s = String(secret ?? "");
  if (!s) return "";
  if (s.length <= keep * 2) return "*".repeat(s.length);
  return `${s.slice(0, keep)}…${s.slice(-keep)}`;
}

/** 字节数 → 人类可读 */
export function humanBytes(n) {
  const units = ["B", "KB", "MB", "GB"];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

/** 从 SSE/JSON 文本里剥离 XSSI 前缀 )]}' */
export function stripXssi(text) {
  return String(text ?? "").replace(/^\)\]\}'?\s*\n?/, "");
}

/** AI Studio 套餐档位：脚本头 x-aistudio-g1-tier → 引擎认的 tier 名 */
export const TIER_MAP = { TIER0: "Free", TIER1: "Pro", TIER2: "Ultra", TIER3: "Ultra_20X" };

/** 按脚本回传的请求头解析 tier（认不出就不传，交给引擎自己判定） */
export function tierFromHeaders(headers) {
  const raw = headers?.["x-aistudio-g1-tier"];
  if (!raw) return undefined;
  return TIER_MAP[String(raw).toUpperCase()];
}
