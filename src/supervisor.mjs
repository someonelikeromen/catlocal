// 子进程托管：把 studio（aistudio-api / Python）与 robin（Summeretto / Node）当成
// 网关的「引擎」，负责启动、日志归集、崩溃退避重启、优雅停机。
// 也可以把 managed.enabled 设为 false，改由你自己起服务（网关只当反向代理）。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.mjs";

const MAX_BACKOFF_MS = 30000;

function parseEnvFile(file) {
  const out = {};
  try {
    if (!fs.existsSync(file)) return out;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[k] = v;
    }
  } catch {
    /* ignore */
  }
  return out;
}

function portOf(baseUrl, fallback) {
  try {
    return String(new URL(baseUrl).port || fallback);
  } catch {
    return String(fallback);
  }
}

export class Supervisor {
  constructor({ config, log }) {
    this.config = config;
    this.log = log;
    this.procs = new Map(); // name -> {child, startedAt, restarts, status, error, logFile, stopping, pid}
    this.logDir = path.join(ROOT, "data", "logs");
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  /** 引擎启动所需的环境变量 */
  envFor(name) {
    const ch = this.config.channels[name];
    const base = { ...process.env };
    if (name === "studio") {
      base.AISTUDIO_PORT = portOf(ch.baseUrl, 8080);
      if (ch.adminPassword) base.AISTUDIO_WEB_PASSWORD = ch.adminPassword;
      if (ch.proxy) base.AISTUDIO_PROXY = ch.proxy;
      base.PYTHONUNBUFFERED = "1";
      base.PYTHONIOENCODING = "utf-8";
      // Windows 控制台默认编码会让中文日志乱码，强制 UTF-8
      base.PYTHONUTF8 = "1";
      return base;
    }
    if (name === "robin") {
      const cwd = path.resolve(ROOT, ch.managed?.cwd || "../Summeretto/service");
      base.PORT = portOf(ch.baseUrl, 3000);
      base.HOST = "127.0.0.1";
      if (ch.apiKey) base.PROXY_API_KEY = ch.apiKey;
      if (ch.adminKey) base.ADMIN_KEY = ch.adminKey;
      base.MAX_BODY_BYTES = String(ch.maxBodyBytes || 33554432);
      base.ROBIN_ENV_FILE = path.join(cwd, ".env");
      // Summeretto 自己不会加载 .env（由 docker-entrypoint 负责），这里替它加载
      Object.assign(base, parseEnvFile(path.join(cwd, ".env")));
      if (ch.envFileOverrides) Object.assign(base, ch.envFileOverrides);
      return base;
    }
    return base;
  }

  status() {
    const out = {};
    for (const name of Object.keys(this.config.channels)) {
      const rec = this.procs.get(name);
      const managed = this.config.channels[name]?.managed?.enabled !== false;
      out[name] = rec
        ? {
            managed,
            status: rec.status,
            pid: rec.pid || null,
            startedAt: rec.startedAt || null,
            restarts: rec.restarts,
            error: rec.error,
            logFile: rec.logFile,
          }
        : { managed, status: managed ? "stopped" : "external", pid: null, restarts: 0, error: null, logFile: null };
    }
    return out;
  }

  async start(name, { force = false } = {}) {
    const ch = this.config.channels[name];
    if (!ch?.managed?.enabled) return { ok: false, reason: "managed 已关闭（外部托管）" };
    const rec = this.procs.get(name);
    if (rec && (rec.status === "running" || rec.status === "starting") && !force) {
      return { ok: true, reason: "已在运行" };
    }
    if (force && rec) await this.stop(name);

    const cwd = path.resolve(ROOT, ch.managed.cwd || ".");
    if (!fs.existsSync(cwd)) {
      const msg = `引擎目录不存在：${cwd}`;
      this.procs.set(name, { status: "error", error: msg, restarts: 0, pid: null, startedAt: null, logFile: null });
      this.log.error(`[${name}] ${msg}`);
      return { ok: false, reason: msg };
    }
    const command = ch.managed.command || "node";
    const args = ch.managed.args || [];
    const logFile = path.join(this.logDir, `engine-${name}.log`);
    const out = fs.createWriteStream(logFile, { flags: "a" });
    const env = { ...this.envFor(name), ...(ch.managed.env || {}) };

    this.log.info(`[${name}] 启动引擎`, { command, args, cwd });
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      const msg = `启动失败：${err.message}`;
      this.procs.set(name, { status: "error", error: msg, restarts: 0, pid: null, startedAt: null, logFile });
      this.log.error(`[${name}] ${msg}`);
      return { ok: false, reason: msg };
    }

    const state = {
      child,
      pid: child.pid,
      status: "starting",
      startedAt: Date.now(),
      restarts: rec?.restarts || 0,
      error: null,
      logFile,
      stopping: false,
      out,
    };
    this.procs.set(name, state);

    child.stdout.on("data", (buf) => {
      out.write(buf);
      this._pump(name, "stdout", buf, state);
    });
    child.stderr.on("data", (buf) => {
      out.write(buf);
      this._pump(name, "stderr", buf, state);
    });

    child.on("error", (err) => {
      state.status = "error";
      state.error = err.code === "ENOENT" ? `找不到可执行文件：${command}` : err.message;
      this.log.error(`[${name}] 进程错误：${state.error}`);
    });

    child.on("exit", (code, signal) => {
      const wasStopping = state.stopping;
      state.status = wasStopping ? "stopped" : "crashed";
      state.pid = null;
      // 清掉子进程引用：留着会让 stop() 误以为进程还在，挂到已退出的进程上死等
      state.child = null;
      this.log.warn(`[${name}] 引擎退出`, { code, signal, wasStopping });
      try {
        out.write(`\n=== exit code=${code} signal=${signal} ===\n`);
        out.end();
      } catch {
        /* ignore */
      }
      if (wasStopping) return;
      // 崩溃重启（指数退避）
      state.restarts++;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, Math.min(5, state.restarts - 1)));
      this.log.warn(`[${name}] ${Math.round(delay / 1000)}s 后自动重启（第 ${state.restarts} 次）`);
      const timer = setTimeout(() => {
        if (!this.procs.has(name)) return;
        this.start(name, { force: true }).catch((err) => this.log.error(`[${name}] 重启失败：${err.message}`));
      }, delay);
      timer.unref?.();
    });

    return { ok: true, pid: child.pid };
  }

  async stop(name, { timeoutMs = 20000 } = {}) {
    const rec = this.procs.get(name);
    if (!rec?.child) {
      if (rec && rec.status !== "stopped") rec.status = "stopped";
      return { ok: true };
    }
    // 子进程可能早已退出（例如 restart() 里 stop → start({force}) → stop 的第二次调用）。
    // 此时再挂 once("exit") 会永远等不到事件 → Promise 永不 resolve → 状态卡在 stopping，
    // 引擎再也起不来。这里直接按已停止处理。
    if (rec.child.exitCode !== null || rec.child.signalCode !== null) {
      rec.stopping = true;
      rec.status = "stopped";
      rec.pid = null;
      rec.child = null;
      return { ok: true };
    }
    rec.stopping = true;
    const child = rec.child;
    this.log.info(`[${name}] 正在停止引擎`, { pid: child.pid });
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        resolve({ ok: true });
      };
      // 兜底：万一 exit 事件因平台差异没来，超时后也要 resolve，绝不无限挂起
      const guard = setTimeout(() => {
        this.log.warn(`[${name}] 停止引擎超时，按已停止处理`, { pid: child.pid });
        rec.status = "stopped";
        rec.pid = null;
        rec.child = null;
        done();
      }, timeoutMs + 5000);
      guard.unref?.();
      child.once("exit", done);
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      // Windows 上 SIGTERM 支持有限，超时兜底强杀
      setTimeout(() => {
        if (rec.pid) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }, timeoutMs).unref?.();
      rec.status = "stopping";
      rec.pid = null;
    });
  }

  async restart(name) {
    await this.stop(name);
    // stop() 已经停过，这里不要再带 force —— 否则 start() 内部会再调一次 stop()，
    // 挂在一个已退出的子进程上死等（历史 bug，见 stop() 里的注释）。
    return this.start(name, { force: false });
  }

  async stopAll() {
    await Promise.all(Object.keys(this.config.channels).map((n) => this.stop(n)));
  }
}