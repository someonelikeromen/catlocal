#!/usr/bin/env node
// 自测：单元 + 端到端（假引擎），覆盖路由、协议转换、并发限流、WS 执行器、cat 协议。
// 设计为完全离线：不碰真实 Google/任何外部服务。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// ── 测试框架（极简）────────────────────────────────────
const results = [];
let currentGroup = "(未分组)";
function group(name) {
  currentGroup = name;
  console.log(`\n\x1b[36m▶ ${name}\x1b[0m`);
}
async function t(name, fn, { timeoutMs = 30000 } = {}) {
  const started = Date.now();
  try {
    let timerHandle;
    await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timerHandle = setTimeout(() => reject(new Error(`测试超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timerHandle));
    const ms = Date.now() - started;
    results.push({ name, ok: true, ms });
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[90m(${ms}ms)\x1b[0m`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m`);
    console.log(`    \x1b[31m${err?.stack || err}\x1b[0m`);
  }
}

// 全局看门狗：任何环节卡死都不让测试无限挂着
setTimeout(() => {
  console.log("\n\x1b[31m全局超时：测试进程卡住了，强制退出\x1b[0m");
  process.exit(2);
}, 240000);

async function waitFor(fn, { timeoutMs = 15000, intervalMs = 150, label = "" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  throw new Error(`等待超时${label ? `（${label}）` : ""}：${lastErr?.message || lastErr}`);
}

// ── 单元：协议转换 ──────────────────────────────────────
group("单元 · 协议转换");
const convert = await import(pathToFileURL(path.join(ROOT, "src", "convert.mjs")).href);

await t("OpenAI 请求 → Gemini：system/多轮/工具/图片都在", async () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const gem = convert.openaiToGemini({
    model: "gemini-x",
    messages: [
      { role: "system", content: "你是助手" },
      { role: "user", content: [{ type: "text", text: "看这张图" }, { type: "image_url", image_url: { url: png } }] },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"杭州"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"temp":21}' },
    ],
    tools: [{ type: "function", function: { name: "get_weather", description: "查天气", parameters: { type: "object" } } }],
    temperature: 0.3,
    max_tokens: 256,
    stop: ["END"],
  });
  assert.equal(gem.systemInstruction.parts[0].text, "你是助手");
  assert.equal(gem.contents[0].role, "user");
  assert.equal(gem.contents[0].parts[1].inlineData.mimeType, "image/png");
  assert.equal(gem.contents[1].role, "model");
  assert.equal(gem.contents[1].parts[0].functionCall.name, "get_weather");
  assert.deepEqual(gem.contents[1].parts[0].functionCall.args, { city: "杭州" });
  assert.equal(gem.contents[2].role, "user");
  assert.equal(gem.contents[2].parts[0].functionResponse.name, "get_weather");
  assert.equal(gem.generationConfig.maxOutputTokens, 256);
  assert.deepEqual(gem.generationConfig.stopSequences, ["END"]);
  assert.equal(gem.tools[0].functionDeclarations[0].name, "get_weather");
});

await t("Gemini 响应 → OpenAI chat.completion（文本 + usage）", async () => {
  const out = convert.geminiToOpenaiResponse(
    {
      candidates: [{ content: { parts: [{ text: "你好" }] }, finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
      modelVersion: "gemini-3.8-flash",
    },
    { model: "gemini-3.8-flash" }
  );
  assert.equal(out.object, "chat.completion");
  assert.equal(out.choices[0].message.content, "你好");
  assert.equal(out.choices[0].finish_reason, "length");
  assert.equal(out.usage.total_tokens, 8);
});

await t("Gemini 分块 → OpenAI chunk delta（thought 归 reasoning_content）", async () => {
  const chunk = convert.geminiChunkToOpenaiDelta(
    { candidates: [{ content: { parts: [{ text: "思考", thought: true }, { text: "答案" }] } }] },
    { model: "m", id: "x", created: 1, roleSent: false }
  );
  assert.equal(chunk.object, "chat.completion.chunk");
  assert.equal(chunk.choices[0].delta.role, "assistant");
  assert.equal(chunk.choices[0].delta.content, "答案");
  assert.equal(chunk.choices[0].delta.reasoning_content, "思考");
});

await t("finishReason 映射", async () => {
  assert.equal(convert.mapFinishReason("STOP"), "stop");
  assert.equal(convert.mapFinishReason("MAX_TOKENS"), "length");
  assert.equal(convert.mapFinishReason("SAFETY"), "content_filter");
  assert.equal(convert.mapFinishReason("MALFORMED_FUNCTION_CALL"), "tool_calls");
  assert.equal(convert.mapFinishReason(null), null);
});

await t("thoughtSignature：响应侧透出到 extra_content 并记入缓存", async () => {
  const out = convert.geminiToOpenaiResponse(
    {
      candidates: [
        {
          content: { parts: [{ thoughtSignature: "SIG_ABC", functionCall: { name: "get_today", args: {}, id: "call_sig1" } }] },
          finishReason: "STOP",
        },
      ],
    },
    { model: "gemini-4-neon" }
  );
  const call = out.choices[0].message.tool_calls[0];
  assert.equal(call.id, "call_sig1");
  assert.equal(call.extra_content.google.thought_signature, "SIG_ABC");
});

await t("thoughtSignature：回灌时客户端没带签名，按 tool_call id 从缓存补齐", async () => {
  // 先让缓存记住 call_sig1 → SIG_ABC（上一条测试已写入；这里独立再写一次，避免顺序依赖）
  const convert2 = convert;
  convert2.geminiToOpenaiResponse(
    { candidates: [{ content: { parts: [{ thoughtSignature: "SIG_ABC", functionCall: { name: "get_today", args: {}, id: "call_sig1" } }] } }] },
    { model: "gemini-4-neon" }
  );
  // 客户端按 OpenAI 标准拼回去：只有 id/type/function，没有 extra_content
  const gem = convert.openaiToGemini({
    messages: [
      { role: "user", content: "今天几号" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_sig1", type: "function", function: { name: "get_today", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_sig1", content: "2026-11-22" },
    ],
  });
  const modelTurn = gem.contents.find((c) => c.role === "model");
  assert.equal(modelTurn.parts[0].functionCall.name, "get_today");
  assert.equal(modelTurn.parts[0].thoughtSignature, "SIG_ABC", "必须从缓存补回签名，否则上游 400");
});

await t("thoughtSignature：客户端显式回传 extra_content 时以它为准", async () => {
  const gem = convert.openaiToGemini({
    messages: [
      { role: "user", content: "查一下" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_sig2",
            type: "function",
            function: { name: "get_today", arguments: "{}" },
            extra_content: { google: { thought_signature: "SIG_EXPLICIT" } },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_sig2", content: "ok" },
    ],
  });
  const modelTurn = gem.contents.find((c) => c.role === "model");
  assert.equal(modelTurn.parts[0].thoughtSignature, "SIG_EXPLICIT");
});

// ── 单元：凭证自愈 ──────────────────────────────────────
group("单元 · 凭证自愈");
const autoRecover = await import(pathToFileURL(path.join(ROOT, "src", "auto-recover.mjs")).href);

// 生产默认是关的（见 config.mjs 注释）；要测「打开后」的行为，必须显式给 enabled:true。
const recoveryConfig = (over = {}) => ({ channels: { studio: { autoRecover: { enabled: true, ...over } } } });
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

await t("失败分类：只认凭证类失败，参数错误/取消不算", async () => {
  const yes = [
    new Error("Studio 上游 503：No available accounts for this request."),
    Object.assign(new Error("x"), { message: "HTTP 503: 无可用备用账号: model=models/gemini-4-neon" }),
    new Error("session_expired"),
    new Error("UNAUTHENTICATED"),
  ];
  for (const e of yes) assert.equal(autoRecover.isCredentialFailure(e), true, `应判为凭证失败：${e.message}`);
  const no = [
    new Error("HTTP 400: invalid argument"),
    Object.assign(new Error("请求已取消"), { status: 499, code: "cancelled" }),
    new Error("429 rate limited"),
    null,
  ];
  for (const e of no) assert.equal(autoRecover.isCredentialFailure(e), false, `不应判为凭证失败：${e?.message}`);
});

await t("默认关闭：配置里没写 enabled 时，凭证失败一律不采集", async () => {
  // 这是安全契约：生产 config.json 里 autoRecover.enabled 默认 false，
  // 少了这条，任何一次「升级后配置文件没写键」都会变成自动抓 Cookie。
  let collects = 0;
  const r = new autoRecover.AutoRecovery({
    studio: { importCookies: async () => ({}) },
    executors: {
      size: 1,
      collect: async () => {
        collects++;
        return { cookies: [{ name: "SID", value: "1" }] };
      },
    },
    store: { recordPush: () => {} },
    log: quietLog,
    config: {},
  });
  const out = await r.recover(new Error("No available accounts"));
  assert.equal(out.recovered, false);
  assert.equal(out.reason, "disabled");
  assert.equal(collects, 0, "关闭状态下一次都不该碰浏览器 Cookie");
  assert.equal(r.snapshot().enabled, false);
  assert.equal(r.snapshot().skippedDisabled, 1);

  // 显式 enabled:false 同样不采集
  const r2 = new autoRecover.AutoRecovery({
    studio: { importCookies: async () => ({}) },
    executors: { size: 1, collect: async () => ({ cookies: [{ name: "SID", value: "1" }] }) },
    store: { recordPush: () => {} },
    log: quietLog,
    config: { channels: { studio: { autoRecover: { enabled: false } } } },
  });
  assert.equal((await r2.recover(new Error("session_expired"))).reason, "disabled");
});

await t("自愈：没有在线执行器时直接放弃，且不占用冷却窗口", async () => {
  const collected = [];
  const fake = {
    size: 0,
    collect: async () => {
      collected.push(1);
      return { cookies: [] };
    },
  };
  const r = new autoRecover.AutoRecovery({
    studio: { importCookies: async () => ({}) },
    executors: fake,
    store: { recordPush: () => {} },
    log: quietLog,
    config: recoveryConfig(),
  });
  const out = await r.recover(new Error("No available accounts"));
  assert.equal(out.recovered, false);
  assert.equal(out.reason, "no_executor");
  assert.equal(collected.length, 0, "没有执行器就不该发采集请求");
  assert.equal(r.snapshot().nextAllowedInMs, 0, "没真正尝试过就不该进入冷却");
});

await t("自愈：并发失败只采一次（单飞）", async () => {
  let collects = 0;
  const fake = {
    size: 1,
    collect: async () => {
      collects++;
      await new Promise((r) => setTimeout(r, 30));
      return { cookies: [{ name: "SID", value: "1" }], email: "a@b.c", authuser: "0", headers: {} };
    },
  };
  let imports = 0;
  const r = new autoRecover.AutoRecovery({
    studio: {
      importCookies: async ({ cookies }) => {
        imports++;
        assert.equal(cookies.length, 1);
        return { account_id: "acc_x", cookie_count: 1, name: "a@b.c" };
      },
    },
    executors: fake,
    store: { recordPush: () => {} },
    log: quietLog,
    config: recoveryConfig(),
  });
  const [a, b, c] = await Promise.all([
    r.recover(new Error("No available accounts")),
    r.recover(new Error("No available accounts")),
    r.recover(new Error("No available accounts")),
  ]);
  assert.equal(a.recovered, true);
  assert.equal(b.recovered, true, "并发失败应共享同一次采集结果");
  assert.equal(c.recovered, true);
  assert.equal(collects, 1, `三次并发失败只应采集一次，实际 ${collects}`);
  assert.equal(imports, 1);
});

await t("自愈：限频窗口内不再重复采集", async () => {
  let collects = 0;
  const fake = {
    size: 1,
    collect: async () => {
      collects++;
      return { cookies: [{ name: "SID", value: "1" }], authuser: "0", headers: {} };
    },
  };
  const r = new autoRecover.AutoRecovery({
    studio: { importCookies: async () => ({ account_id: "acc_y", cookie_count: 1 }) },
    executors: fake,
    store: { recordPush: () => {} },
    log: quietLog,
    config: recoveryConfig({ minIntervalMs: 60000 }),
  });
  const first = await r.recover(new Error("No available accounts"));
  assert.equal(first.recovered, true);
  const second = await r.recover(new Error("No available accounts"));
  assert.equal(second.recovered, false);
  assert.equal(second.reason, "cooldown");
  assert.equal(collects, 1, "冷却窗口内不应再采集");
  assert.ok(r.snapshot().nextAllowedInMs > 0);
});

await t("自愈：采集失败不抛错，只记账", async () => {
  const r = new autoRecover.AutoRecovery({
    studio: { importCookies: async () => ({}) },
    executors: {
      size: 1,
      collect: async () => {
        throw new Error("浏览器采集超时");
      },
    },
    store: { recordPush: () => {} },
    log: quietLog,
    config: recoveryConfig(),
  });
  const out = await r.recover(new Error("No available accounts"));
  assert.equal(out.recovered, false);
  assert.equal(out.reason, "error");
  assert.match(out.error, /浏览器采集超时/);
  const s = r.snapshot();
  assert.equal(s.attempts, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.recovered, 0);
});

await t("自愈：导入后复核，账号仍不可用就不假装成功", async () => {
  // 账号被手工停用这种情况，采集再多次也没用：必须如实返回失败，避免再打一次注定失败的上游
  const r = new autoRecover.AutoRecovery({
    studio: {
      importCookies: async () => ({ account_id: "acc_z", cookie_count: 17 }),
      rotation: async () => ({
        accounts: {
          acc_z: { enabled: false, is_available: false, session_expired: false, cooldown_remaining: 0 },
        },
      }),
    },
    executors: { size: 1, collect: async () => ({ cookies: [{ name: "SID", value: "1" }], authuser: "0", headers: {} }) },
    store: { recordPush: () => {} },
    log: quietLog,
    config: recoveryConfig(),
  });
  const out = await r.recover(new Error("No available accounts"));
  assert.equal(out.recovered, false);
  assert.equal(out.reason, "account_disabled");
  const s = r.snapshot();
  assert.equal(s.unusable, 1);
  assert.equal(s.failed, 0, "采集本身是成功的，只是账号不可用");
});

await t("自愈：导入后账号恢复可用则判定成功", async () => {
  const r = new autoRecover.AutoRecovery({
    studio: {
      importCookies: async () => ({ account_id: "acc_w", cookie_count: 17 }),
      rotation: async () => ({
        accounts: {
          acc_w: { enabled: true, is_available: true, session_expired: false, cooldown_remaining: 0 },
        },
      }),
    },
    executors: { size: 1, collect: async () => ({ cookies: [{ name: "SID", value: "1" }], authuser: "0", headers: {} }) },
    store: { recordPush: () => {} },
    log: quietLog,
    config: recoveryConfig(),
  });
  const out = await r.recover(new Error("session_expired"));
  assert.equal(out.recovered, true);
  assert.equal(out.accountId, "acc_w");
});

// ── 单元：并发限流 ──────────────────────────────────────
group("单元 · 并发限流");
const { Limiter } = await import(pathToFileURL(path.join(ROOT, "src", "limiter.mjs")).href);

await t("并发上限被严格遵守（峰值 = 2）", async () => {
  const lim = new Limiter("t", { concurrency: 2, maxQueue: 10, queueTimeoutMs: 5000 });
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 6 }, () =>
    (async () => {
      const release = await lim.acquire();
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 40));
      active--;
      release();
    })()
  );
  await Promise.all(tasks);
  assert.equal(peak, 2, `峰值应为 2，实测 ${peak}`);
  assert.equal(lim.active, 0);
  assert.equal(lim.queued, 0);
});

await t("队列满 → 立刻 429 channel_busy", async () => {
  const lim = new Limiter("t", { concurrency: 1, maxQueue: 1, queueTimeoutMs: 5000 });
  const r1 = await lim.acquire();
  const r2Promise = lim.acquire(); // 占 1 个排队位
  await assert.rejects(() => lim.acquire(), (err) => err.status === 429 && err.code === "channel_busy");
  r1();
  const r2 = await r2Promise;
  r2();
});

await t("排队超时 → 429 queue_timeout", async () => {
  const lim = new Limiter("t", { concurrency: 1, maxQueue: 5, queueTimeoutMs: 80 });
  const r1 = await lim.acquire();
  await assert.rejects(() => lim.acquire(), (err) => err.status === 429 && err.code === "queue_timeout");
  r1();
});

await t("resize 立刻放行排队请求", async () => {
  const lim = new Limiter("t", { concurrency: 1, maxQueue: 5, queueTimeoutMs: 3000 });
  const r1 = await lim.acquire();
  const p2 = lim.acquire();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(lim.queued, 1);
  lim.resize(2);
  const r2 = await p2;
  assert.equal(lim.active, 2);
  r1();
  r2();
});

// ── 单元：WS 服务端 ─────────────────────────────────────
group("单元 · WebSocket 服务端");
const { attachWebSocket } = await import(pathToFileURL(path.join(ROOT, "src", "ws-server.mjs")).href);

await t("握手 / 收发 / 关闭码全链路", async () => {
  const server = http.createServer((req, res) => res.end("ok"));
  const conns = [];
  attachWebSocket(server, (req, conn) => {
    conns.push(conn);
    conn.onmessage = (text) => {
      const msg = JSON.parse(text);
      if (msg.type === "hello") conn.send({ type: "welcome", echo: msg.value });
      if (msg.type === "bye") conn.close(4001, "顶替");
    };
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pg/ws`);
  const welcome = await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", value: 42 }));
    ws.onmessage = (ev) => resolve(JSON.parse(ev.data));
    ws.onerror = (e) => reject(new Error("ws error " + e.message));
    setTimeout(() => reject(new Error("ws 无响应")), 3000);
  });
  assert.deepEqual(welcome, { type: "welcome", echo: 42 });

  const closed = await new Promise((resolve) => {
    ws.onclose = (ev) => resolve(ev.code);
    ws.send(JSON.stringify({ type: "bye" }));
    setTimeout(() => resolve(-1), 3000);
  });
  assert.equal(closed, 4001);
  ws.close();
  server.close();
});

// ── 单元：引擎托管 ──────────────────────────────────────
// 回归守卫：restart() 曾经死锁 —— 它先 stop()，再 start({force:true})，
// 而 start 内部又调一次 stop()；第二次 stop 把 once("exit") 挂到**已退出**的
// 子进程上，事件永不再来 ⇒ Promise 永不 resolve ⇒ 状态卡在 stopping、引擎起不来。
// 表现是 POST /admin/api/channels/:name/restart 永久挂起。
group("单元 · 引擎托管");
const { Supervisor } = await import(pathToFileURL(path.join(ROOT, "src", "supervisor.mjs")).href);
const QUIET_LOG = { info() {}, warn() {}, error() {}, debug() {} };

await t("Supervisor.restart：连续重启不死锁，状态不卡在 stopping", async () => {
  const sup = new Supervisor({
    config: {
      channels: {
        fake: {
          baseUrl: "http://127.0.0.1:19999",
          managed: { enabled: true, cwd: ".", command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
        },
      },
    },
    log: QUIET_LOG,
  });
  const withTimeout = (p, ms, label) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时（疑似死锁）`)), ms))]);

  try {
    const s1 = await sup.start("fake");
    assert.equal(s1.ok, true);
    assert.ok(s1.pid > 0);

    const r1 = await withTimeout(sup.restart("fake"), 15000, "第 1 次 restart");
    assert.equal(r1.ok, true, "restart 应返回 ok");
    assert.ok(r1.pid > 0, "restart 后应有新 pid");

    const r2 = await withTimeout(sup.restart("fake"), 15000, "第 2 次 restart");
    assert.equal(r2.ok, true);
    assert.ok(r2.pid > 0);

    const st = sup.status().fake;
    assert.notEqual(st.status, "stopping", "状态不能卡在 stopping");
    assert.ok(st.pid > 0, "状态里应有 pid");

    await withTimeout(sup.stop("fake"), 15000, "stop");
    assert.equal(sup.status().fake.status, "stopped");
  } finally {
    await sup.stop("fake").catch(() => {});
  }
});

// ── 单元：执行器池 ──────────────────────────────────────
// 这一组直接驱动 ExecutorPool（不经过网关），覆盖注册/鉴权/顶替/上限/
// 采集/派发/心跳清理/未注册超时这些「只有异常路径才会走到」的分支。
group("单元 · 执行器池");
const { ExecutorPool } = await import(pathToFileURL(path.join(ROOT, "src", "executors.mjs")).href);

/** 起一个只接执行器 WS 的迷你服务器 + 一个执行器池 */
async function makePool(opts = {}, authorize = (key) => ({ ok: true, token: key || "anon" })) {
  const pool = new ExecutorPool({ log: QUIET_LOG, ...opts });
  const server = http.createServer((req, res) => res.end("ok"));
  attachWebSocket(server, (req, conn) => pool.handleConnection(conn, authorize));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${server.address().port}/api/pg/ws`;
  const stop = async () => {
    pool.closeAll();
    try {
      server.closeAllConnections?.();
    } catch {
      /* ignore */
    }
    await new Promise((r) => server.close(r));
  };
  return { pool, url, stop };
}

/** 打开一条执行器连接：发 register，等到 registered 或连接关闭 */
function openExecutor(url, { apiKey = "tok-a", clientVersion = "2.21.0", executorType = "playground", onMessage } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const state = { ws, messages: [], closedCode: null };
    const timer = setTimeout(() => reject(new Error("openExecutor 超时")), 4000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "register", apiKey, clientVersion, executorType }));
    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      state.messages.push(m);
      onMessage?.(m, state);
      if (m.type === "registered") {
        clearTimeout(timer);
        resolve(state);
      }
    };
    ws.onclose = (ev) => {
      state.closedCode = ev.code;
      clearTimeout(timer);
      resolve(state);
    };
    ws.onerror = () => {};
  });
}

