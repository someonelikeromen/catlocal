// studio 通道失败自愈：账号会话过期 / 冷却时，自动从在线浏览器执行器采集一次 Cookie，
// 把它重新导进无头引擎，然后让调用方重试。
//
// ⚠ 默认关闭（channels.studio.autoRecover.enabled 默认 false）。
//   原因：这条路会把浏览器里的会话 Cookie 反复搬进无头引擎。频繁重放同一批会话 Cookie
//   是账号风控上的风险项，代价远高于「一次请求失败」。要开就自己显式打开，并接受：
//     · 每次自愈都会让同一账号的会话凭据重新导入一次
//     · 采集本身不新增请求，但会让「过期→重采」形成一个循环
//
// 触发条件（只认「凭证类」失败，参数错误、429 都不碰）：
//   · aistudio-api 编排层 503「No available accounts for this request.」
//   · 引擎报告 session expired / UNAUTHENTICATED / 无可用备用账号
//
// 护栏：单飞（并发失败共用一次采集）、限频（minIntervalMs）、无执行器直接放弃。
import { nowIso, tierFromHeaders } from "./util.mjs";

// 「凭证坏了」而非「这次请求有问题」的指纹。宁可漏判也不要误判：
// 误判会导致每次参数错误都去抓一次 Cookie。
const CREDENTIAL_PATTERNS = [
  /no available accounts/i,
  /no available credential/i,
  /no usable credential/i,
  /session[_\s-]?expired/i,
  /unauthenticated/i,
  /无可用备用账号/,
  /凭证(已)?(失效|过期|未绑定)/,
  /账号(已)?(失效|过期|被?禁用)/,
];

const DEFAULT_MIN_INTERVAL_MS = 20000;
const DEFAULT_COLLECT_TIMEOUT_MS = 25000;

/** 这个错误是不是「studio 凭证坏了」 */
export function isCredentialFailure(err) {
  if (!err) return false;
  if (err.code === "cancelled" || err.status === 499) return false; // 客户端主动断开，不关凭证的事
  const text = `${err.message || ""} ${err.extra?.body || ""}`;
  return CREDENTIAL_PATTERNS.some((re) => re.test(text));
}

export class AutoRecovery {
  constructor({ studio, executors, store, log, config }) {
    this.studio = studio;
    this.executors = executors;
    this.store = store;
    this.log = log;
    this.config = config; // 保留引用：每次调用都按当前配置判断开关
    this.stats = {
      attempts: 0,
      recovered: 0,
      failed: 0,
      skippedNoExecutor: 0,
      skippedCooldown: 0,
      skippedDisabled: 0,
      unusable: 0,
      lastAt: null,
      lastOkAt: null,
      lastReason: null,
      lastError: null,
      lastCookies: null,
    };
    this._inflight = null;
    this._lastAttemptAt = 0;
  }

  /** 每次都从当前配置读，面板/配置文件改动即时生效（不需要重启） */
  _settings() {
    const cfg = this.config?.channels?.studio?.autoRecover || {};
    return {
      enabled: cfg.enabled === true, // 必须显式 true 才开（默认关）
      minIntervalMs: Math.max(1000, Number(cfg.minIntervalMs) || DEFAULT_MIN_INTERVAL_MS),
      collectTimeoutMs: Math.max(5000, Number(cfg.collectTimeoutMs) || DEFAULT_COLLECT_TIMEOUT_MS),
    };
  }

  /** 失败入口：给 channel 用。返回 {recovered:boolean, ...} */
  async recover(reason) {
    const { enabled, minIntervalMs, collectTimeoutMs } = this._settings();
    if (!enabled) {
      this.stats.skippedDisabled++;
      return { recovered: false, reason: "disabled" };
    }
    // 单飞：同一时刻只允许一次采集，其余等同一个结果
    if (this._inflight) return this._inflight;

    const waitMs = minIntervalMs - (Date.now() - this._lastAttemptAt);
    if (waitMs > 0) {
      this.stats.skippedCooldown++;
      this._skipLog("凭证自愈在冷却中，跳过本次采集", { retryInMs: waitMs, reason: String(reason || "").slice(0, 160) });
      return { recovered: false, reason: "cooldown", retryInMs: waitMs };
    }
    if (!this.executors?.size) {
      this.stats.skippedNoExecutor++;
      this._skipLog("凭证已失效但没有在线浏览器执行器，无法自动采集", { reason: String(reason || "").slice(0, 160) });
      return { recovered: false, reason: "no_executor" };
    }

    this._lastAttemptAt = Date.now();
    this._inflight = this._run(reason, { collectTimeoutMs }).finally(() => {
      this._inflight = null;
    });
    return this._inflight;
  }

