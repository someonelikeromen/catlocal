// 管理 API：姿态总览、通道运维、账号管理、密钥、配置热更新、日志、统计。
// 全部挂在 /admin/api 下（由 server.mjs 先做管理口令/本机校验）。
import { sendJson, sendError, readJson } from "../http.mjs";
import { gwErr, mask, nowIso } from "../util.mjs";

export function registerAdminRoutes(router, ctx) {
  // ── 总览 ────────────────────────────────────────────────
  router.get("/admin/api/overview", async (req, res) => {
    const ch = {};
    for (const [name, channel] of Object.entries(ctx.channels)) {
      ch[name] = channel.snapshot();
    }
    sendJson(res, 200, {
      gateway: {
        version: "1.0.0",
        baseUrl: ctx.publicBaseUrl(req),
        uptimeMs: Date.now() - ctx.metrics.startedAt,
        host: ctx.config.gateway.host,
        port: ctx.config.gateway.port,
      },
      engines: ctx.supervisor.status(),
      channels: ch,
      routing: ctx.config.routing,
      auth: { requireKey: ctx.config.auth.requireKey, hasAdminToken: Boolean(ctx.config.auth.adminToken) },
      executors: ctx.executors.snapshot(),
      recovery: typeof ctx.recovery?.snapshot === "function" ? ctx.recovery.snapshot() : null,
      metrics: ctx.metrics.snapshot(),
      store: {
        stats: ctx.store.data.stats,
        lastPush: ctx.store.data.cat?.lastPush || null,
        robin: ctx.store.data.robin || {},
        keys: ctx.store.listKeys().length,
      },
      cat: (() => {
        try {
          const built = ctx.catScript.build({ baseUrl: ctx.publicBaseUrl(req), wsUrl: ctx.publicWsUrl(req) });
          return {
            version: built.version,
            scriptUrl: `${ctx.publicBaseUrl(req)}/api/pg/script.user.js`,
            wsUrl: ctx.publicWsUrl(req),
          };
        } catch (err) {
          return { error: err.message };
        }
      })(),
    });
  });

  // ── 通道运维 ────────────────────────────────────────────
  router.get("/admin/api/channels", async (req, res) => {
    const out = {};
    for (const [name, channel] of Object.entries(ctx.channels)) out[name] = channel.snapshot();
    sendJson(res, 200, { channels: out, engines: ctx.supervisor.status() });
  });

  router.post("/admin/api/channels/:name/health", async (req, res, params) => {
    const channel = ctx.channels[params.name];
    if (!channel) throw gwErr(404, "unknown_channel", `未知通道 ${params.name}`);
    const health = await channel.checkHealth();
    sendJson(res, 200, { name: params.name, health });
  });

  router.post("/admin/api/channels/:name/resize", async (req, res, params) => {
    const channel = ctx.channels[params.name];
    if (!channel) throw gwErr(404, "unknown_channel", `未知通道 ${params.name}`);
    const body = await readJson(req);
    channel.limiter.resize(body.concurrency, body.maxQueue, body.queueTimeoutMs);
    if (body.concurrency != null) channel.cfg.concurrency = Number(body.concurrency);
    if (body.maxQueue != null) channel.cfg.maxQueue = Number(body.maxQueue);
    if (body.queueTimeoutMs != null) channel.cfg.queueTimeoutMs = Number(body.queueTimeoutMs);
    ctx.saveConfig();
    sendJson(res, 200, { ok: true, limiter: channel.limiter.snapshot() });
  });

  router.post("/admin/api/channels/:name/toggle", async (req, res, params) => {
    const channel = ctx.channels[params.name];
    if (!channel) throw gwErr(404, "unknown_channel", `未知通道 ${params.name}`);
    const body = await readJson(req);
    channel.cfg.enabled = !!body.enabled;
    ctx.saveConfig();
    sendJson(res, 200, { ok: true, enabled: channel.enabled });
  });

  router.post("/admin/api/channels/:name/restart", async (req, res, params) => {
    const name = params.name;
    if (!ctx.config.channels[name]) throw gwErr(404, "unknown_channel", `未知通道 ${name}`);
    const result = await ctx.supervisor.restart(name);
    sendJson(res, 200, { ok: true, result, engines: ctx.supervisor.status() });
  });

  router.post("/admin/api/channels/:name/stop", async (req, res, params) => {
    const name = params.name;
    if (!ctx.config.channels[name]) throw gwErr(404, "unknown_channel", `未知通道 ${name}`);
    await ctx.supervisor.stop(name);
    sendJson(res, 200, { ok: true, engines: ctx.supervisor.status() });
  });

  router.post("/admin/api/channels/:name/start", async (req, res, params) => {
    const name = params.name;
    if (!ctx.config.channels[name]) throw gwErr(404, "unknown_channel", `未知通道 ${name}`);
    const result = await ctx.supervisor.start(name);
    sendJson(res, 200, { ok: result.ok !== false, result, engines: ctx.supervisor.status() });
  });

  router.get("/admin/api/models", async (req, res) => {
    const list = await ctx.router.listAllModels();
    sendJson(res, 200, { count: list.length, models: list });
  });

  // ── 账号（studio 引擎账号库 + robin 凭证） ───────────────
  router.get("/admin/api/accounts", async (req, res) => {
    const out = { studio: { error: null, accounts: [] }, robin: { error: null, status: null } };
    try {
      out.studio.accounts = await ctx.channels.studio.listAccounts();
    } catch (err) {
      out.studio.error = err.message;
    }
    try {
      out.robin.status = await ctx.channels.robin.tokenStatus();
    } catch (err) {
      out.robin.error = err.message;
    }
    sendJson(res, 200, out);
  });

  router.post("/admin/api/accounts/import", async (req, res) => {
    const body = await readJson(req, { limit: 8 * 1024 * 1024 });
    const raw = String(body.cookies || body.text || "").trim();
    if (!raw) throw gwErr(400, "no_cookies", "缺少 cookies 文本");
    // 支持直接粘 Cookie 头字符串 / JSON 导出
    const cookies = raw.startsWith("{") || raw.startsWith("[") ? JSON.parse(raw) : null;
    const imported = await ctx.channels.studio.importCookies({
      cookies: cookies ? cookies : rawToPairs(raw),
      email: body.email,
      name: body.name,
      authUser: body.authuser != null ? String(body.authuser) : "0",
      tier: body.tier,
    });
    ctx.store.recordPush({
      at: nowIso(),
      label: imported?.name || body.name || "手工导入",
      email: body.email || null,
      authUser: String(body.authuser || "0"),
      tier: imported?.tier || body.tier || "Free",
      cookies: imported?.cookie_count ?? 0,
      accountId: imported?.account_id || null,
      source: "manual",
    });
    sendJson(res, 200, { ok: true, account: imported });
  });

  router.post("/admin/api/accounts/collect", async (req, res) => {
    const body = await readJson(req, { limit: 64 * 1024 });
    const sampled = await ctx.executors.collect(body.token || "");
    const email = body.email || sampled.email || undefined;
    const tierHeader = sampled.headers?.["x-aistudio-g1-tier"];
    const tier = tierHeader ? { TIER0: "Free", TIER1: "Pro", TIER2: "Ultra", TIER3: "Ultra_20X" }[tierHeader] : undefined;
    const imported = await ctx.channels.studio.importCookies({
      cookies: sampled.cookies,
      email,
      name: email || `浏览器采集 (u/${sampled.authuser || 0})`,
      authUser: sampled.authuser || "0",
      tier,
    });
    ctx.store.recordPush({
      at: nowIso(),
      label: imported?.name || email || "浏览器采集",
      email: email || null,
      authUser: sampled.authuser || "0",
      tier: imported?.tier || tier || "Free",
      cookies: imported?.cookie_count ?? sampled.cookies.length,
      accountId: imported?.account_id || null,
      source: "collect",
    });
    sendJson(res, 200, { ok: true, cookies: sampled.cookies.length, account: imported });
  });

  router.post("/admin/api/accounts/:id/activate", async (req, res, params) => {
    const account = await ctx.channels.studio.activateAccount(params.id);
    sendJson(res, 200, { ok: true, account });
  });

  router.post("/admin/api/accounts/:id/toggle", async (req, res, params) => {
    const account = await ctx.channels.studio.toggleAccount(params.id);
    sendJson(res, 200, { ok: true, account });
  });

  router.delete("/admin/api/accounts/:id", async (req, res, params) => {
    await ctx.channels.studio.deleteAccount(params.id);
    sendJson(res, 200, { ok: true });
  });

  router.get("/admin/api/robin", async (req, res) => {
    const out = { error: null, status: null, health: ctx.channels.robin.health };
    try {
      out.status = await ctx.channels.robin.tokenStatus();
    } catch (err) {
      out.error = err.message;
    }
    sendJson(res, 200, out);
  });

  router.post("/admin/api/robin/bind", async (req, res) => {
    const body = await readJson(req, { limit: 256 * 1024 });
    const email = String(body.email || "").trim().toLowerCase();
    const oauthToken = String(body.oauth_token || body.oauthToken || "").trim();
    if (!email || !oauthToken) throw gwErr(400, "invalid_args", "需要 email 与 oauth_token");
    const result = await ctx.channels.robin.bindOauthToken({ email, oauthToken, androidId: body.androidId });
    ctx.store.recordBind({ at: nowIso(), email, service: result?.service || null, tokenTail: result?.tokenTail || null });
    sendJson(res, 200, { ok: true, email, result });
  });

  router.post("/admin/api/robin/token", async (req, res) => {
    const body = await readJson(req, { limit: 128 * 1024 });
    const token = String(body.token || "").trim();
    if (!token.startsWith("ya29.")) throw gwErr(400, "invalid_token", "需要 ya29. 开头的访问令牌");
    const result = await ctx.channels.robin.injectToken({ token, expiresIn: body.expiresIn, account: body.account });
    sendJson(res, 200, { ok: true, result });
  });

  router.get("/admin/api/robin/modes", async (req, res) => {
    const modes = await ctx.channels.robin.modes(false);
    sendJson(res, 200, modes);
  });

  // ── 客户端密钥 ──────────────────────────────────────────
  router.get("/admin/api/keys", async (req, res) => {
    sendJson(res, 200, { keys: ctx.store.listKeys() });
  });

  router.post("/admin/api/keys", async (req, res) => {
    const body = await readJson(req);
    const key = ctx.store.createKey({
      name: body.name,
      channels: body.channels,
      rpm: body.rpm,
    });
    sendJson(res, 200, { ok: true, key });
  });

  router.put("/admin/api/keys/:id", async (req, res, params) => {
    const body = await readJson(req);
    const key = ctx.store.updateKey(params.id, body);
    if (!key) throw gwErr(404, "key_not_found", "密钥不存在");
    sendJson(res, 200, { ok: true, key });
  });

  router.delete("/admin/api/keys/:id", async (req, res, params) => {
    const ok = ctx.store.deleteKey(params.id);
    sendJson(res, 200, { ok });
  });

  // ── 配置 ────────────────────────────────────────────────
  router.get("/admin/api/config", async (req, res) => {
    const cfg = JSON.parse(JSON.stringify(ctx.config));
    if (cfg.auth?.adminToken) cfg.auth.adminToken = mask(cfg.auth.adminToken, 4);
    for (const ch of Object.values(cfg.channels || {})) {
      if (ch.apiKey) ch.apiKey = mask(ch.apiKey, 4);
      if (ch.adminKey) ch.adminKey = mask(ch.adminKey, 4);
    }
    sendJson(res, 200, cfg);
  });

  router.put("/admin/api/config", async (req, res) => {
    const patch = await readJson(req, { limit: 512 * 1024 });
    // 不允许通过面板改托管命令（安全边界），其余可热更新
    delete patch.gateway;
    delete patch.keys;
    const cfg = ctx.reloadConfigHot(patch);
    sendJson(res, 200, { ok: true, config: { routing: cfg.routing, executors: cfg.executors, auth: { requireKey: cfg.auth.requireKey } } });
  });

  // ── 日志 / 统计 ────────────────────────────────────────
  router.get("/admin/api/logs", async (req, res, params, query) => {
    const url = new URL(req.url, "http://localhost");
    const limit = Math.min(1000, Number(url.searchParams.get("limit") || 200));
    const level = url.searchParams.get("level") || null;
    sendJson(res, 200, { lines: ctx.log.tail(limit, level) });
  });

  router.get("/admin/api/stats", async (req, res) => {
    sendJson(res, 200, {
      cumulative: ctx.store.data.stats,
      live: ctx.metrics.snapshot(),
    });
  });

  router.post("/admin/api/metrics/reset", async (req, res) => {
    ctx.metrics.total = { requests: 0, ok: 0, error: 0, cancelled: 0, upstreamCalls: 0 };
    ctx.metrics.byChannel.clear();
    ctx.metrics.byModel.clear();
    ctx.metrics.recent.length = 0;
    ctx.metrics.latencyAll.length = 0;
    sendJson(res, 200, { ok: true });
  });

  // ── cat 脚本 ───────────────────────────────────────────
  router.get("/admin/api/cat/script", async (req, res) => {
    const base = ctx.publicBaseUrl(req);
    try {
      const built = ctx.catScript.build({ baseUrl: base, wsUrl: ctx.publicWsUrl(req) });
      sendJson(res, 200, {
        ok: true,
        version: built.version,
        baseUrl: base,
        wsUrl: ctx.publicWsUrl(req),
        pushUrl: `${base}/api/pggo/push`,
        robinBindUrl: `${base}/api/robin/bind-by-key`,
        scriptUrl: `${base}/api/pg/script.user.js`,
        size: Buffer.byteLength(built.text),
        sourceFile: ctx.catScript.sourceFile || null,
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message, scriptUrl: `${base}/api/pg/script.user.js` });
    }
  });

  router.get("/admin/api/executors", async (req, res) => {
    sendJson(res, 200, {
      executors: ctx.executors.snapshot(),
      size: ctx.executors.size,
      stats: ctx.executors.poolStats(),
    });
  });

  router.post("/admin/api/executors/ping", async (req, res) => {
    for (const ex of ctx.executors.executors.values()) {
      try {
        ex.send({ type: "ping", ts: Date.now() });
      } catch {
        /* ignore */
      }
    }
    sendJson(res, 200, { ok: true, count: ctx.executors.size });
  });

  // 调试用：把一个原始 {wire, binding} 请求体直接下发给浏览器执行器。
  // 用于验证执行器通路与上游格式，不参与正常路由。
  router.post("/admin/api/executors/dispatch", async (req, res) => {
    const body = await readJson(req, { limit: 32 * 1024 * 1024 });
    const payload = body.payload ?? body;
    if (!payload || !Array.isArray(payload.wire) || typeof payload.binding !== "string") {
      throw gwErr(400, "invalid_payload", "需要 {wire:[...], binding:'...'}");
    }
    const startedAt = Date.now();
    try {
      const r = await ctx.executors.dispatch({
        model: body.model || payload.wire?.[0] || "unknown",
        stream: !!body.stream,
        payload,
        timeoutMs: Number(body.timeoutMs) || 120000,
      });
      sendJson(res, 200, {
        ok: true,
        kind: r.kind,
        status: r.status,
        latencyMs: Date.now() - startedAt,
        raw: r.raw ?? null,
      });
    } catch (err) {
      sendJson(res, err.status || 502, {
        ok: false,
        error: err.message,
        code: err.code || null,
        latencyMs: Date.now() - startedAt,
      });
    }
  });
}

function rawToPairs(raw) {
  // 把 "a=1; b=2" 这种 Cookie 头转成 [{name,value}]
  return raw
    .split(/;\s*/)
    .map((part) => {
      const eq = part.indexOf("=");
      if (eq <= 0) return null;
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    })
    .filter(Boolean);
}