/** 等某个连接真正关闭，返回关闭码 */
async function waitClose(state, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (state.closedCode != null) return state.closedCode;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

await t("注册成功 → registered 帧 + 池快照字段齐全", async () => {
  const { pool, url, stop } = await makePool();
  const ex = await openExecutor(url);
  assert.ok(ex.messages.some((m) => m.type === "registered"), "应收到 registered");
  const snap = pool.snapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].clientVersion, "2.21.0");
  assert.equal(snap[0].executorType, "playground");
  assert.match(snap[0].token, /^tok-a/, "快照里的 token 应是打码后的前缀");
  const stats = pool.poolStats();
  assert.equal(stats.online, 1);
  assert.equal(stats.registered, 1);
  ex.ws.close();
  await stop();
});

await t("注册鉴权失败 → 关闭码 4008 且池为空", async () => {
  const { pool, url, stop } = await makePool({}, () => ({ ok: false, code: 4008, reason: "Key 无效" }));
  const ex = await openExecutor(url);
  assert.equal(ex.closedCode, 4008);
  assert.equal(pool.size, 0);
  assert.equal(pool.poolStats().rejected, 1);
  await stop();
});

await t("同 token 新连接顶替旧连接（旧连接 4001，池内只留 1 个）", async () => {
  const { pool, url, stop } = await makePool();
  const first = await openExecutor(url, { apiKey: "same" });
  const firstId = pool.snapshot()[0].id;
  const second = await openExecutor(url, { apiKey: "same" });
  const secondId = pool.snapshot()[0].id;
  assert.notEqual(firstId, secondId, "应是新的执行器实例");
  assert.equal(pool.size, 1, "池内只应剩 1 个");
  assert.equal(pool.poolStats().replaced, 1);
  assert.equal(await waitClose(first), 4001, "旧连接应收到 4001");
  second.ws.close();
  await stop();
});

