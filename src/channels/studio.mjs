// Studio 通道：对接 aistudio-api（Google AI Studio 无头代理）。
// 该引擎自带 Gemini 协议、多账号轮换、429 隔离、WAA 本地签名。
// 网关这一层只负责：限流、路由、协议转换、管理端点封装。
import { Channel, parseJsonBody } from "../channel.mjs";
import { httpText, httpStream, sseEvents } from "../upstream.mjs";
import { gwErr, upstreamMessage } from "../util.mjs";

export class StudioChannel extends Channel {
  // ── 健康检查 ───────────────────────────────────────────────
  async checkHealth() {
    const started = Date.now();
    try {
      const { status, text } = await httpText(this.baseUrl, "/health", { timeoutMs: 8000 });
      const latencyMs = Date.now() - started;
      const body = parseJsonBody(text);
      if (status >= 400) throw new Error(`HTTP ${status} ${text.slice(0, 160)}`);
      // 顺带看下账号状态（失败不影响健康结论）
      let accounts = null;
      try {
        accounts = await this.listAccounts();
      } catch {
        /* ignore */
      }
      // 再看一眼可用性：会话过期/冷却/账号被删空 都要主动自愈，而不是等下个请求撞 503
      let rotation = null;
      let credentialIssue = null;
      try {
        rotation = await this.rotation();
        const all = Object.values(rotation?.accounts || {}).filter((a) => a && typeof a === "object");
        const enabled = all.filter((a) => a.enabled !== false);
        if (!enabled.length) {
          credentialIssue = all.length ? "account_disabled" : "no_accounts";
        } else {
          const usable = enabled.filter(
            (a) => a.is_available !== false && !a.session_expired && !(Number(a.cooldown_remaining) > 0)
          );
          if (!usable.length) {
            const first = enabled[0];
            credentialIssue = first.session_expired
              ? "session_expired"
              : Number(first.cooldown_remaining) > 0
                ? `cooldown:${first.cooldown_remaining}s`
                : "unavailable";
          }
        }
      } catch {
        /* 老版本引擎没有 /rotation —— 不影响健康结论 */
      }
      if (credentialIssue && typeof this.recoverCredentials === "function") {
        // 主动自愈（不阻塞健康检查）：成功后下一次健康检查就会看到账号可用
        this.recoverCredentials(
          Object.assign(new Error(`账号不可用（${credentialIssue}）`), { code: "session_expired" })
        )?.catch?.(() => {});
      }
      this.health = {
        ok: true,
        checkedAt: Date.now(),
        latencyMs,
        error: null,
        info: {
          status: body?.status ?? "ok",
          accounts: accounts
            ? {
                total: accounts.length,
                active: accounts.find((a) => a.is_active)?.name ?? null,
                tiers: accounts.reduce((acc, a) => {
                  acc[a.tier || "Free"] = (acc[a.tier || "Free"] || 0) + 1;
                  return acc;
                }, {}),
              }
            : null,
          credentialIssue,
        },
      };
      return this.health;
    } catch (err) {
      this.health = {
        ok: false,
        checkedAt: Date.now(),
        latencyMs: Date.now() - started,
        error: err.message,
        info: null,
      };
      return this.health;
    }
  }

