// 工具调用签名缓存（thought_signature）。
//
// 为什么需要：Gemini 3 系列要求把助手发起的 functionCall 回灌给上游时必须带上
// 它当初随该 functionCall 下发的 thoughtSignature，否则上游直接 400：
//   "Function call is missing a thought_signature in functionCall parts."
// 而 OpenAI 的 tool_calls 结构里没有这个字段位置，绝大多数客户端（OpenAI SDK、
// Cherry Studio、各类 agent 框架）在把 assistant 消息拼回去时只保留
// id/type/function，签名会在往返途中丢失。
//
// 做法：网关下发响应时按 tool_call id 把签名记下来，回灌时若客户端没带签名就按 id 补上。
// 只做尽力而为：id 是客户端一定会保留的字段，所以这条路能覆盖绝大多数客户端。
// 缓存只在内存里，重启即失效；TTL 内命中即可，未命中就让上游按原样拒绝（不伪造）。
const TTL_MS = 6 * 60 * 60 * 1000; // 6 小时：足够一个长会话来回
const MAX_ENTRIES = 2000;

const cache = new Map(); // id -> { sig, at }

export function rememberSignature(id, sig) {
  if (!id || typeof sig !== "string" || !sig) return;
  cache.set(String(id), { sig, at: Date.now() });
  if (cache.size > MAX_ENTRIES) prune();
}

export function lookupSignature(id) {
  if (!id) return null;
  const hit = cache.get(String(id));
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(String(id));
    return null;
  }
  return hit.sig;
}

/** 从 tool_call 的各个可能位置取签名（显式带优先，缓存兜底） */
export function signatureOfToolCall(call) {
  const explicit =
    call?.extra_content?.google?.thought_signature ||
    call?.extra_content?.google?.thoughtSignature ||
    call?.thought_signature ||
    call?.thoughtSignature ||
    call?.function?.thought_signature ||
    call?.function?.thoughtSignature ||
    null;
  if (typeof explicit === "string" && explicit) return explicit;
  return lookupSignature(call?.id);
}

function prune() {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.at > TTL_MS) cache.delete(k);
  }
  // 仍然超限：按插入顺序丢掉最旧的（Map 保序）
  while (cache.size > MAX_ENTRIES) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
}

export function signatureCacheStats() {
  return { size: cache.size, ttlMs: TTL_MS, max: MAX_ENTRIES };
}
