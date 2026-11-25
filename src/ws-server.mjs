// 极简 WebSocket 服务端（RFC6455），零依赖。
// 只实现网关需要的部分：文本帧、ping/pong、close、分片续帧。
// 这样 cat 用户脚本的 `new WebSocket(ws://…)` 能直接连本地网关。
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function acceptKey(key) {
  return crypto.createHash("sha1").update(key + GUID).digest("base64");
}

export class WsConnection {
  constructor(socket, req, { maxPayload = 16 * 1024 * 1024 } = {}) {
    this.socket = socket;
    this.req = req;
    this.maxPayload = maxPayload;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = null;
    this.closed = false;
    this.lastSeen = Date.now();
    this.onmessage = null;
    this.onclose = null;
    this.meta = {};

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._finish(1006, "socket closed"));
    socket.on("error", () => this._finish(1006, "socket error"));
    socket.setNoDelay?.(true);
  }

  get remoteAddress() {
    return this.req?.socket?.remoteAddress || "unknown";
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      this._drain();
    } catch (err) {
      this.close(1002, `protocol error: ${err.message}`);
    }
  }

  _drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < offset + 2) return;
        len = this.buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buf.length < offset + 8) return;
        const big = this.buf.readBigUInt64BE(offset);
        if (big > BigInt(this.maxPayload)) throw new Error("frame too large");
        len = Number(big);
        offset += 8;
      }
      if (len > this.maxPayload) throw new Error("frame too large");
      let maskKey = null;
      if (masked) {
        if (this.buf.length < offset + 4) return;
        maskKey = this.buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buf.length < offset + len) return;
      let payload = this.buf.subarray(offset, offset + len);
      if (maskKey) {
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      this.buf = this.buf.subarray(offset + len);
      this._handleFrame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === OP.PING) {
      this._sendFrame(OP.PONG, payload);
      return;
    }
    if (opcode === OP.PONG) return;
    if (opcode === OP.CLOSE) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
      this._finish(code, reason);
      try {
        this._sendFrame(OP.CLOSE, payload.subarray(0, 2));
      } catch {
        /* ignore */
      }
      try {
        this.socket.end();
      } catch {
        /* ignore */
      }
      return;
    }
    if (opcode === OP.TEXT || opcode === OP.BINARY) {
      this.fragOpcode = opcode;
      this.fragments = [payload];
    } else if (opcode === OP.CONT) {
      if (!this.fragOpcode) throw new Error("unexpected continuation frame");
      this.fragments.push(payload);
    } else {
      return; // 未知 opcode 忽略
    }
    if (!fin) return; // 等后续续帧
    const full = Buffer.concat(this.fragments);
    this.fragments = [];
    const op = this.fragOpcode;
    this.fragOpcode = null;
    const text = full.toString("utf8");
    try {
      this.onmessage?.(text, op);
    } catch (err) {
      // 回调异常不应打断连接
      console.error("[ws] onmessage error:", err?.message);
    }
  }

  _sendFrame(opcode, payloadBuf) {
    if (this.closed) return false;
    const len = payloadBuf.length;
    let header;
    if (len < 126) {
      header = Buffer.allocUnsafe(2);
      header[1] = len;
    } else if (len <= 0xffff) {
      header = Buffer.allocUnsafe(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    try {
      this.socket.write(Buffer.concat([header, payloadBuf]));
      return true;
    } catch {
      return false;
    }
  }

  send(data) {
    const text = typeof data === "string" ? data : JSON.stringify(data);
    return this._sendFrame(OP.TEXT, Buffer.from(text, "utf8"));
  }

  ping() {
    this._sendFrame(OP.PING, Buffer.alloc(0));
  }

  close(code = 1000, reason = "") {
    const reasonBuf = Buffer.from(String(reason), "utf8").subarray(0, 120);
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    try {
      this._sendFrame(OP.CLOSE, payload);
    } catch {
      /* ignore */
    }
    this._finish(code, reason);
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.onclose?.(code, reason);
    } catch {
      /* ignore */
    }
  }
}

/**
 * 把 http.Server 的 upgrade 事件接成 WebSocket 端点。
 * @param {import('node:http').Server} server
 * @param {(req, conn) => void} onConnection
 * @param {{path?: string}} opts
 */
export function attachWebSocket(server, onConnection, { path = "/api/pg/ws" } = {}) {
  server.on("upgrade", (req, socket) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      /* ignore */
    }
    if (pathname !== path) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const key = req.headers["sec-websocket-key"];
    const upgrade = String(req.headers.upgrade || "").toLowerCase();
    if (upgrade !== "websocket" || !key) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const headers = [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "\r\n",
    ];
    socket.write(headers.join("\r\n"));
    const conn = new WsConnection(socket, req);
    onConnection(req, conn);
  });
}