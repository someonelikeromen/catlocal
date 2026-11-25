// 路由解析：把客户端给的模型名落到「通道 + 真实模型名」。
//
// 规则优先级（从高到低）：
//   1. routing.overrides 精确命中
//   2. 显式前缀：pg- / pggo- / studio- / studio/ → studio；robin- / rb/ / robin/ → robin
//   3. 模型只在某一个通道存在 → 该通道
//   4. 两边都有 / 都没有 → routing.defaultChannel
import { gwErr } from "./util.mjs";

const SEP = /[-_/:]/;

export class Router {
  constructor({ config, channels, log }) {
    this.config = config;
    this.channels = channels; // {studio, robin}
    this.log = log;
    this._alias = this._buildAliasIndex();
  }

  _buildAliasIndex() {
    // 收集所有别名 → 通道（跨两通道去重，先到先得）
    const map = new Map();
    for (const [name, ch] of Object.entries(this.channels)) {
      for (const a of ch.cfg.aliases || []) {
        const key = String(a).toLowerCase();
        if (!map.has(key)) map.set(key, name);
      }
    }
    return map;
  }

  /** 刷新别名索引（配置热更新后调用） */
  refresh() {
    this._alias = this._buildAliasIndex();
  }

  /** 解析前缀：`pg-gemini-3.7-flash` / `pggo/gemini-3.8-flash` / `robin/gemini-4-argon` */
  _byPrefix(model) {
    for (const [alias, channel] of this._alias) {
      const lower = model.toLowerCase();
      if (!lower.startsWith(alias)) continue;
      const rest = model.slice(alias.length);
      if (!rest) continue;
      // 必须有分隔符，避免 gemini-... 被 "g" 之类别名误伤
      if (!/^[-_/:]/.test(rest)) continue;
      const stripped = rest.replace(/^[-_/:]+/, "");
      if (!stripped) continue;
      return { channel, model: stripped };
    }
    return null;
  }

  /**
   * @returns {Promise<{channel: string, model: string, reason: string, fallback: Array<{channel:string,model:string}>}>}
   */
  async resolve(model, { preferChannel = null } = {}) {
    const raw = String(model || "").trim();
    if (!raw) throw gwErr(400, "invalid_model", "缺少模型名");

    const overrides = this.config.routing?.overrides || {};
    const ov = overrides[raw] ?? overrides[raw.toLowerCase()];
    if (ov && ov.channel && this.channels[ov.channel]) {
      return this._withFallback({
        channel: ov.channel,
        model: ov.model || raw,
        reason: "override",
      });
    }

    const prefixed = this._byPrefix(raw);
    if (prefixed && this.channels[prefixed.channel]?.enabled) {
      return this._withFallback({ ...prefixed, reason: "prefix" });
    }

    // 没有前缀、没有 override 时，**默认通道就是默认通道**：
    // 不再拿模型清单归属去改写它。这条规则很重要——模型清单是异步拉取、可能失败的，
    // 一旦某次拉取失败，两边都有的模型就会被判成「只属于 studio」，请求于是悄悄落到
    // cookie 通道去（那正是「为什么没走页面」的成因）。默认通道 enabled 就直走它。
    const prefer = preferChannel && this.channels[preferChannel] ? preferChannel : this.config.routing?.defaultChannel;
    if (prefer && this.channels[prefer]?.enabled) {
      return this._withFallback({ channel: prefer, model: raw, reason: "default" });
    }

    // 默认通道不可用时，才退回按清单归属挑一条能用的
    const known = await this._knownModels();
    const inStudio = known.studio.has(raw);
    const inRobin = known.robin.has(raw);

    let channel;
    let reason;
    if (inStudio && !inRobin) {
      channel = "studio";
      reason = "model-list";
    } else if (inRobin && !inStudio) {
      channel = "robin";
      reason = "model-list";
    } else if (inStudio && inRobin) {
      channel = "studio";
      reason = "both-fallback";
    } else {
      channel = this.channels.studio.enabled ? "studio" : "robin";
      reason = "last-resort";
    }
    if (!this.channels[channel]?.enabled) {
      const other = channel === "studio" ? "robin" : "studio";
      if (this.channels[other]?.enabled) channel = other;
    }
    if (!this.channels[channel]?.enabled) {
      throw gwErr(503, "no_channel", "所有通道均不可用，请检查引擎与配置");
    }
    return this._withFallback({ channel, model: raw, reason });
  }

  _withFallback(base) {
    const fallback = [];
    if (this.config.routing?.failover) {
      const order = this.config.routing?.fallbackOrder || [];
      const map = this.config.routing?.failoverMap || {};
      for (const ch of order) {
        if (ch === base.channel || !this.channels[ch]?.enabled) continue;
        fallback.push({ channel: ch, model: map[base.model]?.[ch] || base.model });
      }
    }
    return { ...base, fallback };
  }

  async _knownModels() {
    const out = { studio: new Set(), robin: new Set() };
    await Promise.all(
      Object.entries(this.channels).map(async ([name, ch]) => {
        if (!ch.enabled) return;
        try {
          const list = await ch.listModels();
          for (const m of list) out[name].add(m.id);
        } catch {
          /* 拉不到就当不知道 */
        }
      })
    );
    return out;
  }

  /** 合并模型清单（供 /v1/models、/v1beta/models） */
  async listAllModels() {
    const out = [];
    for (const [name, ch] of Object.entries(this.channels)) {
      if (!ch.enabled) continue;
      try {
        const list = await ch.listModels();
        for (const m of list) {
          out.push({
            ...m,
            // 让调用方一眼看出归属：带前缀的规范名 + 原通道名
            prefixed: `${(ch.cfg.aliases?.[0] || name)}/${m.id}`,
            channel: name,
          });
        }
      } catch (err) {
        this.log?.warn(`模型清单拉取失败（${name}）：${err.message}`);
      }
    }
    return out;
  }
}