await t("超过 maxExecutors 上限 → 关闭码 4008", async () => {
  const { pool, url, stop } = await makePool({ maxExecutors: 1 });
  const a = await openExecutor(url, { apiKey: "a" });
  const b = await openExecutor(url, { apiKey: "b" });
  assert.equal(pool.size, 1, "只应保留第一个");
  assert.equal(b.closedCode, 4008);
  assert.equal(pool.poolStats().rejected, 1);
  a.ws.close();
  await stop();
});

await t("未在 registerTimeoutMs 内注册 → 关闭码 4008", async () => {
  const { pool, url, stop } = await makePool({ registerTimeoutMs: 120 });
  const code = await new Promise((resolve) => {
    const ws = new WebSocket(url); // 故意不发 register
    ws.onclose = (ev) => resolve(ev.code);
    ws.onerror = () => {};
    setTimeout(() => resolve(null), 3000);
  });
  assert.equal(code, 4008);
  assert.equal(pool.poolStats().rejected, 1);
  await stop();
});

await t("采集：成功回传 cookies / headers / email / authuser / 指纹", async () => {
  const { pool, url, stop } = await makePool();
  const ex = await openExecutor(url, {
    onMessage: (m, st) => {
      if (m.type !== "collect") return;
      st.ws.send(
        JSON.stringify({
          type: "collect-result",
          requestId: m.requestId,
          status: 200,
          cookies: [{ name: "SID", value: "v", domain: ".google.com" }],
          headers: { "x-aistudio-g1-tier": "TIER1" },
          email: "a@b.com",
          authuser: "3",
          fingerprint: { screenWidth: 1920, screenHeight: 1080, timezone: "Asia/Shanghai", language: "zh-CN" },
        })
      );
    },
  });
  const got = await pool.collect("tok-a");
  assert.equal(got.cookies.length, 1);
  assert.equal(got.cookies[0].name, "SID");
  assert.equal(got.email, "a@b.com");
  assert.equal(got.authuser, "3");
  assert.equal(got.headers["x-aistudio-g1-tier"], "TIER1");
  assert.equal(got.fingerprint.screenWidth, 1920);
  assert.equal(pool.poolStats().collected, 1);
  ex.ws.close();
  await stop();
});

await t("采集：脚本回传失败 → reject 且带上游 code", async () => {
  const { pool, url, stop } = await makePool();
  const ex = await openExecutor(url, {
    onMessage: (m, st) => {
      if (m.type !== "collect") return;
      st.ws.send(
        JSON.stringify({
          type: "collect-result",
          requestId: m.requestId,
          status: 500,
          error: { code: "collect_failed", message: "未采集到任何 Cookie" },
        })
      );
    },
  });
  await assert.rejects(
    () => pool.collect("tok-a"),
    (err) => {
      assert.equal(err.status, 500);
      assert.equal(err.code, "collect_failed");
      assert.match(err.message, /未采集到任何 Cookie/);
      return true;
    }
  );
  ex.ws.close();
  await stop();
});

await t("采集：执行器不回应 → 超时 504 collect_timeout", async () => {
  const { pool, url, stop } = await makePool();
  const ex = await openExecutor(url); // 收到 collect 也不回
  await assert.rejects(
    () => pool.collect("tok-a", { timeoutMs: 200 }),
    (err) => {
      assert.equal(err.status, 504);
      assert.equal(err.code, "collect_timeout");
      return true;
    }
  );
  ex.ws.close();
  await stop();
});

await t("采集/派发：无在线执行器 → 503 no_executor", async () => {
  const { pool, stop } = await makePool();
  await assert.rejects(
    () => pool.collect(""),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, "no_executor");
      return true;
    }
  );
  await assert.rejects(
    () => pool.dispatch({ token: "", model: "m", payload: {} }),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, "no_executor");
      return true;
    }
  );
  await stop();
});

await t("派发：流式分块按序回传并正常收尾", async () => {
  const { pool, url, stop } = await makePool();
  const ex = await openExecutor(url, {
    onMessage: (m, st) => {
      if (m.type !== "request") return;
      st.ws.send(JSON.stringify({ type: "stream-chunk", requestId: m.requestId, chunkBody: "甲" }));
      st.ws.send(JSON.stringify({ type: "stream-chunk", requestId: m.requestId, chunkBody: "乙" }));
      st.ws.send(JSON.stringify({ type: "stream-end", requestId: m.requestId, status: 200 }));
    },
  });
  const chunks = [];
  const res = await pool.dispatch({
    token: "tok-a",
    model: "gemini-x",
    stream: true,
    payload: { contents: [] },
    onChunk: (c) => chunks.push(c),
  });
  assert.equal(res.kind, "stream");
  assert.equal(chunks.join(""), "甲乙");
  assert.equal(pool.poolStats().dispatched, 1);
  ex.ws.close();
  await stop();
});

