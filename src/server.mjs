#!/usr/bin/env node
// CatLocal 入口：装配配置、通道、限流、路由、WS、管理面，然后监听。
//
// 设计目标：一个本地端口同时提供
//   · OpenAI 兼容 API        /v1/chat/completions、/v1/models
//   · Gemini 原生 API        /v1beta/models/…:generateContent 等
//   · catiecli 兼容接入      /api/pggo/push、/api/robin/bind-by-key、/api/pg/ws、/api/pg/script.user.js
//   · 统一管理面板           /admin
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig, isLoopback, ROOT } from "./config.mjs";
import { Logger } from "./logger.mjs";
import { Store } from "./store.mjs";
import { Metrics } from "./metrics.mjs";
import { Router, readJson, sendJson, sendError, sendHtml, sendText, corsPreflight } from "./http.mjs";
import { GatewayError, gwErr, mask, randomKey } from "./util.mjs";
import { RateWindow } from "./limiter.mjs";
import { StudioChannel } from "./channels/studio.mjs";
import { BrowserChannel } from "./channels/browser.mjs";
import { RobinChannel } from "./channels/robin.mjs";
import { Router as ModelRouter } from "./routing.mjs";
import { Runner } from "./runner.mjs";
import { ExecutorPool } from "./executors.mjs";
import { AutoRecovery } from "./auto-recover.mjs";
import { attachWebSocket } from "./ws-server.mjs";
import { CatScript } from "./cat-script.mjs";
import { Supervisor } from "./supervisor.mjs";
import * as openai from "./api/openai.mjs";
import * as gemini from "./api/gemini.mjs";
import * as cat from "./api/cat.mjs";
import { registerAdminRoutes } from "./api/admin.mjs";

// ───────────────────────── 装配 ─────────────────────────
const config = loadConfig();
const log = new Logger({ dir: path.join(ROOT, "data", "logs"), level: config.logging.level });
const store = new Store();
const metrics = new Metrics();
const supervisor = new Supervisor({ config, log });

// 执行器池要先建：browser 通道要用它把请求下发给浏览器
const executors = new ExecutorPool({
  log,
  heartbeatTimeoutMs: config.executors.heartbeatTimeoutMs,
  maxExecutors: config.executors.maxExecutors,
});

const studioChannel = new StudioChannel("studio", config.channels.studio, log);
const channels = {
  // 页面转发通道：请求真在浏览器标签页里执行（pg- / pggo- / 默认）
  browser: new BrowserChannel("browser", config.channels.browser, log, { executors, studio: studioChannel }),
  // 无头通道：只用它的 encodeWire/parseWire 做编解码，以及模型清单；生成请求不走它
  studio: studioChannel,
  robin: new RobinChannel("robin", config.channels.robin, log),
};
const modelRouter = new ModelRouter({ config, channels, log });
const runner = new Runner({ config, router: modelRouter, channels, metrics, store, log });

// 凭证自愈：studio 账号会话过期/冷却时，自动从在线浏览器执行器采集 Cookie 并重试。
const recovery = new AutoRecovery({
  studio: channels.studio,
  executors,
  store,
  log,
  config,
});
// 通道层只需要一个「凭证失效了就调我」的钩子；具体怎么采、采几次由 AutoRecovery 管。
channels.studio.recoverCredentials = (err) => recovery.recover(err);
const catScript = new CatScript({
  config,
  log,
  // 单机自用：网关不校验 Key，但脚本自身要求非空，所以注入一把内置值兜底
  defaultKey: () => store.listKeys()[0]?.token || "cat-local",
});

const keyWindows = new Map();

const ctx = {
  config,
  log,
  store,
  metrics,
  channels,
  router: modelRouter,
  runner,
  executors,
  recovery,
  catScript,
  supervisor,
  saveConfig: () => saveConfig(config),
  publicBaseUrl,
  publicWsUrl,
  adminToken: () => config.auth.adminToken,
  reloadConfigHot,
};

