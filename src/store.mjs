// 持久化状态：客户端密钥、累计统计、cat 凭证镜像、robin 绑定信息。
// JSON 单文件 + 防抖原子写（先写 .tmp 再 rename），避免断电写坏。
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, ROOT } from "./config.mjs";
import { randomId, randomKey, nowIso, deepMerge } from "./util.mjs";

const STORE_FILE = path.join(DATA_DIR, "state.json");

function defaultState() {
  return {
    version: 1,
    createdAt: nowIso(),
    keys: [],
    stats: { since: nowIso(), total: {}, channels: {}, models: {}, days: {} },
    cat: {
      // 最近一次 Cookie 推送的镜像（仅摘要，真实 Cookie 存在 studio 引擎里）
      lastPush: null,
      pushes: [],
    },
    robin: {
      email: null,
      lastBindAt: null,
      binds: [],
    },
    settings: {},
  };
}

export class Store {
  constructor(file = STORE_FILE) {
    this.file = file;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.data = defaultState();
    this._timer = null;
    this._dirty = false;
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) {
      this.saveNow();
      return;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      this.data = deepMerge(defaultState(), raw || {});
    } catch (err) {
      const bak = `${this.file}.corrupt-${Date.now()}`;
      try {
        fs.copyFileSync(this.file, bak);
      } catch {
        /* ignore */
      }
      console.warn(`[store] state.json 损坏，已备份到 ${path.basename(bak)} 并重建：${err.message}`);
      this.data = defaultState();
      this.saveNow();
    }
  }

  save() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (this._dirty) this.saveNow();
    }, 400);
    this._timer.unref?.();
  }

  saveNow() {
    this._dirty = false;
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[store] 保存失败：${err.message}`);
    }
  }

  // ── 客户端密钥 ─────────────────────────────────────────────
  listKeys() {
    return this.data.keys.map((k) => this.publicKey(k));
  }

  publicKey(k) {
    return {
      id: k.id,
      name: k.name,
      token: k.token,
      channels: k.channels,
      rpm: k.rpm,
      enabled: k.enabled !== false,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt || null,
      requests: k.requests || 0,
    };
  }

  createKey({ name = "未命名", channels = ["*"], rpm = 0 } = {}) {
    const key = {
      id: randomId("key"),
      name: String(name).slice(0, 60) || "未命名",
      token: randomKey("cat"),
      channels: Array.isArray(channels) && channels.length ? channels : ["*"],
      rpm: Number(rpm) || 0,
      enabled: true,
      createdAt: nowIso(),
      lastUsedAt: null,
      requests: 0,
    };
    this.data.keys.push(key);
    this.save();
    return this.publicKey(key);
  }

  findKeyByToken(token) {
    if (!token) return null;
    return this.data.keys.find((k) => k.token === token && k.enabled !== false) || null;
  }

  findKeyById(id) {
    return this.data.keys.find((k) => k.id === id) || null;
  }

  updateKey(id, patch = {}) {
    const k = this.findKeyById(id);
    if (!k) return null;
    if (patch.name != null) k.name = String(patch.name).slice(0, 60);
    if (patch.channels != null) k.channels = patch.channels.length ? patch.channels : ["*"];
    if (patch.rpm != null) k.rpm = Math.max(0, Number(patch.rpm) || 0);
    if (patch.enabled != null) k.enabled = !!patch.enabled;
    this.save();
    return this.publicKey(k);
  }

  deleteKey(id) {
    const before = this.data.keys.length;
    this.data.keys = this.data.keys.filter((k) => k.id !== id);
    this.save();
    return this.data.keys.length < before;
  }

  touchKey(token) {
    const k = this.data.keys.find((x) => x.token === token);
    if (!k) return;
    k.lastUsedAt = nowIso();
    k.requests = (k.requests || 0) + 1;
    this.save();
  }

  // ── 累计统计 ───────────────────────────────────────────────
  recordStat({ channel, model, ok, tokensIn = 0, tokensOut = 0, latencyMs = 0 }) {
    const s = this.data.stats;
    const day = nowIso().slice(0, 10);
    s.total.requests = (s.total.requests || 0) + 1;
    if (ok) s.total.ok = (s.total.ok || 0) + 1;
    else s.total.error = (s.total.error || 0) + 1;
    s.total.tokensIn = (s.total.tokensIn || 0) + tokensIn;
    s.total.tokensOut = (s.total.tokensOut || 0) + tokensOut;

    const ch = (s.channels[channel] ||= { requests: 0, ok: 0, error: 0, tokensIn: 0, tokensOut: 0, latencyMsSum: 0 });
    ch.requests++;
    if (ok) ch.ok++;
    else ch.error++;
    ch.tokensIn += tokensIn;
    ch.tokensOut += tokensOut;
    ch.latencyMsSum += latencyMs || 0;

    if (model) {
      const m = (s.models[model] ||= { requests: 0, ok: 0, error: 0, tokensIn: 0, tokensOut: 0 });
      m.requests++;
      if (ok) m.ok++;
      else m.error++;
      m.tokensIn += tokensIn;
      m.tokensOut += tokensOut;
    }

    const d = (s.days[day] ||= { requests: 0, ok: 0, error: 0, tokensIn: 0, tokensOut: 0 });
    d.requests++;
    if (ok) d.ok++;
    else d.error++;
    d.tokensIn += tokensIn;
    d.tokensOut += tokensOut;

    // 只保留最近 30 天
    const days = Object.keys(s.days).sort();
    while (days.length > 30) delete s.days[days.shift()];

    this.save();
  }

  // ── cat / robin 镜像 ───────────────────────────────────────
  recordPush(entry) {
    const c = this.data.cat;
    c.lastPush = entry;
    c.pushes.unshift(entry);
    if (c.pushes.length > 40) c.pushes.length = 40;
    this.save();
  }

  recordBind(entry) {
    const r = this.data.robin;
    r.email = entry.email || r.email;
    r.lastBindAt = entry.at;
    r.binds.unshift(entry);
    if (r.binds.length > 20) r.binds.length = 20;
    this.save();
  }

  snapshot() {
    return {
      createdAt: this.data.createdAt,
      keys: this.listKeys(),
      stats: this.data.stats,
      cat: this.data.cat,
      robin: this.data.robin,
    };
  }
}

export const ROOT_DIR = ROOT;