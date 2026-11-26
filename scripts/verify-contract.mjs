#!/usr/bin/env node
// 契约自检：把「经验沉淀.md 里的硬规则」变成可执行检查。
//
//   node scripts/verify-contract.mjs          # 只查结构（不产生任何上游请求）
//   node scripts/verify-contract.mjs --live   # 额外打一次真请求，验证请求确实落到 browser 通道
//
// 默认不发请求：账号是别人的，验证工具不该随便花配额。
// 退出码：0 全部通过；1 有检查项不满足。
const GW = process.env.CATLOCAL_URL || "http://127.0.0.1:8788";
const LIVE = process.argv.includes("--live");

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ""}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗ ${name}\x1b[0m ${detail}`);
  }
};

const get = async (path, headers = {}) => {
  const r = await fetch(`${GW}${path}`, { headers });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: r.status, json, text, headers: r.headers };
};

console.log(`\n\x1b[36m▶ 结构检查\x1b[0m  ${GW}`);

let health;
try {
  health = (await get("/healthz")).json;
} catch (err) {
  console.log(`\n\x1b[31m网关连不上：${err.message}\x1b[0m`);
  process.exit(1);
}

const ch = health?.channels || {};
check("page 转发通道存在且启用", Boolean(ch.browser?.enabled), ch.browser ? "" : "healthz.channels 里没有 browser —— 多半还是旧进程");
check("studio 通道存在（编解码用）", Boolean(ch.studio?.enabled));

const cfg = (await get("/admin/api/config")).json;
const routing = cfg?.routing || {};
check("routing.defaultChannel = browser", routing.defaultChannel === "browser", `实际 ${routing.defaultChannel}`);
check("跨通道回退默认关闭", routing.failover === false, `failover=${routing.failover}`);
check("fallbackOrder 为空（不自动落到无头通道）", Array.isArray(routing.fallbackOrder) && routing.fallbackOrder.length === 0, JSON.stringify(routing.fallbackOrder));
check(
  "studio 自动抓 Cookie 已关闭",
  cfg?.channels?.studio?.autoRecover?.enabled === false,
  `autoRecover.enabled=${cfg?.channels?.studio?.autoRecover?.enabled}`
);
check(
  "pg 前缀归页面通道",
  (cfg?.channels?.browser?.aliases || []).includes("pg"),
  `aliases=${JSON.stringify(cfg?.channels?.browser?.aliases)}`
);
check(
  "studio 不再占用 pg/pggo 别名",
  !(cfg?.channels?.studio?.aliases || []).includes("pg"),
  `aliases=${JSON.stringify(cfg?.channels?.studio?.aliases)}`
);

const ex = (await get("/admin/api/executors")).json;
const online = ex?.size ?? 0;
check("页面执行器在线（AI Studio 标签页开着）", online > 0, `${online} 台；离线时页面通道按设计返回 503`);

console.log(`\n\x1b[36m▶ 行为检查\x1b[0m`);
if (!LIVE) {
  console.log(`  \x1b[90m跳过真请求（加 --live 才会发）。当前若发请求，预期：${online > 0 ? "200 + x-catlocal-channel: browser" : "503 no_executor"}\x1b[0m`);
} else {
  const body = JSON.stringify({
    contents: [{ role: "user", parts: [{ text: "契约自检：请只回复两个字「收到」" }] }],
    generationConfig: { maxOutputTokens: 32 },
  });
  const started = Date.now();
  const r = await fetch(`${GW}/v1beta/models/pg-gemini-3.8-flash:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const text = await r.text();
  const ms = Date.now() - started;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignore */
  }
  if (online === 0) {
    // 页面没开：必须明确拒绝，且不能悄悄换到无头通道
    check("页面离线时返回 503 no_executor（不回退）", r.status === 503 && json?.error?.code === "no_executor", `HTTP ${r.status} ${text.slice(0, 120)}`);
  } else {
    check("pg 请求成功", r.status === 200, `HTTP ${r.status} ${text.slice(0, 160)}`);
    check("确实落在 browser 通道", r.headers.get("x-catlocal-channel") === "browser", `x-catlocal-channel=${r.headers.get("x-catlocal-channel")}`);
    const reply = (json?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    check("拿回正文", reply.length > 0, `${JSON.stringify(reply.slice(0, 40))} ${ms}ms`);
  }
}

console.log(`\n${"─".repeat(56)}`);
console.log(`通过 ${pass} / 失败 ${fail}${fail ? "\n\x1b[31m有契约被破坏，先看 经验沉淀.md 第 1 节\x1b[0m" : ""}`);
process.exit(fail ? 1 : 0);
