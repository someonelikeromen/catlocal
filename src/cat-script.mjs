// catiecli 用户脚本本地化：把脚本里写死的云端地址替换成本机网关地址，
// 并注入「浏览器凭证采集」能力（collect），让本地网关可以一键把浏览器里的
// 真人会话搬进无头 studio 引擎，而不用手点推送。
//
// 所有替换都带锚点断言：上游脚本改版导致锚点消失时会明确报错，而不是静默产出坏脚本。
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.mjs";

const LOCAL_BLOCK_ANCHOR = "    // ==================== WS 客户端 ====================";
const SWITCH_ANCHOR = `                case "request":`;

const COLLECT_HANDLER = `    // ==================== [catlocal] 浏览器凭证采集 ====================
    // 本地网关可以通过 WS 下发 {type:"collect", requestId}，脚本把当前页的
    // Cookie / 捕获请求头 / 邮箱 / 账号索引 / 浏览器指纹回传，网关据此
    // 给无头 studio 引擎建档（等价于用户手点「推送 Cookie」，但可定时自动化）。
    async function handleCatlocalCollect(msg) {
        const requestId = msg && msg.requestId;
        try {
            if (!cookieApi()) {
                throw new Error("当前脚本管理器不支持 Cookie API（GM_cookie / GM.cookie）");
            }
            const cookies = await collectCookies();
            if (!cookies.length) throw new Error("未采集到任何 Cookie（未登录或被浏览器限制）");
            const captured = (typeof getHeaders === "function" && getHeaders()) || {};
            const headers = {};
            for (const k of ["x-goog-api-key", "x-aistudio-g1-tier", "x-aistudio-visit-id", "x-goog-authuser"]) {
                if (captured[k]) headers[k] = captured[k];
            }
            for (const k of Object.keys(captured)) {
                if (/^x-goog-ext-/.test(k)) headers[k] = captured[k];
            }
            const authuser = (accountPathPrefix().match(/^\\/u\\/(\\d+)\\/$/) || [])[1] || "0";
            const email = (typeof detectEmail === "function" && detectEmail()) || "";
            const fingerprint = typeof collectBrowserFingerprint === "function" ? collectBrowserFingerprint() : null;
            wsSend({
                type: "collect-result",
                requestId,
                status: 200,
                cookies: cookies.map((c) => ({
                    name: c.name,
                    value: c.value,
                    domain: c.domain,
                    path: c.path || "/",
                    expirationDate: typeof c.expirationDate === "number" ? c.expirationDate : -1,
                    httpOnly: !!c.httpOnly,
                    secure: !!c.secure,
                    sameSite: c.sameSite || "unspecified",
                })),
                headers,
                email,
                authuser,
                fingerprint,
            });
            log(\`📤 [本地网关] 已回传 \${cookies.length} 条 Cookie\${email ? "（" + email + "）" : ""}\`);
        } catch (e) {
            wsSend({
                type: "collect-result",
                requestId,
                status: 500,
                error: { code: "collect_failed", message: String((e && e.message) || e) },
            });
            log("[本地网关] 采集失败: " + ((e && e.message) || e));
        }
    }

`;

export class CatScript {
  constructor({ config, log, defaultKey = null }) {
    this.config = config;
    this.log = log;
    this.sourceText = null;
    this.cacheKey = null;
    this.cacheValue = null;
    // 单机自用场景：网关不校验 Key 时，脚本仍强制要求填 Key，所以把本机默认 Key
    // 直接注入脚本，装完即连，不需要用户再去菜单里粘贴。
    this.defaultKey = typeof defaultKey === "function" ? defaultKey : () => defaultKey || "";
  }

  _readSource() {
    if (this.sourceText) return this.sourceText;
    const candidates = [];
    if (this.config.cat?.sourcePath) candidates.push(this.config.cat.sourcePath);
    candidates.push(path.join(DATA_DIR, "catiecli.user.js"));
    candidates.push(path.join(DATA_DIR, "catiecli.user.txt"));

    for (const file of candidates) {
      try {
        if (file && fs.existsSync(file)) {
          const text = fs.readFileSync(file, "utf8");
          if (text.includes("Catiecli Playground Executor")) {
            this.sourceText = text;
            this.sourceFile = file;
            // 留一份本地母版，避免原始下载文件被清理后无法下发
            const local = path.join(DATA_DIR, "catiecli.user.js");
            if (path.resolve(file) !== path.resolve(local) && !fs.existsSync(local)) {
              fs.mkdirSync(DATA_DIR, { recursive: true });
              fs.writeFileSync(local, text, "utf8");
            }
            this.log.info("已加载 catiecli 用户脚本母版", { file });
            return text;
          }
        }
      } catch {
        /* 继续尝试下一个 */
      }
    }
    throw new Error(
      "找不到 catiecli 用户脚本母版。请把 Catiecli Playground Executor-*.txt 放到 data/catiecli.user.js，" +
        "或在 config.json 的 cat.sourcePath 指到它的位置。"
    );
  }

