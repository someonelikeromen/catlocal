# CatLocal · 本地统一接入网关

把 **robin**（[Summeretto](https://github.com/0xcr1st0f0r0/Summeretto)）与 **studio**（[aistudio-api](https://github.com/DeconstructedCube/aistudio-api)）两条 Gemini 通道，连同 **catiecli Playground Executor 用户脚本**，收拢到**一个本地端口**上，并提供统一的密钥、账号、并发与可观测管理。

不是 fork，也不改上游代码：两个仓库保持原样，网关作为「前台 + 调度器 + 兼容层」把它们的差异抹平。

```
                         ┌──────────────────────────────────────────────┐
  cat 用户脚本 ──WS────►  │  CatLocal  :8788                              │
  （浏览器，可多开）       │  ├ /v1/chat/completions   OpenAI 兼容          │
                          │  ├ /v1beta/models/…       Gemini 原生          │
  客户端（OpenAI /        │  ├ /api/pggo/push         Cookie 推送（cat 协议）│
  Gemini SDK / NextChat） │  ├ /api/robin/bind-by-key Robin 凭证（cat 协议）│
        ──HTTP──────────► │  ├ /api/pg/ws             执行器池（心跳/派发） │
                          │  ├ /api/pg/script.user.js 本机版用户脚本        │
                          │  └ /admin                 管理面板              │
                          └───────┬───────────────────────────┬───────────┘
                                  │ 限流·重试·回退·记账        │
                        ┌─────────▼─────────┐      ┌──────────▼──────────┐
                        │ studio  :8180     │      │ robin  :3000        │
                        │ aistudio-api      │      │ Summeretto          │
                        │ 只做编解码(默认)   │      │ Robin gRPC 高速     │
                        │ 也可无头生成(可选) │      │ 档位/思考强度/多模态 │
                        └───────────────────┘      └─────────────────────┘
```

**默认行为（重要）：请求由浏览器页面真正执行。**
`pg-` / `pggo-` / 不加前缀 → `browser` 通道：网关只负责把 Gemini 请求体换成 `{wire, binding}`
（调 studio 引擎的 `:encodeWire`，纯编解码、不碰账号），再由 WS 下发给 AI Studio 页面的脚本，
脚本现场取 WAA proof 并发起请求，回传 raw 后再用 `:parseWire` 还原。出口 IP、UA、指纹、
Cookie 轮换、签名全部是真人浏览器那一套，网关手里不留任何可复用的会话材料。
**页面关掉 = 不可用**（这是设计取舍，不是故障）。

## 为什么要这个项目

三条通道各有一套协议、各自的凭证体系和各自的 429 策略：

| | browser（页面转发，**默认**） | studio（aistudio-api，可选） | robin（Summeretto） |
|---|---|---|---|
| 上游 | 页面里由浏览器自己发 MakerSuite RPC | Node/Python 冒充浏览器会话 | Gemini App 的 Robin gRPC 双向流 |
| 凭证 | 不落地：用页面现成会话 | Google Cookie（导入后重放） | oauth_token → master token → ya29 |
| 强项 | 与真人浏览器的网络特征完全一致；脚本面板能看到每次请求记录 | 无头常驻、断网不中断、多账号轮换 | 首字快、真实档位、音视频渡桥 |
| 缺陷 | **必须开着页面**；每轮 6~15s | 要重放会话 Cookie（风控风险） | 单凭证；无多账号轮换 |

CatLocal 做的事：

1. **一个入口**：同一个 Key 既能给 cat 脚本用，也能给 OpenAI/Gemini 客户端用。
2. **一个模型名空间**：`pg-`/`pggo-`/`page/`/无前缀 → browser，`studio/` → 无头，`robin/`/`rb/` → robin。
3. **一套并发治理**：每通道独立信号量 + 排队 + 排队超时，互不挤占；跨通道回退默认**关闭**（不自动把请求挪去会重放 Cookie 的通道）。
4. **把「cat 云端」搬回本地**：脚本里写死 `catiecli.sukaka.top` 的四个地址由网关下发时替换成本机地址。
5. **管理面**：账号、密钥、通道健康、执行器在线状态、并发度、日志、请求指标，全在一个面板。

## 目录

```
catlocal/
├─ src/
│  ├─ server.mjs            入口：装配 + 路由 + WS + 启动/停机
│  ├─ config.mjs            配置（config.json + 环境变量覆盖）
│  ├─ http.mjs              极简路由、请求体、JSON/SSE 响应、鉴权错误
│  ├─ upstream.mjs          上游调用：超时/空闲超时/取消/SSE 逐块
│  ├─ limiter.mjs           并发信号量 + FIFO 排队 + RPM 窗口
│  ├─ metrics.mjs           内存指标（p50/p95、近期请求环形缓冲）
│  ├─ store.mjs             持久状态（密钥、累计统计、凭证镜像）
│  ├─ routing.mjs           模型名 → 通道解析（前缀 / 清单 / 覆盖 / 缺省）
│  ├─ runner.mjs            限流→调用→回退→记账（两条 API 共用）
│  ├─ channel.mjs           通道基类（缓存、重试、健康）
│  ├─ channels/studio.mjs   aistudio-api 适配（含账号管理）
│  ├─ channels/robin.mjs    Summeretto 适配（含凭证绑定）
│  ├─ convert.mjs           OpenAI ⇄ Gemini 协议转换
│  ├─ api/gemini.mjs        /v1beta/*
│  ├─ api/openai.mjs        /v1/*
│  ├─ api/cat.mjs           cat 协议兼容（push / bind / script / collect）
│  ├─ api/admin.mjs         /admin/api/*
│  ├─ cat-script.mjs        用户脚本本地化补丁（地址替换 + collect 注入）
│  ├─ ws-server.mjs         手写 RFC6455 服务端（零依赖）
│  ├─ executors.mjs         浏览器执行器池（心跳/顶替/采集）
│  └─ supervisor.mjs        引擎子进程托管（启动/日志/崩溃重启/优雅停机）
├─ web/index.html           管理面板（单文件，无构建）
├─ tests/                   离线自测：mock-studio / mock-robin / run-tests
├─ scripts/install.ps1、start.ps1
└─ data/                    运行态（state.json、日志、脚本母版）—— 已 gitignore
```

## 快速开始（Windows）

前置：Node 22+、Python 3.11+（studio 引擎用）、Git。`robin` 的音频渡桥可选装 ffmpeg。

```powershell
cd catlocal
.\scripts\install.ps1      # 建 venv、装依赖、编译 waa-signer、生成配置与默认 Key
.\scripts\start.ps1        # 起网关（自动带起 studio 与 robin 两个引擎）
```

启动后浏览器打开 **http://127.0.0.1:8788/admin**（或 `https://127.0.0.1:8789/admin`），面板免口令直接进。

> 默认是**单机自用**配置：`auth.requireKey=false`、`auth.adminToken` 为空，所以管理面板和 API 都不需要口令/Key。
> 若以后要把端口暴露到局域网或公网，请务必先把这两个打开（见「管理面板」一节）。

`install.ps1` 做的事：

1. 校验 Node / Python 版本；
2. 在 `..\aistudio-api` 建 `.venv` 并装 `fastapi/httpx/pydantic/uvicorn/pyyaml/python-dotenv/python-multipart`（失败自动切清华镜像重试）；
3. 若 `..\aistudio-api\waa-signer\bin\waa-signer.exe` 不存在，调用上游 `waa-signer\build.ps1` 自动下载 Go + Zig + SpiderMonkey 静态库并编译（首次约 5–15 分钟，取决于网速）；
4. 生成 `config.json`；
5. 生成 `data/tls/` 自签证书（`node scripts/make-cert.mjs`，wss 通道用）；
6. 把 `Catiecli Playground Executor*.txt` 复制成 `data/catiecli.user.js` 作为脚本母版。

后续日常只用 `start.ps1`。

## 浏览器执行器通道（wss · 8789）

AI Studio 页面是 `https://`，浏览器会按**混合内容**规则拦掉 `ws://127.0.0.1` 的连接。所以本机网关额外开一个 TLS 监听：

```
wss://127.0.0.1:8789/api/pg/ws     ← 脚本连这个
http://127.0.0.1:8788/...          ← 其余 API 仍走明文本机端口
```

自签证书必须被浏览器信任，否则脚本连不上（控制台会看到 `ERR_CERT_AUTHORITY_INVALID`）。二选一：

```powershell
.\scripts\trust-cert.ps1                     # 装进「受信任的根证书颁发机构」（推荐）
# 或：浏览器访问一次 https://127.0.0.1:8789 手动点「继续前往」
```

证书 825 天有效，SAN 覆盖 `localhost` 与 `127.0.0.1`。需要重签时 `node scripts/make-cert.mjs --force`。

关闭这个通道：`config.json → gateway.tls.enabled = false`，脚本会自动退回 `ws://127.0.0.1:8788`（此时 Playground 页面会连不上，但推送 Cookie / 绑定 Robin 不受影响，因为它们走 GM XHR）。

## 三种接入方式

### 1. cat 用户脚本（从云端切到本地）

1. 面板 →「接入指引」拿到脚本地址：`http://127.0.0.1:8788/api/pg/script.user.js`
2. 在 Tampermonkey 里装这个 URL（或粘入它下载到的内容）；脚本头里的 `@connect`、`@downloadURL` 已被改写为本机。
3. 打开 AI Studio Playground 页面即可——**不需要填 Key**：本机版脚本已内置默认 Key，网关也不校验。
4. 需要给 studio 供凭证时，点面板「☁ 推送 Cookie」；需要给 robin 供凭证时，在 Google 登录流程页点「🦜 推送 Robin 凭证」——两者都直接进本地，不再经过任何云端。

脚本的四个云端地址被替换为：

| 脚本常量 | 本地 |
|---|---|
| `WS_URL` | `wss://127.0.0.1:8789/api/pg/ws`（无证书时退回 `ws://127.0.0.1:8788`） |
| `PUSH_URL` | `http://127.0.0.1:8788/api/pggo/push` |
| `SCRIPT_URL` | `http://127.0.0.1:8788/api/pg/script.user.js` |
| `ROBIN_BIND_URL` | `http://127.0.0.1:8788/api/robin/bind-by-key` |

另外注入了两样东西：

- `collect` 能力：网关可以主动向在线浏览器要一次「Cookie + 捕获请求头 + 邮箱 + 账号索引 + 指纹」，一键搬进无头 studio 引擎（面板「🔄 从浏览器采集」），省掉手点推送。
- 默认 Key：把当前默认客户端 Key 写成 `apiKey` 的兜底值，装完即连。

> 说明：本机化之后，`pg-` 这类"浏览器执行"的模型**就在页面里执行**——网关把请求编码后通过 WS
> 交给脚本，脚本现场取 WAA proof 再发上游。所以脚本面板的「使用记录」会照常出现每一条请求。
> 代价是必须开着标签页；关掉页面就不可用（503 `no_executor`），这是刻意的取舍。

### 2. OpenAI 兼容客户端（NextChat / Cherry Studio / LobeChat / openai SDK）

```
Base URL : http://127.0.0.1:8788/v1
API Key  : 本机不校验，随便填；若开启了 requireKey 则填面板里的 cat- Key
模型      : pg/gemini-3.8-flash      → 页面转发（浏览器执行）
            pggo/gemini-4-neon       → 同上（pggo- 是 cat 的历史写法）
            studio/gemini-3.8-flash  → studio 无头通道（要导入 Cookie，慎用）
            robin/gemini-4-argon     → robin
            gemini-3.8-flash         → 默认通道（routing.defaultChannel = browser）
```

### 3. Gemini 原生客户端（google-genai SDK / 兼容客户端）

```
Base URL  : http://127.0.0.1:8788      api_version: v1beta
鉴权      : x-goog-api-key: <cat Key>（本机不校验时可任意填）
端点      : /v1beta/models、/v1beta/models/{m}:generateContent、
            :streamGenerateContent?alt=sse、:countTokens
```

## 模型路由规则

优先级从高到低：

1. `routing.overrides` 精确命中（可把模型名重映射到另一通道/另一模型）；
2. **显式前缀**（前缀会被剥掉再交给通道）：
   `pg-` / `pggo-` / `page/` / `browser/` → **browser（页面转发）**；
   `studio/` / `studio-` → studio 无头；
   `robin/` / `rb/` → robin；
3. **没有前缀 → 直接走 `routing.defaultChannel`（默认 `browser`）**。
   这条不再看模型清单归属：清单是异步拉取、可能失败的，一旦拉取失败，两边都有的模型会
   被判成「只属于 studio」，请求就会悄悄落到会重放 Cookie 的通道上去。

跨通道回退默认**关闭**（`routing.failover=false`、`fallbackOrder=[]`）。需要时显式打开，
否则页面没开的时候会直接 503 `no_executor`——这是预期行为，不会偷偷换成无头通道。
回退发生时会写进响应头：

```
x-catlocal-channel: robin
x-catlocal-model: gemini-3.8-flash
```

> 早期版本（2026-11-21 之前）把 `pg-` 映射到无头通道以换取速度；现在改回「页面执行」，
> 原因是账号风控：无头通道要重放导入的会话 Cookie，而页面执行用的是浏览器自己的会话。
> 速度上慢 2~5 倍（每轮 6~15s），但网络特征与真人一致，且脚本面板能看到每次请求的记录。

## 并发与可靠性

- **每通道独立限流**：`channels.<name>.concurrency` 并发上限、`maxQueue` 排队上限、`queueTimeoutMs` 排队超时。队列满/超时分别返回 `429 channel_busy`、`429 queue_timeout`，而不是把内存堆穿。
- **运行时调参**：面板「并发与调度」改完立即生效（正在跑的请求不受影响，缩容只影响新请求）。
- **通道内重试**：`channels.<name>.retries` + 指数退避，只对幂等失败（429/5xx/网络）重试。
- **流式**：先与上游建连成功再向客户端发 SSE 头，因此启动阶段的失败仍能返回标准 JSON 错误；中途断流发一个 error 帧收尾；空闲超过 `idleTimeoutMs` 判超时。
- **取消传播**：客户端断开 → 网关 abort → 上游连接随之关闭，不浪费配额。
- **引擎托管**：`supervisor` 拉起两个引擎、收集日志到 `data/logs/engine-*.log`，崩溃按 1s→30s 退避重启；网关停机时先关执行器、再优雅停引擎。
- **执行器池**：同 Key 只保留最新连接（顶替用 4001），心跳超时自动清退（半开连接不会永远挂着）。

### 凭证自愈（默认关闭 · 会自动抓 Cookie，慎用）

> ⚠ **默认关闭。** 这条链路会把浏览器里的会话 Cookie 反复搬进无头引擎；同一账号的会话凭据被反复重放
> 属于账号风控风险项，代价远高于「一次请求失败」。**建议只在明确需要时临时打开**，用完立刻关掉。
> 打开方式：`config.json → channels.studio.autoRecover.enabled = true`（改完无需重启，下一次失败即生效）。

studio 账号的 Cookie 会过期：一旦会话失效，引擎会把账号挂上约 20 小时冷却，之后所有模型都返回
`503 No available accounts for this request.`。

打开后，只要 **AI Studio 页面上的 cat 脚本还在线**，会做这三件事：

| 触发点 | 行为 |
|---|---|
| 请求撞上凭证类失败（`No available accounts` / `session expired` / `UNAUTHENTICATED`） | 采集一次浏览器 Cookie → 写进引擎 → **同一次请求自动重试** |
| 流式请求中途收到流内 error 帧 | 本次已无法重来（头发出去了），后台采集让**下一次**请求恢复 |
| 健康巡检（每 20s）发现账号全部失效/冷却/被删空 | 不等请求失败，直接主动采集补回 |

护栏（避免自动化把浏览器与引擎打满）：

- **单飞**：并发失败共享同一次采集，只采一次；
- **限频**：`channels.studio.autoRecover.minIntervalMs`（默认 20s）内不重复采集，且每次请求最多自愈一次；
- **无执行器即放弃**：浏览器没开着就老实报错，不排队堆积；
- **采集后复核**：导入不等于可用（例如账号被手工停用），会再查一次 `/rotation`，仍不可用就如实返回失败、不做无谓重试。

```jsonc
"channels": { "studio": {
  "autoRecover": {
    "enabled": false,           // 默认关；显式改 true 才会自动采集
    "minIntervalMs": 20000,     // 两次自动采集的最小间隔
    "collectTimeoutMs": 25000   // 等浏览器回传 Cookie 的超时
  }
}}
```

可观测：`GET /admin/api/overview → recovery`（enabled / attempts / recovered / failed / unusable / skippedDisabled / lastError / lastCookies…）。
开关关闭时失败只记 `skippedDisabled`，日志里不会出现「自动从浏览器采集」。

手动路径（默认就存在，需人点）：面板「🔄 从浏览器采集」、脚本菜单「☁ 推送 Cookie 到云端」、`POST /api/pg/collect`。

## 管理面板

http://127.0.0.1:8788/admin （TLS 口同样能开：https://127.0.0.1:8789/admin）

- **通道现况**：健康探测（延迟）、在跑/排队、峰值、引擎进程状态与重启次数；一键测活 / 启停 / 重启引擎。
- **Studio 账号**：从引擎读账号表（名称、邮箱、套餐、u 索引、冷却），支持切活跃 / 启停 / 删除；手工导入 Cookie；「从浏览器采集」。
- **Robin 凭证**：绑定状态、`credential.verdict`、token 尾号；手工绑定 oauth_token 或注入 `ya29.*`。
- **客户端密钥**：生成 / 吊销 / 限定通道 / RPM（单机自用下不校验，仅作可选开关）。
- **模型分派**：两通道模型清单与带前缀的规范名。
- **最近请求 / 吞吐 / 延迟分位**；**日志**尾部 200 行（info/warn/error 过滤）。
- **并发与调度**：每通道并发、排队上限、排队超时。
- **运行设置**：是否强制 Key、管理口令、跨通道回退开关、默认通道。

鉴权模型：

| 配置 | 行为 |
|---|---|
| `adminToken` 为空（默认） | 管理接口**只允许本机**（loopback）访问，面板不弹口令 |
| `adminToken` 已设置 | 管理接口要求 `x-api-key: <adminToken>`，面板首次会问一次并记住 |
| `requireKey=false`（默认） | API 与执行器注册都不校验 Key，脚本/客户端不用填 |
| `requireKey=true` | 客户端必须带面板里生成的 `cat-…` Key |

> 默认是**单机自用**姿态。要把 8788 暴露到局域网/公网之前，先把 `adminToken` 设上、把 `requireKey` 打开。

## 配置要点（config.json）

首次运行自动生成。关键字段：

```jsonc
{
  "gateway": {
    "host": "127.0.0.1", "port": 8788,
    "tls": { "enabled": true, "port": 8789,
             "certPath": "data/tls/catlocal.crt", "keyPath": "data/tls/catlocal.key" }
  },
  "auth": {
    "adminToken": "",               // 管理口令（空 = 仅本机，面板免口令）
    "requireKey": false,            // 单机自用：客户端/脚本不必带 Key
    "allowLoopbackWithoutKey": true // 本机调试可免 Key
  },
  "channels": {
    "browser": {                    // 默认通道：请求在浏览器页面里执行
      "enabled": true,
      "managed": { "enabled": false },   // 没有自己的引擎
      "concurrency": 4, "maxQueue": 32, "queueTimeoutMs": 120000,
      "timeoutMs": 900000,               // 浏览器往返慢，给足
      "retries": 0,
      "aliases": ["pg", "pggo", "page", "browser"]
    },
    "studio": {
      "enabled": true,                     // 页面通道靠它做 encodeWire/parseWire 编解码
      "baseUrl": "http://127.0.0.1:8180",
      "apiKey": "st-…",             // 调引擎用（与 aistudio-api 的 api_keys 对应；留空则两边都不校验）
      "managed": { "enabled": true, "cwd": "../aistudio-api",
                   "command": ".venv/Scripts/python.exe",
                   "args": ["main.py", "server", "--port", "8180"] },
      "concurrency": 6, "maxQueue": 64, "queueTimeoutMs": 120000,
      "timeoutMs": 900000, "idleTimeoutMs": 300000, "retries": 1,
      "autoRecover": { "enabled": false },   // 自动抓 Cookie：默认关，见下文
      "aliases": ["studio"]
    },
    "robin": {
      "baseUrl": "http://127.0.0.1:3000",
      "apiKey": "rb-…",             // Summeretto 的 PROXY_API_KEY
      "adminKey": "rbadmin-…",      // Summeretto 的 ADMIN_KEY（绑定凭证用）
      "managed": { "enabled": true, "cwd": "../Summeretto/service",
                   "command": "node", "args": ["server.mjs"] },
      "concurrency": 4, "maxQueue": 64, "queueTimeoutMs": 120000
    }
  },
  "routing": { "defaultChannel": "browser", "failover": false,
               "fallbackOrder": [], "overrides": {}, "failoverMap": {} },
  "executors": { "enabled": true, "heartbeatTimeoutMs": 75000, "maxExecutors": 32 },
  "cat": { "publicBaseUrl": "", "sourcePath": "…\\Catiecli Playground Executor-2.21.0.txt" },
  "logging": { "level": "info" }
}
```

环境变量覆盖：`CATLOCAL_PORT`、`CATLOCAL_ADMIN_TOKEN`、`CATLOCAL_HOST`、`STUDIO_URL`、`STUDIO_API_KEY`、`ROBIN_URL`、`ROBIN_API_KEY`、`CATLOCAL_LOG_LEVEL`；自测/多实例另有 `CATLOCAL_CONFIG`、`CATLOCAL_DATA_DIR`。

`managed.enabled=false` 表示引擎由你自己起，网关只做反向代理（此时把 `baseUrl` 指过去、`apiKey` 对齐即可）。

## 自测

```powershell
cd catlocal
node tests/run-tests.mjs
```

完全离线：起两个假引擎（mock-studio / mock-robin）与真网关，覆盖协议转换、限流并发峰值、WS 握手/顶替、路由与前缀、流式多帧、OpenAI 双模、页面转发（含"引擎不得自行生成"的硬契约）、cat 推送/绑定、脚本补丁、执行器采集、跨通道回退、凭证自愈、管理接口。

几个关键用例值得记住：

- **页面转发：pg- 请求由浏览器执行，引擎只被当成编解码器** —— 断言 mock 引擎的 `generateCount` 不变；
- **页面没开 → 503 `no_executor`** —— 不允许悄悄回落到无头通道；
- **默认关闭的自动抓 Cookie** —— 配置里没写 `enabled` 时，一次都不许碰浏览器 Cookie。

## 常见问题

**端口 8080 被别的项目占用**（Docker 容器最常见）
studio 默认用 **8180**，`scripts/install.ps1`（内部 `gen-config.mjs`）还会在端口被占时自动往后找一个空闲端口并写回 `config.json`。若手动改了 `channels.studio.baseUrl`，记得同步 `managed.args` 里的 `--port`。

**`/healthz` 里 studio 显示不可用 / 引擎 `crashed`**
看 `data/logs/engine-studio.log`。最常见是 venv 没建好或 `main.py` 路径不对；重跑 `scripts/install.ps1`。

**studio 报 WAA/签名相关错误**
`waa-signer.exe` 缺失或被杀软拦掉。重跑 `waa-signer\build.ps1`，或确认 `..\aistudio-api\waa-signer\bin\waa-signer.exe` 存在且 `-check` 通过。

**robin 显示 `凭证未绑定`**
用 cat 脚本在 Google 登录流程推一次 oauth_token，或面板里手工绑定。若引擎不是网关拉起的，确认它启动时带了 `ADMIN_KEY` 与 `PROXY_API_KEY`，且与 `config.json` 一致。

**脚本的 WS 连不上（浏览器拦了 `ws://` 或证书没信任）**
两个常见原因：① 页面是 `https://aistudio.google.com`，明文 `ws://127.0.0.1` 会被当作混合内容拦掉 —— 本机版脚本已改成 `wss://127.0.0.1:8789`，需要浏览器信任自签证书（跑一次 `scripts\trust-cert.ps1`，或访问 `https://127.0.0.1:8789` 手动接受）；② `gateway.tls.enabled=false` 时脚本退回 `ws://127.0.0.1:8788`，在 https 页面上必然连不上。
Cookie 推送走的是 `GM.xmlHttpRequest`，不受这两条限制——WS 连不上不影响凭证推送与所有模型调用；只是面板里看不到该浏览器执行器、不能用「从浏览器采集」。

**Cookie 推送报「缺少会话必需 Cookie」**
Tampermonkey 需把「允许脚本访问 Cookie」设为 **all**（HttpOnly 的会话 Cookie 才能读到）。

**端口冲突**
改 `config.json` 的 `gateway.port` / `channels.*.baseUrl`（端口来自 baseUrl）。若引擎由网关托管，`managed.args` 里的 `--port` 也要同步改。

## 与上游的关系

本仓库**不改** `aistudio-api` 与 `Summeretto` 的任何源码，只做进程托管 + HTTP 反向代理 + 协议转换 + cat 协议兼容。上游更新后直接 `git pull` 即可，网关侧只需要在 `install.ps1` 里重跑依赖/编译。

## 仓库里没有什么

`config.json` 与 `data/`（凭证、密钥、日志、统计、自签证书）都在 `.gitignore` 里，不会被提交。首次运行请执行 `npm run config:init` 生成你自己的 `config.json`（随机密钥、自动挑空闲端口）。

## License

[MIT](LICENSE)