await t("派发：非流式 → response 原样回传", async () => {
  const { pool, url, stop } = await makePool();
  const ex = await openExecutor(url, {
    onMessage: (m, st) => {
      if (m.type !== "request") return;
      st.ws.send(JSON.stringify({ type: "response", requestId: m.requestId, status: 200, rawResponse: '{"ok":1}' }));
    },
  });
  const res = await pool.dispatch({ token: "tok-a", model: "gemini-x", payload: {} });
  assert.equal(res.kind, "json");
  assert.equal(res.status, 200);
  assert.equal(res.raw, '{"ok":1}');
  ex.ws.close();
  await stop();
});

await t("心跳巡检：静默执行器被清退（evicted）", async () => {
  const { pool, url, stop } = await makePool({ heartbeatTimeoutMs: 60, sweepIntervalMs: 40 });
  const ex = await openExecutor(url); // 不回 ping，lastSeen 不再刷新
  await waitFor(
    () => {
      if (pool.size !== 0) throw new Error(`池内仍有 ${pool.size} 个执行器`);
      return true;
    },
    { timeoutMs: 4000, intervalMs: 40 }
  );
  assert.equal(pool.poolStats().evicted, 1);
  assert.equal(await waitClose(ex), 4008, "被清退的连接应收到 4008");
  await stop();
});

await t("非 JSON / 未知消息被忽略，连接不中断且照常回 pong", async () => {
  const { pool, url, stop } = await makePool();
  const ex = await openExecutor(url);
  ex.ws.send("这不是 JSON");
  ex.ws.send(JSON.stringify({ type: "某个没见过的类型" }));
  ex.ws.send(JSON.stringify({ type: "ping", ts: 12345 }));
  const pong = await waitFor(
    () => {
      const m = ex.messages.find((x) => x.type === "pong");
      if (!m) throw new Error("没收到 pong");
      return m;
    },
    { timeoutMs: 2000, intervalMs: 25 }
  );
  // 网关回的 pong.ts 是服务端时间戳（不是回显客户端 ts）
  assert.equal(typeof pong.ts, "number");
  assert.ok(Math.abs(pong.ts - Date.now()) < 60000, "pong 应带近期服务端时间戳");
  assert.equal(pool.size, 1, "连接应仍然在线");
  ex.ws.close();
  await stop();
});

await t("pick：优先最闲；指定 token 时只在该 token 内选", async () => {
  const { pool, url, stop } = await makePool();
  const a = await openExecutor(url, { apiKey: "a" });
  const b = await openExecutor(url, { apiKey: "b" });
  const [ea, eb] = pool.snapshot();
  pool.executors.get(ea.id).inflight = 3;
  pool.executors.get(eb.id).inflight = 0;
  assert.equal(pool.pick().id, eb.id, "应选 inflight 更少的那个");
  assert.equal(pool.pick("a").id, ea.id, "指定 token 时应只在其内部选");
  a.ws.close();
  b.ws.close();
  await stop();
});

// ── 单元：cat 脚本补丁 ─────────────────────────────────
group("单元 · cat 脚本补丁");
const { CatScript } = await import(pathToFileURL(path.join(ROOT, "src", "cat-script.mjs")).href);
// 独立临时目录（TMP 在本段之后才定义）
const UNIT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "catlocal-unit-"));

const MASTER_MIN = `// ==UserScript==
// @name         Catiecli Playground Executor
// @version      2.21.0
// @namespace    https://catiecli.sukaka.top/
// @connect      catiecli.sukaka.top
// @downloadURL  https://catiecli.sukaka.top/api/pg/script.user.js
// @updateURL    https://catiecli.sukaka.top/api/pg/script.user.js
// @homepageURL  https://catiecli.sukaka.top/
// ==/UserScript==
(function () {
    const WS_URL = "wss://catiecli.sukaka.top/api/pg/ws";
    const PUSH_URL = "https://catiecli.sukaka.top/api/pggo/push";
    const SCRIPT_URL = "https://catiecli.sukaka.top/api/pg/script.user.js";
    const ROBIN_BIND_URL = "https://catiecli.sukaka.top/api/robin/bind-by-key";
    const cfg = { apiKey: gmStore.get(API_KEY_STORE_KEY, "") };
    // ==================== WS 客户端 ====================
    function connectWs() {
        ws.onmessage = (ev) => {
            switch (msg.type) {
                case "request":
                    break;
                default:
                    break;
            }
        };
    }
})();
`;

function makeCatScript({ defaultKey = null, dir }) {
  const file = path.join(dir, "catiecli.user.js");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, MASTER_MIN, "utf8");
  return new CatScript({
    config: { cat: { sourcePath: file } },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    defaultKey: () => defaultKey,
  });
}

await t("显式 wss 下传：脚本里写的是 wss，且不留 ws:// 明文地址", async () => {
  const cs = makeCatScript({ dir: path.join(UNIT_TMP, "unit-wss") });
  const built = cs.build({ baseUrl: "http://127.0.0.1:8788", wsUrl: "wss://127.0.0.1:8789/api/pg/ws" });
  assert.ok(built.text.includes('const WS_URL = "wss://127.0.0.1:8789/api/pg/ws"'), "应写入 wss 地址");
  assert.ok(!built.text.includes("ws://127.0.0.1"), "不应残留 ws://");
  assert.ok(built.text.includes('case "collect"'), "应挂 collect 分支");
  assert.equal(built.wsUrl, "wss://127.0.0.1:8789/api/pg/ws");
});

await t("默认 Key 注入：有锚点则写入兜底值", async () => {
  const cs = makeCatScript({ dir: path.join(UNIT_TMP, "unit-key"), defaultKey: "cat-unit-key" });
  const built = cs.build({ baseUrl: "http://127.0.0.1:8788" });
  assert.ok(built.text.includes('|| "cat-unit-key"'), "应注入默认 Key");
  assert.equal(built.keyInjected, true);
});

await t("默认 Key 注入：母版缺锚点时降级而不报错", async () => {
  const dir = path.join(UNIT_TMP, "unit-nokey");
  const file = path.join(dir, "catiecli.user.js");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, MASTER_MIN.replace('const cfg = { apiKey: gmStore.get(API_KEY_STORE_KEY, "") };', ""), "utf8");
  const cs = new CatScript({
    config: { cat: { sourcePath: file } },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    defaultKey: () => "cat-unit-key",
  });
  const built = cs.build({ baseUrl: "http://127.0.0.1:8788" });
  assert.equal(built.keyInjected, false, "缺锚点时应跳过");
  assert.ok(built.text.includes('const WS_URL = "ws://127.0.0.1:8788/api/pg/ws"'), "其余补丁仍应生效");
});

// ── 端到端：假引擎 + 真网关 ────────────────────────────
group("集成 · 网关 + 假引擎");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "catlocal-test-"));
const STUDIO_PORT = 18080;
const ROBIN_PORT = 13000;
const GW_PORT = 18788;
const ADMIN = "adm-test-123";
const RB_ADMIN = "rbadmin-test";
const RB_KEY = "rbkey-test";
const ST_KEY = "stkey-test";

const procs = [];
function startProc(name, args, { cwd = ROOT, env = {} } = {}) {
  const logFile = path.join(TMP, `${name}.log`);
  const out = fs.createWriteStream(logFile, { flags: "a" });
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  child.on("exit", (code) => console.log(`\x1b[90m[${name}] exited ${code}\x1b[0m`));
  procs.push(child);
  return { child, logFile };
}

const configFile = path.join(TMP, "config.json");
fs.writeFileSync(
  configFile,
  JSON.stringify(
    {
      gateway: { host: "127.0.0.1", port: GW_PORT, tls: { enabled: false } },
      auth: { adminToken: ADMIN, requireKey: true, allowLoopbackWithoutKey: false },
      channels: {
        // 页面转发通道（生产默认）。自测里默认通道仍是 studio，
        // 但 pg- / pggo- 前缀会强制走这里，专门的用例会开一个假执行器。
        browser: {
          enabled: true,
          managed: { enabled: false },
          concurrency: 2,
          maxQueue: 16,
          queueTimeoutMs: 20000,
          timeoutMs: 30000,
          retries: 0,
          retryBackoffMs: 100,
          modelsCacheMs: 60000,
          aliases: ["pg", "pggo", "page", "browser"],
        },
        studio: {
          enabled: true,
          baseUrl: `http://127.0.0.1:${STUDIO_PORT}`,
          apiKey: ST_KEY,
          managed: { enabled: false },
          concurrency: 2,
          maxQueue: 16,
          queueTimeoutMs: 20000,
          timeoutMs: 30000,
          idleTimeoutMs: 15000,
          retries: 0,
          retryBackoffMs: 100,
          // 测试环境显式打开凭证自愈（生产默认关闭，见 config.mjs 的注释）
          autoRecover: { enabled: true, minIntervalMs: 1000, collectTimeoutMs: 5000 },
          aliases: ["pg", "pggo", "studio"],
        },
        robin: {
          enabled: true,
          baseUrl: `http://127.0.0.1:${ROBIN_PORT}`,
          apiKey: RB_KEY,
          adminKey: RB_ADMIN,
          managed: { enabled: false },
          concurrency: 2,
          maxQueue: 16,
          queueTimeoutMs: 20000,
          timeoutMs: 30000,
          idleTimeoutMs: 15000,
          retries: 0,
          aliases: ["robin", "rb"],
        },
      },
      routing: { defaultChannel: "studio", failover: false, fallbackOrder: [], failoverMap: {} },
      executors: { enabled: true, dispatch: false, heartbeatTimeoutMs: 60000, maxExecutors: 8 },
      cat: { sourcePath: "" },
      logging: { level: "warn" },
    },
    null,
    2
  ),
  "utf8"
);

