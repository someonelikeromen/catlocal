// 日志：控制台 + data/logs/*.log（NDJSON 便于排查），并保留内存环形缓冲供面板/接口查看。
import fs from "node:fs";
import path from "node:path";
import { nowIso } from "./util.mjs";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export class Logger {
  constructor({ dir, level = "info", maxMemory = 1500, console = true } = {}) {
    this.dir = dir || null;
    this.level = LEVELS[level] != null ? level : "info";
    this.maxMemory = maxMemory;
    this.toConsole = console;
    this.buffer = []; // {ts, level, msg, meta}
    this.listeners = new Set();
    this.day = todayStamp();
    this.fd = null;
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true });
      this._open();
    }
  }

  _open() {
    try {
      const file = path.join(this.dir, `catlocal-${this.day}.log`);
      this.fd = fs.createWriteStream(file, { flags: "a" });
      this.file = file;
    } catch {
      this.fd = null;
    }
  }

  _rotateIfNeeded() {
    if (!this.dir) return;
    const day = todayStamp();
    if (day === this.day) return;
    this.day = day;
    try {
      this.fd?.end();
    } catch {
      /* ignore */
    }
    this._open();
  }

  _emit(level, msg, meta) {
    if ((LEVELS[level] ?? 99) < (LEVELS[this.level] ?? 20)) return;
    const rec = { ts: nowIso(), level, msg: String(msg), ...(meta ? { meta } : {}) };
    this.buffer.push(rec);
    if (this.buffer.length > this.maxMemory) this.buffer.shift();

    if (this.toConsole) {
      const line = `[${rec.ts.slice(11, 23)}] ${level.toUpperCase().padEnd(5)} ${rec.msg}${
        meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : ""
      }`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }

    this._rotateIfNeeded();
    try {
      this.fd?.write(JSON.stringify(rec) + "\n");
    } catch {
      /* 落盘失败不影响主流程 */
    }

    for (const fn of this.listeners) {
      try {
        fn(rec);
      } catch {
        /* ignore */
      }
    }
  }

  debug(msg, meta) {
    this._emit("debug", msg, meta);
  }
  info(msg, meta) {
    this._emit("info", msg, meta);
  }
  warn(msg, meta) {
    this._emit("warn", msg, meta);
  }
  error(msg, meta) {
    this._emit("error", msg, meta);
  }

  /** 订阅实时日志（SSE 推送用），返回退订函数 */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 最近 N 条日志 */
  tail(n = 200, level = null) {
    const min = level ? LEVELS[level] ?? 0 : 0;
    return this.buffer.filter((r) => (LEVELS[r.level] ?? 99) >= min).slice(-n);
  }

  setLevel(level) {
    if (LEVELS[level] != null) this.level = level;
  }
}