// 用「真实」catiecli 脚本母版验证本地化补丁是否成功（同时检查残留的云端地址）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, ROOT } from "../src/config.mjs";
import { CatScript } from "../src/cat-script.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();
const log = { info: (...a) => console.log("[info]", ...a), warn: (...a) => console.warn("[warn]", ...a), error: (...a) => console.error("[error]", ...a), debug() {} };

const cs = new CatScript({
  config: cfg,
  log,
  // 网关构建时会注入当前默认客户端 Key，这里照做以便验证注入结果
  defaultKey: () => {
    try {
      const st = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "state.json"), "utf8"));
      return st?.keys?.find((k) => k.enabled !== false)?.token || "";
    } catch {
      return "";
    }
  },
});
const base = "http://127.0.0.1:8788";

// 与网关 publicWsUrl 同规则：有 TLS 证书就必须给 wss（https 页面拦 ws://）
const tls = cfg.gateway?.tls;
const tlsOk =
  tls?.enabled &&
  fs.existsSync(path.resolve(ROOT, tls.certPath || "")) &&
  fs.existsSync(path.resolve(ROOT, tls.keyPath || ""));
const wsUrl = tlsOk ? `wss://127.0.0.1:${tls.port}/api/pg/ws` : "ws://127.0.0.1:8788/api/pg/ws";

const built = cs.build({ baseUrl: base, wsUrl });
const t = built.text;

const checks = [
  ["脚本版本行存在", /\/\/ @version\s+2\.21\.0/.test(t)],
  ["WS 地址已本地化", t.includes(wsUrl)],
  ["未残留 ws:// 明文地址（TLS 已启用）", !tlsOk || !t.includes(`ws://127.0.0.1:`)],
  ["PUSH 地址已本地化", t.includes("http://127.0.0.1:8788/api/pggo/push")],
  ["SCRIPT 地址已本地化", t.includes("http://127.0.0.1:8788/api/pg/script.user.js")],
  ["ROBIN 绑定地址已本地化", t.includes("http://127.0.0.1:8788/api/robin/bind-by-key")],
  ["@connect 含本机", /\/\/ @connect\s+127\.0\.0\.1/.test(t)],
  ["已注入采集函数", t.includes("async function handleCatlocalCollect")],
  ["已注入默认 Key（免填写）", /apiKey: gmStore\.get\(API_KEY_STORE_KEY,\s*""\)\s*\|\|/.test(t)],
  ["已挂 collect 分支", t.includes('case "collect":')],
  ["未残留云端 WS", !t.includes("wss://catiecli.sukaka.top/api/pg/ws")],
  ["未残留云端 PUSH", !t.includes("https://catiecli.sukaka.top/api/pggo/push")],
  ["未残留云端 robin bind", !t.includes("https://catiecli.sukaka.top/api/robin/bind-by-key")],
  ["远端 @downloadURL 已改写", !/\/\/ @downloadURL\s+https:\/\/catiecli\.sukaka\.top/.test(t)],
];

let ok = 0;
for (const [name, pass] of checks) {
  console.log(`${pass ? "✓" : "✗"} ${name}`);
  if (pass) ok++;
}
console.log(`\n${ok}/${checks.length} 项通过 · 逐字节 ${Buffer.byteLength(t)}（原 ${Buffer.byteLength(cs.sourceText || "")}）· 母版 ${cs.sourceFile}`);

// 顺带把补丁后的脚本落一份，便于人工对比
const outFile = path.join(HERE, "..", "data", "catiecli.local.user.js");
fs.writeFileSync(outFile, t, "utf8");
console.log("已写出样本：" + outFile);
process.exit(ok === checks.length ? 0 : 1);