startProc("mock-studio", [path.join(HERE, "mock-studio.mjs")], { env: { PORT: String(STUDIO_PORT), MOCK_DELAY_MS: "120" } });
startProc("mock-robin", [path.join(HERE, "mock-robin.mjs")], {
  env: { PORT: String(ROBIN_PORT), ADMIN_KEY: RB_ADMIN, MOCK_DELAY_MS: "120" },
});

const GW = `http://127.0.0.1:${GW_PORT}`;

// 先造一份最小 cat 脚本母版（只要包含打补丁所需的锚点即可），再起网关
fs.writeFileSync(
  path.join(TMP, "catiecli.user.js"),
  `// ==UserScript==
// @name         Catiecli Playground Executor
// @version      2.21.0
// @namespace    https://catiecli.sukaka.top/
// @match        https://aistudio.google.com/*prompts*
// @connect      catiecli.sukaka.top
// @downloadURL  https://catiecli.sukaka.top/api/pg/script.user.js
// @updateURL    https://catiecli.sukaka.top/api/pg/script.user.js
// @homepageURL  https://catiecli.sukaka.top/
// ==/UserScript==
(function () {
    const WS_URL = "wss://catiecli.sukaka.top/api/pg/ws";
    const PUSH_URL = "https://catiecli.sukaka.top/api/pggo/push";
    const SCRIPT_URL = "https://catiecli.sukaka.top/api/pg/script.user.js"; // @downloadURL 同源
    const ROBIN_BIND_URL = "https://catiecli.sukaka.top/api/robin/bind-by-key";
    function cookieApi() { return true; }
    async function collectCookies() { return []; }
    function getHeaders() { return {}; }
    function accountPathPrefix() { return "/"; }
    function detectEmail() { return ""; }
    function collectBrowserFingerprint() { return {}; }
    function wsSend() { return true; }
    function log() {}
    // ==================== WS 客户端 ====================
    function connectWs() {
        ws.onmessage = (ev) => {
            switch (msg.type) {
                case "request":
                    break;
                default:
                    break;
            }
        };
    }
})();
`,
  "utf8"
);

startProc("gateway", [path.join(ROOT, "src", "server.mjs")], {
  env: {
    CATLOCAL_CONFIG: configFile,
    CATLOCAL_DATA_DIR: TMP,
    CATLOCAL_ADMIN_TOKEN: ADMIN,
    CATLOCAL_PORT: String(GW_PORT),
    STUDIO_URL: `http://127.0.0.1:${STUDIO_PORT}`,
    ROBIN_URL: `http://127.0.0.1:${ROBIN_PORT}`,
    STUDIO_API_KEY: ST_KEY,
    ROBIN_API_KEY: RB_KEY,
    CATLOCAL_LOG_LEVEL: "warn",
  },
});

await waitFor(async () => {
  const r = await fetch(`${GW}/healthz`);
  if (!r.ok) throw new Error(`healthz ${r.status}`);
}, { timeoutMs: 20000, label: "网关启动" });

await waitFor(async () => {
  const r = await fetch(`http://127.0.0.1:${STUDIO_PORT}/health`);
  if (!r.ok) throw new Error("studio not ready");
}, { timeoutMs: 10000, label: "等 studio 启动" });

await waitFor(async () => {
  const r = await fetch(`http://127.0.0.1:${ROBIN_PORT}/healthz`);
  if (!r.ok) throw new Error("robin not ready");
}, { timeoutMs: 10000, label: "等 robin 启动" });

async function gwFetch(pathname, { method = "GET", body, key = null, headers = {}, timeoutMs = 20000 } = {}) {
  const h = { "content-type": "application/json", ...headers };
  if (key === "admin") h["x-api-key"] = ADMIN;
  else if (key) h["x-api-key"] = key;
  const resp = await fetch(`${GW}${pathname}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* SSE 文本 */
  }
  return { status: resp.status, text, json, headers: resp.headers };
}

let CLIENT_KEY = null;

await t("healthz 可用", async () => {
  const r = await gwFetch("/healthz");
  assert.equal(r.status, 200);
  assert.equal(r.json.service, "catlocal");
});

await t("无 Key 被拒（401）", async () => {
  const r = await gwFetch("/v1beta/models");
  assert.equal(r.status, 401);
});

await t("管理接口：生成客户端 Key", async () => {
  const r = await gwFetch("/admin/api/keys", { method: "POST", key: "admin", body: { name: "测试", channels: ["*"] } });
  assert.equal(r.status, 200);
  assert.match(r.json.key.token, /^cat-/);
  CLIENT_KEY = r.json.key.token;
});

await t("Gemini 模型清单合并两通道 + 带前缀别名", async () => {
  const r = await gwFetch("/v1beta/models", { key: CLIENT_KEY });
  assert.equal(r.status, 200);
  const names = r.json.models.map((m) => m.name);
  assert.ok(names.includes("models/gemini-3.7-flash"), "应含 studio 模型");
  assert.ok(names.includes("models/gemini-4-argon"), "应含 robin 模型");
  assert.ok(names.some((n) => n.includes("pg/")), "应含带通道前缀的别名");
});

await t("generateContent 默认走 studio", async () => {
  const r = await gwFetch("/v1beta/models/gemini-3.7-flash:generateContent", {
    method: "POST",
    key: CLIENT_KEY,
    body: { contents: [{ role: "user", parts: [{ text: "你好" }] }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-catlocal-channel"), "studio");
  assert.match(r.json.candidates[0].content.parts[0].text, /\[studio:gemini-3\.7-flash\]/);
});

await t("robin/ 前缀强制走 robin 通道", async () => {
  const r = await gwFetch("/v1beta/models/robin%2Fgemini-4-argon:generateContent", {
    method: "POST",
    key: CLIENT_KEY,
    body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
  });
  // 未绑定凭证时 robin 回 401 —— 这正说明路由到了 robin
  assert.equal(r.status, 401);
  assert.match(JSON.stringify(r.json), /凭证未绑定/);
});

await t("studio/ 前缀走无头通道，且剥掉前缀", async () => {
  // pg / pggo 现在归页面转发（见后面的用例）；无头通道只保留 studio/ 前缀
  const r = await gwFetch("/v1beta/models/studio%2Fgemini-3.7-flash:generateContent", {
    method: "POST",
    key: CLIENT_KEY,
    body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
  });
  assert.equal(r.status, 200, `studio/ 前缀应能正常生成：${r.text.slice(0, 160)}`);
  assert.equal(r.headers.get("x-catlocal-channel"), "studio");
  assert.match(r.json.candidates[0].content.parts[0].text, /\[studio:gemini-3\.7-flash\]/, "前缀应被剥掉");
});

// ── 页面转发（真浏览器执行）──────────────────────────────
/** 假执行器：注册后把 request 当成页面请求处理，回 MOCKRAW: 原始响应 */
function openPageExecutor({ streamChunks = 3 } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/pg/ws`);
  const seen = { requests: [], collects: 0 };
  const ready = new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: "register", clientVersion: "2.21.0", apiKey: CLIENT_KEY, executorType: "playground" }));
    ws.onmessage = async (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "registered") return resolve();
      if (m.type === "collect") {
        seen.collects++;
        ws.send(JSON.stringify({ type: "collect-result", requestId: m.requestId, status: 200, cookies: [], headers: {}, email: "page@example.com", authuser: "0" }));
        return;
      }
      if (m.type !== "request") return;
      seen.requests.push(m);
      let payload = {};
      try {
        payload = JSON.parse(m.requestBody);
      } catch {
        /* ignore */
      }
      const text = `[page:${m.model}] ${String(payload.binding || "").slice(0, 60)}`;
      // 流式回传必须是「上游原始响应文本」的连续切片（真实脚本就是这样转发的），
      // 所以这里带上 MOCKRAW: 前缀再切块，网关累积后交给 parseWire。
      const fullRaw = `MOCKRAW:${text}`;
      if (!m.stream) {
        ws.send(JSON.stringify({ type: "response", requestId: m.requestId, status: 200, rawResponse: fullRaw }));
        return;
      }
      const step = Math.max(1, Math.ceil(fullRaw.length / streamChunks));
      for (let i = 0; i < fullRaw.length; i += step) {
        ws.send(JSON.stringify({ type: "stream-chunk", requestId: m.requestId, chunkBody: fullRaw.slice(i, i + step) }));
        // 给网关留出增量解析的节流窗口
        await new Promise((r) => setTimeout(r, 40));
      }
      ws.send(JSON.stringify({ type: "stream-end", requestId: m.requestId, status: 200 }));
    };
    ws.onerror = () => reject(new Error("page executor ws error"));
    setTimeout(() => reject(new Error("page executor register 超时")), 4000);
  });
  return { ws, seen, ready, close: () => ws.close() };
}

async function waitExecutorGone() {
  await waitFor(
    async () => {
      const info = await gwFetch("/admin/api/executors", { key: "admin" });
      if (info.json.size !== 0) throw new Error(`池内仍有 ${info.json.size} 个执行器`);
      return true;
    },
    { timeoutMs: 3000, intervalMs: 100 }
  ).catch(() => {});
}

const statsBefore = (await (await fetch(`http://127.0.0.1:${STUDIO_PORT}/__stats`)).json());