  async _run(reason, { collectTimeoutMs }) {
    this.stats.attempts++;
    this.stats.lastAt = nowIso();
    this.stats.lastReason = String(reason || "").slice(0, 300);
    this.log.warn("studio 凭证失效，自动从浏览器采集 Cookie", { reason: this.stats.lastReason });

    try {
      const sampled = await this.executors.collect("", { timeoutMs: collectTimeoutMs });
      const cookies = Array.isArray(sampled?.cookies) ? sampled.cookies : [];
      if (!cookies.length) throw new Error("浏览器没有回传任何 Cookie");

      const email = sampled.email || undefined;
      const authUser = sampled.authuser || "0";
      const tier = tierFromHeaders(sampled.headers);
      const imported = await this.studio.importCookies({
        cookies,
        email,
        name: email || `Auto Recover (u/${authUser})`,
        authUser,
        tier,
      });

      this.stats.recovered++;
      this.stats.lastOkAt = nowIso();
      this.stats.lastError = null;
      this.stats.lastCookies = imported?.cookie_count ?? cookies.length;
      this.store?.recordPush?.({
        at: nowIso(),
        label: imported?.name || email || "自动采集",
        email: email || null,
        authUser,
        tier: imported?.tier || tier || "Free",
        cookies: this.stats.lastCookies,
        accountId: imported?.account_id || null,
        source: "auto-recover",
      });

      // 导入成功不等于账号立即可用：有些故障采集修不好（账号被手工停用、还在别处冷却）。
      // 复核一次 /rotation，避免拿着一个注定失败的账号再打一次上游。
      const verdict = await this._verifyUsable();
      if (verdict) {
        this.stats.unusable++;
        this.log.warn("凭证已重新导入，但引擎仍判定账号不可用", { verdict, email: email || null });
        return { recovered: false, reason: verdict, cookies: this.stats.lastCookies, accountId: imported?.account_id || null };
      }

      this.log.info("凭证自愈完成：账号已用浏览器 Cookie 刷新", {
        email: email || null,
        cookies: this.stats.lastCookies,
        accountId: imported?.account_id || null,
      });
      return {
        recovered: true,
        cookies: this.stats.lastCookies,
        accountId: imported?.account_id || null,
        email: email || null,
      };
    } catch (err) {
      this.stats.failed++;
      this.stats.lastError = err?.message || String(err);
      this.log.error("凭证自愈失败", { err: this.stats.lastError });
      return { recovered: false, reason: "error", error: this.stats.lastError };
    }
  }

  /** 跳过类的日志限频：首次 warn，5 分钟内重复只落 debug，避免健康巡检每 20s 刷屏 */
  _skipLog(msg, meta) {
    const now = Date.now();
    if (!this._lastSkipLogAt || now - this._lastSkipLogAt > 5 * 60 * 1000) {
      this._lastSkipLogAt = now;
      this.log.warn(msg, meta);
    } else {
      this.log.debug?.(msg, meta);
    }
  }

  /** 导入后复核账号是否真的可用；返回 null 表示可用（或无法判定），否则返回原因 */
  async _verifyUsable() {
    if (typeof this.studio?.rotation !== "function") return null;
    let rot;
    try {
      rot = await this.studio.rotation();
    } catch {
      return null; // 引擎不支持/临时失败：不因为复核不了就否定自愈结果
    }
    const all = Object.values(rot?.accounts || {}).filter((a) => a && typeof a === "object");
    if (!all.length) return null;
    const enabled = all.filter((a) => a.enabled !== false);
    if (!enabled.length) return "account_disabled";
    const usable = enabled.filter(
      (a) => a.is_available !== false && !a.session_expired && !(Number(a.cooldown_remaining) > 0)
    );
    return usable.length ? null : "still_unavailable";
  }

  snapshot() {
    const { enabled, minIntervalMs, collectTimeoutMs } = this._settings();
    return {
      ...this.stats,
      enabled,
      minIntervalMs,
      collectTimeoutMs,
      inflight: Boolean(this._inflight),
      nextAllowedInMs: Math.max(0, minIntervalMs - (Date.now() - this._lastAttemptAt)),
    };
  }
}