function publicBaseUrl(req) {
  if (config.cat?.publicBaseUrl) return config.cat.publicBaseUrl.replace(/\/+$/, "");
  const hostHeader = String(req?.headers?.host || `${config.gateway.host}:${config.gateway.port}`);
  const cut = hostHeader.lastIndexOf(":");
  let host = cut > 0 ? hostHeader.slice(0, cut) : hostHeader;
  let port = cut > 0 ? hostHeader.slice(cut + 1) : String(config.gateway.port);
  // 面板也可能从 TLS 口打开；对外 HTTP 入口只有 gateway.port，别把 8789 当 http 地址发出去
  const t = config.gateway.tls;
  if (t?.enabled && String(t.port) === port) port = String(config.gateway.port);
  if (!host) host = "127.0.0.1";
  const proto = req?.headers?.["x-forwarded-proto"] || "http";
  // 只信任 loopback / 局域网字面地址，避免脚本里被写入诡异地址
  return `${proto}://${host}:${port}`;
}
/** TLS 监听是否可用（证书存在且开关打开） */
function tlsReady() {
  const t = config.gateway.tls;
  if (!t?.enabled) return false;
  const cert = path.resolve(ROOT, t.certPath || "");
  const key = path.resolve(ROOT, t.keyPath || "");
  return fs.existsSync(cert) && fs.existsSync(key);
}

/**
 * 浏览器执行器专用的 WS 地址。
 * 页面是 https，ws:// 会被浏览器的混合内容规则直接掐掉，所以必须给 wss://。
 */
function publicWsUrl(req = null) {
  const host = String(req?.headers?.host || `${config.gateway.host}:${config.gateway.port}`).split(":")[0];
  const h = host === "0.0.0.0" || host === "" ? "127.0.0.1" : host;
  if (tlsReady()) return `wss://${h}:${config.gateway.tls.port}/api/pg/ws`;
  return `ws://${h}:${config.gateway.port}/api/pg/ws`;
}

// ───────────────────────── 鉴权 ─────────────────────────
function resolveToken(req, url) {
  const h = req.headers;
  const cand =
    h["x-api-key"] ||
    h["x-goog-api-key"] ||
    h["x-admin-key"] ||
    url.searchParams.get("key") ||
    (String(h.authorization || "").toLowerCase().startsWith("bearer ") ? h.authorization.slice(7).trim() : "");
  return String(cand || "").trim();
}

function isAdminToken(token) {
  const t = config.auth.adminToken;
  return Boolean(t) && token === t;
}

function checkClientAuth(req, url) {
  const token = resolveToken(req, url);
  req.apiToken = token;
  if (!config.auth.requireKey) return { ok: true, anonymous: true, token };
  if (isAdminToken(token)) return { ok: true, admin: true, token };
  const key = store.findKeyByToken(token);
  if (key) {
    const win = keyWindows.get(key.id) || new RateWindow(key.rpm);
    win.perMinute = Number(key.rpm) || 0;
    keyWindows.set(key.id, win);
    const gate = win.allow();
    if (!gate.ok) {
      const err = gwErr(429, "rate_limited", `该 Key 每分钟上限 ${key.rpm} 次，请稍后重试`);
      err.retryAfterS = Math.ceil((gate.retryAfterMs || 1000) / 1000);
      throw err;
    }
    store.touchKey(token);
    return { ok: true, key, token };
  }
  if (config.auth.allowLoopbackWithoutKey && isLoopback(req.socket.remoteAddress)) {
    return { ok: true, loopback: true, token };
  }
  throw gwErr(401, "unauthorized", "缺少或无效的 API Key（请求头 x-api-key / x-goog-api-key / Authorization: Bearer）");
}

function requireAdmin(req, url) {
  const token = resolveToken(req, url);
  if (config.auth.adminToken) {
    if (token !== config.auth.adminToken) throw gwErr(401, "admin_unauthorized", "管理口令不正确");
    return;
  }
  // 未设置口令：仅允许本机访问
  if (!isLoopback(req.socket.remoteAddress)) {
    throw gwErr(403, "admin_locked", "未设置管理口令时，管理接口仅允许本机访问（请设置 gateway.auth.adminToken）");
  }
}

/** 客户端 Key 是否允许访问该通道（channels: ["*"] 表示全部） */
function assertChannelAllowed(req, channel) {
  const key = req.authKey;
  if (!key) return;
  const list = key.channels || ["*"];
  if (list.includes("*") || list.includes(channel)) return;
  throw gwErr(403, "channel_forbidden", `该 Key 不允许使用通道 ${channel}`);
}