await t("页面转发：pg- 前缀的请求由浏览器执行，引擎不自行生成", async () => {
  const ex = openPageExecutor();
  try {
    await ex.ready;
    const r = await gwFetch("/v1beta/models/pg-gemini-3.7-flash:generateContent", {
      method: "POST",
      key: CLIENT_KEY,
      body: { contents: [{ role: "user", parts: [{ text: "页面执行测试" }] }] },
    });
    assert.equal(r.status, 200, `应成功：${r.text.slice(0, 200)}`);
    assert.equal(r.headers.get("x-catlocal-channel"), "browser", "pg- 必须落到页面转发通道");
    const text = r.json.candidates[0].content.parts[0].text;
    assert.match(text, /\[page:gemini-3\.7-flash\]/, `应答应来自浏览器（前缀已剥）：${text}`);
    assert.match(text, /页面执行测试/, "binding 应随请求下发到页面");
    assert.equal(ex.seen.requests.length, 1, "浏览器应恰好收到 1 个 request");

    // 关键契约：引擎只能被当成编解码器用，绝不能自己发 GenerateContent
    const statsAfter = (await (await fetch(`http://127.0.0.1:${STUDIO_PORT}/__stats`)).json());
    assert.equal(statsAfter.generateCount, statsBefore.generateCount, "页面通道不得让引擎自行生成");
    assert.ok(statsAfter.wireCounter > statsBefore.wireCounter, "应调用 encodeWire");
  } finally {
    ex.close();
    await waitExecutorGone();
  }
});

