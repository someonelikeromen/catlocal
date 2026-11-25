// catiecli 协议兼容层（把「云端 cat」搬回本地）：
//   POST /api/pggo/push            Cookie 推送 → 写进 studio 无头引擎账号库
//   POST /api/robin/bind-by-key    Robin oauth_token → 换成 master token 并绑定
//   GET  /api/pg/script.user.js    下发本机版用户脚本（地址已替换为本地网关）
//   POST /api/pg/collect           主动从浏览器执行器采集凭证
//   GET  /api/pg/status            面板用：脚本/执行器/凭证概况
import { sendJson, sendError, readJson } from "../http.mjs";
import { gwErr, mask, nowIso, randomId } from "../util.mjs";

const TIER_MAP = { TIER0: "Free", TIER1: "Pro", TIER2: "Ultra", TIER3: "Ultra_20X" };

function epochSec() {
  return Math.floor(Date.now() / 1000);
}

/** Cookie 推送：与 cat 的响应字段保持一致（label / cookies / created_at） */
export async function handleCookiePush(ctx, req, res, body) {
  const cookies = Array.isArray(body?.cookies) ? body.cookies : [];
  if (!cookies.length) throw gwErr(400, "no_cookies", "推送内容里没有 Cookie（cookies 为空）");

  const missing = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID", "HSID", "SSID"].filter(
    (n) => !cookies.some((c) => c?.name === n)
  );
  if (missing.length) {
    throw gwErr(400, "missing_session_cookies", `缺少会话必需 Cookie（${missing.length} 件）：${missing.join(", ")}`);
  }

  const email = body?.email ? String(body.email).toLowerCase() : undefined;
  const authUser = body?.authuser != null ? String(body.authuser) : "0";
  const tierHeader = body?.headers?.["x-aistudio-g1-tier"];
  const tier = tierHeader ? TIER_MAP[String(tierHeader).toUpperCase()] : undefined;
  const label = email || `Google Account (u/${authUser})`;

  const studio = ctx.channels.studio;
  if (!studio?.enabled) throw gwErr(503, "studio_disabled", "studio 通道未启用，无法接收 Cookie");

  const imported = await studio.importCookies({ cookies, email, name: label, authUser, tier });

  const record = {
    at: nowIso(),
    label: imported?.name || label,
    email: email || imported?.email || null,
    authUser,
    tier: imported?.tier || tier || "Free",
    cookies: imported?.cookie_count ?? cookies.length,
    accountId: imported?.account_id || null,
    fingerprint: body?.fingerprint ? describeFingerprint(body.fingerprint) : null,
  };
  ctx.store.recordPush(record);
  ctx.log.info("收到 Cookie 推送并已建档", {
    label: record.label,
    cookies: record.cookies,
    accountId: record.accountId,
    tier: record.tier,
  });

  sendJson(res, 200, {
    status: "ok",
    label: record.label,
    cookies: record.cookies,
    created_at: epochSec(),
    account_id: record.accountId,
    authuser: authUser,
    tier: record.tier,
    message: "已写入本地 studio 引擎（pggo- 模型已可用）",
  });
}

function describeFingerprint(fp) {
  if (!fp || typeof fp !== "object") return null;
  const w = fp.screenWidth ?? fp.width;
  const h = fp.screenHeight ?? fp.height;
  return [w && h ? `${w}x${h}` : null, fp.timezone || null, fp.language || null].filter(Boolean).join(" @ ") || null;
}

/** Robin 凭证绑定：{email, oauth_token} → Summeretto /admin/gpsoauth */
export async function handleRobinBind(ctx, req, res, body) {
  const email = String(body?.email || "").trim().toLowerCase();
  const oauthToken = String(body?.oauth_token || body?.oauthToken || "").trim();
  if (!oauthToken) throw gwErr(400, "no_oauth_token", "缺少 oauth_token（需在 Google 登录流程点过「I agree」后再推送）");
  if (!/^[\w.+-]+@[\w.-]+\.\w+$/.test(email)) throw gwErr(400, "bad_email", "邮箱格式不正确");

  const robin = ctx.channels.robin;
  if (!robin?.enabled) throw gwErr(503, "robin_disabled", "robin 通道未启用，无法绑定凭证");

  ctx.log.info("收到 Robin 凭证推送，正在换取 master token", { email, token: mask(oauthToken, 4) });
  const result = await robin.bindOauthToken({ email, oauthToken });
  const at = nowIso();
  ctx.store.recordBind({ at, email, service: result?.service || null, tokenTail: result?.tokenTail || null });

  sendJson(res, 200, {
    status: "ok",
    email,
    message: `已绑定 ${email}（master token 已保存，robin 通道立即可用）`,
    tokenTail: result?.tokenTail || null,
    service: result?.service || null,
    bound_at: at,
  });
}