  // ── 模型清单 ───────────────────────────────────────────────
  async fetchModels() {
    const { status, text } = await httpText(this.baseUrl, "/v1beta/models", {
      headers: this.authHeaders(),
      timeoutMs: 25000,
    });
    if (status >= 400) {
      throw gwErr(status, "models_failed", `Studio 模型清单获取失败：${upstreamMessage(text, status)}`);
    }
    const data = parseJsonBody(text);
    return (data?.models || []).map((m) => {
      const id = String(m.name || "").replace(/^models\//, "");
      return {
        id,
        rawName: m.name,
        displayName: m.displayName || id,
        description: m.description || "",
        inputTokenLimit: m.inputTokenLimit,
        outputTokenLimit: m.outputTokenLimit,
        channel: "studio",
      };
    });
  }

  // ── 请求 ───────────────────────────────────────────────────
  async request(kind, model, body, signal, requestId) {
    const m = encodeURIComponent(model);
    if (kind === "stream") {
      const resp = await httpStream(
        this.baseUrl,
        `/v1beta/models/${m}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...this.authHeaders() },
          body,
          timeoutMs: Number(this.cfg.timeoutMs) || 900000,
          idleTimeoutMs: Number(this.cfg.idleTimeoutMs) || 300000,
          signal,
        }
      );
      if (resp.status >= 400) {
        let text = "";
        for await (const piece of resp.stream) text += piece;
        throw gwErr(resp.status, "upstream_error", `Studio 上游 ${resp.status}：${upstreamMessage(text, resp.status)}`, {
          body: text.slice(0, 4000),
        });
      }
      return { type: "stream", status: resp.status, headers: resp.headers, events: this._events(resp.stream) };
    }

    const suffix = kind === "countTokens" ? ":countTokens" : ":generateContent";
    const { status, text } = await httpText(this.baseUrl, `/v1beta/models/${m}${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body,
      timeoutMs: Number(this.cfg.timeoutMs) || 900000,
      signal,
    });
    if (status >= 400) {
      throw gwErr(status, "upstream_error", `Studio 上游 ${status}：${upstreamMessage(text, status)}`, {
        body: text.slice(0, 4000),
      });
    }
    const json = parseJsonBody(text);
    if (!json) throw gwErr(502, "upstream_bad_body", `Studio 返回非 JSON：${text.slice(0, 200)}`);
    return { type: "json", status, json };
  }

  async *_events(pieces) {
    for await (const data of sseEvents(pieces)) {
      if (data === "[DONE]") {
        yield { __done: true };
        continue;
      }
      const json = parseJsonBody(data);
      if (json) yield json;
    }
  }

  // ── 管理端点（账号） ───────────────────────────────────────
  async listAccounts() {
    const { status, text } = await httpText(this.baseUrl, "/api/accounts", {
      headers: this.authHeaders(),
      timeoutMs: 15000,
    });
    if (status >= 400) throw gwErr(status, "accounts_failed", `账号列表失败：${upstreamMessage(text, status)}`);
    const data = parseJsonBody(text);
    return Array.isArray(data) ? data : [];
  }

  /**
   * 导入 Cookie：把 cat 脚本推送的 cookie 数组转成 aistudio-api 认识的 JSON 文本。
   * 返回引擎的 ImportCookiesResponse。
   */
  async importCookies({ cookies, email, name, authUser = "0", tier }) {
    const payload = {
      cookies: JSON.stringify(cookies),
      auth_user: String(authUser ?? "0"),
    };
    if (email) payload.email = email;
    if (name) payload.name = name;
    if (tier) payload.tier = tier;
    const { status, text } = await httpText(this.baseUrl, "/api/accounts/import-cookies", {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders() },
      body: payload,
      timeoutMs: 90000,
    });
    if (status >= 400) throw gwErr(status, "import_failed", `Cookie 导入失败：${upstreamMessage(text, status)}`);
    return parseJsonBody(text);
  }

  async activateAccount(id) {
    const { status, text } = await httpText(this.baseUrl, `/api/accounts/${encodeURIComponent(id)}/activate`, {
      method: "POST",
      headers: this.authHeaders(),
      timeoutMs: 30000,
    });
    if (status >= 400) throw gwErr(status, "activate_failed", upstreamMessage(text, status));
    return parseJsonBody(text);
  }

  async deleteAccount(id) {
    const { status, text } = await httpText(this.baseUrl, `/api/accounts/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: this.authHeaders(),
      timeoutMs: 30000,
    });
    if (status >= 400) throw gwErr(status, "delete_failed", upstreamMessage(text, status));
    return { ok: true, text };
  }

  async toggleAccount(id) {
    const { status, text } = await httpText(this.baseUrl, `/api/accounts/${encodeURIComponent(id)}/toggle`, {
      method: "POST",
      headers: this.authHeaders(),
      timeoutMs: 20000,
    });
    if (status >= 400) throw gwErr(status, "toggle_failed", upstreamMessage(text, status));
    return parseJsonBody(text);
  }

  async stats() {
    const { status, text } = await httpText(this.baseUrl, "/stats", {
      headers: this.authHeaders(),
      timeoutMs: 15000,
    });
    if (status >= 400) throw gwErr(status, "stats_failed", upstreamMessage(text, status));
    return parseJsonBody(text);
  }

  async rotation() {
    const { status, text } = await httpText(this.baseUrl, "/rotation", {
      headers: this.authHeaders(),
      timeoutMs: 15000,
    });
    if (status >= 400) throw gwErr(status, "rotation_failed", upstreamMessage(text, status));
    return parseJsonBody(text);
  }
}