await t("页面转发：流式按块增量吐给客户端", async () => {
  const ex = openPageExecutor({ streamChunks: 4 });
  try {
    await ex.ready;
    const r = await gwFetch("/v1beta/models/pggo-gemini-3.7-flash:streamGenerateContent?alt=sse", {
      method: "POST",
      key: CLIENT_KEY,
      body: { contents: [{ role: "user", parts: [{ text: "流式页面测试" }] }] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-catlocal-channel"), "browser");
    const frames = r.text
      .split("\n\n")
      .filter((x) => x.startsWith("data: "))
      .map((f) => f.slice(6).trim())
      .filter(Boolean)
      .map((s) => JSON.parse(s));
    const acc = frames
      .map((f) => (f.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""))
      .join("");
    assert.match(acc, /\[page:gemini-3\.7-flash\]/, `拼起来应是页面应答：${acc}`);
    assert.match(acc, /流式页面测试/);
    assert.ok(frames.length >= 2, `应分多帧（增量解析），实际 ${frames.length}`);
  } finally {
    ex.close();
    await waitExecutorGone();
  }
});

await t("页面转发：页面没开（无执行器）→ 503 并提示打开页面", async () => {
  const r = await gwFetch("/v1beta/models/pg-gemini-3.7-flash:generateContent", {
    method: "POST",
    key: CLIENT_KEY,
    body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
  });
  assert.equal(r.status, 503);
  assert.match(JSON.stringify(r.json), /no_executor|页面在线|执行器/);
});

await t("别名匹配要求分隔符：pggo- 归页面、pgfoo- 原样透传", async () => {
  // "pggo-x".startsWith("pg") 为真，若只看 startsWith 就会把 pggo- 切成 "go-x"。
  const ex = openPageExecutor();
  try {
    await ex.ready;
    const a = await gwFetch("/v1beta/models/pggo-gemini-3.7-flash:generateContent", {
      method: "POST",
      key: CLIENT_KEY,
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    });
    assert.equal(a.status, 200);
    assert.equal(a.headers.get("x-catlocal-channel"), "browser", "pggo- 应归页面转发");
    const aText = a.json.candidates[0].content.parts[0].text;
    assert.match(aText, /\[page:gemini-3\.7-flash\]/, "pggo- 应剥成 gemini-3.7-flash");
    assert.ok(!aText.includes("[page:go-gemini"), "不应被 pg 前缀切成 go- 开头");

    // 不是别名、只是恰好以 pg 开头的模型名，必须原样透传（这里落默认通道 studio）
    const b = await gwFetch("/v1beta/models/pgfoo-gemini-3.7-flash:generateContent", {
      method: "POST",
      key: CLIENT_KEY,
      body: { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    });
    assert.equal(b.status, 200);
    assert.match(
      b.json.candidates[0].content.parts[0].text,
      /\[studio:pgfoo-gemini-3\.7-flash\]/,
      "非别名前缀应原样透传"
    );
  } finally {
    ex.close();
    await waitExecutorGone();
  }
});

await t("countTokens 透传", async () => {
  const r = await gwFetch("/v1beta/models/gemini-3.7-flash:countTokens", {
    method: "POST",
    key: CLIENT_KEY,
    body: { contents: [{ parts: [{ text: "count me" }] }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.totalTokens, 42);
});

await t("流式：多帧 SSE", async () => {
  const r = await gwFetch("/v1beta/models/gemini-3.7-flash:streamGenerateContent?alt=sse", {
    method: "POST",
    key: CLIENT_KEY,
    body: { contents: [{ role: "user", parts: [{ text: "讲个短故事" }] }] },
  });
  assert.equal(r.status, 200);
  const frames = r.text.split("\n\n").filter((x) => x.startsWith("data: "));
  assert.ok(frames.length >= 3, `应有多个帧，实际 ${frames.length}`);
  const texts = frames.map((f) => {
    try {
      return JSON.parse(f.slice(6)).candidates?.[0]?.content?.parts?.[0]?.text || "";
    } catch {
      return "";
    }
  });
  assert.ok(texts.join("").includes("[studio:gemini-3.7-flash]"), "拼起来应是完整回答");
});

await t("OpenAI 非流式：chat.completion", async () => {
  const r = await gwFetch("/v1/chat/completions", {
    method: "POST",
    key: CLIENT_KEY,
    body: { model: "gemini-3.7-flash", messages: [{ role: "user", content: "你好，测试" }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.object, "chat.completion");
  assert.match(r.json.choices[0].message.content, /\[studio:/);
  assert.ok(r.json.usage.total_tokens > 0);
});

await t("OpenAI 流式：chunk + [DONE]", async () => {
  const r = await gwFetch("/v1/chat/completions", {
    method: "POST",
    key: CLIENT_KEY,
    body: { model: "gemini-3.7-flash", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "流式测试" }] },
  });
  assert.equal(r.status, 200);
  const frames = r.text.split("\n\n").filter((x) => x.startsWith("data: "));
  assert.ok(frames.length >= 2);
  assert.equal(frames[frames.length - 1].slice(6).trim(), "[DONE]");
  const deltas = frames
    .map((f) => {
      try {
        return JSON.parse(f.slice(6));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .map((c) => c.choices?.[0]?.delta?.content || "")
    .join("");
  assert.match(deltas, /\[studio:/);
});

await t("OpenAI 流式工具调用：finish_reason=tool_calls 不被后续 usage 帧覆盖", async () => {
  const r = await gwFetch("/v1/chat/completions", {
    method: "POST",
    key: CLIENT_KEY,
    body: { model: "gemini-3.7-flash", stream: true, stream_options: { include_usage: true }, messages: [{ role: "user", content: "TOOLCALL 搜一下" }] },
  });
  assert.equal(r.status, 200);
  const frames = r.text
    .split("\n\n")
    .filter((x) => x.startsWith("data: "))
    .map((f) => f.slice(6).trim())
    .filter((s) => s && s !== "[DONE]")
    .map((s) => JSON.parse(s));
  const withCalls = frames.filter((f) => f.choices?.[0]?.delta?.tool_calls?.length);
  assert.equal(withCalls.length, 1, "应恰有一帧带 tool_calls");
  assert.equal(withCalls[0].choices[0].delta.tool_calls[0].function.name, "WebSearch");
  assert.equal(withCalls[0].choices[0].delta.tool_calls[0].id, "call_mock1", "上游给的 tool call id 要原样透出");
  assert.equal(
    withCalls[0].choices[0].delta.tool_calls[0].extra_content?.google?.thought_signature,
    "SIG_MOCK_1",
    "签名要随 tool_call 一起透出（客户端可原样回传）"
  );
  // 结束原因只宣告一次，且必须是 tool_calls（早先会被后面的 STOP+usage 帧覆盖成 stop）
  const finishes = frames.map((f) => f.choices?.[0]?.finish_reason).filter(Boolean);
  assert.deepEqual(finishes, ["tool_calls"], `结束原因应为单次 tool_calls，实际 ${JSON.stringify(finishes)}`);
  // usage 仍要透出
  assert.ok(frames.some((f) => f.usage?.total_tokens > 0), "usage 不能因为去掉 finish_reason 而丢失");
});

await t("OpenAI 流式上游错误：转成 error 事件，而不是空回答", async () => {
  const r = await gwFetch("/v1/chat/completions", {
    method: "POST",
    key: CLIENT_KEY,
    body: { model: "gemini-3.7-flash", stream: true, messages: [{ role: "user", content: "STREAMERR 任意问题" }] },
  });
  assert.equal(r.status, 200, "引擎已发 200 头，网关只能走事件");
  const dataFrames = r.text
    .split("\n\n")
    .filter((x) => x.startsWith("data: "))
    .map((f) => f.slice(6).trim())
    .filter((s) => s && s !== "[DONE]");
  const errFrame = dataFrames.map((s) => JSON.parse(s)).find((j) => j.error);
  assert.ok(errFrame, `应有一帧 error，实际帧：${JSON.stringify(dataFrames).slice(0, 300)}`);
  assert.equal(errFrame.error.code, 503);
  assert.match(errFrame.error.message, /No available accounts/);
});

await t("Gemini 原生流式上游错误：error 事件原样透出", async () => {
  const r = await gwFetch("/v1beta/models/gemini-3.7-flash:streamGenerateContent?alt=sse", {
    method: "POST",
    key: CLIENT_KEY,
    body: { contents: [{ role: "user", parts: [{ text: "STREAMERR" }] }] },
  });
  assert.equal(r.status, 200);
  const frames = r.text
    .split("\n\n")
    .filter((x) => x.startsWith("data: "))
    .map((f) => f.slice(6).trim())
    .filter(Boolean)
    .map((s) => JSON.parse(s));
  const err = frames.find((j) => j.error);
  assert.ok(err, "原生通道应把 error 事件透出");
  assert.equal(err.error.code, 503);
});

await t("OpenAI /v1/models 含通道前缀别名", async () => {
  const r = await gwFetch("/v1/models", { key: CLIENT_KEY });
  assert.equal(r.status, 200);
  const ids = r.json.data.map((m) => m.id);
  assert.ok(ids.includes("gemini-4-argon"));
  assert.ok(ids.some((i) => i.startsWith("robin/")));
});

await t("cat：Cookie 推送 → studio 建档（响应字段与 cat 一致）", async () => {
  const cookies = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID", "HSID", "SSID"].map(
    (name) => ({ name, value: `v-${name}`, domain: ".google.com", path: "/", expirationDate: -1, httpOnly: true, secure: true, sameSite: "unspecified" })
  );
  const r = await gwFetch("/api/pggo/push", {
    method: "POST",
    key: CLIENT_KEY,
    body: { email: "tester@example.com", authuser: "0", headers: { "x-aistudio-g1-tier": "TIER1" }, cookies, fingerprint: { screenWidth: 1920, screenHeight: 1080, timezone: "Asia/Shanghai" } },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.label, "tester@example.com");
  assert.equal(r.json.cookies, 8);
  assert.ok(r.json.created_at > 0);
  assert.match(r.json.message, /pggo-/);
});

await t("cat：缺会话 Cookie 时明确拒绝", async () => {
  const r = await gwFetch("/api/pggo/push", { method: "POST", key: CLIENT_KEY, body: { cookies: [{ name: "foo", value: "bar" }] } });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.json), /缺少会话必需 Cookie/);
});

await t("cat：Robin 凭证绑定 → 之后 robin 请求可通", async () => {
  const bind = await gwFetch("/api/robin/bind-by-key", {
    method: "POST",
    key: CLIENT_KEY,
    body: { email: "robin@example.com", oauth_token: "1//mock-oauth-token" },
  });
  assert.equal(bind.status, 200);
  assert.equal(bind.json.status, "ok");

  const gen = await gwFetch("/v1beta/models/robin%2Fgemini-4-argon:generateContent", {
    method: "POST",
    key: CLIENT_KEY,
    body: { contents: [{ role: "user", parts: [{ text: "认证后再试" }] }] },
  });
  assert.equal(gen.status, 200);
  assert.match(gen.json.candidates[0].content.parts[0].text, /\[robin:gemini-4-argon\]/);
});

await t("cat：绑定失败透传（BadAuthentication）", async () => {
  const r = await gwFetch("/api/robin/bind-by-key", {
    method: "POST",
    key: CLIENT_KEY,
    body: { email: "bad@example.com", oauth_token: "bad-token" },
  });
  assert.equal(r.status, 400);
  assert.match(JSON.stringify(r.json), /BadAuthentication|绑定失败/);
});

await t("cat：脚本下发已改写为本地地址 + 注入 collect", async () => {
  const r = await gwFetch("/api/pg/script.user.js");
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(`ws://127.0.0.1:${GW_PORT}/api/pg/ws`), "WS 地址应指向本地网关");
  assert.ok(r.text.includes(`http://127.0.0.1:${GW_PORT}/api/pggo/push`));
  assert.ok(r.text.includes(`/api/robin/bind-by-key`));
  assert.ok(r.text.includes("handleCatlocalCollect"), "应注入采集函数");
  assert.ok(r.text.includes('case "collect"'), "应挂上 collect 分支");
  assert.ok(!r.text.includes("wss://catiecli.sukaka.top/api/pg/ws"), "不应残留云端 WS 地址");
});

await t("cat：/api/pg/status 返回脚本/执行器/凭证概况", async () => {
  const r = await gwFetch("/api/pg/status", { key: CLIENT_KEY });
  assert.equal(r.status, 200);
  assert.match(String(r.json.script.version), /^\d+\.\d+/, "应带脚本版本号");
  assert.ok(r.json.script.size > 0, "应带脚本字节数");
  assert.ok(Array.isArray(r.json.executors), "应返回执行器列表");
  // 池级统计（面板据此展示注册/顶替/踢出次数）
  assert.equal(typeof r.json.executorPool.online, "number");
  assert.equal(typeof r.json.executorPool.maxExecutors, "number");
  assert.equal(typeof r.json.executorPool.registered, "number");
  assert.equal(typeof r.json.executorPool.heartbeatTimeoutMs, "number");
  // Key 必须打码，绝不能回明文
  assert.ok(Array.isArray(r.json.keys));
  assert.ok(r.json.keys.length > 0, "此前已生成过客户端 Key");
  for (const k of r.json.keys) {
    assert.ok(k.token.includes("…") || /^\*+$/.test(k.token), `Key 应被打码，实际 ${k.token}`);
  }
  assert.ok(r.json.robin && typeof r.json.robin === "object", "应返回 robin 绑定状态");
  assert.ok("lastPush" in r.json, "应返回最近推送");
});

await t("WS 执行器：注册 + 心跳 + 出现在面板", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/pg/ws`);
  const registered = await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ type: "register", clientVersion: "2.21.0", apiKey: CLIENT_KEY, executorType: "playground" }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "registered") resolve(m);
      if (m.type === "collect") {
        // 模拟补丁后脚本的采集回传
        ws.send(
          JSON.stringify({
            type: "collect-result",
            requestId: m.requestId,
            status: 200,
            email: "collected@example.com",
            authuser: "0",
            headers: { "x-aistudio-g1-tier": "TIER2", "x-goog-api-key": "AIza-mock" },
            cookies: ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID", "HSID", "SSID"].map((name) => ({
              name,
              value: `c-${name}`,
              domain: ".google.com",
              path: "/",
            })),
          })
        );
      }
    };
    setTimeout(() => reject(new Error("register 超时")), 4000);
  });
  assert.ok(registered.executorId);

  const ov = await gwFetch("/admin/api/overview", { key: "admin" });
  assert.equal(ov.status, 200);
  assert.equal(ov.json.executors.length, 1);

  // 从浏览器采集 → 导入 studio
  const col = await gwFetch("/admin/api/accounts/collect", { method: "POST", key: "admin", body: { token: CLIENT_KEY } });
  assert.equal(col.status, 200);
  assert.equal(col.json.cookies, 8);
  assert.ok(col.json.account?.account_id);

  // 心跳：网关 ping，脚本回 pong
  const pingSeen = await new Promise((resolve) => {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", ts: m.ts }));
        resolve(true);
      }
    };
    gwFetch("/admin/api/executors/ping", { method: "POST", key: "admin", body: {} }).catch(() => {});
    setTimeout(() => resolve(false), 3000);
  });
  assert.equal(pingSeen, true);
  ws.close();
});

await t("WS 执行器：断开后立刻出池（不等 75s 心跳巡检兜底）", async () => {
  // 回归守卫：早期 server.mjs 在 handleConnection 之后把 conn.onclose 覆盖成空函数，
  // 导致浏览器标签页关闭后执行器残留在池里，只能等心跳巡检清退。这条用例专门盯住它。
  const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/pg/ws`);
  await new Promise((resolve, reject) => {
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: "register", clientVersion: "2.21.0", apiKey: CLIENT_KEY, executorType: "playground" }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.type === "registered") resolve(m);
    };
    ws.onerror = () => reject(new Error("ws error"));
    setTimeout(() => reject(new Error("register 超时")), 4000);
  });
  const online = await gwFetch("/admin/api/executors", { key: "admin" });
  assert.equal(online.json.size, 1, "注册后应在池中");

  ws.close();

  // 心跳超时是 75s；这里只给 3s，能清空就说明是 onclose 立刻清退的，不是巡检兜底
  const emptied = await waitFor(
    async () => {
      const r = await gwFetch("/admin/api/executors", { key: "admin" });
      if (r.json.size !== 0) throw new Error(`池内仍有 ${r.json.size} 个执行器`);
      return true;
    },
    { timeoutMs: 3000, intervalMs: 100 }
  );
  assert.equal(emptied, true);
});

await t("cat：/api/pg/collect 成功路径（import 写入 studio 账号）", async () => {
  // 之前只测了 503 无执行器分支，这里补上真正跑通的路径：
  // 执行器回传凭证 → 网关剥 Cookie → 调 studio importCookies → 回 account_id。
  const sessionCookies = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID", "HSID", "SSID"];
  const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/pg/ws`);
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = () =>
        ws.send(JSON.stringify({ type: "register", clientVersion: "2.21.0", apiKey: CLIENT_KEY, executorType: "playground" }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "registered") resolve();
        if (m.type === "collect") {
          ws.send(
            JSON.stringify({
              type: "collect-result",
              requestId: m.requestId,
              status: 200,
              email: "collect-ok@example.com",
              authuser: "3",
              headers: { "x-aistudio-g1-tier": "TIER1", "x-goog-api-key": "AIza-collect" },
              cookies: sessionCookies.map((name) => ({ name, value: `v-${name}`, domain: ".google.com", path: "/" })),
            })
          );
        }
      };
      ws.onerror = () => reject(new Error("ws error"));
      setTimeout(() => reject(new Error("register 超时")), 4000);
    });

    const r = await gwFetch("/api/pg/collect", { method: "POST", key: CLIENT_KEY, body: { import: true } });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, "ok");
    assert.equal(r.json.cookies, 8, "应回传 8 条会话 Cookie");
    assert.equal(r.json.email, "collect-ok@example.com");
    assert.equal(r.json.authuser, "3");
    assert.equal(r.json.import_error, null, "导入不应报错");
    assert.ok(r.json.account_id, "import 后应返回 studio 账号 id");
    assert.ok(Array.isArray(r.json.headers) && r.json.headers.includes("x-aistudio-g1-tier"));
  } finally {
    // 无论断言是否失败都要断连并等池子清空，否则残留执行器会污染后续用例
    ws.close();
    await waitFor(
      async () => {
        const info = await gwFetch("/admin/api/executors", { key: "admin" });
        if (info.json.size !== 0) throw new Error(`池内仍有 ${info.json.size} 个执行器`);
        return true;
      },
      { timeoutMs: 3000, intervalMs: 100 }
    ).catch(() => {});
  }
});

await t("cat：无在线执行器时采集 → 503 no_executor", async () => {
  // 顺便确认池级计数已暴露（面板/接口据此观察注册、顶替、踢出）
  const info = await gwFetch("/admin/api/executors", { key: "admin" });
  assert.equal(info.status, 200);
  assert.ok(info.json.stats, "应返回池级统计");
  assert.ok(info.json.stats.registered >= 2, "本次测试至少注册过 2 次");

  const r = await gwFetch("/api/pg/collect", { method: "POST", key: CLIENT_KEY, body: { import: false } });
  assert.equal(r.status, 503);
  assert.match(JSON.stringify(r.json), /no_executor|没有在线的浏览器执行器/);
});

await t("并发：6 个请求 / 通道并发 2 → 上游峰值恰为 2 且全部成功", async () => {
  const jobs = Array.from({ length: 6 }, (_, i) =>
    gwFetch("/v1beta/models/gemini-3.7-flash:generateContent", {
      method: "POST",
      key: CLIENT_KEY,
      body: { contents: [{ role: "user", parts: [{ text: `并发-${i}` }] }] },
    })
  );
  const rs = await Promise.all(jobs);
  assert.ok(rs.every((r) => r.status === 200), rs.map((r) => r.status).join(","));
  const stat = await (await fetch(`http://127.0.0.1:${STUDIO_PORT}/__stats`)).json();
  assert.equal(stat.peak, 2, `上游峰值应为 2（网关并发限制），实测 ${stat.peak}`);
});

await t("跨通道回退：studio 500 → 自动落到 robin 同名模型", async () => {
  // 生产默认 failover=false（不自动落到会重放 Cookie 的通道），
  // 所以这里先把回退显式打开，验证机制本身可用，测完还原。
  await gwFetch("/admin/api/config", {
    method: "PUT",
    key: "admin",
    body: { routing: { failover: true, fallbackOrder: ["robin"] } },
  });
  try {
    // 先让 robin 绑定好凭证（前面已绑）；模型 gemini-3.8-flash 两边都有
    const r = await gwFetch("/v1beta/models/gemini-3.8-flash:generateContent", {
      method: "POST",
      key: CLIENT_KEY,
      body: { contents: [{ role: "user", parts: [{ text: "BOOM" }] }] },
    });
    assert.equal(r.status, 200, `应回退成功，实测 ${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(r.headers.get("x-catlocal-channel"), "robin");
    assert.match(r.json.candidates[0].content.parts[0].text, /\[robin:/);
  } finally {
    await gwFetch("/admin/api/config", {
      method: "PUT",
      key: "admin",
      body: { routing: { failover: false, fallbackOrder: [] } },
    });
  }
});

await t("管理：通道 resize 生效", async () => {
  const r = await gwFetch("/admin/api/channels/studio/resize", { method: "POST", key: "admin", body: { concurrency: 3 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.limiter.concurrency, 3);
  const ov = await gwFetch("/admin/api/overview", { key: "admin" });
  assert.equal(ov.json.channels.studio.limiter.concurrency, 3);
  await gwFetch("/admin/api/channels/studio/resize", { method: "POST", key: "admin", body: { concurrency: 2 } });
});

await t("管理：账号列表 / 激活 / 删除 走 studio 引擎", async () => {
  const list = await gwFetch("/admin/api/accounts", { key: "admin" });
  assert.equal(list.status, 200);
  assert.ok(list.json.studio.accounts.length >= 2);

  const first = list.json.studio.accounts[0];
  const act = await gwFetch(`/admin/api/accounts/${first.id}/activate`, { method: "POST", key: "admin", body: {} });
  assert.equal(act.status, 200);
  assert.equal(act.json.account.is_active, true);

  const del = await gwFetch(`/admin/api/accounts/${first.id}`, { method: "DELETE", key: "admin" });
  assert.equal(del.status, 200);
});

await t("管理：日志 / 统计 / 配置 可读", async () => {
  const logs = await gwFetch("/admin/api/logs?limit=50", { key: "admin" });
  assert.equal(logs.status, 200);
  assert.ok(Array.isArray(logs.json.lines));

  const stats = await gwFetch("/admin/api/stats", { key: "admin" });
  assert.equal(stats.status, 200);
  assert.ok(stats.json.live.total.requests > 0);
  assert.ok(stats.json.cumulative.total.requests > 0);

  const cfg = await gwFetch("/admin/api/config", { key: "admin" });
  assert.equal(cfg.status, 200);
  assert.ok(cfg.json.channels.studio);
  assert.match(cfg.json.auth.adminToken, /…/, "管理口令应被掩码");
});

await t("管理：非法口令被拒", async () => {
  const r = await gwFetch("/admin/api/overview", { key: "wrong-token" });
  assert.equal(r.status, 401);
});

await t("路由：未知名模型 → 默认通道（不崩）", async () => {
  const r = await gwFetch("/v1beta/models/unknown-model-xyz:generateContent", {
    method: "POST",
    key: CLIENT_KEY,
    body: { contents: [{ role: "user", parts: [{ text: "unknown" }] }] },
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-catlocal-channel"), "studio");
});

await t("自愈：账号 503 → 自动采集 Cookie → 重试成功（端到端）", async () => {
  // 场景：引擎首次报「No available accounts」，网关自动让浏览器回传 Cookie 重建账号，
  // 然后用同一份请求重试，客户端最终拿到 200 + 正文。
  const sessionCookies = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID", "HSID", "SSID"];
  const importedBefore = (await (await fetch(`http://127.0.0.1:${STUDIO_PORT}/__stats`)).json()).imported;
  const before = await gwFetch("/admin/api/overview", { key: "admin" });
  const attemptsBefore = before.json.recovery?.attempts ?? 0;

  const ws = new WebSocket(`ws://127.0.0.1:${GW_PORT}/api/pg/ws`);
  let collectRequests = 0;
  try {
    await new Promise((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: "register", clientVersion: "2.21.0", apiKey: CLIENT_KEY, executorType: "playground" }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.type === "registered") resolve();
        if (m.type === "collect") {
          collectRequests++;
          ws.send(
            JSON.stringify({
              type: "collect-result",
              requestId: m.requestId,
              status: 200,
              email: "recover@example.com",
              authuser: "1",
              headers: { "x-aistudio-g1-tier": "TIER1" },
              cookies: sessionCookies.map((name) => ({ name, value: `v-${name}`, domain: ".google.com", path: "/" })),
            })
          );
        }
      };
      ws.onerror = () => reject(new Error("ws error"));
      setTimeout(() => reject(new Error("register 超时")), 4000);
    });

    const r = await gwFetch("/v1beta/models/gemini-3.7-flash:generateContent", {
      method: "POST",
      key: CLIENT_KEY,
      body: { contents: [{ role: "user", parts: [{ text: "RECOVER_ONCE 自愈测试" }] }] },
    });
    assert.equal(r.status, 200, `首次 503 后应自愈并成功，实测 ${r.status} ${r.text.slice(0, 200)}`);
    assert.match(r.json.candidates[0].content.parts[0].text, /\[studio:/);
    assert.equal(collectRequests, 1, "应恰好触发一次自动采集");

    const after = await gwFetch("/admin/api/overview", { key: "admin" });
    const rec = after.json.recovery;
    assert.ok(rec, "overview 应暴露自愈统计");
    assert.equal(rec.attempts, attemptsBefore + 1, "应记录一次自愈尝试");
    assert.equal(rec.recovered, 1);
    assert.equal(rec.lastCookies, 8);

    const importedAfter = (await (await fetch(`http://127.0.0.1:${STUDIO_PORT}/__stats`)).json()).imported;
    assert.equal(importedAfter, importedBefore + 1, "采集到的 Cookie 应真的写进了引擎账号库");
  } finally {
    ws.close();
    await waitFor(
      async () => {
        const info = await gwFetch("/admin/api/executors", { key: "admin" });
        if (info.json.size !== 0) throw new Error(`池内仍有 ${info.json.size} 个执行器`);
        return true;
      },
      { timeoutMs: 3000, intervalMs: 100 }
    ).catch(() => {});
  }
});

// ── 收尾 ────────────────────────────────────────────────
group("收尾");
await t("关闭全部测试进程", async () => {
  for (const p of procs.reverse()) {
    try {
      p.kill();
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 400));
});

// 汇总
const total = results.length;
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);
console.log(`\n${"─".repeat(60)}`);
console.log(`总计 ${total} 项：\x1b[32m通过 ${passed}\x1b[0m${failed.length ? ` / \x1b[31m失败 ${failed.length}\x1b[0m` : ""}`);
if (failed.length) {
  for (const f of failed) console.log(`  \x1b[31m✗ ${f.name}\x1b[0m — ${f.err?.message}`);
  console.log(`\n测试目录保留：${TMP}`);
  process.exit(1);
}
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(0);