/** 主动采集：让在线浏览器执行器回传凭证，并写入 studio 引擎 */
export async function handleCollect(ctx, req, res, body) {
  const token = req.apiToken || "";
  const sampled = await ctx.executors.collect(token);
  const email = body?.email || sampled.email || undefined;
  const authUser = sampled.authuser || "0";
  const tierHeader = sampled.headers?.["x-aistudio-g1-tier"];
  const tier = tierHeader ? TIER_MAP[String(tierHeader).toUpperCase()] : undefined;

  let imported = null;
  let importError = null;
  if (body?.import !== false && sampled.cookies.length) {
    try {
      imported = await ctx.channels.studio.importCookies({
        cookies: sampled.cookies,
        email,
        name: email || `Browser Collect (u/${authUser})`,
        authUser,
        tier,
      });
      ctx.store.recordPush({
        at: nowIso(),
        label: imported?.name || email || "浏览器采集",
        email: email || null,
        authUser,
        tier: imported?.tier || tier || "Free",
        cookies: imported?.cookie_count ?? sampled.cookies.length,
        accountId: imported?.account_id || null,
        source: "collect",
      });
    } catch (err) {
      importError = err.message;
    }
  }
  sendJson(res, 200, {
    status: "ok",
    email: email || null,
    authuser: authUser,
    cookies: sampled.cookies.length,
    headers: Object.keys(sampled.headers || {}),
    account_id: imported?.account_id || null,
    import_error: importError,
  });
}

/** 下本机版用户脚本 */
export function handleScript(ctx, req, res) {
  const built = ctx.catScript.build({ baseUrl: ctx.publicBaseUrl(req), wsUrl: ctx.publicWsUrl(req) });
  res.writeHead(200, {
    "content-type": "application/javascript; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(built.text),
    "access-control-allow-origin": "*",
  });
  res.end(built.text);
}

/** 脚本元信息（面板展示 + 更新检查） */
export function handleScriptInfo(ctx, req, res) {
  const built = ctx.catScript.build({ baseUrl: ctx.publicBaseUrl(req), wsUrl: ctx.publicWsUrl(req) });
  const m = /\/\/ @version\s+([0-9.]+)/.exec(built.text);
  sendJson(res, 200, {
    version: m ? m[1] : built.version,
    baseUrl: built.baseUrl,
    wsUrl: built.wsUrl || ctx.publicWsUrl(req),
    size: Buffer.byteLength(built.text),
    sourceFile: ctx.catScript.sourceFile || null,
    patched: true,
    notes: [
      "所有 catiecli 云端地址已替换为本机网关地址",
      "已注入 collect：网关可主动把浏览器凭证搬进无头 studio 引擎",
    ],
  });
}

/** 面板用概况 */
export async function handleCatStatus(ctx, req, res) {
  let script = null;
  try {
    script = handleScriptInfoData(ctx, req);
  } catch (err) {
    script = { error: err.message };
  }
  sendJson(res, 200, {
    script,
    executors: ctx.executors.snapshot(),
    executorPool: ctx.executors.poolStats(),
    lastPush: ctx.store.data.cat?.lastPush || null,
    recentPushes: (ctx.store.data.cat?.pushes || []).slice(0, 10),
    robin: ctx.store.data.robin || {},
    keys: ctx.store.listKeys().map((k) => ({ ...k, token: mask(k.token, 8) })),
  });
}

function handleScriptInfoData(ctx, req) {
  const built = ctx.catScript.build({ baseUrl: ctx.publicBaseUrl(req), wsUrl: ctx.publicWsUrl(req) });
  return { version: built.version, baseUrl: built.baseUrl, size: Buffer.byteLength(built.text) };
}