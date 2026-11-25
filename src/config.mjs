// 配置：config.json（首次运行自动生成）+ 环境变量覆盖。
// 配置文件是唯一「真源」，面板改设置也写回这里（热生效，不重启）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deepMerge, randomKey } from "./util.mjs";

function randomSecret(prefix) {
  return randomKey(prefix);
}

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 允许用环境变量重定位数据目录/配置文件（自测与多实例部署用）
export const DATA_DIR = process.env.CATLOCAL_DATA_DIR
  ? path.resolve(process.env.CATLOCAL_DATA_DIR)
  : path.join(ROOT, "data");
export const CONFIG_FILE = process.env.CATLOCAL_CONFIG
  ? path.resolve(process.env.CATLOCAL_CONFIG)
  : path.join(ROOT, "config.json");

const DEFAULT_CONFIG = {
  gateway: {
    host: "127.0.0.1",
    port: 8788,
    // 对外标题（面板/healthz 显示）
    title: "CatLocal · 本地统一接入",
    // 额外起一个 https 监听，专供浏览器执行器的 wss:// 使用。
    // 原因：AI Studio 页面是 https，浏览器会按混合内容规则直接拒绝 ws://127.0.0.1。
    // 证书由 scripts/make-cert.mjs 生成（自签，只落文件）；浏览器需接受或信任它。
    tls: {
      enabled: true,
      port: 8789,
      certPath: "data/tls/catlocal.crt",
      keyPath: "data/tls/catlocal.key",
    },
  },

  auth: {
    // 管理口令：为空则管理接口仅允许本机访问（127.0.0.1），面板免口令
    adminToken: "",
    // 客户端密钥校验：默认关闭 —— 本机独占使用，脚本/客户端都不用填 Key。
    // 要把端口暴露到局域网/公网时，务必改回 true 并设置 adminToken。
    requireKey: false,
    // 允许匿名直连的本机地址（默认放行 loopback，便于本地脚本调试）
    allowLoopbackWithoutKey: true,
  },
  channels: {
    // 页面转发通道：请求由浏览器标签页（cat 脚本）真正执行。凭证不落地，出口/指纹/签名都是真浏览器。
    // 代价：必须开着 AI Studio 页面，且比无头慢（每轮 6~15s）。
    browser: {
      label: "Browser · 页面转发通道（真浏览器执行）",
      enabled: true,
      // 没有自己的引擎：encodeWire/parseWire 借用 studio 引擎的编解码器（不涉及账号、不发上游）
      managed: { enabled: false },
      concurrency: 4,
      maxQueue: 32,
      queueTimeoutMs: 120000,
      // 浏览器往返 + 现场取 proof 都很慢，给足时间
      timeoutMs: 900000,
      retries: 0,
      retryBackoffMs: 700,
      modelsCacheMs: 300000,
      // pg / pggo 是 cat 的「Playground 页面执行」语义，必须落到这里
      aliases: ["pg", "pggo", "page", "browser"],
    },
    studio: {
      label: "Studio · AI Studio 无头通道",
      enabled: true,
      // 注意：8080 在不少机器上已被别的服务/容器占用，这里默认用 8180；
      // install.ps1 会在端口被占时自动往后找一个空闲端口并写回配置。
      baseUrl: "http://127.0.0.1:8180",
      // 网关调用引擎时带的 Key（对应 aistudio-api config.yaml 的 api_keys；为空则不校验）
      apiKey: "",
      // 子进程托管：由网关的 supervisor 拉起 / 守护
      managed: {
        enabled: true,
        cwd: "../aistudio-api",
        command: ".venv/Scripts/python.exe",
        args: ["main.py", "server", "--port", "8180"],
        env: {},
      },
      concurrency: 6,
      maxQueue: 64,
      queueTimeoutMs: 120000,
      // 单请求硬超时 / 流式空闲超时
      timeoutMs: 900000,
      idleTimeoutMs: 300000,
      // 重试次数（仅对幂等失败：429/502/503/504/网络错误）
      retries: 1,
      retryBackoffMs: 700,
      // 模型清单缓存
      modelsCacheMs: 300000,
      // 凭证自愈：账号会话过期/冷却时，自动从在线浏览器执行器采集 Cookie 并重试本次请求。
      // ⚠ 默认关闭：反复把浏览器会话 Cookie 搬进无头引擎属于账号风控风险项（容易被判定异常登录），
      //   代价大于「一次请求失败」。要用必须显式改 true，并接受「过期 → 重采」的循环。
      autoRecover: {
        enabled: false,
        // 两次自动采集之间的最小间隔（毫秒）：防止失败风暴把浏览器和引擎打满
        minIntervalMs: 20000,
        // 等浏览器回传 Cookie 的超时
        collectTimeoutMs: 25000,
      },
      // 模型名前缀：只保留 studio/（pg / pggo 归页面转发通道，见 browser.aliases）
      aliases: ["studio"],
    },
    robin: {
      label: "Robin · Summeretto 高速通道",
      enabled: true,
      baseUrl: "http://127.0.0.1:3000",
      // Summeretto 的 PROXY_API_KEY（网关内部用，与客户端 Key 无关）
      apiKey: "",
      managed: {
        enabled: true,
        cwd: "../Summeretto/service",
        command: "node",
        args: ["server.mjs"],
        env: {},
      },
      concurrency: 4,
      maxQueue: 64,
      queueTimeoutMs: 120000,
      timeoutMs: 600000,
      idleTimeoutMs: 300000,
      retries: 1,
      retryBackoffMs: 700,
      modelsCacheMs: 300000,
      aliases: ["robin", "rb"],
    },
  },
  routing: {
    // 默认通道：无前缀的模型名走哪里。
    // 默认给 browser —— 请求由真浏览器执行，不会把导入的 Cookie 拿去冒充会话。
    defaultChannel: "browser",
    // 精确模型名覆盖：{"my-alias": {"channel":"robin","model":"gemini-4-argon"}}
    overrides: {},
    // 通道故障时是否跨通道回退（同族模型名，仅在两通道都有该模型时生效）
    failover: false,
    // 回退顺序：默认留空 = 不自动回退。
    // 有意不把 studio 放进来自动兜底：那条路会重放导入的 Cookie，账号风险由使用者自己决定。
    fallbackOrder: [],
    // 跨通道回退等价表（源模型 → 目标模型；留空则同名回退）
    failoverMap: {},
  },
  executors: {
    // 浏览器执行器（catiecli 脚本 WS 模式）接入
    enabled: true,
    // 执行器心跳超时（毫秒）
    heartbeatTimeoutMs: 75000,
    maxExecutors: 32,
  },
  cat: {
    // 是否允许「返回缓存内容」等 cat 脚本辅助能力
    replayCache: true,
    // 脚本下发时替换成的本机地址（留空则按监听地址自动推导）
    publicBaseUrl: "",
    // 原始脚本路径（首次启动会复制到 data/catiecli.user.js 作为母版）
    sourcePath: "C:\\Users\\Administrator\\Downloads\\Catiecli Playground Executor-2.21.0.txt",
  },
  logging: {
    level: "info",
    keepDays: 7,
  },
  keys: [],
};

