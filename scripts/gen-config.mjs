#!/usr/bin/env node
// 触发配置生成并打印关键信息（install.ps1 调用）。
// 只做「读/建配置」与端口避让，不起服务、不拉引擎。
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { loadConfig, saveConfig, CONFIG_FILE, DATA_DIR, ROOT } from "../src/config.mjs";
import { Store } from "../src/store.mjs";
import { CatScript } from "../src/cat-script.mjs";

const cfg = loadConfig();

/** 端口是否已被占用（只测 127.0.0.1） */
function portBusy(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(true));
    srv.once("listening", () => srv.close(() => resolve(false)));
    srv.listen(port, "127.0.0.1");
  });
}

function portOf(url, fallback) {
  try {
    return Number(new URL(url).port || fallback);
  } catch {
    return fallback;
  }
}

/** 通道端口被占用时自动往后挪（8080 常常被别的项目占着） */
async function ensureChannelPort(name, cfgObj, startFrom = 8180, limit = 8280) {
  const base = cfgObj.channels[name].baseUrl;
  const want = portOf(base, startFrom);
  if (!(await portBusy(want))) return { changed: false, port: want, baseUrl: base };

  for (let p = startFrom; p <= limit; p++) {
    if (await portBusy(p)) continue;
    const newBase = `http://127.0.0.1:${p}`;
    cfgObj.channels[name].baseUrl = newBase;
    const managed = cfgObj.channels[name].managed;
    if (managed?.args) {
      const args = [...managed.args];
      const idx = args.indexOf("--port");
      if (idx >= 0 && idx + 1 < args.length) args[idx + 1] = String(p);
      managed.args = args;
    }
    saveConfig(cfgObj);
    return { changed: true, from: want, port: p, baseUrl: newBase };
  }
  return { changed: false, port: want, baseUrl: base, error: "没有找到空闲端口" };
}

const moves = [];
for (const name of ["studio", "robin"]) {
  const r = await ensureChannelPort(name, cfg, name === "studio" ? 8180 : 3000, 8280);
  if (r.changed) moves.push({ channel: name, ...r });
}

const store = new Store();

const out = {
  root: ROOT,
  config: CONFIG_FILE,
  dataDir: DATA_DIR,
  gateway: `${cfg.gateway.host}:${cfg.gateway.port}`,
  adminToken: cfg.auth.adminToken,
  studio: { baseUrl: cfg.channels.studio.baseUrl, apiKey: cfg.channels.studio.apiKey },
  robin: { baseUrl: cfg.channels.robin.baseUrl, apiKey: cfg.channels.robin.apiKey, adminKey: cfg.channels.robin.adminKey },
  portMoves: moves,
  keys: store.listKeys(),
  catScript: null,
};

try {
  // 与网关 server.mjs 同一套规则：有 TLS 证书就给 wss，否则退回 ws
  const tls = cfg.gateway?.tls;
  const tlsOk =
    tls?.enabled &&
    fs.existsSync(path.resolve(ROOT, tls.certPath || "")) &&
    fs.existsSync(path.resolve(ROOT, tls.keyPath || ""));
  const host = cfg.gateway.host === "0.0.0.0" ? "127.0.0.1" : cfg.gateway.host;
  const wsUrl = tlsOk
    ? `wss://${host}:${tls.port}/api/pg/ws`
    : `ws://${host}:${cfg.gateway.port}/api/pg/ws`;
  const built = new CatScript({
    config: cfg,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    defaultKey: () => store.listKeys()[0]?.token || "cat-local",
  }).build({ baseUrl: `http://${host}:${cfg.gateway.port}`, wsUrl });
  out.catScript = { version: built.version, bytes: Buffer.byteLength(built.text), wsUrl, keyInjected: built.keyInjected };
} catch (err) {
  out.catScript = { error: err.message };
}

console.log(JSON.stringify(out, null, 2));
fs.writeFileSync(path.join(DATA_DIR, "install-report.json"), JSON.stringify(out, null, 2), "utf8");