  /** 生成本机版脚本（baseUrl 形如 http://127.0.0.1:8788） */
  build({ baseUrl, wsUrl: explicitWsUrl = null }) {
    // wsUrl 由网关按「是否有 TLS 监听」决定：https 页面不能用 ws://（混合内容会被拦）
    const wsUrl = explicitWsUrl || baseUrl.replace(/^http/, "ws") + "/api/pg/ws";
    const localKey = String(this.defaultKey() || "").trim();
    const key = `script:${baseUrl}|${wsUrl}|${localKey}`;
    if (this.cacheKey === key && this.cacheValue) return this.cacheValue;
    let text = this._readSource();

    const replacements = [
      [
        /const WS_URL = "[^"]+";/,
        `const WS_URL = "${wsUrl}"; // [catlocal] 本地网关`,
      ],
      [
        /const PUSH_URL = "[^"]+";/,
        `const PUSH_URL = "${baseUrl}/api/pggo/push"; // [catlocal]`,
      ],
      [
        /const SCRIPT_URL = "[^"]+";[^\n]*/,
        `const SCRIPT_URL = "${baseUrl}/api/pg/script.user.js"; // [catlocal] 本地同源`,
      ],
      [
        /const ROBIN_BIND_URL = "[^"]+";/,
        `const ROBIN_BIND_URL = "${baseUrl}/api/robin/bind-by-key"; // [catlocal]`,
      ],
      [
        /\/\/ @connect\s+[^\n]+/,
        (() => {
          const h = hostOf(baseUrl);
          // @connect 重复会让脚本头变脏，这里去重
          const hosts = [...new Set([h, "127.0.0.1", "localhost"])];
          return hosts.map((x) => `// @connect      ${x}`).join("\n");
        })(),
      ],
      [/\/\/ @downloadURL\s+[^\n]+/, `// @downloadURL  ${baseUrl}/api/pg/script.user.js`],
      [/\/\/ @updateURL\s+[^\n]+/, `// @updateURL    ${baseUrl}/api/pg/script.user.js`],
      [/\/\/ @homepageURL\s+[^\n]+/, `// @homepageURL  ${baseUrl}/`],
      [/\/\/ @namespace\s+[^\n]+/, `// @namespace    ${baseUrl}/`],
    ];

    for (const [re, to] of replacements) {
      if (!re.test(text)) throw new Error(`用户脚本补丁锚点缺失：${re}`);
      text = text.replace(re, to);
    }

    // 单机自用：把本机默认 Key 写成脚本里的兜底值，装完不用再填。
    // 这是「附加能力」而非必须项：母版没这段时降级成「脚本会要求手填 Key」，不报错。
    let keyInjected = false;
    if (localKey) {
      const keyRe = /apiKey:\s*gmStore\.get\(API_KEY_STORE_KEY,\s*""\)/;
      if (keyRe.test(text)) {
        text = text.replace(keyRe, `apiKey: gmStore.get(API_KEY_STORE_KEY, "") || ${JSON.stringify(localKey)}`);
        keyInjected = true;
      } else {
        this.log.warn?.("用户脚本母版缺少 apiKey 锚点，跳过默认 Key 注入（脚本将要求手填 Key）");
      }
    }

    // 注入 collect 处理函数
    if (!text.includes(LOCAL_BLOCK_ANCHOR)) throw new Error("用户脚本补丁锚点缺失：WS 客户端区块");
    text = text.replace(LOCAL_BLOCK_ANCHOR, COLLECT_HANDLER + LOCAL_BLOCK_ANCHOR);

    // 在 WS 消息分发里挂上 collect 分支
    if (!text.includes(SWITCH_ANCHOR)) throw new Error("用户脚本补丁锚点缺失：request 分支");
    text = text.replace(
      SWITCH_ANCHOR,
      `                case "collect":\n                    handleCatlocalCollect(msg).catch((e) => log("collect 异常: " + e));\n                    break;\n${SWITCH_ANCHOR}`
    );

    // 版本号加本地后缀，便于面板里区分「云端版 / 本地版」
    const versionMatch = /\/\/ @version\s+([0-9.]+)/.exec(text);
    const version = versionMatch ? versionMatch[1] : "unknown";
    text = text.replace(
      /\/\/ @version\s+([0-9.]+)/,
      `// @version      $1`
    );

    this.cacheKey = key;
    this.cacheValue = { text, version, baseUrl, wsUrl, keyInjected };
    return this.cacheValue;
  }
}

function hostOf(baseUrl) {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "127.0.0.1";
  }
}