#!/usr/bin/env node
// 生成本机自签证书（给 wss:// 用）。
// 为什么需要：AI Studio 页面是 https，浏览器按混合内容规则会直接拒绝 ws://127.0.0.1，
// 所以脚本的 WS 通道必须走 wss。证书只落文件，不写系统证书库；信任与否由用户决定
// （scripts\trust-cert.ps1 可一键装进「当前用户 → 受信任的根证书」）。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.mjs";

const outDir = path.join(ROOT, "data", "tls");
const keyPath = path.join(outDir, "catlocal.key");
const certPath = path.join(outDir, "catlocal.crt");

function findOpenssl() {
  const candidates = [
    process.env.OPENSSL_BIN,
    "openssl",
    "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
    "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
    "/usr/bin/openssl",
    "/usr/local/bin/openssl",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ["version"], { stdio: "ignore" });
      return c;
    } catch {
      /* 试下一个 */
    }
  }
  return null;
}

const openssl = findOpenssl();
if (!openssl) {
  console.error("[make-cert] 找不到 openssl。请安装 OpenSSL，或设置 OPENSSL_BIN 指向可执行文件。");
  console.error("           Windows 上装了 Git 的话通常已有：C:\\Program Files\\Git\\usr\\bin\\openssl.exe");
  process.exit(1);
}

if (fs.existsSync(certPath) && fs.existsSync(keyPath) && !process.argv.includes("--force")) {
  const stat = fs.statSync(certPath);
  console.log(`[make-cert] 证书已存在，跳过：${certPath}（${stat.mtime.toISOString()}）`);
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

const args = [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  keyPath,
  "-out",
  certPath,
  "-days",
  "825",
  "-subj",
  "/CN=CatLocal Local Gateway",
  "-addext",
  "subjectAltName=DNS:localhost,IP:127.0.0.1",
  "-addext",
  "basicConstraints=critical,CA:TRUE",
  "-addext",
  "keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign",
  "-addext",
  "extendedKeyUsage=serverAuth",
];

try {
  execFileSync(openssl, args, { stdio: ["ignore", "ignore", "pipe"] });
} catch (err) {
  console.error("[make-cert] 生成失败：", err.stderr ? err.stderr.toString() : err.message);
  process.exit(1);
}

console.log("[make-cert] 已生成：");
console.log("  证书 " + certPath);
console.log("  私钥 " + keyPath);
console.log("  有效期 825 天，SAN = DNS:localhost, IP:127.0.0.1");
console.log("");
console.log("  下一步：");
console.log("   1) 在 config.json 里打开 gateway.tls.enabled（默认已打开），重启网关");
console.log("   2) 浏览器先访问一次 https://127.0.0.1:8789 并接受证书告警（或运行 scripts\\trust-cert.ps1 装进受信任根）");
console.log("   3) 之后脚本的 wss:// 连接才能建立");