// ───────────────────────── 路由表 ─────────────────────────
const router = new Router();

router.get("/healthz", async (req, res) => {
  sendJson(res, 200, {
    ok: true,
    service: "catlocal",
    version: "1.0.0",
    time: new Date().toISOString(),
    uptimeMs: Date.now() - metrics.startedAt,
    channels: Object.fromEntries(
      Object.entries(channels).map(([n, ch]) => [
        n,
        { enabled: ch.enabled, health: ch.health, inflight: ch.inflight, queued: ch.limiter.queued },
      ])
    ),
    executors: executors.size,
    engines: supervisor.status(),
  });
});

router.get("/v1/models", async (req, res) => {
  await openai.handleOpenaiModels(ctx, req, res);
});

router.post("/v1/chat/completions", async (req, res) => {
  const body = await readJson(req);
  await openai.handleChatCompletions(ctx, req, res, body);
});

for (const feature of ["/v1/completions", "/v1/embeddings", "/v1/responses", "/v1/images/generations", "/v1/audio/speech"]) {
  router.post(feature, (req, res) => {
    throw openai.notImplemented(feature);
  });
}

router.get("/v1beta/models", async (req, res) => {
  await gemini.handleModels(ctx, req, res, {});
});

router.get("/models", async (req, res) => {
  await gemini.handleModels(ctx, req, res, {});
});

// ── catiecli 兼容 ───────────────────────────────────────
router.post("/api/pggo/push", async (req, res) => {
  const body = await readJson(req, { limit: 8 * 1024 * 1024 });
  await cat.handleCookiePush(ctx, req, res, body);
});

router.post("/api/robin/bind-by-key", async (req, res) => {
  const body = await readJson(req, { limit: 256 * 1024 });
  await cat.handleRobinBind(ctx, req, res, body);
});

router.get("/api/pg/script.user.js", (req, res) => cat.handleScript(ctx, req, res));
router.get("/api/pg/script.meta.js", (req, res) => cat.handleScriptInfo(ctx, req, res));
router.get("/api/pg/status", async (req, res) => cat.handleCatStatus(ctx, req, res));
router.post("/api/pg/collect", async (req, res) => {
  const body = await readJson(req, { limit: 64 * 1024 });
  await cat.handleCollect(ctx, req, res, body);
});

registerAdminRoutes(router, ctx);

// ───────────────────────── 请求处理 ─────────────────────────
async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || "GET";

  if (method === "OPTIONS") return corsPreflight(res);

  // 静态：管理面板
  if (pathname === "/" || pathname === "/admin" || pathname === "/admin/") {
    return sendAdminUi(res);
  }
  if (pathname.startsWith("/admin/assets/")) {
    return sendAdminAsset(res, pathname.slice("/admin/assets/".length));
  }

  const isAdminApi = pathname === "/admin/api" || pathname.startsWith("/admin/api/");
  const isOpen = pathname === "/healthz" || pathname.startsWith("/api/pg/script.");

  if (isAdminApi) requireAdmin(req, url);
  else if (!isOpen) {
    const auth = checkClientAuth(req, url);
    req.authKey = auth.key || null;
  }

  // Gemini 动作路径：/v1beta/models/{model}:{verb}
  const gm = gemini.matchGeminiPath(pathname);
  if (gm && method === "POST") {
    const body = await readJson(req, { limit: 32 * 1024 * 1024 });
    return gemini.handleGenerate(ctx, req, res, { ...gm, body, query: url.searchParams });
  }

  const hit = router.match(method, pathname);
  if (!hit) throw gwErr(404, "not_found", `未知路由 ${method} ${pathname}`);
  if (!hit.route) throw gwErr(405, "method_not_allowed", `不支持的请求方法 ${method} ${pathname}`);
  await hit.route.handler(req, res, hit.params);
}

function sendAdminUi(res) {
  const file = path.join(ROOT, "web", "index.html");
  if (!fs.existsSync(file)) return sendText(res, 500, "管理面板文件缺失（web/index.html）");
  return sendHtml(res, 200, fs.readFileSync(file, "utf8"));
}