function envOverrides(cfg) {
  const env = process.env;
  if (env.CATLOCAL_HOST) cfg.gateway.host = env.CATLOCAL_HOST;
  if (env.CATLOCAL_PORT) cfg.gateway.port = Number(env.CATLOCAL_PORT);
  if (env.CATLOCAL_ADMIN_TOKEN) cfg.auth.adminToken = env.CATLOCAL_ADMIN_TOKEN;
  if (env.STUDIO_URL) cfg.channels.studio.baseUrl = env.STUDIO_URL;
  if (env.ROBIN_URL) cfg.channels.robin.baseUrl = env.ROBIN_URL;
  if (env.STUDIO_API_KEY) cfg.channels.studio.apiKey = env.STUDIO_API_KEY;
  if (env.ROBIN_API_KEY) cfg.channels.robin.apiKey = env.ROBIN_API_KEY;
  if (env.CATLOCAL_LOG_LEVEL) cfg.logging.level = env.CATLOCAL_LOG_LEVEL;
  return cfg;
}

export function defaultConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

export function loadConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let user = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      user = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    } catch (err) {
      throw new Error(`config.json 解析失败：${err.message}`);
    }
  } else {
    // 首次运行：只生成「网关↔引擎」之间的内部口令（用户不需要关心）。
    // 管理口令保持为空 —— 单机自用，面板免口令；要开放到局域网时再自己设。
    const seed = defaultConfig();
    seed.channels.robin.apiKey = randomSecret("rb");
    seed.channels.robin.adminKey = randomSecret("rbadmin");
    seed.channels.studio.apiKey = randomSecret("st");
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(seed, null, 2), "utf8");
    console.log(`[config] 已生成默认配置 ${CONFIG_FILE}`);
    user = seed;
  }
  const merged = deepMerge(defaultConfig(), user);

  // 升级友好：新版本新增的配置键自动补进用户的 config.json（用户已有值优先级更高）。
  // 否则新功能（比如 gateway.tls）只在内存生效，用户打开 config.json 找不到、也没法改。
  const missing = missingPaths(merged, user);
  if (missing.length) {
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), "utf8");
      console.log(`[config] 已补全 ${missing.length} 个新配置项：${missing.slice(0, 6).join(", ")}${missing.length > 6 ? " …" : ""}`);
    } catch {
      /* 写不进去就只在内存生效 */
    }
  }
  return envOverrides(merged);
}

/** 返回 base 里有、sub 里没有的路径（只递归对象） */
function missingPaths(base, sub, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(base)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (!(k in (sub || {}))) {
      out.push(p);
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v) && sub[k] && typeof sub[k] === "object") {
      out.push(...missingPaths(v, sub[k], p));
    }
  }
  return out;
}

/** 把配置写回 config.json（面板「保存设置」用） */
export function saveConfig(cfg) {
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_FILE);
}

/** 判断某地址是否 loopback（管理接口/匿名直连用） */
export function isLoopback(addr) {
  const a = String(addr || "");
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}