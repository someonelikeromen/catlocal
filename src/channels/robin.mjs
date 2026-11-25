// Robin 通道：对接 Summeretto（Gemini App 的 Robin gRPC 双向流网关）。
// 凭证模型：oauth_token → master token（服务端自动铸 ya29 访问令牌）。
import { Channel, parseJsonBody } from "../channel.mjs";
import { httpText, httpStream, sseEvents } from "../upstream.mjs";
import { gwErr, upstreamMessage } from "../util.mjs";

export class RobinChannel extends Channel {
  get adminKey() {
    return String(this.cfg.adminKey || "");
  }

  adminHeaders() {
    const h = { ...this.authHeaders() };
    if (this.adminKey) h["x-admin-key"] = this.adminKey;
    return h;
  }

  // ── 健康检查 ───────────────────────────────────────────────
  async checkHealth() {
    const started = Date.now();
    try {
      const { status, text } = await httpText(this.baseUrl, "/healthz", { timeoutMs: 8000 });
      const latencyMs = Date.now() - started;
      if (status >= 400) throw new Error(`HTTP ${status} ${text.slice(0, 160)}`);
      const body = parseJsonBody(text);
      this.health = {
        ok: true,
        checkedAt: Date.now(),
        latencyMs,
        error: null,
        info: {
          stage: body?.stage ?? null,
          auth: body?.auth ?? null,
          credential: body?.credential ?? null,
          modes: body?.modes ?? null,
          inflight: body?.inflight ?? null,
          dedup: body?.dedup ?? null,
          thinking: body?.thinking ?? null,
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
      timeoutMs: 30000,
    });
    if (status >= 400) {
      throw gwErr(status, "models_failed", `Robin 模型清单获取失败：${upstreamMessage(text, status)}`);
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
        channel: "robin",
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
          timeoutMs: Number(this.cfg.timeoutMs) || 600000,
          idleTimeoutMs: Number(this.cfg.idleTimeoutMs) || 300000,
          signal,
        }
      );
      if (resp.status >= 400) {
        let text = "";
        for await (const piece of resp.stream) text += piece;
        throw gwErr(resp.status, "upstream_error", `Robin 上游 ${resp.status}：${upstreamMessage(text, resp.status)}`, {
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
      timeoutMs: Number(this.cfg.timeoutMs) || 600000,
      signal,
    });
    if (status >= 400) {
      throw gwErr(status, "upstream_error", `Robin 上游 ${status}：${upstreamMessage(text, status)}`, {
        body: text.slice(0, 4000),
      });
    }
    const json = parseJsonBody(text);
    if (!json) throw gwErr(502, "upstream_bad_body", `Robin 返回非 JSON：${text.slice(0, 200)}`);
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

  // ── 凭证管理（Summeretto /admin/*） ────────────────────────
  /** 绑定 oauth_token：服务端换 master token，并回写 .env（如已配置 ROBIN_ENV_FILE） */
  async bindOauthToken({ email, oauthToken, androidId }) {
    if (!this.adminKey) {
      throw gwErr(
        503,
        "robin_admin_disabled",
        "Robin 引擎未配置 ADMIN_KEY，无法通过网关绑定凭证（请检查网关 config 与 Summeretto 启动环境变量）"
      );
    }
    const { status, text } = await httpText(this.baseUrl, "/admin/gpsoauth", {
      method: "POST",
      headers: { "content-type": "application/json", ...this.adminHeaders() },
      body: { email, oauthToken, androidId },
      timeoutMs: 120000,
    });
    const json = parseJsonBody(text);
    if (status >= 400) {
      throw gwErr(status, "robin_bind_failed", `Robin 绑定失败：${json?.detail || json?.error?.message || upstreamMessage(text, status)}`);
    }
    return json;
  }

  /** 直接注入 ya29 访问令牌（临时凭证，不自动续期） */
  async injectToken({ token, expiresIn, account }) {
    const { status, text } = await httpText(this.baseUrl, "/admin/token", {
      method: "POST",
      headers: { "content-type": "application/json", ...this.adminHeaders() },
      body: { token, expiresIn, account },
      timeoutMs: 30000,
    });
    const json = parseJsonBody(text);
    if (status >= 400) throw gwErr(status, "robin_token_failed", upstreamMessage(text, status));
    return json;
  }

  async tokenStatus() {
    const { status, text } = await httpText(this.baseUrl, "/admin/gpsoauth", {
      headers: this.adminHeaders(),
      timeoutMs: 15000,
    });
    const json = parseJsonBody(text);
    if (status >= 400) throw gwErr(status, "robin_status_failed", upstreamMessage(text, status));
    return json;
  }

  async modes(refresh = false) {
    const { status, text } = await httpText(this.baseUrl, "/v1beta/modes", {
      headers: this.authHeaders(),
      timeoutMs: refresh ? 60000 : 20000,
    });
    if (status >= 400) throw gwErr(status, "robin_modes_failed", upstreamMessage(text, status));
    return parseJsonBody(text);
  }
}