function sendAdminAsset(res, rel) {
  const file = path.join(ROOT, "web", "assets", path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!fs.existsSync(file) || !file.startsWith(path.join(ROOT, "web"))) return sendText(res, 404, "not found");
  const ext = path.extname(file).toLowerCase();
  const type =
    ext === ".js" ? "application/javascript" : ext === ".css" ? "text/css" : ext === ".svg" ? "image/svg+xml" : "application/octet-stream";
  res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-cache" });
  return res.end(fs.readFileSync(file));
}

// ───────────────────────── 启动 ─────────────────────────
/** 统一的未捕获异常出口：HTTP 与 TLS 两个监听共用，否则 TLS 口会把 401 也写成 500 */
function handleFailure(req, res, err) {
  if (err instanceof GatewayError || err?.status) {
    if (err.status >= 500) log.error(`请求失败：${err.message}`, { path: req.url, code: err.code });
    else log.warn(`请求被拒绝：${err.message}`, { path: req.url, code: err.code });
    return sendError(res, err);
  }
  log.error(`未捕获异常：${err?.message}\n${err?.stack}`, { path: req.url });
  if (!res.headersSent) return sendError(res, gwErr(500, "internal_error", err?.message || "internal error"));
  try {
    res.end();
  } catch {
    /* ignore */
  }
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on("finish", () => {
    if (config.logging.level === "debug") {
      log.debug(`${req.method} ${req.url} → ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });
  handle(req, res).catch((err) => handleFailure(req, res, err));
});

/** 执行器 WS 的鉴权：与 HTTP 侧同一套 Key */
function authorizeExecutor(req) {
  return (token) => {
    if (!config.auth.requireKey) return { ok: true, token: token || "anonymous" };
    if (!token) return { ok: false, reason: "缺少 apiKey" };
    if (isAdminToken(token)) return { ok: true, token };
    if (store.findKeyByToken(token)) return { ok: true, token };
    if (config.auth.allowLoopbackWithoutKey && isLoopback(req.socket.remoteAddress)) return { ok: true, token };
    return { ok: false, code: 4008, reason: "API Key 无效（请在脚本面板里更新 Key）" };
  };
}

function onWsConnection(req, conn) {
  // 注意：handleConnection 内部会给 conn 装 onclose（用于断开时立刻清退执行器），
  // 这里不能再覆盖它 —— 早期版本在这行把它覆盖成空函数，导致浏览器标签页关闭后
  // 执行器仍残留在池里，只能等心跳巡检（默认 75s）兜底，期间采集/派发可能选中死连接。
  executors.handleConnection(conn, authorizeExecutor(req));
}

attachWebSocket(server, onWsConnection, { path: "/api/pg/ws" });

/** 首次运行：自动建一把默认客户端 Key，并把用法打出来 */
function ensureDefaultKey() {
  if (!config.auth.requireKey) return null;
  if (store.listKeys().length) return null;
  const key = store.createKey({ name: "default（脚本/客户端通用）", channels: ["*"], rpm: 0 });
  return key;
}

/** 热更新配置（面板保存后调用） */
function reloadConfigHot(patch) {
  const merged = { ...config, ...patch };
  // channels 深度合并，避免半截配置把通道打坏
  merged.channels = { ...config.channels };
  for (const [name, chCfg] of Object.entries(patch.channels || {})) {
    merged.channels[name] = { ...(config.channels[name] || {}), ...chCfg };
  }
  for (const name of Object.keys(config.channels)) {
    if (patch.channels?.[name]) {
      channels[name].applyConfig(merged.channels[name]);
      channels[name].limiter.resize(
        merged.channels[name].concurrency,
        merged.channels[name].maxQueue,
        merged.channels[name].queueTimeoutMs
      );
    }
  }
  Object.assign(config, merged);
  config.routing = { ...config.routing, ...(patch.routing || {}) };
  config.auth = { ...config.auth, ...(patch.auth || {}) };
  config.executors = { ...config.executors, ...(patch.executors || {}) };
  modelRouter.config = config;
  modelRouter.refresh();
  if (patch.logging?.level) log.setLevel(patch.logging.level);
  saveConfig(config);
  return config;
}

const healthLoop = setInterval(() => {
  for (const ch of Object.values(channels)) {
    if (!ch.enabled) continue;
    ch.checkHealth().catch(() => {});
  }
}, 20000);
healthLoop.unref?.();

async function boot() {
  const defaultKey = ensureDefaultKey();
  const { host, port } = config.gateway;

  // 先起引擎（不阻塞网关监听，引擎就绪前请求会拿到 502/503，可重试）
  if (config.channels.studio?.managed?.enabled) {
    supervisor.start("studio").catch((e) => log.error(`studio 启动失败：${e.message}`));
  }
  if (config.channels.robin?.managed?.enabled) {
    supervisor.start("robin").catch((e) => log.error(`robin 启动失败：${e.message}`));
  }

  tlsServer = null;
  if (tlsReady()) {
    const t = config.gateway.tls;
    try {
      tlsServer = https.createServer(
        {
          cert: fs.readFileSync(path.resolve(ROOT, t.certPath)),
          key: fs.readFileSync(path.resolve(ROOT, t.keyPath)),
        },
        (req, res) => {
          handle(req, res).catch((err) => handleFailure(req, res, err));
        }
      );
      attachWebSocket(tlsServer, onWsConnection, { path: "/api/pg/ws" });
      tlsServer.on("error", (err) => log.error(`TLS 监听失败：${err.message}`, { port: t.port }));
      tlsServer.listen(t.port, host, () => {
        log.info("wss 监听就绪（浏览器执行器通道）", { url: `wss://${host}:${t.port}/api/pg/ws` });
      });
    } catch (err) {
      log.error(`TLS 证书加载失败，wss 不可用：${err.message}`);
      tlsServer = null;
    }
  } else if (config.gateway.tls?.enabled) {
    log.warn("gateway.tls 已开启但证书缺失，wss 通道不可用（运行 node scripts/make-cert.mjs 生成）");
  }

  server.listen(port, host, () => {
    const base = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
    log.info("CatLocal 已启动", { base });
    console.log("");
    console.log("┌───────────────────────────────────────────────────────────────┐");
    console.log("│  CatLocal · 本地统一接入网关                                  │");
    console.log("├───────────────────────────────────────────────────────────────┤");
    console.log(`│  管理面板   ${base}/admin`.padEnd(64) + "│");
    console.log(`│  健康检查   ${base}/healthz`.padEnd(64) + "│");
    console.log(`│  用户脚本   ${base}/api/pg/script.user.js`.padEnd(64) + "│");
    console.log(`│  OpenAI     ${base}/v1  (chat/completions, models)`.padEnd(64) + "│");
    console.log(`│  Gemini     ${base}/v1beta`.padEnd(64) + "│");
    if (tlsReady()) {
      const wsLine = `  wss(页面)  wss://${host === "0.0.0.0" ? "127.0.0.1" : host}:${config.gateway.tls.port}/api/pg/ws`;
      console.log(`│${wsLine}`.padEnd(64) + "│");
    }
    console.log("├───────────────────────────────────────────────────────────────┤");
    if (defaultKey) {
      console.log(`│  默认 Key   ${defaultKey.token}`);
      console.log("│  （脚本面板里粘贴这把 Key；面板可再生成/吊销）");
    }
    console.log("└───────────────────────────────────────────────────────────────┘");
    if (!config.auth.adminToken) {
      console.log("\n⚠ 管理口令为空：管理接口目前只允许本机访问。设置 gateway.auth.adminToken 后可从局域网访问。\n");
    }
  });
}

let tlsServer = null;
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`收到 ${signal}，开始优雅停机`);
  clearInterval(healthLoop);
  try {
    executors.closeAll();
  } catch {
    /* ignore */
  }
  try {
    await new Promise((resolve) => server.close(resolve));
  } catch {
    /* ignore */
  }
  try {
    tlsServer?.close();
  } catch {
    /* ignore */
  }
  try {
    await supervisor.stopAll();
  } catch {
    /* ignore */
  }
  store.saveNow();
  log.info("已退出");
  setTimeout(() => process.exit(0), 200).unref?.();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (err) => log.error(`未处理的 Promise 拒绝：${err?.message || err}`));
process.on("uncaughtException", (err) => log.error(`未捕获异常：${err?.message}\n${err?.stack}`));

boot().catch((err) => {
  console.error("启动失败：", err);
  process.exit(1);
});