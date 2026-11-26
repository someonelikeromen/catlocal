// ==UserScript==
// @name         Catiecli Playground Executor
// @version      2.21.0
// @description  在 AI Studio Playground 页面激活：① WS Executor 模式——接收后端请求，页面 WAA proof + fetch 调用 MakerSuite（pg- Playground 通道模型）；② Cookie 推送模式——导出 AI Studio Cookie 推送到 catiecli 云端，云端 Go 进程无头执行（pggo- Playground 通道模型），无需挂机；③ Robin 凭证——在 EmbeddedSetup 登录流程页通过菜单推送 oauth_token 绑定（弹窗显示结果）；④ 使用记录——面板实时记录每次请求（模型/方式/结果/耗时，可展开错误详情，跨刷新保留）；⑤ 返回缓存内容——缓存最新成功响应体，断线丢结果时可一键补发；⑥ 快速换号——面板一键切换 Google 多账号（/u/N/ 索引，整页跳转该账号的临时会话页）；⑦ 受限账号补推——AI Studio 被 Google restrictions 封禁打不开页面时，在 Google 账号页（myaccount.google.com）通过菜单直接采集 Cookie 推送（附带通用公开 x-goog-api-key 跳过云端页面加载）。
// @author       catiecli
// @namespace    https://catiecli.sukaka.top/
// @match        https://aistudio.google.com/*prompts*
// @match        https://alkalimakersuite-pa.clients6.google.com/*
// @match        https://accounts.google.com/v3/signin/*
// @match        https://myaccount.google.com/*
// @run-at       document-start
// @connect      catiecli.sukaka.top
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_cookie
// @grant        GM.xmlHttpRequest
// @grant        GM_openInTab
// @noframes
// @updateURL    https://catiecli.sukaka.top/api/pg/script.user.js
// @downloadURL  https://catiecli.sukaka.top/api/pg/script.user.js
// @homepageURL  https://catiecli.sukaka.top/
// ==/UserScript==
// ↑ 说明：@match alkalimakersuite-pa.clients6.google.com 不是为了在该域执行
//（有 @noframes），而是让 GM_cookie 能按 GENERATE_URL 查询 Cookie——
// Tampermonkey 要求查询 url 必须被 @match/@include 覆盖，策略 1 语义最准
//（= 浏览器真实将发送的 Cookie）。
// @match accounts.google.com/v3/signin/* 说明：EmbeddedSetup 登录流程（邮箱→
// 密码→I agree）都在此路径下。Robin 凭证推送不依赖页面注入——用户在登录
// 流程任意一步点 Tampermonkey 菜单「🦜 推送 Robin 凭证」即可（菜单驱动，
// 弹窗显示结果，比自动挂载面板可靠）。
// @match myaccount.google.com/* 说明：AI Studio 被 Google restrictions
//（如 restrictions/200 servicerestricted）封禁、打不开 Playground 页面的
// 受限账号，在 Google 账号页（https://myaccount.google.com/ 或 /u/N/ 多账号
// 前缀）通过菜单「🚑 推送受限账号 Cookie (pggo)」直接采集 Cookie 推送——
// 页面本身不跑任何 Playground 逻辑（main() 短路返回，不连 WS、不装捕获）。

/*
 * ============================== 使用说明 ==============================
 *
 * 1. 确保账号下已创建 cat- 前缀 API Key。
 *
 * 2. 安装本脚本后打开 Playground 页面：
 *    https://aistudio.google.com/prompts/new_chat?temporary=true
 *    （临时会话页：自动引导触发的页面发送不会写入会话历史）
 *    ⚠ Cookie 推送（云端模式）需要在 Tampermonkey 把「允许脚本访问 Cookie」
 *      设为 all（管理面板 → 设置 → 配置模式选「高级」→ 安全栏 → 设为 all → 保存），
 *      否则 GM_cookie 读不到 HttpOnly 会话 Cookie。
 *      iOS 的 Safari 系管理器（Userscripts / Stay 等）大多没有 Cookie API，
 *      云端推送请用桌面浏览器 + Tampermonkey。
 *
 * 3. 【WS 挂机模式】设置 catiecli API Key 后：
 *    脚本自动连接 WS；收到第一个请求时会自动完成引导——脚本自动
 *    跳转到临时会话页（new_chat?temporary=true）、发送一条 "hi"
 *    （被拦截，不会真发到上游、不写入会话历史），借这次发送捕获
 *    WAA service 与请求头。自动引导失败时可手动在聊天框里发一条
 *    消息兜底。菜单里可切换「自动引导拦截」（关闭后退化为真发
 *    一条 hi，页面会短暂出现该消息）。
 *    连上 WS 后 pg-（Playground 通道）前缀模型可用：走
 *    GenerateContent。
 *
 * 4. 【云端无头模式（推荐，无需发消息/无需挂机）】设置 Key 后即可点
 *    「推送 Cookie」：脚本用 GM_cookie 导出 AI Studio / Google 域全部
 *    Cookie（含 HttpOnly 的 SAPISID / __Secure-*），连同真实浏览器现场
 *    （屏幕几何/时区/语言/硬件并发数——自动附带，云端按此
 *    建 VM，降低风控风险）POST 到 catiecli 后端。之后无需保持页面
 *    在线，请求 pggo- 前缀模型即由云端用你的 Cookie 无头执行。
 *    （同账号重复推送自动覆盖更新。）多账号浏览器：导出的
 *    是当前激活账号的 Cookie（切到目标账号再推即可），账号索引
 *    优先取页面捕获头里的 x-goog-authuser，
 *    无捕获时回退 URL /u/N/ 前缀，云端按同一索引发请求。
 *    已捕获的页面请求头（x-goog-api-key / 订阅 tier / x-goog-ext-*
 *    日志上下文 / visit-id）随推送一并上报：云端首冷启动免页面载入
 *    与权益查询，无头请求头与浏览器现场完全一致，加速更多（未发过
 *    消息时无请求头，云端自行载入，不影响可用性）。
 *
 * 5. 可选：「小窗保活」（iPhone 不支持时置灰）与「后台音频保活」
 *    两个开关可分别开启（也可同时开），减少浏览器冻结后台标签页
 *    导致 WS 掉线。iOS 切后台后标签页仍可能被系统挂起（平台限制），
 *    回到本页会自动重连。
 *
 * 6. 【Robin 凭证】打开 EmbeddedSetup 登录页（见凭证页引导），输入邮箱
 *    登录并点「I agree」同意条款（点完页面转圈属正常）后，在 Tampermonkey
 *    菜单点「🦜 推送 Robin 凭证」——脚本读取 oauth_token cookie 与邮箱，
 *    推送到 catiecli 完成绑定，弹窗显示结果。相同邮箱重复推送自动覆盖。
 *    首次使用会要求粘贴 cat- API Key（记住后不再询问）。
 *
 * 7. 【使用记录】面板中部的指标卡（进行中/已完成/失败/本次连接）与
 *    「最近请求」表实时记录每个请求的时间/模型/方式/结果/耗时，失败
 *    行可点「详情」展开错误全文。记录随脚本存储持久保留（最近 30 条，
 *    页面跳转/刷新不丢）；「清空」同时清表格条目与累计完成/失败计数。
 *
 * 8. 【返回缓存内容】网络不稳定导致「页面这边请求已完成、但客户端
 *    到后端的连接中途断了」时，最新一次成功的响应体会被缓存（只存一条，
 *    新成功自动顶替旧的）。开启面板「缓存」后，下一个到达的
 *    请求不再发往上游，而是直接把缓存内容回传给后端（一次性：用完即
 *    自动关闭）。用于补发刚才断线丢失的那条响应。
 *
 * 9. 【快速换号】浏览器登录了多个 Google 账号时，面板「换号」
 *    可直接切换（/u/0/ … /u/5/ 索引）：点击后断开 WS、整页跳转到目标
 *    账号的临时会话页，脚本在新账号页面自动重新引导，Cookie 推送与
 *    WS 挂机都随新账号走。Google 多账号的 URL 前缀（/u/N/）即账号
 *    路由——主账号无前缀（索引 0）。
 *
 * 10.【受限账号补推（AI Studio 被封禁时）】账号被 Google restrictions
 *    （如 restrictions/200 servicerestricted）封禁、打开 AI Studio 只见
 *    限制提示页时：改到 Google 账号页（主号 https://myaccount.google.com/，
 *    第 2 个账号 /u/1/，以此类推），点 Tampermonkey 菜单
 *    「🚑 推送受限账号 Cookie (pggo)」，按弹窗确认邮箱即可（账号索引
 *    按 URL /u/N/ 前缀自动确定）。
 *    推送固定附带 AI Studio 未登录前端通用公开 Key（x-goog-api-key），
 *    云端凭它跳过「拉取被封禁页面」的冷启动步骤；不携带任何账号私有
 *    tier / visit-id / ext-bin 头。
 *
 * ====================================================================
 */

(function () {
    "use strict";

    const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

    // ==================== 常量（集中配置区） ====================

    // ---- 服务端点（catiecli 后端） ----
    const WS_URL = "wss://catiecli.sukaka.top/api/pg/ws";
    const PUSH_URL = "https://catiecli.sukaka.top/api/pggo/push";
    const SCRIPT_URL = "https://catiecli.sukaka.top/api/pg/script.user.js"; // @downloadURL 同源
    const ROBIN_BIND_URL = "https://catiecli.sukaka.top/api/robin/bind-by-key";

    // ---- 上游（AI Studio MakerSuite） ----
    const GENERATE_URL =
        "https://alkalimakersuite-pa.clients6.google.com/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";
    const GENERATE_PATH =
        "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/GenerateContent";
    const EXECUTOR_TYPE = "playground"; // 与后端 EXECUTOR_TYPE_PLAYGROUND 对应
    const CLIENT_VERSION = "2.21.0";
    // 单次上游 fetch（含读取响应体）的最长等待
    const FETCH_TIMEOUT_MS = 15 * 60 * 1000;
    // 单个请求整体硬超时（防任何环节挂起）
    const REQUEST_HARD_TIMEOUT_MS = 15 * 60 * 1000;

    // ---- WS 连接 ----
    // 心跳间隔（worker 驱动；主线程定时器会被后台标签页节流）
    const HEARTBEAT_MS = 20000;
    // 心跳半开判定：连续 N 轮无任何下行则主动断开重连
    const HEARTBEAT_MAX_SILENT_ROUNDS = 3;
    // 断线重连退避上限
    const RECONNECT_MAX_DELAY_MS = 30000;
    // WS 发送背压阈值：超过则视为来不及发，走 outbox 暂存
    const MAX_WS_BUFFERED_AMOUNT = 1024 * 1024;

    // ---- 断线续传 outbox ----
    // 单条补发消息最长保留时间（超时丢弃，避免无限堆积）
    const OUTBOX_MAX_AGE_MS = 10 * 60 * 1000;
    // 补发消息条数上限（超出后丢最旧）
    const OUTBOX_MAX_ITEMS = 200;

    // ---- 自动引导 ----
    const BOOTSTRAP_TRIGGER_PROMPT = "hi";
    // 自动引导：页面发送被认领后等这条假响应回填页面的最长时间
    const BOOTSTRAP_PAGE_SEND_TIMEOUT_MS = 15000;
    // 融合执行（首请求随引导顶替发出）的最长等待：覆盖上游往返 +
    // 流式全程，对齐 FETCH_TIMEOUT_MS 的量级（防上游挂起拖死引导）
    const BOOTSTRAP_HANDOFF_TIMEOUT_MS = 15 * 60 * 1000;
    // 自动引导整体超时（等 service+headers 捕获完成）
    const BOOTSTRAP_TIMEOUT_MS = 45000;
    // 引导等待输入框就位的最长时间（SPA 布局就位）
    const COMPOSER_WAIT_TIMEOUT_MS = 20000;
    // 拦截窗口吞包 TTL：只吃页面拿到伪造 502 后的即时自动重试，
    // 超时自动关闭——无限期开着会吞掉用户之后手动发的真实消息
    const SUPPRESS_WINDOW_MS = 10000;

    // ---- 页面 bundle 探测 / hook 重扫 ----
    // 等待 default_MakerSuite 出现的最长时间（超时后仍由重扫循环兜底）
    const BUNDLE_WAIT_TIMEOUT_MS = 120000;
    // 等到这个时间仍读不到页面变量 → 提示可能运行在隔离环境
    const BUNDLE_ISO_WARN_MS = 15000;
    // hook 重扫：前 BUNDLE 窗口期内快扫，之后降频慢扫（页面 chunk 陆续
    // 就位/热更新替换函数，慢扫兜底补装被覆盖的 hook）
    const HOOK_RESCAN_FAST_MS = 2500;
    const HOOK_RESCAN_SLOW_MS = 30000;
    const HOOK_RESCAN_FAST_WINDOW_MS = 120000;

    // ---- WAA proof（snapshot 可能因页面 zone 冻结而永不回调：超时+重试兜底） ----
    const PROOF_MAX_ROUNDS = 3;
    const PROOF_TIMEOUT_FIRST_MS = 20000;
    const PROOF_TIMEOUT_RETRY_MS = 30000;

    // ---- 对后端的 gmXhr 请求超时 ----
    const COOKIE_PUSH_TIMEOUT_MS = 30000; // Cookie 推送（含大量 Cookie，放宽）
    const UPDATE_CHECK_TIMEOUT_MS = 15000; // 检查脚本更新

    // ---- 请求头持久化 ----
    const WAA_PERSIST_TTL = 24 * 3600 * 1000; // 持久记录有效期 24h

    // ---- 流式保活（CountTokens 一次 + robots.txt 周期旁路） ----
    // CountTokens：对齐官网页面行为——主请求发出 2s 后向同端点发一次
    // 真实 CountTokens RPC（gcli playground-executor 同款），流量形态
    // 与真实页面一致。⚠ 只发这一次，覆盖不了长请求的全程。
    // robots.txt 周期旁路：主请求进行期间每 15s 往同域发一个轻量 GET，
    // 持续维持同一条 h2/QUIC 连接不被代理/NAT 按连接级空闲超时
    //（~198s）掐断——等首字节的窗口里主 fetch 零流量，全靠这发兜底。
    // no-cors 简单请求不触发预检；credentials:include 保证与主请求
    // 同一连接池（⚠ Chrome 对 "omit" 用独立连接池，那样保不到主请求
    // 那条连接）；自带 10s 超时防止旁路请求被挂住堆积。
    const COUNT_TOKENS_KEEPALIVE_DELAY_MS = 2000; // 主请求发出 2s 后触发一次
    const COUNT_TOKENS_KEEPALIVE_TIMEOUT_MS = 10000; // 保活请求自身最长挂起时间
    const KEEPALIVE_MODEL = "gemini-3.8-flash";
    const BYPASS_KEEPALIVE_INTERVAL_MS = 15000; // 旁路轮询间隔
    const BYPASS_KEEPALIVE_REQ_TIMEOUT_MS = 10000; // 单个旁路请求最长挂起时间

    // ---- GM 存储键 ----
    const API_KEY_STORE_KEY = "pg_api_key";
    const PANEL_POS_KEY = "pg_panel_pos"; // 面板位置
    const PANEL_COLLAPSED_KEY = "pg_panel_collapsed"; // 面板折叠态
    const WAA_STORE_KEY = "pg_waa_snapshot"; // 请求头快照
    const BOOTSTRAP_INTERCEPT_KEY = "pg_bootstrap_intercept"; // 自动引导拦截开关
    const ACTIVITY_STORE_KEY = "pg_activities"; // 使用记录（最近请求）
    const ACTIVITY_STATS_KEY = "pg_activity_stats"; // 累计完成/失败计数
    const REPLAY_CACHE_KEY = "pg_replay_cache"; // 最新成功响应体缓存（一条）
    // preload 需要预读的全部键（新增键请同步加进来）
    const GM_STORE_KEYS = [
        API_KEY_STORE_KEY,
        PANEL_POS_KEY,
        PANEL_COLLAPSED_KEY,
        WAA_STORE_KEY,
        BOOTSTRAP_INTERCEPT_KEY,
        ACTIVITY_STORE_KEY,
        ACTIVITY_STATS_KEY,
        REPLAY_CACHE_KEY,
    ];

    // ---- Playground 面板 UI ----
    const PANEL_MARGIN = 8; // 面板距视口边缘的最小留白（px）
    const STEP_TITLES = ["设置 API Key", "自动引导", "连接服务器"];
    const STEP_HINTS = [
        "点下方「设置 Key」，粘贴 cat- 开头的密钥",
        "收到第一个请求时自动完成（会自动跳转临时会话页，不落会话历史）",
        "设置 Key 后会自动连接",
    ];

    // ---- 使用记录（活动表） ----
    const MAX_ACTIVITY_ROWS = 30; // 最近请求最多保留条数
    const MAX_ACTIVITY_MSG_LENGTH = 1000; // 错误信息入库截断
    const MAX_ACTIVITY_ERROR_BODY_LENGTH = 4 * 1024; // 错误响应体入库截断（控制存储体积）

    // ---- 返回缓存内容（断线结果补偿） ----
    // 只缓存最新一条成功响应体；面板开关开启后下一个请求直接回它。
    // 响应体可能很大（长回答），给缓存设一个上限，超过则不缓存（避免
    // GM 存储/内存压力失控；此类超长回复断线丢失的概率也低）
    const REPLAY_CACHE_MAX_BYTES = 10 * 1024 * 1024;

    // ---- Robin 凭证推送（EmbeddedSetup 登录流程，菜单驱动） ----
    const ROBIN_UPLOAD_TIMEOUT_MS = 30000; // 推送请求超时

    // ---- 受限账号补推（AI Studio 被封禁时，Google 账号页菜单驱动） ----
    // AI Studio 未登录前端公开通用 Client Key（页面 WIZ_global_data["WIu0Nc"]
    // 的历史稳定值）：单凭此头即可让云端跳过「拉取 AI Studio 页面」的
    // 冷启动步骤（被封禁账号拉页面只会 502/限制页）。它是页面级公开
    // 常量而非账号私有值，不会污染账号特征
    const RESTRICTED_PUBLIC_WEB_API_KEY = "AIzaSyDdP816MREB3SkjZO04QXbjsigfcI0GWOs";

    // ---- 快速换号（Google 多账号 /u/N/ 切换） ----
    // Google 多账号用 URL 前缀 /u/N/ 区分（N 为账号索引，主账号无前缀 = 0）。
    // 切换 = 整页跳转到目标账号的临时会话页——页面上下文（Cookie 会话、
    // WAA service、捕获请求头）全部按新账号重建，无需用户手动改 URL
    const ACCOUNT_SWITCH_MAX_INDEX = 5; // 面板可选 0-5（Google 最多 6 个账号）

    // ==================== GM API 兼容层（iOS 管理器只提供部分 API） ====================
    // 桌面 Tampermonkey：同步 GM_getValue/GM_setValue + 回调式 GM.xmlHttpRequest 都有；
    // 部分 iOS 管理器只有其中一套。跨域请求统一走 gmXhr；存储统一走 gmStore——
    // 没有同步存储 API 时，main() 启动先 await 一次把值读进内存，之后同步读写走缓存。

    function gmXhr(opts) {
        if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest(opts);
        if (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") {
            return GM.xmlHttpRequest(opts);
        }
        throw new Error("当前脚本管理器未提供 GM_xmlhttpRequest / GM.xmlHttpRequest");
    }

    const gmStore = {
        cache: new Map(),
        hasSync: typeof GM_getValue === "function" && typeof GM_setValue === "function",
        get(key, def) {
            if (this.hasSync) {
                try {
                    return GM_getValue(key, def);
                } catch (_) {}
            }
            return this.cache.has(key) ? this.cache.get(key) : def;
        },
        set(key, val) {
            this.cache.set(key, val);
            if (this.hasSync) {
                try {
                    GM_setValue(key, val);
                    return;
                } catch (_) {}
            }
            try {
                if (typeof GM !== "undefined" && typeof GM.setValue === "function") {
                    GM.setValue(key, val);
                }
            } catch (_) {}
        },
        async preload() {
            if (this.hasSync) return;
            try {
                for (const k of GM_STORE_KEYS) {
                    const v = await GM.getValue(k, undefined);
                    if (v !== undefined) this.cache.set(k, v);
                }
            } catch (_) {}
        },
    };

    // ==================== 配置（GM 存储） ====================

    const cfg = {
        apiKey: gmStore.get(API_KEY_STORE_KEY, ""),
    };

    function saveCfg() {
        gmStore.set(API_KEY_STORE_KEY, cfg.apiKey);
    }

    // 自动引导拦截开关：默认开启（拦截式引导，不污染会话）。
    // 关闭后退化为「真发一条 hi」（与手动发消息等价，页面会留下该消息）。
    function bootstrapInterceptEnabled() {
        return gmStore.get(BOOTSTRAP_INTERCEPT_KEY, true) !== false;
    }

    function setBootstrapIntercept(on) {
        gmStore.set(BOOTSTRAP_INTERCEPT_KEY, !!on);
        log(on ? "✅ 自动引导拦截已开启" : "⚠ 自动引导拦截已关闭（下次引导将真发一条 hi）");
    }

    // 菜单注册守卫：部分 iOS 管理器没有 GM_registerMenuCommand，没有就跳过
    function regMenu(title, fn) {
        try {
            if (typeof GM_registerMenuCommand === "function") {
                GM_registerMenuCommand(title, fn);
            }
        } catch (_) {}
    }

    regMenu("⚙ 设置 API Key (cat-...)", () => {
        openKeyEditor();
    });

    regMenu("👁 显示/隐藏面板", () => {
        if (!panelEl) return;
        panelEl.style.display = panelEl.style.display === "none" ? "block" : "none";
    });

    regMenu("🪟 小窗保活 开/关", () => {
        togglePip();
    });

    regMenu("🔊 后台音频保活 开/关", () => {
        toggleAudio();
    });

    regMenu("🔆 屏幕常亮 开/关", () => {
        toggleScreenLock();
    });

    regMenu("☁ 推送 Cookie 到云端 (pggo)", () => {
        pushCookiesToCloud().catch((e) => log("推送失败: " + e));
    });

    regMenu("🔍 检查更新", () => {
        checkForUpdate(true).catch((e) => log("⚠ 检查更新失败: " + e));
    });

    regMenu("🤖 自动引导拦截 开/关", () => {
        setBootstrapIntercept(!bootstrapInterceptEnabled());
    });

    // 清空使用记录（表格条目 + 累计完成/失败计数一并归零，与面板「清空」同逻辑）
    regMenu("🧹 清空使用记录", () => {
        clearActivities();
        log("✅ 使用记录已清空");
    });

    // ⚡ 返回缓存内容（一次性开关，菜单驱动——面板收起时也能用）
    regMenu("⚡ 返回缓存内容 开/关", () => {
        if (!state.replayCache) {
            log("⚠ 暂无缓存响应（成功响应会自动缓存最新一条）");
            updatePanel();
            return;
        }
        if (state.replayArmed) {
            disarmReplay();
            log("⚡ 已取消：下一个请求恢复正常处理");
        } else {
            armReplay();
            log("⚡ 已开启：下一个请求将直接返回缓存内容（用完自动关闭）");
        }
    });

    // 登录流程页专用：推送 Robin 凭证（菜单驱动，弹窗显示结果）
    regMenu("🦜 推送 Robin 凭证", () => {
        pushRobinCredential().catch((e) => log("Robin 推送失败: " + e));
    });

    // Google 账号页专用：受限账号 Cookie 补推（菜单驱动，弹窗显示结果）
    regMenu("🚑 推送受限账号 Cookie (pggo)", () => {
        pushRestrictedAccountCookies().catch((e) => alert("❌ 执行异常：" + ((e && e.message) || e)));
    });

    // ==================== Robin oauth_token 推送（EmbeddedSetup 登录流程，菜单驱动） ====================
    // Google 登录是 SPA：整个流程只有一次页面加载（邮箱页 /v3/signin/identifier），
    // 密码页、同意条款页都是页内导航。不依赖页面注入/导航监听/自动挂载——
    // 用户在登录流程任意一步点 Tampermonkey 菜单「🦜 推送 Robin 凭证」即可：
    //   读 oauth_token cookie + 探测邮箱 → POST /api/robin/bind-by-key →
    //   弹窗显示结果。相同邮箱重复推送自动覆盖。
    // 前置条件：完成登录并点过「I agree」（oauth_token 那一步才写入）。

    // 是否在 Google 登录流程页（v3/signin/*；门 1 @match 已保证注入范围）
    function robinOnGoogleSignin() {
        try {
            const u = new URL(W.location.href);
            return (
                u.hostname === "accounts.google.com" &&
                /^\/v3\/signin\//.test(u.pathname)
            );
        } catch (_) {
            return false;
        }
    }

    // oauth_token 值理论上不做百分号编码，但解码失败要兜底：
    // decodeURIComponent 遇到孤立 % 会抛 URIError，若不兜底会把
    //「读到了 cookie」误判成「没读到」（异常被外层吞掉后层层穿透返回 ""）。
    function robinSafeDecode(v) {
        try {
            return decodeURIComponent(v || "");
        } catch (_) {
            return String(v || "");
        }
    }

    // 判断 cookie 的 domain 属性是否会随请求发往 accounts.google.com
    //（D == host，或 host 是 D 的子域）——即 DevTools Application 面板里
    // 列在 accounts.google.com 域下的那批 cookie。
    function robinDomainMatchesAccounts(domain) {
        const d = String(domain || "").replace(/^\./, "").toLowerCase();
        return d === "accounts.google.com" || "accounts.google.com".endsWith("." + d);
    }

    // 从查询结果里挑出 oauth_token（不信任管理器对 name/domain 参数的
    // 过滤，客户端侧再过滤一遍；只认有值的）
    function robinPickOauth(list) {
        const c = (list || []).find(
            (x) => x && x.name === "oauth_token" && x.value && robinDomainMatchesAccounts(x.domain)
        );
        return c ? robinSafeDecode(c.value) : "";
    }

    // 读取 accounts.google.com 域的 oauth_token cookie。
    // ⚠ oauth_token 实测是 HttpOnly：document.cookie 读不到，必须走 GM_cookie
    //（@grant GM_cookie；Tampermonkey 需把「允许脚本访问 Cookie」设为 all）。
    // GM_cookie 查询的 url 必须被 @match 覆盖——v3/signin/* 已覆盖当前页。
    // 逐层降级：url+name → url → domain+name → name 全库过滤。
    async function robinReadOauthToken() {
        // 快路径：万一不是 HttpOnly，document.cookie 直接读到
        try {
            const m = document.cookie.match(/(?:^|;\s*)oauth_token=([^;]+)/);
            if (m) return robinSafeDecode(m[1]);
        } catch (_) {}
        // GM_cookie 兜底（HttpOnly 也能读）：按当前页 url + name 查
        try {
            const { cookies, error } = await gmCookieList({ url: W.location.origin + W.location.pathname, name: "oauth_token" });
            if (!error) {
                const v = robinPickOauth(cookies);
                if (v) return v;
            }
        } catch (_) {}
        // 个别管理器不支持 url+name 组合查询，退一步只按 url 查再过滤
        try {
            const { cookies, error } = await gmCookieList({ url: W.location.origin + W.location.pathname });
            if (!error) {
                const v = robinPickOauth(cookies);
                if (v) return v;
            }
        } catch (_) {}
        // 兜底 ①：纯按域名查询、不带 url/path——实测部分浏览器/管理器按 url
        // 查不到 oauth_token（DevTools 后台手动却能看到）。url 查询语义 =
        //「浏览器对 X 将发送的 Cookie」，隐含 path 前缀匹配：若 oauth_token
        // 带的不是全站 path（非 /）或管理器对 url 查询实现有出入就会漏。
        // domain 查询与 DevTools Application 面板同语义（按域列出全部
        // cookie，与 path 无关），能覆盖这类「后台能看到、url 查不到」。
        try {
            const { cookies, error } = await gmCookieList({ domain: "accounts.google.com", name: "oauth_token" });
            if (!error) {
                const v = robinPickOauth(cookies);
                if (v) return v;
            }
        } catch (_) {}
        // 兜底 ②：domain+name 组合也不支持的管理器，只按 name 全库查，
        // 客户端按域过滤（与 collectCookies 的 byName 补查同策略）
        try {
            const { cookies, error } = await gmCookieList({ name: "oauth_token" });
            if (!error) {
                const v = robinPickOauth(cookies);
                if (v) return v;
            }
        } catch (_) {}
        return "";
    }

    // 从页面登录态里尽量自动探测邮箱（URL Email= 参数 / 输入框 / 页面文本）。
    // 实测同意条款页 URL 不带 Email= 参数，顶部账号徽章是纯文本——最后一级
    // 扫 body 文本抓第一个邮箱形态的字符串。
    function robinDetectEmail() {
        try {
            const um = W.location.search.match(/[?&]Email=([^&]+)/);
            if (um) return decodeURIComponent(um[1]).toLowerCase();
        } catch (_) {}
        try {
            for (const input of document.querySelectorAll('input[type="email"], input[name="email"], input[type="text"]')) {
                const v = (input.value || "").trim();
                const m = v.match(/[\w.+-]+@[\w.-]+\.\w+/);
                if (m) return m[0].toLowerCase();
            }
        } catch (_) {}
        try {
            // 同意条款页顶部显示账号徽章（邮箱文本直接在 DOM 里）
            for (const el of document.querySelectorAll("[data-email], .OV1QFd")) {
                const m = ((el.dataset && el.dataset.email) || el.textContent || "").match(/[\w.+-]+@[\w.-]+\.\w+/);
                if (m) return m[0].toLowerCase();
            }
        } catch (_) {}
        try {
            const links = document.querySelectorAll('a[aria-label]');
            for (const link of links) {
                const m = (link.getAttribute("aria-label") || "").match(/[\w.+-]+@[\w.-]+\.\w+/);
                if (m) return m[0].toLowerCase();
            }
        } catch (_) {}
        try {
            // 兜底：扫 body 文本（同意页徽章/欢迎语里就有邮箱）
            const m = (document.body && document.body.textContent || "").match(/[\w.+-]+@[\w.-]+\.\w+/);
            if (m) return m[0].toLowerCase();
        } catch (_) {}
        return "";
    }

    async function pushRobinCredential() {
        // ① 位置检查：必须在 accounts.google.com 登录流程页
        if (!robinOnGoogleSignin()) {
            alert(
                "Robin 凭证推送需要在 Google 登录流程页（accounts.google.com/v3/signin/...）使用。\n\n" +
                "请先打开 EmbeddedSetup 登录页（见凭证页引导），登录并点「I agree」后再来点这个菜单。"
            );
            return;
        }
        // ② 读 oauth_token：没点过 I agree 就没有这个 cookie；
        //    oauth_token 是 HttpOnly，走 GM_cookie 读（需把「允许脚本访问 Cookie」设为 all）
        const oauthToken = await robinReadOauthToken();
        if (!oauthToken) {
            alert(
                "未读到 oauth_token cookie。\n\n" +
                "请按顺序检查：\n" +
                "① 已完成登录并点击「I agree」同意条款（点完页面一直转圈属正常现象）\n" +
                "② Tampermonkey 已允许脚本访问 Cookie（oauth_token 是 HttpOnly cookie，\n" +
                "   未授权时即使已登录也读不到）：\n" +
                "   · 进入篡改猴管理面板\n" +
                "   · 点击「设置」标签页\n" +
                "   · 在通用配置模式中选择「高级」\n" +
                "   · 找到「安全」一栏，将「允许脚本访问 Cookie」设置为 All\n" +
                "   · 点击底部「保存」按钮\n\n" +
                "设置完成后刷新本页，再点一次这个菜单。\n\n" +
                "仍失败的话，请回到 catiecli 站点的「Robin 凭证」页面，查看手动填入凭证的方法。"
            );
            return;
        }
        // ③ API Key：优先用已保存的，没有就现场要一个
        let apiKey = (cfg.apiKey || "").trim();
        if (!apiKey) {
            const input = prompt("首次使用请粘贴你的 cat- API Key（cat- 前缀，之后会记住）：", "");
            if (input === null) return;
            apiKey = input.trim();
            if (!apiKey) { alert("未填 API Key，已取消。"); return; }
            cfg.apiKey = apiKey;
            saveCfg();
        }
        // ④ 邮箱：自动探测，探测不到就问用户
        let email = robinDetectEmail();
        if (!email) {
            const input = prompt("未能从页面自动识别邮箱，请输入该 Google 账号的邮箱：", "");
            if (input === null) return;
            email = input.trim().toLowerCase();
        }
        if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
            alert("邮箱格式不对，已取消。");
            return;
        }
        // ⑤ 推送到 catiecli
        try {
            const resp = await new Promise((resolve, reject) => {
                gmXhr({
                    method: "POST",
                    url: ROBIN_BIND_URL,
                    headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
                    data: JSON.stringify({ email, oauth_token: oauthToken }),
                    timeout: ROBIN_UPLOAD_TIMEOUT_MS,
                    onload: (r) => resolve(r),
                    onerror: () => reject(new Error("网络错误")),
                    ontimeout: () => reject(new Error("超时")),
                });
            });
            let data = {};
            try { data = JSON.parse(resp.responseText); } catch (_) {}
            if (resp.status === 200 && data.status === "ok") {
                alert("✅ Robin 凭证绑定成功\n\n" + (data.message || "已保存（相同邮箱重复推送自动覆盖）") + "\n\n邮箱：" + email);
                log("✅ Robin 凭证已推送：" + email);
            } else {
                const msg = data.detail || (data.error && data.error.message) || ("HTTP " + resp.status);
                alert("❌ 绑定失败\n\n" + msg + "\n\n请检查 API Key 是否正确、账号是否已完成登录流程。");
            }
        } catch (e) {
            alert("❌ 推送失败：" + e.message);
        }
    }

    // ==================== 受限账号 Cookie 补推（Google 账号页，菜单驱动） ====================
    // 场景：AI Studio 被 Google restrictions（如 restrictions/200
    // servicerestricted）封禁，打开 Playground 只见限制提示页、无法完成
    // 正常推送。改到 Google 账号页（myaccount.google.com）点菜单推送：
    //   GM_cookie 采集 Google 域全部 Cookie（含 HttpOnly 会话 8 件套）
    //   → 探测邮箱（人工确认）+ /u/N/ 账号索引（URL 自动确定）
    //   → 附带通用公开 x-goog-api-key + 浏览器指纹 POST /api/pggo/push
    //   → 弹窗显示结果。
    // 关键差异（与 pushCookiesToCloud 相比）：页面本身没有任何 GenerateContent
    // 可捕获，推送固定附带 AI Studio 未登录前端公开 Key——云端首冷启动
    // 凭它跳过「载入 AI Studio 页面」（被封账号拉页面只会 502/限制页，
    // 拉了也提不出 key）；不携带任何账号私有 tier / visit-id / ext-bin 头。

    // 是否在 Google 账号页（myaccount.google.com；门 1 @match 已保证注入范围）
    function restrictedOnGoogleAccountPage() {
        try {
            const u = new URL(W.location.href);
            return u.hostname === "myaccount.google.com";
        } catch (_) {
            return false;
        }
    }

    // 从账号页 URL 提取多账号索引：/u/N/ 前缀 → N，无前缀 → "0"
    function restrictedDetectAuthuser() {
        try {
            const pm = String(W.location.pathname || "").match(/^\/u\/(\d+)(?:\/|$)/);
            if (pm) return pm[1];
            const sp = new URLSearchParams(W.location.search || "");
            const q = sp.get("authuser");
            if (q && /^\d+$/.test(q)) return q;
        } catch (_) {}
        return "0";
    }

    async function pushRestrictedAccountCookies() {
        // ① 位置检查：必须在 myaccount.google.com（账号页/限制提示页）
        if (!restrictedOnGoogleAccountPage()) {
            alert(
                "受限账号推送需要在 Google 账号页使用：\n\n" +
                "· 主账号：https://myaccount.google.com/\n" +
                "· 第 2 个账号：https://myaccount.google.com/u/1/\n" +
                "· 第 N+1 个账号：https://myaccount.google.com/u/N/\n\n" +
                "打开后回到本页，再点 Tampermonkey 菜单里的「🚑 推送受限账号 Cookie (pggo)」。"
            );
            return;
        }
        // ② Cookie API 可用性（HttpOnly 会话 Cookie 必须走 GM_cookie）
        if (!cookieApi()) {
            alert(
                "❌ 当前脚本管理器不支持 GM_cookie，无法读取 HttpOnly 会话 Cookie。\n\n" +
                "请检查：\n" +
                "1. 使用桌面版 Tampermonkey（篡改猴）；\n" +
                "2. 管理面板 → 设置 → 配置模式选「高级」→ 安全 → 允许脚本访问 Cookie 设为「All」→ 保存并刷新页面。"
            );
            return;
        }
        // ③ API Key：优先用已保存的（同一 gmStore 存储，AI Studio 页设置过
        //    就直接复用），没有就现场要一个
        let apiKey = String(cfg.apiKey || "").trim();
        if (!apiKey) {
            const input = prompt("首次使用请粘贴你的 cat- API Key（cat- 前缀，之后会记住）：", "");
            if (input === null) return;
            apiKey = input.trim();
            if (!apiKey) { alert("API Key 不能为空，已取消。"); return; }
            cfg.apiKey = apiKey;
            saveCfg();
        }
        // ④ 采集 Cookie（复用 pushCookiesToCloud 的三策略采集 + 同名收敛：
        //    策略 1 按 GENERATE_URL 查询、策略 2 按 prompts 页查询、策略 3
        //    核心 8 件缺失时按名补查——@match 已覆盖两查询 url，语义不变）
        const cookies = await collectCookies();
        if (!cookies.length) {
            alert(
                "❌ 未导出到任何 Google Cookie。\n\n" +
                "请确认已在当前浏览器登录 Google 账号，并在篡改猴设置中将「允许脚本访问 Cookie」设为 All 后刷新重试。"
            );
            return;
        }
        // ⑤ 会话 8 件套预检：缺任一件 Google 必 401
        const names = new Set(cookies.map((c) => c.name));
        const required = [
            "SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID",
            "__Secure-1PSID", "__Secure-3PSID", "SID", "HSID", "SSID",
        ];
        const missing = required.filter((n) => !names.has(n));
        if (missing.length) {
            alert(
                `❌ 缺少会话必需 Cookie（共 ${missing.length} 件）：${missing.join(", ")}\n\n` +
                "请到 Tampermonkey 设置 → 配置模式选「高级」→ 安全 → 将「允许脚本访问 Cookie」改为「All」→ 保存后刷新本页重试。"
            );
            return;
        }
        // ⑥ 邮箱：自动探测（账号页 One Bar 的 aria-label 是主命中路径），
        //    探测不到就人工输入
        let email = detectEmail() || "";
        const emailInput = prompt("请确认要推送的 Google 账号邮箱（用于凭证命名）：", email);
        if (emailInput === null) return;
        email = emailInput.trim().toLowerCase();
        // ⑦ 账号索引：直接按 URL 确定（/u/N/ 前缀，无前缀 = 主账号 0），
        //    不再弹窗询问
        const authuser = restrictedDetectAuthuser();
        // ⑧ 推送：指纹随行 + 仅公开 api-key 头（受限页无私有头可捕获，
        //    云端首冷启动凭公开 key 跳过页面载入）
        const fingerprint = collectBrowserFingerprint();
        const payload = {
            email: email || undefined,
            authuser,
            fingerprint,
            headers: { "x-goog-api-key": RESTRICTED_PUBLIC_WEB_API_KEY },
            cookies: cookies.map((c) => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path || "/",
                expirationDate: typeof c.expirationDate === "number" ? c.expirationDate : -1,
                httpOnly: !!c.httpOnly,
                secure: !!c.secure,
                sameSite: c.sameSite || "unspecified",
            })),
        };
        try {
            const resp = await new Promise((resolve, reject) => {
                gmXhr({
                    method: "POST",
                    url: PUSH_URL,
                    headers: {
                        "Content-Type": "application/json",
                        "X-API-Key": apiKey,
                    },
                    data: JSON.stringify(payload),
                    timeout: COOKIE_PUSH_TIMEOUT_MS,
                    onload: (r) => resolve(r),
                    onerror: (e) => reject(new Error((e && e.error) || "网络错误")),
                    ontimeout: () => reject(new Error("请求超时")),
                });
            });
            let data = {};
            try { data = JSON.parse(resp.responseText || "{}"); } catch (_) {}
            if (resp.status === 200) {
                const at = data.created_at
                    ? new Date(data.created_at * 1000).toLocaleString("zh-CN", { hour12: false })
                    : "";
                alert(
                    `✅ 受限账号 Cookie 已推送（HTTP 200）\n\n` +
                    `凭证名称：${data.label || email || "(未命名)"}\n` +
                    `账号索引 authuser：${authuser}\n` +
                    `Cookie 数量：${(data.cookies !== undefined ? data.cookies : cookies.length)}\n` +
                    (at ? `更新时间：${at}\n\n` : "\n") +
                    "提示：请用 pggo- 前缀模型发送 2–3 次测试；若偶发 403 可原样重试。"
                );
            } else {
                const msg =
                    (data.error && data.error.message) ||
                    data.detail ||
                    resp.responseText ||
                    `HTTP ${resp.status}`;
                alert(`❌ 推送失败 [${resp.status}]\n\n${msg}`);
            }
        } catch (err) {
            alert(`❌ 推送异常：${(err && err.message) || err}`);
        }
    }


    // ==================== 工具 ====================

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function waitFor(fn, timeoutMs = 60000, intervalMs = 250) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const value = fn();
            if (value) return value;
            if (Date.now() > deadline) return null;
            await sleep(intervalMs);
        }
    }

    async function sha256Hex(text) {
        const data = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest("SHA-256", data);
        return [...new Uint8Array(digest)]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }

    async function sha1Hex(text) {
        const data = new TextEncoder().encode(text);
        const digest = await crypto.subtle.digest("SHA-1", data);
        return [...new Uint8Array(digest)]
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }

    function getCookie(name) {
        const m = document.cookie.match(
            new RegExp("(?:^|;\\s*)" + name + "=([^;]+)")
        );
        return m ? m[1] : null;
    }

    function isMobileLike() {
        try {
            return W.matchMedia("(pointer: coarse)").matches || W.innerWidth < 700;
        } catch {
            return false;
        }
    }

    // 画中画可用性：iPhone Safari 根本没有 PiP API（document.pictureInPictureEnabled
    // 与 requestPictureInPicture 都不存在）——检测不到时面板把开关置灰
    function pipSupported() {
        try {
            if (document.pictureInPictureEnabled === false) return false;
            if (typeof document.pictureInPictureEnabled === "boolean") return true;
            return !!(
                W.HTMLVideoElement &&
                W.HTMLVideoElement.prototype &&
                typeof W.HTMLVideoElement.prototype.requestPictureInPicture === "function"
            );
        } catch {
            return false;
        }
    }

    // 现算三段合并 Authorization（对齐官网页面真实抓包形态）：
    //   SAPISIDHASH <ts>_<h(SAPISID)> SAPISID1PHASH <ts>_<h(__Secure-1PAPISID)>
    //   SAPISID3PHASH <ts>_<h(__Secure-3PAPISID)>
    // 三 Cookie 通常同源同值；缺失时回退 SAPISID。捕获来的 authorization
    // 头时间戳会过期，每次请求重新计算；读不到 cookie 时返回 null（保留捕获的那份）。
    async function freshAuthHeader() {
        try {
            const sapisid =
                getCookie("SAPISID") ||
                getCookie("__Secure-1PAPISID") ||
                getCookie("APISID");
            if (!sapisid) return null;
            const sapisid1p = getCookie("__Secure-1PAPISID") || sapisid;
            const sapisid3p = getCookie("__Secure-3PAPISID") || sapisid;
            const ts = Math.floor(Date.now() / 1000);
            const calc = async (val) =>
                sha1Hex(ts + " " + val + " " + W.location.origin);
            return [
                "SAPISIDHASH " + ts + "_" + (await calc(sapisid)),
                "SAPISID1PHASH " + ts + "_" + (await calc(sapisid1p)),
                "SAPISID3PHASH " + ts + "_" + (await calc(sapisid3p)),
            ].join(" ");
        } catch (_) {
            return null;
        }
    }

    // 流式保活（对齐官网页面 + 连接级兜底）：
    // ① CountTokens 一次：主请求发出 2s 后发一次真实 CountTokens RPC
    //    （流量形态对齐真实页面）；
    // ② robots.txt 周期旁路：每 15s 一次轻量 GET，全程维持同一条
    //    h2/QUIC 连接不被代理/NAT 判空闲（CountTokens 只发一次，
    //    长请求等首字节的窗口靠它覆盖）。
    // 构造与 runGenerate 同款请求头；返回 stop() 供 finally 清理。
    function startCountTokensKeepAlive(signal) {
        const doFetch = W.__pgOrigFetch || W.fetch;
        let stopped = false;
        let sendTimer = null; // CountTokens 延迟触发句柄
        let kaTimer = null; // CountTokens 自身超时句柄
        const controller = new AbortController();
        const stop = () => {
            if (stopped) return;
            stopped = true;
            if (sendTimer) clearTimeout(sendTimer);
            if (kaTimer) clearTimeout(kaTimer);
            if (bypassTimer) clearInterval(bypassTimer);
            try { controller.abort(); } catch (_) {}
        };
        const bypassUrl = "https://alkalimakersuite-pa.clients6.google.com/robots.txt?_=" + Date.now();
        let bypassTimer = setInterval(() => {
            const ac = new AbortController();
            const to = setTimeout(() => { try { ac.abort(); } catch (_) {} }, BYPASS_KEEPALIVE_REQ_TIMEOUT_MS);
            try {
                doFetch.call(W, bypassUrl, {
                    method: "GET",
                    mode: "no-cors",
                    credentials: "include",
                    cache: "no-store",
                    signal: ac.signal,
                }).catch(() => {}).finally(() => clearTimeout(to));
            } catch (_) {}
        }, BYPASS_KEEPALIVE_INTERVAL_MS);
        const send = async () => {
            try {
                if (stopped) return;
                const headers = await buildUpstreamHeaders();
                if (stopped) return;
                // 超时只中止 CountTokens 自身，不动旁路轮询
                kaTimer = setTimeout(() => { try { controller.abort(); } catch (_) {} }, COUNT_TOKENS_KEEPALIVE_TIMEOUT_MS);
                const resp = await doFetch.call(
                    W,
                    GENERATE_URL.replace(/\/GenerateContent$/, "/CountTokens"),
                    {
                        method: "POST",
                        headers,
                        body: JSON.stringify([
                            "models/" + KEEPALIVE_MODEL,
                            [[[[null, BOOTSTRAP_TRIGGER_PROMPT]], "user"]],
                        ]),
                        credentials: "include",
                        signal: controller.signal,
                    }
                );
                await resp.text().catch(() => {});
            } catch (_) {
            } finally {
                if (kaTimer) { clearTimeout(kaTimer); kaTimer = null; }
            }
        };
        sendTimer = setTimeout(send, COUNT_TOKENS_KEEPALIVE_DELAY_MS);
        signal?.addEventListener("abort", stop, { once: true });
        return stop;
    }

    // 上游请求头组装（pg GenerateContent / CountTokens 共用）：
    // 捕获头（仅剔浏览器接管的传输层头）+ content-type + 三段现算
    // authorization（freshAuthHeader 返回 null 时保留捕获的那份）
    async function buildUpstreamHeaders() {
        const captured = getHeaders();
        const headers = { ...captured };
        for (const k of Object.keys(headers)) {
            if (/^(content-length|host|connection)$/.test(k)) delete headers[k];
        }
        headers["content-type"] = "application/json+protobuf";
        const freshAuth = await freshAuthHeader();
        if (
            freshAuth &&
            (!headers["authorization"] ||
                String(headers["authorization"]).startsWith("SAPISIDHASH "))
        ) {
            headers["authorization"] = freshAuth;
        }
        return headers;
    }

    const logs = [];
    function log(msg) {
        logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if (logs.length > 200) logs.shift();
        console.log("[PG-EXEC]", msg);
        captureNotice(String(msg));
        updatePanel();
    }
    // ==================== 状态 ====================

    const state = {
        ws: null,
        wsStatus: "disconnected", // disconnected | connecting | connected
        waaReady: false,
        waaSnapshotKey: null,
        waaPersistedTs: 0, // 持久化请求头快照的时间戳（0 = 无）
        reconnectTimer: null,
        reconnectDelay: 1000,
        aborted: new Set(), // 已取消的 requestId
        controllers: new Map(), // requestId -> AbortController
        requestCount: 0,
        bundleReady: false,
        outbox: [], // 待补发消息（WS 断线期间完成的请求结果，重连注册成功后按序补发）
        // ---- 使用记录 ----
        activities: [], // 最近请求（最新在前，持久化跨刷新保留）
        activitySeq: 0, // 记录自增序号（展开错误详情用）
        successCount: 0, // 累计完成（持久化）
        failureCount: 0, // 累计失败（持久化）
        connectedAt: 0, // 本次 WS 注册成功时间戳
        durationTimer: null, // 本次连接时长计时器
        // ---- 返回缓存内容（断线结果补偿） ----
        replayArmed: false, // 开关：开启后下一个请求直接回缓存（用完自动关）
        replayCache: null, // { ts, model, stream, body } 最新成功响应体
        // ---- 自动引导 ----
        bootstrapPromise: null, // 单飞：引导进行中，并发请求共享同一次引导
        bootstrapAttempt: 0, // 引导尝试次数（诊断用）
        handoff: {
            armed: false, // 拦截窗口开启：页面下一次 GenerateContent 发送被拦截层认领
            suppress: false, // 只吞不发（吃掉页面重试），无需回填 ctx
            ctx: null, // { resolve } 认领成功时 resolve 通知引导方
        },
        // ---- 账号切换检测 ----
        accountPrefix: null, // service 捕获时的 /u/N/ 前缀（null = 非多账号或未捕获）
        // ---- 诊断（iOS 上"发消息仍不就绪"分步定位） ----
        diag: {
            inPageContext: true, // W === window（false = 脚本在隔离环境）
            hasUnsafeWindow: typeof unsafeWindow !== "undefined",
            makerSuiteFnCount: 0, // default_MakerSuite 上函数属性数量
            hookCandidateKeys: [], // 源码匹配候选 key
            hookInstalled: false,
            sawGenerate: false, // fetch/XHR 捕获见过 GenerateContent
            sawGenerateTs: 0,
            serviceCapturedTs: 0, // 最近一次 service 捕获时间
            lastScanTs: 0,
            scanCount: 0,
        },
    };

    // 更新检查结果：null=未检查，"checking"=检查中，"latest"=已是最新，"X.Y.Z"=远端新版本号
    let updateInfo = null;

    function waaCapturedHeaders() {
        return W.__pgWaaHeaders || null;
    }
    // ==================== 请求头：合并 + 持久化 ====================
    // WAA service 是页面活对象，无法序列化，刷新后必须靠页面再发一次请求；
    // 但请求头（x-goog-api-key 等）是纯字符串，可以持久化并在刷新后恢复。

    function persistWaa() {
        const h = waaCapturedHeaders();
        if (!h || !h["x-goog-api-key"]) return; // 没有关键头不落盘，避免覆盖好记录
        try {
            const ts = Date.now();
            gmStore.set(
                WAA_STORE_KEY,
                JSON.stringify({
                    ts,
                    headers: h,
                    snapshotKey: state.waaSnapshotKey,
                    // 捕获时的账号前缀：恢复时校验（跨账号记录弃用），
                    // 防止旧账号的 x-goog-authuser/tier 头被误当现账号值
                    accountPrefix: accountPathPrefix(),
                })
            );
            state.waaPersistedTs = ts;
        } catch (_) {}
    }

    function loadPersistedWaa() {
        try {
            const s = JSON.parse(gmStore.get(WAA_STORE_KEY, "null"));
            if (s && s.headers && Date.now() - s.ts < WAA_PERSIST_TTL) return s;
        } catch (_) {}
        return null;
    }

    // 持久记录对当前账号是否可用：捕获时的账号前缀与当前一致才可信。
    // 跨账号残留记录里的 x-goog-authuser / tier 是别的账号的值，直接
    // 采纳会把请求头推成别人的账号索引/订阅
    function persistedWaaForCurrentAccount() {
        const p = loadPersistedWaa();
        if (!p) return null;
        if ((p.accountPrefix || "") !== accountPathPrefix()) return null;
        return p;
    }

    // 合并写入：新头覆盖同名旧头，但不会丢掉已有的键（尤其 x-goog-api-key）
    function setCapturedHeaders(h) {
        if (!h || !Object.keys(h).length) return;
        W.__pgWaaHeaders = { ...(W.__pgWaaHeaders || {}), ...h };
        // 捕获到的头带账号语义（x-goog-authuser/tier/Authorization 与
        // 发送账号绑定）：记录捕获时的前缀，供路由钩子比对作废。
        // hook 路径（onSnapshotHit）重复赋值无害
        state.accountPrefix = accountPathPrefix();
        persistWaa();
    }

    // 取可用请求头：内存优先；内存里没有关键头时回退持久化记录
    // （仅当持久记录捕获时与当前同账号——跨账号记录里的
    // x-goog-authuser/tier 不可用）
    function getHeaders() {
        const live = waaCapturedHeaders();
        if (live && live["x-goog-api-key"]) return live;
        const p = persistedWaaForCurrentAccount();
        if (p) {
            W.__pgWaaHeaders = { ...p.headers, ...(live || {}) };
            return W.__pgWaaHeaders;
        }
        return live;
    }

    // ==================== UI 面板（Shadow DOM，样式与页面隔离） ====================
    // 设计目标：新手一眼看懂"现在该做什么"——顶部状态横幅 + 3 步清单，
    // 大按钮、大字号（手机友好），Key 在面板内输入（不弹 prompt），日志可复制。

    let panelEl = null; // Shadow DOM 宿主（fixed 定位，可拖动）
    const ui = {};
    let panelCollapsed = false;
    let keyEditorOpen = false;
    let logOpen = false;
    const notice = { text: "", level: "info", ts: 0 };

    const PANEL_CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }
.wrap {
  --bg: #0f1217; --card: #161a21; --raise: #1d222b; --line: #252b36; --fg: #e7eaf0; --muted: #7b8494;
  --accent: #6aa9ff; --ok: #3ddc97; --warn: #f2b84b; --err: #ff6b6b; --in: #7fb0ff; --out: #e8b05a;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font: 12px/1.45 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  color: var(--fg); -webkit-text-size-adjust: 100%;
}
@media (prefers-color-scheme: light) {
  .wrap { --bg: #fbfbfd; --card: #f2f4f8; --raise: #e9edf4; --line: #dfe3ec; --fg: #171a22; --muted: #667085;
    --accent: #2f5fe0; --ok: #0d9467; --warn: #a9690c; --err: #d02f3c; --in: #2f5fe0; --out: #b0620a; }
}
.card {
  width: min(380px, calc(100vw - 16px)); background: var(--bg);
  border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
  box-shadow: 0 14px 40px rgba(0,0,0,.38);
}
.head {
  display: flex; align-items: center; gap: 8px; padding: 10px 8px 10px 14px;
  background: var(--card); border-bottom: 1px solid var(--line);
  cursor: grab; user-select: none; -webkit-user-select: none; touch-action: none;
}
.title { font-weight: 650; font-size: 13px; letter-spacing: .2px; }
.ver { color: var(--muted); font: 10.5px var(--mono); }
.st { flex: 1; min-width: 0; text-align: right; color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.dot.ok { background: var(--ok); box-shadow: 0 0 0 3px rgba(61,220,151,.18); }
.dot.warn { background: var(--warn); box-shadow: 0 0 0 3px rgba(242,184,75,.18); }
.dot.info { background: var(--accent); box-shadow: 0 0 0 3px rgba(106,169,255,.2); }
.dot.err { background: var(--err); box-shadow: 0 0 0 3px rgba(255,107,107,.18); }
.ib {
  flex: none; width: 26px; height: 26px; border: 0; border-radius: 7px;
  background: transparent; color: var(--muted); font-size: 15px; line-height: 1; cursor: pointer;
}
.ib:hover { background: var(--raise); color: var(--fg); }
.body {
  padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 8px;
  max-height: min(80vh, 680px); overflow-y: auto; overscroll-behavior: contain;
}
.steps { display: flex; gap: 6px; }
.step {
  flex: 1; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 5px 6px; border-radius: 7px; background: var(--card); font-size: 11.5px; white-space: nowrap;
  border: 1px solid var(--line);
}
.step i { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--line); }
.step b { flex: none; font-weight: 600; color: var(--muted); }
.step.done i { background: var(--ok); } .step.done b { color: var(--fg); }
.step.cur { border-color: var(--warn); } .step.cur i { background: var(--warn); } .step.cur b { color: var(--fg); }
.hint { color: var(--muted); font-size: 11px; }
.klabel { color: var(--muted); font-size: 11px; }
.msg { color: var(--muted); font-size: 11.5px; padding: 0 2px; }
.notice, .updatebox {
  display: none; align-items: flex-start; gap: 4px; padding: 6px 4px 6px 10px;
  border-radius: 8px; font-size: 11.5px; background: var(--card); border-left: 3px solid var(--muted);
}
.notice.ok { border-color: var(--ok); } .notice.err { border-color: var(--err); } .notice.warn { border-color: var(--warn); }
.updatebox { align-items: center; border-color: var(--accent); padding-right: 6px; }
.utext { flex: 1; } .ntext { flex: 1; min-width: 0; padding-top: 3px; white-space: pre-wrap; word-break: break-word; max-height: 110px; overflow-y: auto; }
.keybox { display: none; flex-direction: column; gap: 6px; }
.keyrow { display: flex; gap: 6px; }
.input {
  flex: 1; min-width: 0; height: 32px; padding: 0 10px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--card); color: var(--fg); font: inherit; font-size: 16px;
}
.input:focus { outline: 1px solid var(--accent); }
.btn {
  height: 30px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--card); color: var(--fg); font: inherit; font-weight: 500; cursor: pointer; white-space: nowrap;
}
.btn:hover { border-color: var(--muted); background: var(--raise); }
.btn:focus-visible, .tg:focus-visible, .ib:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn.ghost { background: transparent; border-color: transparent; color: var(--muted); }
.btn.ghost:hover { color: var(--fg); }
.btn.sm { height: 24px; padding: 0 8px; font-size: 11px; border-radius: 6px; }
.btn.full { width: 100%; }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.rhint { margin-top: -4px; color: var(--muted); font-size: 10.5px; text-align: center; }
.grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.acct { position: relative; }
.acct > .btn { width: 100%; }
.acct-menu {
  display: none; position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 30;
  grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 6px;
  background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 6px 20px rgba(0,0,0,.35);
}
.acct.open .acct-menu { display: grid; }
.acct-menu .abtn {
  height: 34px; padding: 0 8px; border: 1px solid var(--line); border-radius: 7px;
  background: var(--card); color: var(--fg); font: inherit; font-size: 11px;
  display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 0; cursor: pointer; white-space: nowrap; font-variant-numeric: tabular-nums;
}
.acct-menu .abtn:hover:not(:disabled) { border-color: var(--muted); }
.acct-menu .abtn[aria-current="true"] { border-color: var(--accent); background: var(--accent); color: #fff; cursor: default; }
.acct-menu .abtn i { font-style: normal; font-size: 9px; opacity: .8; }
.tgs { display: flex; gap: 6px; }
.tg {
  flex: 1; min-width: 0; white-space: nowrap; display: flex; align-items: center; justify-content: center; gap: 6px; height: 28px;
  border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--muted);
  font: inherit; font-size: 11px; cursor: pointer;
}
.tg i { width: 6px; height: 6px; border-radius: 50%; background: var(--line); transition: background .15s; }
.tg[aria-checked="true"] { color: var(--fg); border-color: var(--ok); }
.tg[aria-checked="true"] i { background: var(--ok); }
.tg:disabled { opacity: .35; cursor: not-allowed; }
.metrics {
  display: grid; grid-template-columns: repeat(4, auto); justify-content: space-between; gap: 4px 12px;
  padding: 8px 12px; background: var(--card); border: 1px solid var(--line); border-radius: 10px;
}
.metric { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.m-label { font-size: 10.5px; color: var(--muted); white-space: nowrap; }
.m-value { font: 600 16px/1.25 var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.metric.ok .m-value { color: var(--ok); } .metric.err .m-value { color: var(--err); }
.m-value.time { font-size: 13px; line-height: 20px; color: var(--muted); font-weight: 500; }
.acthead { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 6px; gap: 8px; }
.acthead-title { font-weight: 650; font-size: 12px; }
.actcount { font-size: 11px; color: var(--muted); margin-left: 6px; }
.actsum { flex: 1; text-align: right; font: 10.5px var(--mono); color: var(--muted); white-space: nowrap; }
.actsum .i { color: var(--in); } .actsum .o { color: var(--out); }
.act-scroll { max-height: 280px; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 6px; }
.act-item { background: var(--card); border: 1px solid var(--line); border-left: 3px solid var(--ok); border-radius: 9px; padding: 7px 10px 8px; }
.act-item.err { border-left-color: var(--err); }
.act-item.cancel { border-left-color: var(--muted); }
.act-l1, .act-l2 { display: flex; align-items: center; gap: 8px; min-width: 0; }
.act-l2 { margin-top: 3px; font-size: 11px; color: var(--muted); }
.act-model { flex: 1; min-width: 0; font-weight: 600; font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.act-time { flex: none; font: 10.5px var(--mono); color: var(--muted); }
.act-tag { flex: none; padding: 0 6px; border-radius: 999px; font-size: 10.5px; font-weight: 600; line-height: 17px; }
.act-tag.err { background: rgba(255,107,107,.15); color: var(--err); }
.act-tag.cancel { background: var(--raise); color: var(--muted); }
.act-mode { flex: none; padding: 0 6px; border-radius: 5px; background: var(--raise); line-height: 17px; font-size: 10.5px; }
.act-io { display: inline-flex; align-items: baseline; gap: 4px; white-space: nowrap; }
.act-io b { font: 500 11px var(--mono); font-variant-numeric: tabular-nums; }
.act-io.in b { color: var(--in); } .act-io.out b { color: var(--out); }
.act-io.dim b { color: var(--muted); }
.act-dur { margin-left: auto; flex: none; font: 11px var(--mono); font-variant-numeric: tabular-nums; }
.act-detail-btn { flex: none; border: 0; background: transparent; color: var(--err); font-size: 10.5px; cursor: pointer; padding: 0; text-decoration: underline; }
.act-empty { padding: 18px 0; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 9px; }
.act-error-detail { margin-top: 7px; padding-top: 7px; border-top: 1px dashed var(--line); }
.act-error-detail[hidden] { display: none; }
.act-error-meta { display: grid; grid-template-columns: 56px minmax(0, 1fr); margin: 0; gap: 2px 8px; font-size: 11px; }
.act-error-meta dt { color: var(--muted); } .act-error-meta dd { margin: 0; overflow-wrap: anywhere; }
.act-error-body-label { margin-top: 6px; color: var(--muted); font-size: 10.5px; }
.act-error-body {
  max-height: 120px; margin: 4px 0 0; padding: 6px; overflow: auto; border: 1px solid var(--line); border-radius: 6px;
  background: var(--bg); font: 10.5px/1.5 var(--mono); white-space: pre-wrap; word-break: break-word;
}
.foot { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 11px; }
.logbox { display: none; flex-direction: column; gap: 6px; }
.logbar { display: flex; gap: 6px; }
.loglist {
  max-height: 160px; overflow-y: auto; padding: 6px 8px; border-radius: 8px; background: var(--card);
  font: 10.5px/1.55 var(--mono); word-break: break-all;
}
.ll.err { color: var(--err); } .ll.ok { color: var(--ok); } .ll.warn { color: var(--warn); }
.pill {
  display: none; align-items: center; gap: 8px; padding: 7px 12px; border-radius: 999px;
  background: var(--bg); border: 1px solid var(--line); box-shadow: 0 6px 20px rgba(0,0,0,.35);
  font-weight: 600; font-size: 12px; cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: none;
}
.body, .act-scroll, .loglist { scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.body { overflow-x: hidden; }
.body::-webkit-scrollbar, .act-scroll::-webkit-scrollbar { width: 6px; }
.body::-webkit-scrollbar-thumb, .act-scroll::-webkit-scrollbar-thumb { background: var(--line); border-radius: 3px; }
/* 窄屏：不压缩内容，改为元素换行/纵向堆叠 + 整个面板纵向滚动 */
@media (max-width: 420px) {
  .body { max-height: 78vh; max-height: 78dvh; }
  .act-scroll { max-height: none; overflow: visible; }
  .metrics { grid-template-columns: repeat(2, 1fr); }
  .grid4 { grid-template-columns: repeat(2, 1fr); }
  .tgs, .steps { flex-wrap: wrap; }
  .tg { flex: 1 1 45%; }
  .act-l2 { flex-wrap: wrap; row-gap: 4px; }
  .act-dur { margin-left: 0; }
  .acthead { flex-wrap: wrap; }
  .actsum { order: 3; flex-basis: 100%; text-align: left; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

    // 轻量建元素工具：h("div", {class, text, onclick, ...属性}, ...子节点)
    function h(tag, props, ...kids) {
        const el = document.createElement(tag);
        if (props) {
            for (const [k, v] of Object.entries(props)) {
                if (v == null || v === false) continue; // 布尔/空属性：false 与 null 均不设置
                if (k === "class") el.className = v;
                else if (k === "text") el.textContent = v;
                else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
                else el.setAttribute(k, v === true ? "" : String(v));
            }
        }
        for (const kid of kids.flat()) {
            if (kid == null || kid === false) continue;
            el.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
        }
        return el;
    }

    function fmtTime(ts) {
        try {
            return new Date(ts).toLocaleTimeString();
        } catch {
            return "?";
        }
    }

    // 把关键日志提炼成面板里的"最近提示"（新手不用翻日志）。
    // ✅ 成功 / ❌ ✖ 失败 / ⚠ ⏭ 警告；缩进行（排查步骤）并入上一条提示。
    function captureNotice(msg) {
        const now = Date.now();
        if (/^\s{2,}/.test(msg)) {
            if (notice.text && now - notice.ts < 2500) {
                notice.text = (notice.text + "\n" + msg.trim()).slice(0, 700);
                notice.ts = now;
            }
            return;
        }
        const m = msg.match(/^(✅|❌|✖|⚠|⏭)\s*/);
        if (!m) return;
        const sym = m[1];
        notice.level = sym === "✅" ? "ok" : sym === "❌" || sym === "✖" ? "err" : "warn";
        notice.text = msg.slice(m[0].length).slice(0, 300);
        notice.ts = now;
    }

    function saveKey(raw) {
        const key = String(raw || "").trim();
        const changed = key !== cfg.apiKey;
        cfg.apiKey = key;
        saveCfg();
        if (!key) log("⚠ API Key 已清空");
        else if (!key.startsWith("cat-")) log("⚠ Key 通常以 cat- 开头，请确认没有粘贴错");
        else log("✅ API Key 已保存");
        keyEditorOpen = false;
        if (changed && state.ws) disconnectWs("Key 已更改，重新连接");
        updatePanel();
        scheduleConnect(0);
    }

    // 复制文本到剪贴板：优先 navigator.clipboard，失败回退 execCommand
    function copyText(text, okMsg) {
        const ok = () => log(okMsg);
        const fallback = () => {
            try {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.style.cssText = "position:fixed;left:0;top:0;opacity:0;";
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                ta.remove();
                ok();
            } catch {
                log("⚠ 复制失败，请长按文字手动选择复制");
            }
        };
        try {
            navigator.clipboard.writeText(text).then(ok, fallback);
        } catch {
            fallback();
        }
    }

    // ==================== 使用记录（活动表，持久化） ====================
    // 记录每次请求：时间/模型/方式/结果/耗时，失败行可展开错误详情。
    // 表格与累计计数都持久化到 GM 存储，页面跳转（自动引导整页跳转
    // 临时会话页）/刷新后恢复，掉线期间完成的请求不丢账。

    function loadActivities() {
        try {
            const raw = JSON.parse(gmStore.get(ACTIVITY_STORE_KEY, "null"));
            if (Array.isArray(raw)) {
                state.activities = raw.slice(0, MAX_ACTIVITY_ROWS).map((a) => ({
                    ...a,
                    errorExpanded: false,
                }));
                state.activitySeq = state.activities.reduce(
                    (m, a) => Math.max(m, Number(a.id) || 0),
                    0
                );
            }
        } catch (_) {
            state.activities = [];
        }
        try {
            const s = JSON.parse(gmStore.get(ACTIVITY_STATS_KEY, "null"));
            if (s && typeof s === "object") {
                state.successCount = Number(s.success) || 0;
                state.failureCount = Number(s.failure) || 0;
            }
        } catch (_) {}
    }

    function saveActivities() {
        try {
            // errorExpanded 是纯 UI 态，不落盘
            gmStore.set(
                ACTIVITY_STORE_KEY,
                JSON.stringify(
                    state.activities.map(({ errorExpanded, ...rest }) => rest)
                )
            );
        } catch (_) {}
    }

    function saveActivityStats() {
        try {
            gmStore.set(
                ACTIVITY_STATS_KEY,
                JSON.stringify({ success: state.successCount, failure: state.failureCount })
            );
        } catch (_) {}
    }

    // 记录一条请求结果并重渲染。info 是展示用附加信息（字节/块数等）
    function addActivity(act) {
        state.activities.unshift({
            ...act,
            id: ++state.activitySeq,
            message: String(act.message || "").slice(0, MAX_ACTIVITY_MSG_LENGTH),
            errorExpanded: false,
        });
        if (state.activities.length > MAX_ACTIVITY_ROWS) {
            state.activities.length = MAX_ACTIVITY_ROWS;
        }
        saveActivities();
        renderActivities();
    }

    function clearActivities() {
        state.activities = [];
        state.successCount = 0;
        state.failureCount = 0;
        saveActivities();
        saveActivityStats();
        renderActivities();
        updatePanel();
    }

    function fmtDuration(ms) {
        const v = Math.max(0, Math.round(ms));
        if (v < 10000) return v + "ms";
        if (v < 60000) return (v / 1000).toFixed(1) + "s";
        return Math.round(v / 1000) + "s";
    }

    // 字节数（UTF-8 实际字节，而非 JS 字符数）
    const utf8Encoder = new TextEncoder();
    function utf8Len(str) {
        try { return utf8Encoder.encode(String(str == null ? "" : str)).length; } catch (_) { return String(str || "").length; }
    }

    function fmtBytes(n) {
        if (typeof n !== "number" || !isFinite(n) || n < 0) return "-";
        if (n < 1024) return n + " B";
        if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 2 : 1) + " KB";
        return (n / 1024 / 1024).toFixed(2) + " MB";
    }

    function fmtClock(ts) {
        try {
            return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
        } catch {
            return "?";
        }
    }

    function renderActivities() {
        if (!ui.activityBody) return;
        // 兼顾老旧 WebView（不支持 replaceChildren）：退回 innerHTML 清空 + append
        const setRows = (nodes) => {
            if (typeof ui.activityBody.replaceChildren === "function") {
                ui.activityBody.replaceChildren(...nodes);
            } else {
                ui.activityBody.innerHTML = "";
                for (const n of nodes) ui.activityBody.appendChild(n);
            }
        };
        if (!state.activities.length) {
            setRows([h("div", { class: "act-empty", text: "暂无请求" })]);
            ui.clearActivityBtn.disabled = true;
            return;
        }
        ui.clearActivityBtn.disabled = false;
        const rows = [];
        for (const act of state.activities) {
            const cls = act.result === "success" ? "" : act.result === "cancelled" ? " cancel" : " err";
            const io = (kind, label, v) =>
                h("span", { class: "act-io " + kind + (typeof v === "number" ? "" : " dim") }, label, h("b", { text: fmtBytes(v) }));
            const l1 = h("div", { class: "act-l1" },
                h("span", { class: "act-model", title: act.model || "", text: act.model || "-" }),
                act.result === "error" ? h("span", { class: "act-tag err", text: "失败" }) : null,
                act.result === "cancelled" ? h("span", { class: "act-tag cancel", text: "取消" }) : null,
                h("span", { class: "act-time", text: fmtClock(act.at) })
            );
            const l2 = h("div", { class: "act-l2" },
                h("span", { class: "act-mode", text: act.stream ? "流式" : "非流式" }),
                io("in", "输入", act.inBytes),
                io("out", "输出", act.outBytes),
                act.error
                    ? h("button", {
                        class: "act-detail-btn", type: "button",
                        text: act.errorExpanded ? "收起" : "详情",
                        "aria-expanded": String(!!act.errorExpanded),
                        onclick: () => { act.errorExpanded = !act.errorExpanded; renderActivities(); },
                    })
                    : null,
                h("span", { class: "act-dur", text: fmtDuration(act.durationMS || 0) })
            );
            const item = h("div", { class: "act-item" + cls, title: act.result === "error" ? act.message || "" : null }, l1, l2);

            if (act.error) {
                const detail = h("div", { class: "act-error-detail", hidden: act.errorExpanded ? null : "" });
                const meta = h("dl", { class: "act-error-meta" });
                const fields = [
                    ["请求 ID", act.requestID],
                    ["状态码", String(act.error.status || "-")],
                    ["错误码", act.error.code || "-"],
                    ["错误信息", act.error.message || "-"],
                ];
                for (const [label, value] of fields) {
                    meta.appendChild(h("dt", { text: label }));
                    meta.appendChild(h("dd", { text: value }));
                }
                detail.appendChild(meta);
                if (act.error.body) {
                    detail.appendChild(h("div", { class: "act-error-body-label", text: "原始响应" }));
                    detail.appendChild(h("pre", { class: "act-error-body", text: act.error.body }));
                }
                item.appendChild(detail);
            }
            rows.push(item);
        }
        setRows(rows);
    }

    // 本次连接时长计时器（registered 启动 / 断开停止）
    function startDurationTimer() {
        stopDurationTimer();
        const update = () => {
            const elapsed = Math.max(0, Date.now() - state.connectedAt);
            const secs = Math.floor(elapsed / 1000);
            const hh = String(Math.floor(secs / 3600)).padStart(2, "0");
            const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, "0");
            const ss = String(secs % 60).padStart(2, "0");
            if (ui.duration) ui.duration.textContent = `${hh}:${mm}:${ss}`;
        };
        update();
        state.durationTimer = setInterval(update, 1000);
    }

    function stopDurationTimer() {
        if (state.durationTimer !== null) {
            clearInterval(state.durationTimer);
            state.durationTimer = null;
        }
        if (state.wsStatus !== "connected" && ui.duration) ui.duration.textContent = "00:00:00";
    }

    // ==================== 返回缓存内容（断线结果补偿） ====================
    // 场景：页面侧请求已成功完成，但客户端到后端的 WS 中途断开，后端
    // （重连/新连接）又发来请求——把刚才的成功响应直接回传，避免用户
    // 白白丢一次已生成的回答。
    // 只缓存最新一条成功响应体（新的顶替旧的）；面板「⚡ 返回缓存内容」
    // 是一次性开关：开启后下一个请求不再发上游，直接回缓存，随即自动关闭。

    function loadReplayCache() {
        try {
            const c = JSON.parse(gmStore.get(REPLAY_CACHE_KEY, "null"));
            if (c && typeof c === "object" && typeof c.body === "string") {
                state.replayCache = c;
            }
        } catch (_) {
            state.replayCache = null;
        }
    }

    // 成功响应落缓存（超过体积上限的不缓存）
    function saveReplayCache(model, stream, body) {
        const raw = String(body || "");
        if (!raw || raw.length > REPLAY_CACHE_MAX_BYTES) return;
        state.replayCache = {
            ts: Date.now(),
            model: String(model || ""),
            stream: !!stream,
            body: raw,
        };
        try {
            gmStore.set(REPLAY_CACHE_KEY, JSON.stringify(state.replayCache));
        } catch (_) {}
    }

    // 一次性开关操作
    function armReplay() {
        state.replayArmed = true;
        updatePanel();
    }

    function disarmReplay() {
        if (!state.replayArmed) return;
        state.replayArmed = false;
        updatePanel();
    }

    // handleRequest 入口检查：armed 且有缓存 → 直接回传，返回 true（已处理）
    // 分流式（按 4KB 切块合成 stream-chunk + stream-end）与非流式（整包
    // response）两种回传形态，与真实路径一致，后端无需任何配合改动。
    function tryReplayRequest(requestId, stream) {
        const c = state.replayCache;
        if (!state.replayArmed || !c) return false;
        state.replayArmed = false; // 一次性：无论成败，用完即关
        const rid = String(requestId || "").slice(0, 8);
        const age = Math.round((Date.now() - c.ts) / 1000);
        log(`⚡ 返回缓存内容：直接回传缓存响应 ${rid}（${c.body.length} 字节，缓存于 ${age}s 前）`);
        try {
            if (stream) {
                const CHUNK = 4 * 1024;
                for (let i = 0; i < c.body.length; i += CHUNK) {
                    deliverResult({
                        type: "stream-chunk",
                        requestId,
                        chunkBody: c.body.slice(i, i + CHUNK),
                    });
                }
                deliverResult({ type: "stream-end", requestId, status: 200 });
            } else {
                deliverResult({
                    type: "response",
                    requestId,
                    status: 200,
                    rawResponse: c.body,
                });
            }
            log(`⚡ 缓存内容已回传 ${rid}，开关已自动关闭`);
        } catch (e) {
            log(`⚠ 回传缓存异常: ${(e && e.message) || e}`);
        }
        updatePanel();
        return true;
    }

    function openKeyEditor() {
        if (!panelEl) {
            // 面板还没建好（页面加载中）：退回系统弹窗
            const key = prompt("Catiecli API Key (cat- 前缀):", cfg.apiKey);
            if (key !== null) saveKey(key);
            return;
        }
        if (panelEl.style.display === "none") panelEl.style.display = "block";
        if (panelCollapsed) setCollapsed(false);
        keyEditorOpen = true;
        ui.keyInput.value = cfg.apiKey || "";
        updatePanel();
        setTimeout(() => {
            try { ui.keyInput.focus(); } catch (_) {}
        }, 60);
    }

    function copyLogs() {
        copyText(logs.join("\n"), "✅ 日志已复制到剪贴板");
    }

    function setCollapsed(v) {
        panelCollapsed = !!v;
        try { gmStore.set(PANEL_COLLAPSED_KEY, panelCollapsed); } catch (_) {}
        ui.card.style.display = panelCollapsed ? "none" : "block";
        ui.pill.style.display = panelCollapsed ? "flex" : "none";
        requestAnimationFrame(() => {
            if (!panelEl) return;
            const r = panelEl.getBoundingClientRect();
            applyPanelPos(r.left, r.top);
        });
    }

    function buildPanel() {
        panelCollapsed = gmStore.get(PANEL_COLLAPSED_KEY, false) === true;
        // 手机默认收起
        if (isMobileLike() && gmStore.get(PANEL_COLLAPSED_KEY, undefined) === undefined) {
            panelCollapsed = true;
        }

        panelEl = document.createElement("div");
        panelEl.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;display:block;";
        const root = panelEl.attachShadow({ mode: "open" });
        const style = document.createElement("style");
        style.textContent = PANEL_CSS;
        root.appendChild(style);
        const wrap = h("div", { class: "wrap" });
        root.appendChild(wrap);

        // 收起态小圆标
        ui.pillDot = h("span", { class: "dot" });
        ui.pillText = h("span", { text: "Catiecli" });
        ui.pill = h("div", { class: "pill", title: "点击展开（可拖动）" }, ui.pillDot, ui.pillText);

        // 标题栏：状态点 + 名称 + 版本 + 一句状态
        ui.headDot = h("span", { class: "dot" });
        ui.headSt = h("span", { class: "st" });
        ui.head = h(
            "div", { class: "head" },
            ui.headDot,
            h("span", { class: "title", text: "Catiecli" }),
            h("span", { class: "ver", text: "v" + CLIENT_VERSION }),
            ui.headSt,
            h("button", { class: "ib", title: "收起", "aria-label": "收起", text: "–", onclick: () => setCollapsed(true) })
        );

        // 三步进度（小胶囊：**Key** / **引导** / **连接**，省纵向空间）
        ui.steps = ["Key", "引导", "连接"].map((t) => {
            const row = h("div", { class: "step" }, h("i"), h("b", { text: t }));
            return { row };
        });
        ui.msg = h("div", { class: "msg" });

        ui.updateVersion = h("b");
        ui.updateBox = h(
            "div", { class: "updatebox" },
            h("div", { class: "utext" }, "新版本 ", ui.updateVersion),
            h("button", { class: "btn sm primary", text: "更新", onclick: () => openUpdatePage() })
        );

        ui.noticeText = h("div", { class: "ntext" });
        ui.notice = h(
            "div", { class: "notice" }, ui.noticeText,
            h("button", { class: "ib", "aria-label": "关闭", text: "×", onclick: () => { notice.text = ""; updatePanel(); } })
        );

        // Key 输入（面板内）
        ui.keyInput = h("input", {
            class: "input", type: "password", placeholder: "cat-xxxxxxxx",
            autocomplete: "off", spellcheck: "false", autocapitalize: "off",
        });
        ui.keyInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") saveKey(ui.keyInput.value);
        });
        const eye = h("button", {
            class: "btn", text: "显示",
            onclick: () => {
                const show = ui.keyInput.type === "password";
                ui.keyInput.type = show ? "text" : "password";
                eye.textContent = show ? "隐藏" : "显示";
            },
        });
        ui.keyBox = h(
            "div", { class: "keybox" },
            h("div", { class: "klabel", text: "粘贴你的 API Key（cat- 开头）" }),
            h("div", { class: "keyrow" }, ui.keyInput, eye),
            h(
                "div", { class: "keyrow" },
                h("button", { class: "btn primary", style: "flex:1", text: "保存", onclick: () => saveKey(ui.keyInput.value) }),
                h("button", { class: "btn", text: "取消", onclick: () => { keyEditorOpen = false; updatePanel(); } })
            )
        );

        // 操作区
        ui.pushBtn = h("button", {
            class: "btn primary full", text: "☁ 推送 Cookie 到云端",
            onclick: () => pushCookiesToCloud().catch((e) => log("推送异常: " + ((e && e.message) || e))),
        });
        ui.pushHint = h("div", { class: "hint" });
        ui.keyBtn = h("button", { class: "btn", text: "Key", onclick: openKeyEditor });
        ui.reconnectBtn = h("button", {
            class: "btn", text: "重连", title: "断开并重新连接服务器",
            onclick: () => { disconnectWs("手动重连"); scheduleConnect(0); },
        });
        ui.replayBtn = h("button", {
            class: "btn", text: "缓存",
            onclick: () => {
                if (!state.replayCache) {
                    log("⚠ 暂无缓存响应（成功响应会自动缓存最新一条）");
                    updatePanel();
                    return;
                }
                if (state.replayArmed) {
                    disarmReplay();
                    log("⚡ 已取消：下一个请求恢复正常处理");
                } else {
                    armReplay();
                    log("⚡ 已开启：下一个请求将直接返回缓存内容（用完自动关闭）");
                }
            },
        });

        // 快速换号：下拉选 Google 多账号（/u/N/），当前账号高亮不可点
        ui.acctBtn = h("button", { class: "btn", text: "换号", title: "切换 Google 多账号（/u/N/ 索引），切到目标账号的临时会话页" });
        ui.acctOptions = [];
        for (let i = 0; i <= ACCOUNT_SWITCH_MAX_INDEX; i++) {
            const opt = h("button", {
                class: "abtn", type: "button", "data-index": String(i),
                onclick: () => { ui.acctWrap.classList.remove("open"); switchAccount(i); },
            }, h("span", { text: String(i) }));
            ui.acctOptions.push(opt);
        }
        ui.acctMenu = h("div", { class: "acct-menu", role: "group", "aria-label": "选择 Google 账号" }, ui.acctOptions);
        ui.acctWrap = h("div", { class: "acct" }, ui.acctBtn, ui.acctMenu);
        ui.acctBtn.addEventListener("click", () => {
            updateAccountMenu();
            ui.acctWrap.classList.toggle("open");
        });
        // 点菜单外关闭
        document.addEventListener("pointerdown", (ev) => {
            if (!ui.acctWrap) return;
            if (ui.acctWrap.classList.contains("open") &&
                !(ev.composedPath && ev.composedPath().includes(ui.acctWrap))) {
                ui.acctWrap.classList.remove("open");
            }
        });

        // 指标
        ui.replayHint = h("div", { class: "rhint" });
        ui.activeMetric = h("strong", { class: "m-value", text: "0" });
        ui.successMetric = h("strong", { class: "m-value", text: "0" });
        ui.failureMetric = h("strong", { class: "m-value", text: "0" });
        ui.duration = h("strong", { class: "m-value time", text: "00:00:00" });
        const metric = (cls, label, el) => h("div", { class: "metric " + cls }, h("span", { class: "m-label", text: label }), el);
        ui.metrics = h(
            "div", { class: "metrics" },
            metric("", "进行中", ui.activeMetric),
            metric("ok", "完成", ui.successMetric),
            metric("err", "失败", ui.failureMetric),
            metric("", "连接时长", ui.duration)
        );

        // 保活开关
        const tog = (text, tip, onclick) =>
            h("button", { class: "tg", role: "switch", "aria-checked": "false", title: tip, onclick }, h("i"), text);
        ui.pipBtn = tog("🪟 小窗保活", "弹出画中画小窗，浏览器会把本页当作前台", () => togglePip());
        ui.audioBtn = tog("🔊 后台音频", "近无声循环播放（16Hz 低频正弦，听不见），浏览器不会冻结本标签页", () => toggleAudio());
        ui.screenBtn = tog("🔆 屏幕常亮", "防止锁屏（较耗电，需 iOS 16.4+；需先开后台音频）", () => toggleScreenLock());

        // 最近请求
        ui.activityBody = h("div", { class: "act-scroll" });
        ui.clearActivityBtn = h("button", { class: "btn sm ghost", text: "清空", disabled: "disabled", onclick: clearActivities });
        ui.activityCount = h("span", { class: "actcount" });
        ui.activitySum = h("span", { class: "actsum" });
        ui.activityCard = h(
            "div", null,
            h(
                "div", { class: "acthead" },
                h("div", null, h("span", { class: "acthead-title", text: "最近请求" }), ui.activityCount),
                ui.activitySum,
                ui.clearActivityBtn
            ),
            ui.activityBody
        );

        // 底栏 + 日志
        ui.stats = h("span");
        ui.logToggle = h("button", { class: "btn sm ghost", text: "▸ 查看日志", onclick: () => { logOpen = !logOpen; updatePanel(); } });
        ui.logList = h("div", { class: "loglist" });
        ui.logBox = h(
            "div", { class: "logbox" },
            h("div", { class: "logbar" },
                h("button", { class: "btn sm", text: "复制", onclick: copyLogs }),
                h("button", { class: "btn sm", text: "清空", onclick: () => { logs.length = 0; updatePanel(); } })),
            ui.logList
        );

        ui.body = h(
            "div", { class: "body" },
            h("div", { class: "steps" }, ui.steps.map((s) => s.row)),
            ui.msg, ui.updateBox, ui.notice, ui.keyBox,
            ui.pushBtn, ui.pushHint,
            h("div", { class: "grid4" }, ui.keyBtn, ui.reconnectBtn, ui.replayBtn, ui.acctWrap),
            ui.replayHint,
            ui.metrics,
            h("div", { class: "klabel", text: "防止被浏览器冻结（可单独开关，也可同时开启）" }),
            h("div", { class: "tgs" }, ui.pipBtn, ui.audioBtn, ui.screenBtn),
            h("div", { class: "hint", text: "手机浏览器不支持小窗时，请用后台音频；屏幕常亮是音频保活的加成项（较耗电）。" }),
            ui.activityCard,
            h("div", { class: "foot" }, ui.stats, ui.logToggle),
            ui.logBox
        );
        ui.card = h("div", { class: "card" }, ui.head, ui.body);

        wrap.appendChild(ui.pill);
        wrap.appendChild(ui.card);
        ui.card.style.display = panelCollapsed ? "none" : "block";
        ui.pill.style.display = panelCollapsed ? "flex" : "none";

        makeDraggable(ui.head);
        makeDraggable(ui.pill, () => setCollapsed(false));
        document.documentElement.appendChild(panelEl);
        restorePanelPos();
        installPanelGuards();
        renderActivities();
        updatePanel();
    }

    function updatePanel() {
        if (!panelEl || !ui.card) return;
        const hasKey = !!cfg.apiKey;
        const headersOk = !!(getHeaders() || {})["x-goog-api-key"];
        const waaOk = state.bundleReady && state.waaReady;
        const wsOk = state.wsStatus === "connected";
        const connecting = state.wsStatus === "connecting";
        const done = [hasKey, waaOk, wsOk];
        const cur = done.indexOf(false); // -1 = 全部完成

        const masked = hasKey ? cfg.apiKey.slice(0, 8) + "…" + cfg.apiKey.slice(-4) : "";
        // 状态：level + 标题栏短句 + 下方一行提示（细节并入 msg，tooltip 保留全文）
        let level, head, sub = "";
        const tips = [
            hasKey ? "Key 已设置：" + masked : STEP_HINTS[0],
            waaOk ? "引导已完成" : !state.bundleReady ? "等待 AI Studio 页面加载完成…" : STEP_HINTS[1],
            wsOk ? "已连接服务器" : connecting ? "连接中…" : hasKey ? "未连接，正在自动重连" : STEP_HINTS[2],
        ];
        ui.steps.forEach((s, i) => {
            s.row.className = "step" + (done[i] ? " done" : i === cur ? " cur" : "");
            s.row.title = tips[i];
        });
        if (cur === -1) {
            level = "ok"; head = "一切就绪"; sub = "Key / 引导 / 连接均已就绪，请保持本页打开（建议开启下方保活，减少掉线）";
        } else if (cur === 1 && !state.bundleReady) {
            level = "info"; head = "页面加载中"; sub = "等待 AI Studio 页面完全打开";
        } else if (cur === 2) {
            level = connecting ? "info" : "warn";
            head = connecting ? "连接中" : "未连接";
            sub = connecting ? "" : "正在自动重连，也可点「重连」";
        } else {
            level = "warn"; head = STEP_TITLES[cur]; sub = tips[cur];
        }
        if (cur === 1 && state.diag.sawGenerate && !state.waaReady) {
            level = "err"; head = "hook 未命中"; sub = "请求已发出但 snapshot hook 未命中，页面可能改版，请复制日志反馈";
        } else if (cur === 1 && !state.bundleReady && promptBoxInDom()) {
            level = "err"; head = "读不到页面变量"; sub = "脚本可能运行在隔离环境，请复制日志反馈";
        } else if (cur === 1 && state.waaPersistedTs > 0 && state.bundleReady) {
            level = "info"; head = "待引导"; sub = "请求头已恢复，收到第一个请求时会自动引导";
        }
        ui.headDot.className = "dot " + level;
        ui.headSt.textContent = head;
        ui.msg.textContent = sub;
        ui.msg.style.display = sub ? "block" : "none";
        ui.pillDot.className = "dot " + level;
        ui.pillText.textContent = level === "ok" ? "已就绪" : level === "info" ? "连接中" : "需要操作";

        // 更新提示
        const hasUpdate = !!updateInfo && updateInfo !== "checking" && updateInfo !== "latest";
        ui.updateBox.style.display = hasUpdate ? "flex" : "none";
        if (hasUpdate) ui.updateVersion.textContent = "v" + updateInfo;

        // 最近提示
        if (notice.text) {
            ui.notice.style.display = "flex";
            ui.notice.className = "notice " + notice.level;
            ui.noticeText.textContent = notice.text;
        } else {
            ui.notice.style.display = "none";
        }

        // Key / 推送
        ui.keyBox.style.display = keyEditorOpen ? "flex" : "none";
        ui.keyBtn.textContent = hasKey ? "修改 Key" : "设置 Key";
        ui.keyBtn.title = hasKey ? "已设置：" + masked : "";
        ui.keyBtn.className = "btn" + (cur === 0 && !keyEditorOpen ? " primary" : "");
        ui.pushBtn.disabled = !hasKey;
        ui.pushHint.textContent = hasKey
            ? "推送后无需挂机：云端用你的 Cookie 无头执行 pggo-（Playground）模型（多账号可各推一份）"
            : "设置 Key 后即可推送（无需在页面发消息）";
        ui.pushBtn.title = hasKey
            ? "导出当前会话 Cookie 推送到云端，之后无需挂机即可使用 pggo- 模型"
            : "请先设置 cat- API Key";

        // 保活开关
        const pipOk = pipSupported();
        ui.pipBtn.setAttribute("aria-checked", keepalive.pip ? "true" : "false");
        ui.pipBtn.disabled = !pipOk;
        ui.audioBtn.setAttribute("aria-checked", keepalive.audio ? "true" : "false");
        ui.screenBtn.setAttribute("aria-checked", keepalive.screenLockOn ? "true" : "false");
        ui.screenBtn.disabled = !keepalive.audio;
        updateAccountMenu(); // 换号菜单：当前账号高亮

        // 指标
        ui.activeMetric.textContent = String(state.controllers.size);
        ui.successMetric.textContent = String(state.successCount);
        ui.failureMetric.textContent = String(state.failureCount);
        ui.activityCount.textContent = state.activities.length ? String(state.activities.length) : "";
        {
            let sumIn = 0, sumOut = 0;
            for (const a of state.activities) {
                if (typeof a.inBytes === "number") sumIn += a.inBytes;
                if (typeof a.outBytes === "number") sumOut += a.outBytes;
            }
            ui.activitySum.textContent = "";
            if (state.activities.length) {
                ui.activitySum.append("合计 入 ");
                ui.activitySum.appendChild(h("span", { class: "i", text: fmtBytes(sumIn) }));
                ui.activitySum.append(" 出 ");
                ui.activitySum.appendChild(h("span", { class: "o", text: fmtBytes(sumOut) }));
            }
        }

        // ⚡ 缓存按钮
        const c = state.replayCache;
        if (state.replayArmed) {
            ui.replayBtn.className = "btn primary";
            ui.replayBtn.textContent = "已开启";
            ui.replayBtn.title = "点击取消";
            ui.replayHint.textContent = "下一个请求将直接回传缓存，随后自动关闭";
        } else if (c) {
            const ageS = Math.round((Date.now() - c.ts) / 1000);
            const kb = c.body.length >= 1024 ? (c.body.length / 1024).toFixed(1) + "KB" : c.body.length + "B";
            ui.replayBtn.className = "btn";
            ui.replayBtn.textContent = "缓存";
            ui.replayBtn.title = "断线丢结果时开启：下一个请求直接回传缓存";
            ui.replayHint.textContent = `缓存 ${kb} · ${ageS}s 前`;
        } else {
            ui.replayBtn.className = "btn";
            ui.replayBtn.textContent = "缓存";
            ui.replayBtn.title = "暂无缓存（成功响应会自动缓存最新一条）";
            ui.replayHint.textContent = "暂无缓存";
        }

        ui.stats.textContent = `已处理 ${state.requestCount} 个请求 · 头${headersOk ? "✓" : "✗"} 服务${state.waaReady ? "✓" : "✗"}`;

        // 日志
        ui.logToggle.textContent = logOpen ? "▾ 收起日志" : "▸ 查看日志";
        ui.logBox.style.display = logOpen ? "flex" : "none";
        if (logOpen) {
            const frag = document.createDocumentFragment();
            for (const line of logs) {
                const cls = /❌|✖|失败|异常/.test(line) ? "err" : /✅|✔/.test(line) ? "ok" : /⚠|⏭|⊘/.test(line) ? "warn" : "";
                frag.appendChild(h("div", { class: "ll " + cls, text: line }));
            }
            ui.logList.replaceChildren(frag);
            ui.logList.scrollTop = ui.logList.scrollHeight;
        }
    }

    function promptBoxInDom() {
        try {
            return !!document.querySelector("ms-prompt-box");
        } catch {
            return false;
        }
    }

    // ==================== 面板位置 / 拖动 ====================

    function clampPanelPos(x, y) {
        const w = panelEl.offsetWidth;
        const hgt = panelEl.offsetHeight;
        const vw = W.innerWidth;
        const vh = W.innerHeight;
        const maxX = Math.max(PANEL_MARGIN, vw - w - PANEL_MARGIN);
        const maxY = Math.max(PANEL_MARGIN, vh - hgt - PANEL_MARGIN);
        return {
            x: Math.min(Math.max(x, PANEL_MARGIN), maxX),
            y: Math.min(Math.max(y, PANEL_MARGIN), maxY),
        };
    }

    function applyPanelPos(x, y) {
        const pos = clampPanelPos(x, y);
        panelEl.style.left = pos.x + "px";
        panelEl.style.top = pos.y + "px";
        return pos;
    }

    function restorePanelPos() {
        let saved = null;
        try {
            saved = JSON.parse(gmStore.get(PANEL_POS_KEY, "null"));
        } catch {
            saved = null;
        }
        if (
            saved &&
            typeof saved.x === "number" &&
            typeof saved.y === "number" &&
            isFinite(saved.x) &&
            isFinite(saved.y)
        ) {
            const pos = applyPanelPos(saved.x, saved.y);
            gmStore.set(PANEL_POS_KEY, JSON.stringify(pos));
        } else {
            // 默认：右下角
            applyPanelPos(
                W.innerWidth - panelEl.offsetWidth - 12,
                W.innerHeight - panelEl.offsetHeight - 12
            );
        }
    }

    // 拖动手柄（标题栏 / 收起态圆标）。onTap：没有发生位移的轻点（圆标用来展开）。
    function makeDraggable(handle, onTap) {
        let dragging = false;
        let moved = false;
        let startX = 0;
        let startY = 0;
        let origLeft = 0;
        let origTop = 0;

        handle.addEventListener("pointerdown", (ev) => {
            if (ev.pointerType === "mouse" && ev.button !== 0) return;
            if (ev.target && ev.target.closest && ev.target.closest("button, input")) return;
            dragging = true;
            moved = false;
            startX = ev.clientX;
            startY = ev.clientY;
            const rect = panelEl.getBoundingClientRect();
            origLeft = rect.left;
            origTop = rect.top;
            try { handle.setPointerCapture(ev.pointerId); } catch (_) {}
            handle.style.cursor = "grabbing";
        });

        handle.addEventListener("pointermove", (ev) => {
            if (!dragging) return;
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
            moved = true;
            applyPanelPos(origLeft + dx, origTop + dy);
        });

        const endDrag = (ev, cancelled) => {
            if (!dragging) return;
            dragging = false;
            handle.style.cursor = "";
            try { handle.releasePointerCapture(ev.pointerId); } catch (_) {}
            if (moved) {
                const rect = panelEl.getBoundingClientRect();
                const pos = applyPanelPos(rect.left, rect.top);
                gmStore.set(PANEL_POS_KEY, JSON.stringify(pos));
            } else if (!cancelled && onTap) {
                onTap();
            }
        };
        handle.addEventListener("pointerup", (ev) => endDrag(ev, false));
        handle.addEventListener("pointercancel", (ev) => endDrag(ev, true));
    }

    // 窗口缩放 / 内容高度变化（展开日志、提示变长）时，保证面板不跑出可视区
    function installPanelGuards() {
        const reclamp = () => {
            if (!panelEl || panelEl.style.display === "none") return;
            const r = panelEl.getBoundingClientRect();
            applyPanelPos(r.left, r.top);
        };
        W.addEventListener("resize", reclamp);
        try {
            new ResizeObserver(reclamp).observe(panelEl);
        } catch (_) {}
    }

    // ==================== WAA 层：hook 页面 ====================

    // snapshot(service, digest) 命中后记录 service 引用，标记引导完成。
    // ⚠ 判定保持 2.5.1 的宽松标准：实参[0] 是对象/函数即记录。曾试过
    // 严格要求 service.snapshot 为函数——实测真实 service 并不满足
    // （snapshot 属性形态与预期不符），严格校验会把真 service 全拒掉。
    function onSnapshotHit(key, args) {
        const service = args[0];
        if (service && (typeof service === "object" || typeof service === "function")) {
            W.__pgWaaService = service;
            state.diag.serviceCapturedTs = Date.now();
            // 记录捕获时的账号前缀（/u/N/），SPA 内切换账号时用于作废捕获
            state.accountPrefix = accountPathPrefix();
            persistWaa(); // 页面每次发消息都刷新持久记录
            if (!state.waaReady) {
                state.waaReady = true;
                log("✅ WAA service 已捕获（key=" + key + "），引导完成");
                updatePanel();
                scheduleConnect(0);
            }
        }
    }

    // 包装函数：保持 this、拷贝原函数自身属性、可重复包装检测。
    // 只用于包装源码匹配命中的那一个函数（不批量包装——见下方
    // "不做运行时签名识别"的注释），闭包式即可
    function wrapFn(orig, probe) {
        if (typeof orig !== "function" || orig.__pgWrapped) return orig;
        const wrapped = function (...args) {
            try { probe(args); } catch (_) {}
            return orig.apply(this, args);
        };
        try {
            Object.assign(wrapped, orig);
        } catch (_) {}
        wrapped.__pgWrapped = true;
        wrapped.__pgOrigFn = orig;
        return wrapped;
    }

    // wrap MakerSuite 的 snapshot 函数，捕获 WAA service 引用。
    // 源码特征匹配（首选）：`.snapshot({` + content——带 yield 的是未转译
    // generator，优先级最高；iOS 的 Safari 常拿到转译版 bundle（$jscomp
    // 状态机，无 yield），同样参与匹配。自检失败的 key 记入坏名单跳过。
    function installSnapshotHook() {
        const makerSuite = W.default_MakerSuite;
        if (!makerSuite) return "no_default_MakerSuite";
        state.diag.makerSuiteFnCount = Object.keys(makerSuite).filter(
            (k) => { try { return typeof makerSuite[k] === "function"; } catch (_) { return false; } }
        ).length;

        // 已装且未被页面覆盖：直接复用
        const currentKey = W.__pgWaaSnapshotKey;
        if (currentKey && makerSuite[currentKey] && makerSuite[currentKey].__pgWrapped) {
            state.waaSnapshotKey = currentKey;
            state.diag.hookInstalled = true;
            return currentKey;
        }

        const candidates = [];
        for (const key of Object.keys(makerSuite)) {
            try {
                if (typeof makerSuite[key] !== "function") continue;
                const source = makerSuite[key].toString();
                if (source.includes(".snapshot({") && source.includes("content")) {
                    // 带 yield 的是未转译 generator，优先级最高（放到队首）
                    if (source.includes("yield")) candidates.unshift(key);
                    else candidates.push(key);
                }
            } catch (_) {}
        }
        state.diag.hookCandidateKeys = candidates.slice(0, 5);
        state.diag.lastScanTs = Date.now();
        state.diag.scanCount++;

        const snapshotKey = candidates[0];
        if (!snapshotKey) return "no_snapshot_fn";
        makerSuite[snapshotKey] = wrapFn(makerSuite[snapshotKey], (args) =>
            onSnapshotHit(snapshotKey, args)
        );
        W.__pgWaaSnapshotKey = snapshotKey;
        state.waaSnapshotKey = snapshotKey;
        state.diag.hookInstalled = true;
        return snapshotKey;
    }

    // ⚠ 不做"运行时签名识别"（曾按评审建议实现过，实测在桌面端直接
    // 弄坏了页面：把 default_MakerSuite 的 2663 个函数全部换成包装函数，
    // 页面内部对函数引用做相等性比较的地方全部失配，用户消息发不出去）。
    // 现在只保留"源码匹配 + 单函数包装 + 持续重扫"这一条 2.5.1 已验证
    // 的路径；转译 bundle 的兼容靠放宽源码匹配（不再要求 yield）承接。

    // 持续重扫：前 120s 每 2.5s 一次（页面 chunk 陆续就位/热更新替换函数），
    // 之后降频到 30s 一次。同时校验已装 hook 是否被页面覆盖。
    // bundleReady 在这里补置：main() 的 120s waitFor 超时后变量才出现
    // （iOS 慢加载常见），面板第 2 步不能因此卡死。
    let scanTimer = null;
    function startHookRescanLoop() {
        if (scanTimer) return;
        const startedAt = Date.now();
        const tick = () => {
            let delay = HOOK_RESCAN_SLOW_MS;
            try {
                if (W.default_MakerSuite) {
                    if (!state.bundleReady) {
                        state.bundleReady = true;
                        state.diag.inPageContext = true;
                        log("default_MakerSuite 已出现（重扫发现）");
                        updatePanel();
                    }
                    installSnapshotHook(); // 校验 hook 是否被覆盖，被覆盖则补装
                }
                if (Date.now() - startedAt < HOOK_RESCAN_FAST_WINDOW_MS) delay = HOOK_RESCAN_FAST_MS;
            } catch (_) {}
            scanTimer = setTimeout(tick, delay);
        };
        scanTimer = setTimeout(tick, HOOK_RESCAN_FAST_MS);
    }

    // ==================== 自动引导拦截状态机 ====================
    // armHandoff(req)：开启拦截窗口——页面下一次 GenerateContent 发送被
    //   fetch/XHR 捕获层认领；req 非空时融合执行（顶替真实发送、用页面
    //   即时新鲜头，完成后回填页面），req 为空则只吞不发（回伪造 502）；
    // armSuppress：只吞不发（页面重试也吃掉），不 resolve 引导方；
    // claimPageSend：捕获层调用，返回 ctx（认领成功）/ "suppressed" /
    //   null（窗口未开）。认领成功后窗口自动关闭（armed=false）。

    let suppressTimer = null;

    function armHandoff(req) {
        state.handoff.armed = true;
        state.handoff.suppress = false;
        const ctx = { claimed: false, req: req || null, error: null };
        state.handoff.ctx = ctx;
        return ctx;
    }

    function armSuppress() {
        state.handoff.armed = true;
        state.handoff.suppress = true;
        state.handoff.ctx = null;
        // 有界窗口：只吃页面拿到伪造 502 后的即时自动重试。
        // 超时自动关闭——无限期开着会吞掉用户之后手动发的真实消息
        clearTimeout(suppressTimer);
        suppressTimer = setTimeout(() => {
            if (state.handoff.armed && state.handoff.suppress) disarmHandoff();
        }, SUPPRESS_WINDOW_MS);
    }

    function disarmHandoff() {
        clearTimeout(suppressTimer);
        state.handoff.armed = false;
        state.handoff.suppress = false;
        state.handoff.ctx = null;
    }

    function claimPageSend(kind) {
        if (!state.handoff.armed) return null;
        state.handoff.armed = false;
        if (state.handoff.suppress) {
            state.handoff.suppress = false;
            return "suppressed";
        }
        const ctx = state.handoff.ctx;
        state.handoff.ctx = null;
        if (ctx && !ctx.claimed) {
            ctx.claimed = true;
            ctx.kind = kind;
            log("🤖 已拦截页面发送（" + kind + "）" + (ctx.req ? "，融合执行中" : "，引导捕获进行中"));
            return ctx;
        }
        return null;
    }

    // 融合执行：引导/重签点 Run 后页面发起的这次 GenerateContent 被认领——
    // 顶替它发真实请求（请求头取认领时刻 getHeaders()——拦截层刚刚用页面
    // 这一发的原始头刷新过捕获记录，全部是即时新鲜值；authorization 现算
    // 三段）。真实结果通过 WS 回传后端；页面侧按拦截方式回填：
    //   fetch：回 200 空体（页面不等待内容）
    //   xhr：delivery 按流推送 chunk（页面渲染管线照常走）
    // ctx.req 为 { requestId, payload, model, stream, controller, startedAt }
    //（由 runBootstrap / reSignViaPageSend 装配）。返回值：true=已投递，
    //   Error=需引导方自行处理（401/403 等）。
    async function performHandoffSend(ctx, capturedHeaders, xhr) {
        const req = ctx.req;
        // 3.1 克隆 payload 防重签重试时 wire 已被本轮注入污染
        let payload;
        try {
            payload = JSON.parse(JSON.stringify(req.payload));
        } catch (e) {
            ctx.error = mkError(500, "wire_clone_failed", "wire 克隆失败: " + e);
            ctx.handoffDone = true;
            return ctx.error;
        }
        const { wire, binding } = payload;
        const delivery = ctx.kind === "xhr" && xhr ? createLocalXhrDelivery(xhr) : null;
        if (delivery) delivery.ready();
        try {
            // 3.2 fresh proof 注入 field 5（wire[4]）
            let t = Date.now();
            const digest = await sha256Hex(binding);
            wire[4] = await takeProof(digest);
            const tm = { proof: Date.now() - t };

            // 3.3 请求头：页面这一发的即时原始头（拦截层刚捕获），
            //     仅剔浏览器接管的传输层头，authorization 现算三段
            const headers = { ...(capturedHeaders || getHeaders()) };
            for (const k of Object.keys(headers)) {
                if (/^(content-length|host|connection)$/.test(k)) delete headers[k];
            }
            headers["content-type"] = "application/json+protobuf";
            const freshAuth = await freshAuthHeader();
            if (
                freshAuth &&
                (!headers["authorization"] ||
                    String(headers["authorization"]).startsWith("SAPISIDHASH "))
            ) {
                headers["authorization"] = freshAuth;
            }

            // 3.4 发送 + 流式逐块（CountTokens 保活同 runGenerate）
            const doFetch = W.__pgOrigFetch || W.fetch;
            const stopKa = startCountTokensKeepAlive(req.controller.signal);
            let raw;
            let rawBytes = 0;
            let chunkCount = 0;
            try {
                const resp = await doFetch.call(W, GENERATE_URL, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(wire),
                    credentials: "include",
                    signal: req.controller.signal,
                });
                if (!resp.ok) {
                    const text = await resp.text().catch(() => "");
                    const realMsg = parseUpstreamErrorBody(text);
                    const err = mkError(
                        resp.status,
                        "upstream_http_error",
                        realMsg
                            ? `上游 HTTP ${resp.status}: ${realMsg.slice(0, 300)}`
                            : `上游 HTTP ${resp.status}` + (text ? `: ${text.slice(0, 300)}` : ""),
                        text
                    );
                    if (delivery) delivery.fail(resp.status, "");
                    throw err;
                }
                if (req.stream && resp.body && typeof resp.body.getReader === "function") {
                    const reader = resp.body.getReader();
                    const decoder = new TextDecoder("utf-8");
                    let acc = "";
                    for (;;) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        const piece = decoder.decode(value, { stream: true });
                        if (!piece) continue;
                        acc += piece;
                        rawBytes += utf8Len(piece);
                        chunkCount++;
                        if (delivery) delivery.pushChunk(acc);
                        try {
                            deliverResult({ type: "stream-chunk", requestId: req.requestId, chunkBody: piece });
                        } catch (_) {}
                    }
                    const tail = decoder.decode();
                    if (tail) {
                        acc += tail;
                        rawBytes += utf8Len(tail);
                        chunkCount++;
                        if (delivery) delivery.pushChunk(acc);
                        try {
                            deliverResult({ type: "stream-chunk", requestId: req.requestId, chunkBody: tail });
                        } catch (_) {}
                    }
                    raw = acc;
                } else {
                    raw = await resp.text();
                    rawBytes = utf8Len(raw);
                }
            } finally {
                stopKa();
            }
            if (!raw || !raw.trim()) {
                if (delivery) delivery.fail(502, "");
                throw mkError(502, "empty_response", "上游返回空内容");
            }

            // 3.5 投递结果（流式收尾 / 非流式整包）+ 记账 + 缓存
            if (req.stream) {
                deliverResult({ type: "stream-end", requestId: req.requestId, status: 200 });
            } else {
                deliverResult({ type: "response", requestId: req.requestId, status: 200, rawResponse: raw });
            }
            if (delivery) delivery.finish(200, raw);
            // finishActivity 统一完成计数 + 使用记录（防重复记账）
            req.finishActivity("success", `融合 ${rawBytes} 字节${req.stream ? ` / ${chunkCount} 块` : ""}`, null, rawBytes);
            saveReplayCache(req.model, !!req.stream, raw);
            log(`✔ 完成（融合） ${req.requestId.slice(0, 8)} ${rawBytes}字节 proof${tm.proof || 0}ms`);
            ctx.handoffDone = true;
            return true;
        } catch (e) {
            // cancel/硬超时 abort → 499（对齐 runGenerate 的取消语义）
            if (e && e.name === "AbortError") {
                ctx.error = mkError(499, "cancelled", "请求已取消");
            } else {
                ctx.error = e;
            }
            ctx.handoffDone = true;
            if (delivery) {
                const status = ctx.error && ctx.error.httpStatus ? ctx.error.httpStatus : 502;
                delivery.fail(status, "");
            }
            return ctx.error;
        }
    }

    // 自动引导主流程（单飞）：
    //   0. 不在临时会话页 → 报 409 并自动跳转临时会话页（页面重载后
    //      下一个请求在新页重新引导；
    //   1. armHandoff 开拦截窗口（pendingReq 非空时融合执行）
    //   2. fillPrompt("hi") + clickRun 触发页面自身发送管线
    //   3. snapshot hook 捕 service、fetch/XHR 捕 headers（同手动引导）
    //   4. 页面那次发送被认领：融合时顶替执行真实请求（用页面这一发
    //      的即时新鲜头，结果经 WS 回传，页面回 200 空体/流式回填）；
    //      纯引导时回伪造 502（不发真包、不落历史）
    //   5. 等 waaReady；引导成功后 armSuppress 吃掉页面可能的自动重试
    // 拦截开关关闭 → 退化为真发一条 hi（与手动发消息等价），此时
    // pendingReq 无法融合，由调用方在引导完成后走常规 runGenerate。
    async function runBootstrap(reason, pendingReq) {
        const attempt = ++state.bootstrapAttempt;
        log("🤖 自动引导开始（" + reason + "）" + (pendingReq ? "（融合首请求）" : "") + "…");

        // 引导宿主：临时会话页（new_chat?temporary=true）——引导 "hi"
        // 不落会话历史。不在该页时：先把 409 交回 handleRequest 发给
        // 后端（WS 还在），再由 navigateToTemporaryChat 跳转——整页
        // 加载脚本随页面重启，后端重发/下一个请求即在新页完成引导
        if (!isTemporaryChatPage()) {
            navigateToTemporaryChat();
            throw mkError(
                409,
                "temporary_chat_required",
                "正在打开临时会话页完成自动引导，请稍后重试"
            );
        }

        // 引导需要输入框与 Run 按钮：最多等 20s（SPA 布局就位）
        const composerReady = await waitFor(() => getPromptTextarea(), COMPOSER_WAIT_TIMEOUT_MS, 300);
        if (!composerReady) {
            throw mkError(503, "bootstrap_composer_missing", "未找到提示词输入框，无法自动引导，请手动发一条消息");
        }

        const intercept = bootstrapInterceptEnabled();
        const ctx = intercept ? armHandoff(pendingReq || null) : null;
        try {
            fillPrompt(BOOTSTRAP_TRIGGER_PROMPT);
            await sleep(200);
            const via = clickRun();
            if (!via) {
                throw mkError(503, "bootstrap_run_missing", "未找到 Run/发送按钮，请手动发一条消息");
            }
            log("🤖 已触发页面发送（" + via + (intercept ? (pendingReq ? "，融合拦截中" : "，拦截中") : "，真发") + "）");

            if (intercept) {
                // 等 capture 层认领（页面把这次发送真正发起）
                const claimed = await waitFor(
                    () => (ctx.claimed ? true : null),
                    BOOTSTRAP_PAGE_SEND_TIMEOUT_MS,
                    100
                );
                if (!claimed) {
                    disarmHandoff();
                    log("⚠ 页面未在 " + BOOTSTRAP_PAGE_SEND_TIMEOUT_MS / 1000 + "s 内发出请求，拦截窗口已关闭");
                } else if (ctx.req) {
                    // 融合：等顶替发送完成（结果已投递/记账在
                    // performHandoffSend 内完成）。错误向外抛——
                    // 401/403 由调用方走重签，其余按失败透传
                    const outcome = await waitFor(() => ctx.handoffDone ? true : null, BOOTSTRAP_HANDOFF_TIMEOUT_MS, 100);
                    if (!outcome) {
                        armSuppress(); // 融合挂起：吃掉页面后续重试
                        throw mkError(504, "handoff_timeout", "融合执行超时");
                    }
                    if (ctx.error) {
                        // 失败也吃掉页面重试（回填的 4xx/5xx 会触发页面
                        // 自动重试，真发出去就露馅了）
                        armSuppress();
                        throw ctx.error;
                    }
                    pendingReq.__fused = true; // 结果已在 performHandoffSend 投递/记账
                    log("✅ 引导融合完成（真实请求已随引导发出并投递）");
                }
            }

            // 等 WAA 就绪（service + headers 都到位）
            const ok = await waitFor(() => state.waaReady, BOOTSTRAP_TIMEOUT_MS, 200);
            if (!ok) {
                disarmHandoff();
                throw mkError(504, "bootstrap_timeout", "自动引导超时：页面未完成签名管线，请手动发一条消息");
            }
            // 认领成功后页面可能自动重试（拿到 502）——armSuppress 有界
            // 窗口吃掉（10s TTL 自动关闭）。finally 里不能 disarm 掉它
            if (intercept) armSuppress();
            log("✅ 自动引导完成（WAA 已就绪）");
            return true;
        } finally {
            // 清空引导留下的输入框内容（失败也不影响——下一次引导会覆盖）
            try {
                const textarea = getPromptTextarea();
                if (textarea && textarea.value === BOOTSTRAP_TRIGGER_PROMPT) {
                    const setter = Object.getOwnPropertyDescriptor(
                        W.HTMLTextAreaElement.prototype,
                        "value"
                    ).set;
                    setter.call(textarea, "");
                    textarea.dispatchEvent(new W.Event("input", { bubbles: true }));
                }
            } catch (_) {}
            // suppress 窗口留给 TTL 定时器关闭；其余状态一律复位
            if (!(state.handoff.armed && state.handoff.suppress)) disarmHandoff();
        }
    }

    // 单飞入口：已有引导在进行则共享同一个 Promise。
    // 返回 true = pendingReq 已融合完成（首请求随引导顶替发出并投递，
    // 调用方直接 return）；false = 引导完成但未融合（共享了别人的引导、
    // 拦截关闭或纯引导，调用方走常规 runGenerate）。
    function ensureBootstrapped(reason, pendingReq) {
        if (state.waaReady) return Promise.resolve(false);
        if (state.bootstrapPromise) return state.bootstrapPromise.then(() => false);
        const p = runBootstrap(reason, pendingReq)
            .then(() => {
                const fused = !!(pendingReq && pendingReq.__fused);
                if (pendingReq) delete pendingReq.__fused;
                return fused;
            })
            .finally(() => {
                if (state.bootstrapPromise === p) state.bootstrapPromise = null;
            });
        state.bootstrapPromise = p;
        return p;
    }

    // 401/403 重签融合：清 service/headers 后 armHandoff(req) + 点 Run——
    // 页面这次发送被顶替执行（fresh proof + 即时新鲜头），结果直接投递。
    // 与 runBootstrap 不同：不动 waaReady 单飞状态（service 已在拦截层
    // 重新捕获），失败由调用方按原逻辑透传。
    async function reSignViaPageSend(req) {
        if (!isTemporaryChatPage()) {
            throw mkError(409, "temporary_chat_required", "请在临时会话页重连后重试");
        }
        const composerReady = await waitFor(() => getPromptTextarea(), COMPOSER_WAIT_TIMEOUT_MS, 300);
        if (!composerReady) {
            throw mkError(503, "resign_composer_missing", "重签需要输入框：未找到提示词输入框，请手动发一条消息");
        }
        const ctx = armHandoff(req);
        try {
            fillPrompt(BOOTSTRAP_TRIGGER_PROMPT);
            await sleep(200);
            const via = clickRun();
            if (!via) {
                throw mkError(503, "resign_run_missing", "重签未触发页面发送（未找到 Run 按钮），请手动发一条消息");
            }
            const claimed = await waitFor(
                () => (ctx.claimed ? true : null),
                BOOTSTRAP_PAGE_SEND_TIMEOUT_MS,
                100
            );
            if (!claimed) {
                throw mkError(504, "resign_no_page_send", "页面未产生发送，重签失败");
            }
            const outcome = await waitFor(() => ctx.handoffDone ? true : null, BOOTSTRAP_HANDOFF_TIMEOUT_MS, 100);
            if (!outcome) {
                throw mkError(504, "resign_timeout", "重签融合执行超时");
            }
            if (ctx.error) throw ctx.error;
            log("✅ 重签融合完成");
            armSuppress();
            return true;
        } catch (e) {
            // 失败一律吃掉页面重试（回填 4xx/5xx 后页面可能自动重发）
            armSuppress();
            throw e;
        } finally {
            try {
                const textarea = getPromptTextarea();
                if (textarea && textarea.value === BOOTSTRAP_TRIGGER_PROMPT) {
                    const setter = Object.getOwnPropertyDescriptor(
                        W.HTMLTextAreaElement.prototype,
                        "value"
                    ).set;
                    setter.call(textarea, "");
                    textarea.dispatchEvent(new W.Event("input", { bubbles: true }));
                }
            } catch (_) {}
        }
    }

    // 记录页面自身 GenerateContent 请求的 headers（合并 + 持久化）。
    // 页面上下文 fetch 自动带 cookie，脚本请求复用捕获的显式头。
    // 保存原生 fetch 到 W.__pgOrigFetch：脚本自己发请求走它，不触发捕获。
    // 自动引导拦截：arm 窗口内页面发起的 GenerateContent 被认领——
    // 请求头照常捕获，真实发送不发生，回填伪造响应（502 空体）。
    function installFetchCapture() {
        const originalFetch = W.fetch;
        if (typeof originalFetch !== "function") return;
        if (originalFetch.__pgWrapped) return; // 已安装
        W.__pgOrigFetch = originalFetch;
        const matches = (input) => {
            const raw =
                typeof input === "string"
                    ? input
                    : input && input.url;
            if (!raw) return false;
            try {
                const u = new URL(raw, W.location.href);
                return (
                    u.pathname === GENERATE_PATH ||
                    // 引导 "hi" 附带的会话保存请求：窗口内一律回空（不写入会话历史）
                    (state.handoff.armed && /\/(SavePrompt|CreatePrompt)$/.test(u.pathname))
                );
            } catch {
                return false;
            }
        };
        const recordHeaders = (h) => {
            const captured = {};
            if (!h) return;
            try {
                if (typeof h.forEach === "function") {
                    h.forEach((v, k) => (captured[String(k).toLowerCase()] = String(v)));
                } else if (Array.isArray(h)) {
                    for (const [k, v] of h) captured[String(k).toLowerCase()] = String(v);
                } else if (typeof h === "object") {
                    for (const [k, v] of Object.entries(h))
                        captured[String(k).toLowerCase()] = String(v);
                }
            } catch (_) {}
            if (!Object.keys(captured).length) return;
            setCapturedHeaders(captured);
            log(
                "已捕获页面请求头 (" + Object.keys(captured).length + " 项" +
                    (captured["x-goog-api-key"] ? ", 含 api-key" : ", 无 api-key") + ")"
            );
        };
        const fetchWrapper = function (input, init) {
            let intercepted = null;
            try {
                if (matches(input)) {
                    const raw =
                        typeof input === "string"
                            ? input
                            : input && input.url;
                    const path = new URL(raw, W.location.href).pathname;
                    if (state.handoff.armed && /\/(SavePrompt|CreatePrompt)$/.test(path)) {
                        // 引导触发的会话保存：直接吞掉（页面拿空列表，不落历史）
                        intercepted = Promise.resolve(
                            new W.Response("[]", {
                                status: 200,
                                headers: { "content-type": "application/json+protobuf" },
                            })
                        );
                    } else if (path === GENERATE_PATH) {
                        state.diag.sawGenerate = true;
                        state.diag.sawGenerateTs = Date.now();
                        let justCaptured = null;
                        recordHeaders(init && init.headers);
                        if (init && init.headers) {
                            const h = {};
                            try {
                                const src = init.headers;
                                if (typeof src.forEach === "function") {
                                    src.forEach((v, k) => (h[String(k).toLowerCase()] = String(v)));
                                } else if (typeof src === "object") {
                                    for (const [k, v] of Object.entries(src)) {
                                        h[String(k).toLowerCase()] = String(v);
                                    }
                                }
                            } catch (_) {}
                            if (Object.keys(h).length) justCaptured = h;
                        }
                        if (!init && input instanceof W.Request) {
                            recordHeaders(input.headers);
                        }
                        // 自动引导拦截：认领这一次页面发送——融合执行（有 req）
                        // 或回伪造响应（纯引导）
                        const ctx = claimPageSend("fetch");
                        if (ctx === "suppressed") {
                            intercepted = Promise.resolve(
                                new W.Response("", {
                                    status: 502,
                                    headers: { "content-type": "application/json+protobuf" },
                                })
                            );
                        } else if (ctx && ctx.req) {
                            // 顶替发送：页面拿到 200 空体，真实结果经 WS 回传
                            performHandoffSend(ctx, justCaptured, null).catch(() => {});
                            intercepted = Promise.resolve(
                                new W.Response("", {
                                    status: 200,
                                    headers: { "content-type": "application/json+protobuf; charset=UTF-8" },
                                })
                            );
                        } else if (ctx) {
                            intercepted = Promise.resolve(
                                new W.Response("", {
                                    status: 502,
                                    headers: { "content-type": "application/json+protobuf" },
                                })
                            );
                        }
                    }
                }
            } catch (_) {}
            if (intercepted) return intercepted;
            return originalFetch.apply(this, arguments);
        };
        fetchWrapper.__pgWrapped = true;
        W.fetch = fetchWrapper;
    }

    // XHR 侧伪造响应回填：
    // defineProperty 锁定 readyState/status/responseText 等只读槽位，
    // 按事件序列 readystatechange → (progress) → load → loadend 通知页面。
    function createLocalXhrDelivery(xhr) {
        const inner = { responseType: "", text: "" };
        try {
            inner.responseType = String(xhr.responseType || "");
        } catch (_) {}
        const def = (k, v) => {
            try {
                Object.defineProperty(xhr, k, { configurable: true, get: () => v });
            } catch (_) {}
        };
        def("responseURL", GENERATE_URL);
        def("getResponseHeader", (name) =>
            String(name).toLowerCase() === "content-type"
                ? "application/json+protobuf; charset=UTF-8"
                : null
        );
        const updateBody = () => {
            def("responseText", inner.text);
            if (inner.responseType === "json" && inner.text) {
                let parsed = inner.text;
                try {
                    parsed = JSON.parse(inner.text);
                } catch (_) {}
                def("response", parsed);
            } else {
                def("response", inner.text);
            }
        };
        const fire = (type) => {
            try {
                xhr.dispatchEvent(new W.Event(type));
            } catch (_) {}
        };
        return {
            ready() {
                def("readyState", 2);
                def("status", 0);
                updateBody();
                fire("readystatechange");
            },
            pushChunk(text) {
                inner.text = text;
                def("readyState", 3);
                def("status", 200);
                def("statusText", "OK");
                updateBody();
                fire("readystatechange");
                try {
                    xhr.dispatchEvent(
                        new W.ProgressEvent("progress", {
                            lengthComputable: false,
                            loaded: text.length,
                            total: 0,
                        })
                    );
                } catch (_) {}
            },
            fail(status, text) {
                inner.text = text || "";
                def("readyState", 4);
                def("status", status || 502);
                def("statusText", "Error");
                updateBody();
                fire("readystatechange");
                fire("load");
                fire("loadend");
            },
            finish(status, text) {
                inner.text = text || "";
                def("readyState", 4);
                def("status", status);
                def("statusText", status === 200 ? "OK" : "Error");
                updateBody();
                fire("readystatechange");
                fire("load");
                fire("loadend");
            },
        };
    }

    // grpc-web 页面可能走 XHR：wrap open/setRequestHeader/send 记录 headers。
    // 自动引导拦截：arm 窗口内 send 被认领——headers 照常捕获，真实发送
    // 不发生（不调 origSend），用 createLocalXhrDelivery 回填伪造响应。
    function installXhrCapture() {
        const proto = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
        if (!proto) return;
        if (proto.__pgXhrWrapped) return; // 已安装
        proto.__pgXhrWrapped = true;
        const origOpen = proto.open;
        const origSetRH = proto.setRequestHeader;
        const origSend = proto.send;
        const urls = new WeakMap();
        const headerMap = new WeakMap();
        proto.open = function (method, url, ...rest) {
            urls.set(this, String(url));
            return origOpen.call(this, method, url, ...rest);
        };
        proto.setRequestHeader = function (k, v) {
            const h = headerMap.get(this) || {};
            h[String(k).toLowerCase()] = String(v);
            headerMap.set(this, h);
            return origSetRH.call(this, k, v);
        };
        proto.send = function (body) {
            const url = urls.get(this);
            let claimed = false;
            try {
                if (url) {
                    const path = new URL(url, W.location.href).pathname;
                    if (path === GENERATE_PATH) {
                        state.diag.sawGenerate = true;
                        state.diag.sawGenerateTs = Date.now();
                        const h = headerMap.get(this) || {};
                        if (Object.keys(h).length) {
                            setCapturedHeaders(h);
                            log(
                                "已捕获页面 XHR 请求头" +
                                    (h["x-goog-api-key"] ? "（含 api-key）" : "（无 api-key）")
                            );
                        }
                        const ctx = claimPageSend("xhr");
                        if (ctx === "suppressed") {
                            claimed = true;
                            const delivery = createLocalXhrDelivery(this);
                            delivery.ready();
                            delivery.finish(502, "");
                        } else if (ctx && ctx.req) {
                            // 融合执行：delivery 由 performHandoffSend 内部
                            // 按流推送，真实结果经 WS 回传
                            claimed = true;
                            performHandoffSend(ctx, h, this).catch(() => {});
                        } else if (ctx) {
                            claimed = true;
                            const delivery = createLocalXhrDelivery(this);
                            delivery.ready();
                            delivery.finish(502, "");
                        }
                    } else if (state.handoff.armed && /\/(SavePrompt|CreatePrompt)$/.test(path)) {
                        // 引导触发的会话保存：吞掉，返回空列表
                        claimed = true;
                        const delivery = createLocalXhrDelivery(this);
                        delivery.ready();
                        delivery.finish(200, "[]");
                    }
                }
            } catch (_) {}
            if (claimed) return; // 真实发送不发生
            return origSend.call(this, body);
        };
    }

    // 输入框可见性判定（checkVisibility
    // 出错时当作可见——隐藏元素面积通常为 0，会被下方按面积选框自然过滤）
    function isVisible(el) {
        try {
            return el.checkVisibility({ visibilityProperty: true });
        } catch (_) {
            return true;
        }
    }

    // 当前 URL 的账号前缀（"/u/3/" 或 ""）——SPA 内切换 Google 账号时
    // pathname 前缀变化，捕获的 headers/service 随之作废
    function accountPathPrefix() {
        const m = W.location.pathname.match(/^(\/u\/\d+\/)/);
        return m ? m[1] : "";
    }

    // 当前账号索引（"0"-"5"）：无 /u/N/ 前缀 = 主账号 0
    function currentAccountIndex() {
        const m = accountPathPrefix().match(/^\/u\/(\d+)\/$/);
        return m ? m[1] : "0";
    }

    // 目标账号的临时会话页 URL（/u/N/ 前缀只在 N>0 时带上）
    function accountTemporaryChatURL(index) {
        const prefix = Number(index) > 0 ? `/u/${Number(index)}/` : "/";
        return "https://aistudio.google.com" + prefix + "prompts/new_chat?temporary=true";
    }

    // 快速换号：断开 WS、按账号前缀作废捕获物，然后整页跳转目标账号的
    // 临时会话页。页面整载后脚本随页面重启：持久化请求头记录由
    // persistedWaaForCurrentAccount() 按前缀校验自动丢弃旧账号记录，
    // 引导在新账号页面重新完成，Cookie 推送/WS 执行都指向新账号。
    // 与导航到 /u/N/prompts 的 upstream 做法（gogcli playground-executor
    // switchAccount）同原理：URL 前缀即 Google 账号路由，前缀对了
    // Cookie/授权/WAA 全部随新账号走
    function switchAccount(index) {
        const n = Number(index);
        if (!isFinite(n) || n < 0 || n > ACCOUNT_SWITCH_MAX_INDEX) return;
        if (String(n) === currentAccountIndex()) return; // 已是当前账号
        disconnectWs("切换 Google 账号");
        const url = accountTemporaryChatURL(n);
        log("🔄 切换 Google 账号 → " + (n === 0 ? "主账号" : "账号 " + n) + "（" + url + "）…");
        // 与 navigateToTemporaryChat 同款：下一拍再跳，避免打断未决 WS 发送
        setTimeout(() => {
            try {
                W.location.assign(url);
            } catch (e) {
                log("⚠ 无法跳转换号页: " + e + "，请手动访问 " + url);
            }
        }, 500);
    }

    // 换号菜单刷新：当前账号高亮禁点，其余可选
    function updateAccountMenu() {
        if (!ui.acctOptions || !ui.acctOptions.length) return;
        const cur = currentAccountIndex();
        for (const opt of ui.acctOptions) {
            const idx = opt.getAttribute("data-index") || "0";
            const isCur = idx === cur;
            opt.disabled = isCur;
            opt.setAttribute("aria-current", String(isCur));
            opt.title = isCur ? `当前账号（${idx === "0" ? "主账号" : "账号 " + idx}）` : `切换到账号 ${idx}`;
            // Trusted Types（require-trusted-types-for 'script'）站点禁 innerHTML，
            // 用 replaceChildren 清空重填（老 WebView 无 TT，replaceChildren 也在）
            opt.replaceChildren(h("span", { text: idx }));
            if (isCur) opt.appendChild(h("i", { text: "当前" }));
        }
        if (ui.acctBtn) {
            ui.acctBtn.textContent = "换号" + (cur !== "0" ? " " + cur : "");
        }
    }

    // ---- 临时会话页：自动引导的宿主页面 ----
    // 临时会话页（new_chat?temporary=true）本身不落历史，引导 "hi" 在
    // 这里零残留；保存 Key 时若不在此页会自动跳转（执行本身不依赖
    // 输入框，只有引导需要在页面上发送一次）
    function promptsBasePath() {
        const m = W.location.pathname.match(/^(\/(?:u\/\d+\/)?prompts)(?:\/|$)/);
        return m ? m[1] : "";
    }

    function isTemporaryChatPage() {
        const base = promptsBasePath();
        if (!base) return false;
        try {
            return (
                W.location.pathname === base + "/new_chat" &&
                new URLSearchParams(W.location.search).get("temporary") === "true"
            );
        } catch (_) {
            return false;
        }
    }

    function temporaryChatURL() {
        return "https://aistudio.google.com" + promptsBasePath() + "/new_chat?temporary=true";
    }

    // 跳转临时会话页：日志先落（导航后 console/日志清空），交给事件
    // 循环下一拍执行（location.assign 同步打断未决的 WS 发送）
    let navigateTimer = null;
    function navigateToTemporaryChat() {
        const url = temporaryChatURL();
        log("🤖 不在临时会话页，即将跳转完成引导（" + url + "）…");
        if (navigateTimer) return;
        navigateTimer = setTimeout(() => {
            try {
                W.location.assign(url);
            } catch (e) {
                log("⚠ 无法跳转临时会话页: " + e);
            }
        }, 500);
    }

    // 查找页面提示词输入框。移动端布局可能同时有多个可见 textarea：
    // 不再 throw，改选面积最大（通常是主输入框）的一个。
    // 现在仅自动引导使用（每请求执行已不写输入框——digest 与输入框无关）。
    function getPromptTextarea() {
        const items = [...document.querySelectorAll("ms-prompt-box textarea")].filter(isVisible);
        if (!items.length) return null;
        let best = null;
        let bestArea = -1;
        for (const el of items) {
            const r = el.getBoundingClientRect();
            const area = Math.max(0, r.width) * Math.max(0, r.height);
            if (area >= bestArea) {
                bestArea = area;
                best = el;
            }
        }
        return best;
    }

    // 把 prompt 写入页面输入框并触发页面表单状态同步（仅自动引导用）
    function fillPrompt(prompt) {
        const textarea = getPromptTextarea();
        if (!textarea) throw new Error("未找到可见的提示词输入框（ms-prompt-box textarea）");
        const setter = Object.getOwnPropertyDescriptor(
            W.HTMLTextAreaElement.prototype,
            "value"
        ).set;
        setter.call(textarea, prompt);
        textarea.dispatchEvent(
            new W.InputEvent("input", {
                bubbles: true,
                inputType: "insertText",
                data: prompt,
            })
        );
        textarea.dispatchEvent(new W.Event("change", { bubbles: true }));
        return textarea.value;
    }

    // 点页面 Run/发送按钮：
    // ctrl-enter-submits / build-button / aria-label / 按钮文本 / Enter 兜底
    function clickRun() {
        const selectors = [
            "button.ctrl-enter-submits",
            "button.build-button",
            "button[aria-label*='Run']",
            "button[aria-label*='运行']",
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
                el.click();
                return "selector:" + sel;
            }
        }
        const btns = [...document.querySelectorAll("button")];
        const hit = btns.find((b) => /^(Run|Build|运行|发送)$/i.test((b.innerText || "").trim()));
        if (hit) {
            hit.click();
            return "text:" + (hit.innerText || "").trim();
        }
        const ta = getPromptTextarea();
        if (ta) {
            ta.focus();
            ta.dispatchEvent(
                new W.KeyboardEvent("keydown", {
                    key: "Enter",
                    code: "Enter",
                    keyCode: 13,
                    which: 13,
                    bubbles: true,
                    cancelable: true,
                })
            );
            return "keydown-Enter";
        }
        return null;
    }

    // 生成 fresh WAA proof（digest 为 sha256hex(binding)），带硬超时与重试
    async function takeProof(digest) {
        const makerSuite = W.default_MakerSuite;
        const service = W.__pgWaaService;
        const snapshotKey = W.__pgWaaSnapshotKey;
        if (
            !makerSuite ||
            !service ||
            !snapshotKey ||
            typeof makerSuite[snapshotKey] !== "function"
        ) {
            throw mkError(503, "waa_not_ready", "WAA service 未就绪（自动引导未完成）");
        }
        // snapshot 可能因页面 zone 冻结而永不回调——用超时+重试兜底，
        // 重试前重扫 hook（页面 bundle 热更新可能换掉 snapshot 函数）
        const attempt = async (timeoutMs) => {
            return Promise.race([
                Promise.resolve(makerSuite[snapshotKey](service, digest)),
                new Promise((_, reject) =>
                    setTimeout(
                        () => reject(new Error("proof_timeout")),
                        timeoutMs
                    )
                ),
            ]);
        };
        let proof;
        let lastErr = null;
        for (let round = 0; round < PROOF_MAX_ROUNDS; round++) {
            try {
                proof = await attempt(round === 0 ? PROOF_TIMEOUT_FIRST_MS : PROOF_TIMEOUT_RETRY_MS);
                lastErr = null;
                break;
            } catch (e) {
                lastErr = e;
                log(`proof 第 ${round + 1} 次尝试失败: ${e && e.message}`);
                // 页面 bundle 热更新会把 snapshot 函数换掉（旧 key 失效）——重扫 hook
                try {
                    const r = installSnapshotHook();
                    if (r === "no_snapshot_fn") log("⚠ 重扫：未找到 snapshot 函数（页面可能改版）");
                } catch (_) {}
                await sleep(300);
            }
        }
        if (lastErr) {
            throw mkError(504, "waa_proof_timeout", "WAA proof 生成超时（页面可能被浏览器冻结，请切回该标签页）");
        }
        if (typeof proof !== "string" || !proof.startsWith("!")) {
            throw mkError(502, "waa_proof_invalid", "fresh WAA proof 前缀无效: " + String(proof).slice(0, 40));
        }
        return proof;
    }

    function ensureWaaReady() {
        if (!state.waaReady) {
            throw mkError(503, "waa_not_ready", "WAA 未就绪（自动引导未完成）");
        }
        const headers = getHeaders();
        if (!headers || !headers["x-goog-api-key"]) {
            log("请求头现有键: " + Object.keys(headers || {}).join(",") + "（无 x-goog-api-key）");
            throw mkError(503, "waa_headers_missing", "缺少页面请求头捕获（x-goog-api-key），请手动在聊天框发一条消息");
        }
    }

    // ==================== Cookie 推送（云端无头模式） ====================
    // GM_cookie 需要 Tampermonkey 把「允许脚本访问 Cookie」设为 all 才能读全量 Cookie
    //（管理面板 → 设置 → 配置模式「高级」→ 安全栏 → all → 保存）。
    // 导出 aistudio.google.com + google.com 相关域 Cookie（含 HttpOnly），
    // 连同真实浏览器指纹 POST 到后端 /api/pggo/push，后端转发 Go 微服务
    // 落盘，之后 pggo-（Playground）模型由
    // 云端按本机现场无头执行。

    // Cookie API 可用性：Tampermonkey 的 GM_cookie（回调式）或 GM.cookie
    // （Promise 风格，部分新式管理器）。都没有则明确提示不可用。
    function cookieApi() {
        if (typeof GM_cookie !== "undefined" && GM_cookie && typeof GM_cookie.list === "function") {
            return { style: "callback", api: GM_cookie };
        }
        if (typeof GM !== "undefined" && GM.cookie && typeof GM.cookie.list === "function") {
            return { style: "promise", api: GM.cookie };
        }
        return null;
    }

    function gmCookieList(query) {
        const c = cookieApi();
        if (!c) return Promise.resolve({ cookies: null, error: "Cookie API 不可用" });
        if (c.style === "promise") {
            return c.api
                .list(query)
                .then((cookies) => ({ cookies: cookies || [], error: null }))
                .catch((e) => ({ cookies: null, error: String(e) }));
        }
        return new Promise((resolve) => {
            try {
                c.api.list(query, (cookies, error) => {
                    if (error) resolve({ cookies: null, error: String(error) });
                    else resolve({ cookies: cookies || [], error: null });
                });
            } catch (e) {
                resolve({ cookies: null, error: String(e) });
            }
        });
    }

    // 检测当前登录的 Google 账号邮箱（用于凭证命名）。
    // 依次尝试：One Bar 账号按钮 aria-label、头像 alt、页面全文兜底。
    // 第 3 层全文兜底是历史上的主命中路径（前两层在 AI Studio 当前
    // 标记下常失配）——不能删；为防对话内容里的邮箱误命名，兜底只认
    // Google 账号域（gmail/googlemail），且要求像账号显示名（One Bar
    // 菜单里 "xxx@gmail.com" 前后紧跟账号名/菜单边界时可再收紧）。
    function detectEmail() {
        // 1. One Bar 账号按钮：aria-label 形如 "Google Account: Alice
        //    (alice@gmail.com)" 或 "Google 帐号：…"
        try {
            const links = document.querySelectorAll(
                'a[href*="accounts.google.com"], a[href*="myaccount.google.com"]'
            );
            for (const link of links) {
                const label = link.getAttribute("aria-label") || "";
                const m = label.match(/[\w.+-]+@[\w.-]+\.\w+/);
                if (m) return m[0].toLowerCase();
            }
        } catch (_) {}
        // 2. img alt（账号头像）
        try {
            for (const img of document.querySelectorAll("img[alt]")) {
                const m = (img.getAttribute("alt") || "").match(/[\w.+-]+@[\w.-]+\.\w+/);
                if (m) return m[0].toLowerCase();
            }
        } catch (_) {}
        // 3. 页面全文兜底（One Bar 展开后的菜单项、账号弹层等文本）。
        //    限定 gmail/googlemail：Google 登录账号几乎都是这两个域，
        //    对话内容里出现的其他邮箱（示例/转发）直接忽略；Google 账号
        //    邮箱若在对话里出现，One Bar 文本通常排在 DOM 前面先命中。
        try {
            const text = document.body ? document.body.innerText || "" : "";
            const m = text.match(/[\w.+-]+@(?:gmail|googlemail)\.com\b/i);
            if (m) return m[0].toLowerCase();
        } catch (_) {}
        return null;
    }

    // 采集真实浏览器指纹（随 Cookie 一起推送；云端按此建 WAA VM，使 VM
    // 现场与本机一致，降低风控风险）。全字段来自标准 Web API，任何一项
    // 读取异常都跳过该项（推送不因此失败——云端对缺失项保留随机值）。
    function collectBrowserFingerprint() {
        const fp = {};
        const safe = (fn) => {
            try {
                const v = fn();
                return v === undefined || v === null ? null : v;
            } catch (_) {
                return null;
            }
        };
        const num = (v) => (typeof v === "number" && isFinite(v) ? v : null);

        fp.userAgent = safe(() => navigator.userAgent);
        fp.platform = safe(() => navigator.platform);
        fp.language = safe(() => navigator.language);
        fp.languages = safe(() => (Array.isArray(navigator.languages) && navigator.languages.length ? [...navigator.languages] : null));
        fp.hardwareConcurrency = num(safe(() => navigator.hardwareConcurrency));
        fp.maxTouchPoints = num(safe(() => navigator.maxTouchPoints));

        // Intl 挂载名是浏览器配置的权威 IANA 时区：DST 切换时偏移变化、
        // 挂载名不变，无需采样校验（按 1/7 月偏移比对应会错杀所有 DST
        // 时区——美洲/欧洲用户全部丢时区）。仅做格式初筛，Go 侧再校验
        fp.timezone = safe(() => {
            const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            return typeof zone === "string" && /^[A-Za-z0-9_+\-/]{3,64}$/.test(zone) ? zone : null;
        });

        fp.screenWidth = num(safe(() => screen.width));
        fp.screenHeight = num(safe(() => screen.height));
        fp.availWidth = num(safe(() => screen.availWidth));
        fp.availHeight = num(safe(() => screen.availHeight));
        fp.availLeft = num(safe(() => screen.availLeft));
        fp.availTop = num(safe(() => screen.availTop));
        fp.colorDepth = num(safe(() => screen.colorDepth));
        fp.pixelDepth = num(safe(() => screen.pixelDepth));
        fp.devicePixelRatio = num(safe(() => window.devicePixelRatio));

        fp.outerWidth = num(safe(() => window.outerWidth));
        fp.outerHeight = num(safe(() => window.outerHeight));
        fp.innerWidth = num(safe(() => window.innerWidth));
        fp.innerHeight = num(safe(() => window.innerHeight));
        fp.windowScreenX = num(safe(() => window.screenX));
        fp.windowScreenY = num(safe(() => window.screenY));

        // oscpu 仅 Firefox 有；Chrome 上 undefined → null（云端只在
        // Firefox UA 时才看它）
        fp.oscpu = safe(() => navigator.oscpu);

        // 清理：null/undefined 字段不外发（payload 紧凑 + 云端零值
        // 语义清晰）
        for (const key of Object.keys(fp)) {
            if (fp[key] === null || fp[key] === undefined) delete fp[key];
        }
        return Object.keys(fp).length ? fp : null;
    }

    // Google 系 Cookie 的过滤条件（丢弃误收集的其他域）
    function isGoogleDomain(domain) {
        const d = String(domain || "").replace(/^\./, "").toLowerCase();
        return d === "google.com" || d.endsWith(".google.com") ||
            d === "googlegroups.com" || d.endsWith(".googlegroups.com");
    }

    // 收集 Cookie。
    // GM_cookie.list({url: X}) 语义 = 浏览器对 X 实际将发送的完整 Cookie
    // （含 HttpOnly），与请求 Cookie 头完全一致（Cookie 是 forbidden header，
    // 脚本读不到请求头，url 查询与之等价）。按 GenerateContent 请求端点查询，
    // 即云端将发送的同一套 Cookie。核心件缺失时按 name 逐项补查。
    async function collectCookies() {
        const byKey = new Map();
        const addCookie = (c, source) => {
            if (!c || !c.name || !isGoogleDomain(c.domain)) return;
            const key = `${c.name}|${c.domain}|${c.path || "/"}`;
            if (!byKey.has(key)) {
                c.source = source; // 记录来源，供同名收敛打分
                byKey.set(key, c);
            }
        };
        const stats = { reqURL: null, pageURL: null, byName: 0 };

        // --- 策略 1：按请求端点 url 查询（= 浏览器发 GenerateContent 时带的 Cookie，
        //     含 HttpOnly，与请求 Cookie 头语义完全一致） ---
        try {
            const { cookies, error } = await gmCookieList({ url: GENERATE_URL });
            if (error) {
                stats.reqURL = `失败(${String(error).slice(0, 40)})`;
                log(`⚠ 请求端点 url 查询失败: ${String(error).slice(0, 80)}`);
            } else {
                stats.reqURL = cookies.length;
                cookies.forEach((c) => addCookie(c, "reqURL"));
            }
        } catch (_) {}

        // --- 策略 2：按 aistudio 页面 url 查询（补漏） ---
        // 部分 Tampermonkey/浏览器对请求端点的 url 查询只暴露子集，
        // 页面域查询能补回会话 Cookie（SID/HSID/__Secure-1PSID 等）。
        // 双份同名由下方"同名收敛"消除，不会再引发 CookieMismatch。
        // ⚠ Tampermonkey 限制：GM_cookie 查询的 url 必须被本脚本的
        //    @match/@include 覆盖。2.4.7 把 @include 收窄到路径含 prompts 后，
        //    根路径 "https://aistudio.google.com/" 不再被覆盖，查询恒失败
        //    （报 "the URL needs to be included by the script's @match or @include"）。
        //    改查含 prompts 的路径；Google Cookie 均在 path=/，结果集不变。
        try {
            const { cookies, error } = await gmCookieList({ url: "https://aistudio.google.com/prompts/" });
            if (error) {
                stats.pageURL = `失败(${String(error).slice(0, 40)})`;
            } else {
                stats.pageURL = cookies.length;
                cookies.forEach((c) => addCookie(c, "pageURL"));
            }
        } catch (_) {}

        // --- 策略 3：核心 Cookie 缺失时按 name 逐项补查 ---
        const has = (name) => [...byKey.values()].some((c) => c.name === name);
        const core = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID", "__Secure-1PSID", "__Secure-3PSID", "SID", "HSID", "SSID"];
        const missing = core.filter((n) => !has(n));
        if (missing.length && cookieApi()) {
            for (const name of missing) {
                try {
                    const { cookies, error } = await gmCookieList({ name });
                    if (error) continue;
                    const found = (cookies || []).filter((c) => isGoogleDomain(c.domain));
                    found.forEach((c) => addCookie(c, "byName"));
                    stats.byName += found.length;
                } catch (_) {}
            }
        }

        // --- 同名收敛：同一名称多份（不同 domain/host-only）只保留一份，
        // 否则 Cookie 头重复发送同名值，Google 判 CookieMismatch。
        // 打分与注释语义一致：优先请求端点结果（= 浏览器真实将发送的属性），
        // 其次 path 更长者。
        const merged = [...byKey.values()];
        const byName = new Map();
        for (const c of merged) {
            const prev = byName.get(c.name);
            if (!prev) {
                byName.set(c.name, c);
                continue;
            }
            const score = (x) => (x.source === "reqURL" ? 100 : 0) + (x.path || "/").length;
            if (score(c) > score(prev)) byName.set(c.name, c);
        }
        const finalCookies = [...byName.values()].map((c) => {
            delete c.source; // 不随 payload 外发
            return c;
        });

        log(
            `Cookie 收集统计: 请求端点=${stats.reqURL} | 页面=${stats.pageURL}` +
            (stats.byName ? ` | 按名补查+${stats.byName}` : "") +
            ` → 同名收敛 ${finalCookies.length} 条`
        );
        return finalCookies;
    }

    async function pushCookiesToCloud() {
        if (!cfg.apiKey) {
            log("推送 Cookie 前，请先设置 cat- API Key");
            updatePanel();
            return;
        }
        log("☁ 开始导出 Cookie…");
        if (!cookieApi()) {
            log("❌ 当前脚本管理器不支持 Cookie API（GM_cookie / GM.cookie）");
            log("   · Tampermonkey（桌面 Chrome/Edge/Firefox）：把「允许脚本访问 Cookie」设为 all 后刷新重试");
            log("     （管理面板 → 设置 → 配置模式选「高级」→ 安全栏 → all → 保存）");
            log("   · iOS 的 Safari 系管理器（Userscripts / Stay 等）大多没有 Cookie API，");
            log("     请改用桌面浏览器推送一次，之后手机上直接用 pggo- 模型即可");
            return;
        }
        const cookies = await collectCookies();
        if (!cookies.length) {
            log("❌ 未导出到任何 Cookie（未登录？或浏览器限制 Cookie 读取，请确认「允许脚本访问 Cookie」已设为 all）");
            return;
        }
        const names = new Set(cookies.map((c) => c.name));
        // 会话必需 8 件套：签名 3 件（SAPISID 系）+ 会话 5 件（SID 系）。
        // 缺任一件 Google 必判 401——推送前就拦下，明示缺什么
        const required = [
            "SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID",
            "__Secure-1PSID", "__Secure-3PSID", "SID", "HSID", "SSID",
        ];
        const missing = required.filter((n) => !names.has(n));
        if (missing.length) {
            log(`❌ 缺少会话必需 Cookie（共 ${missing.length} 件）: ${missing.join(", ")}`);
            log("   排查：Tampermonkey 默认不向脚本开放全部 Cookie（尤其 HttpOnly 的会话 Cookie），");
            log("   需把「允许脚本访问 Cookie」设为 all，步骤如下：");
            log("   ① 进入篡改猴（Tampermonkey）管理面板");
            log("   ② 点击「设置」标签页");
            log("   ③ 在通用配置模式中选择「高级」");
            log("   ④ 找到「安全」一栏，将「允许脚本访问 Cookie」设置为 All");
            log("   ⑤ 点击底部「保存」按钮，然后回到本页刷新重试");
            return;
        }
        const email = detectEmail();
        if (email) {
            log(`账号: ${email}`);
        } else {
            log("⚠ 未检测到账号邮箱（可在页面点开右上角账号菜单后重试），凭证将以临时名保存");
        }
        const fingerprint = collectBrowserFingerprint();
        // 捕获的页面请求头（发过一条消息后才有）：云端首冷启动可用
        // x-goog-api-key 跳过页面载入、用 tier 跳过权益查询；
        // x-goog-ext-*（LoggingContext）与 x-aistudio-visit-id 供云端
        // 无头请求复用（与页面抓包形态一致）。authorization（会过期的
        // SAPISIDHASH）不能搬，云端自查/现算。
        // 一致性兜底：捕获头若来自持久回退（非本会话捕获），与当前
        // Cookie（刚导出的，必然是当前激活账号）可能不同账号——同前缀
        // 下切换账号且未发过消息时路由作废与 401 重签都不触发，这里用
        // x-goog-authuser 与 URL 前缀交叉校验，不一致就丢弃不用
        //（Cookie 本身与 authuser 解析不受影响，只是不加速）
        const capturedHeaders = getHeaders() || {};
        const prefixAuthuser = (() => {
            const pm = accountPathPrefix().match(/^\/u\/(\d+)\/$/);
            return pm ? pm[1] : "0";
        })();
        const capturedAuthuser = String(capturedHeaders["x-goog-authuser"] || "");
        if (
            capturedHeaders["x-goog-api-key"] &&
            /^\d+$/.test(capturedAuthuser) &&
            capturedAuthuser !== prefixAuthuser
        ) {
            log(`⚠ 捕获请求头疑似其他账号（authuser=${capturedAuthuser}，当前=${prefixAuthuser}），本次不随 Cookie 推送请求头`);
            delete capturedHeaders["x-goog-api-key"];
            delete capturedHeaders["x-aistudio-g1-tier"];
            delete capturedHeaders["x-aistudio-visit-id"];
            for (const k of Object.keys(capturedHeaders)) {
                if (/^x-goog-ext-/.test(k)) delete capturedHeaders[k];
            }
        }
        const pushedHeaders = {};
        if (capturedHeaders["x-goog-api-key"]) {
            pushedHeaders["x-goog-api-key"] = capturedHeaders["x-goog-api-key"];
        }
        if (capturedHeaders["x-aistudio-g1-tier"]) {
            pushedHeaders["x-aistudio-g1-tier"] = capturedHeaders["x-aistudio-g1-tier"];
        }
        // x-goog-ext-519733851-bin（页面 LoggingContext）与
        // x-aistudio-visit-id：真实页面每次请求都带，云端无头请求
        // 一并复用，保持与浏览器现场完全一致（值由页面生成，跨请求
        // 重放有效——visit 上下文对上游只读不校验时效）
        const extKeys = Object.keys(capturedHeaders).filter((k) => /^x-goog-ext-/.test(k));
        for (const k of extKeys) {
            pushedHeaders[k] = capturedHeaders[k];
        }
        if (capturedHeaders["x-aistudio-visit-id"]) {
            pushedHeaders["x-aistudio-visit-id"] = capturedHeaders["x-aistudio-visit-id"];
        }
        // 账号索引优先取捕获头里的 x-goog-authuser（页面真实发送到
        // MakerSuite 的值，比解析 URL 前缀更权威——前缀只在跨账号导航
        // 时出现，SPA 内同前缀下切换账号场景前缀可能滞后）；无捕获头时
        // 回退 URL /u/N/ 前缀。getHeaders() 已保证捕获头与当前账号一致
        //（跨账号持久记录已弃用）
        let authuser = null;
        if (capturedHeaders["x-goog-authuser"] && /^\d+$/.test(capturedHeaders["x-goog-authuser"])) {
            authuser = capturedHeaders["x-goog-authuser"];
        } else {
            const prefix = accountPathPrefix();
            const pm = prefix.match(/^\/u\/(\d+)\/$/);
            authuser = pm ? pm[1] : "0";
        }
        const payload = {
            email: email || undefined,
            authuser: authuser,
            fingerprint: fingerprint,
            headers: Object.keys(pushedHeaders).length ? pushedHeaders : undefined,
            cookies: cookies.map((c) => ({
                name: c.name,
                value: c.value,
                domain: c.domain,
                path: c.path || "/",
                expirationDate: typeof c.expirationDate === "number" ? c.expirationDate : -1,
                httpOnly: !!c.httpOnly,
                secure: !!c.secure,
                sameSite: c.sameSite || "unspecified",
            })),
        };
        const body = JSON.stringify(payload);
        const viaCaptured = capturedHeaders["x-goog-authuser"] === authuser;
        log(
            `☁ 推送 ${cookies.length} 条 Cookie 到云端${email ? `（${email}）` : ""}` +
            (authuser !== "0" ? `（authuser=${authuser}${viaCaptured ? "，来自捕获头" : ""}）` : "") +
            (pushedHeaders["x-goog-api-key"] ? "（含请求头，首请求免页面载入）" : "（无捕获请求头，云端自行载入；在页面发一条消息后重推可加速）") +
            (fingerprint ? `（浏览器现场: ${fingerprint.screenWidth}x${fingerprint.screenHeight} @ ${fingerprint.timezone}）` : "")
        );
        await new Promise((resolve, reject) => {
            gmXhr({
                method: "POST",
                url: PUSH_URL,
                headers: {
                    "Content-Type": "application/json",
                    "X-API-Key": cfg.apiKey,
                },
                data: body,
                timeout: COOKIE_PUSH_TIMEOUT_MS,
                onload: (resp) => {
                    try {
                        const data = JSON.parse(resp.responseText);
                        if (resp.status === 200) {
                            const at = data.created_at
                                ? new Date(data.created_at * 1000).toLocaleString("zh-CN", { hour12: false })
                                : "";
                            log(`✅ 凭证「${data.label || email || "?"}」已推送/更新${at ? `（更新时间 ${at}）` : ""}（${data.cookies} 条 Cookie），pggo- 模型已可用`);
                            resolve(data);
                        } else {
                            const msg = data?.error?.message || data?.detail || resp.responseText;
                            log(`❌ 推送失败 [${resp.status}]: ${msg}`);
                            reject(mkError(resp.status, "push_failed", msg));
                        }
                    } catch (e) {
                        log(`❌ 推送响应解析失败: ${e}`);
                        reject(mkError(502, "push_response_invalid", String(e)));
                    }
                },
                onerror: (e) => {
                    log("❌ 推送网络错误: " + (e && e.error));
                    reject(mkError(502, "push_network_error", String(e && e.error)));
                },
                ontimeout: () => {
                    log("❌ 推送超时");
                    reject(mkError(504, "push_timeout", "推送超时"));
                },
            });
        });
    }

    // ==================== 更新检查 ====================

    // 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等返回 0
    // （非数字段按 0 处理——parseInt + 兜底，避免 NaN 让比较失效）
    function cmpVersion(a, b) {
        const seg = (s) =>
            String(s)
                .split(".")
                .map((x) => {
                    const n = parseInt(x, 10);
                    return isNaN(n) ? 0 : n;
                });
        const pa = seg(a);
        const pb = seg(b);
        for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
            const d = (pa[i] || 0) - (pb[i] || 0);
            if (d) return d > 0 ? 1 : -1;
        }
        return 0;
    }

    // 检查更新：拉取 SCRIPT_URL 的脚本头，比对 @version。
    // manual=true 表示用户手动触发（结果即使无更新也在日志提示）。
    // 注意不能直接检查 Tampermonkey 自身的更新状态——脚本可能被设置
    // 为"从不检查更新"，所以脚本自己拉一次头部做比对。
    async function checkForUpdate(manual) {
        updateInfo = "checking";
        updatePanel();
        log("🔍 检查更新…（当前 v" + CLIENT_VERSION + "）");
        const result = await new Promise((resolve) => {
            const done = (v) => {
                updateInfo = v; // null / "latest" / "新版本号"
                updatePanel();
                resolve(v);
            };
            let settled = false;
            const finish = (v) => {
                if (!settled) { settled = true; done(v); }
            };
            try {
                gmXhr({
                    method: "GET",
                    url: SCRIPT_URL + "?_ts=" + Date.now(), // 破缓存
                    timeout: UPDATE_CHECK_TIMEOUT_MS,
                    onload: (resp) => {
                        try {
                            if (resp.status !== 200) {
                                log(`⚠ 检查更新失败 [${resp.status}]`);
                                finish(null);
                                return;
                            }
                            const m = (resp.responseText || "").match(/@version\s+([\d.]+)/);
                            if (!m) {
                                log("⚠ 检查更新失败：远端脚本头无 @version");
                                finish(null);
                                return;
                            }
                            const remote = m[1];
                            if (cmpVersion(remote, CLIENT_VERSION) > 0) {
                                log(`🔔 发现新版本 v${remote}（当前 v${CLIENT_VERSION}），请在面板点击「⬇ 更新」`);
                                finish(remote);
                            } else {
                                if (manual) log(`✅ 已是最新版本（v${CLIENT_VERSION}）`);
                                finish("latest");
                            }
                        } catch (e) {
                            log("⚠ 检查更新解析失败: " + e);
                            finish(null);
                        }
                    },
                    onerror: () => { log("⚠ 检查更新网络错误"); finish(null); },
                    ontimeout: () => { log("⚠ 检查更新超时"); finish(null); },
                });
            } catch (e) {
                log("⚠ 检查更新异常: " + e);
                finish(null);
            }
        });
        return result;
    }

    // 打开更新页（新标签页加载脚本 → Tampermonkey 弹确认 → 更新）
    function openUpdatePage() {
        const url = SCRIPT_URL + "?_update=" + Date.now(); // 破缓存，确保拿到最新版
        log("⬇ 打开更新页: " + url);
        try {
            if (typeof GM_openInTab === "function") {
                GM_openInTab(url, { active: true });
                return;
            }
            // GM.openInTab 兜底（@grant GM.xmlHttpRequest 之外的新式 API）
            if (typeof GM !== "undefined" && GM.openInTab) {
                GM.openInTab(url, { active: true });
                return;
            }
            const opened = window.open(url, "_blank");
            if (!opened) log("⚠ 浏览器拦截了弹窗，请允许弹窗后重试，或手动访问 " + url);
        } catch (e) {
            log("⚠ 打开更新页失败: " + e + "，请手动访问 " + url);
        }
    }

    // ==================== 网页保活（小窗 / 后台音频，可分别开关） ====================
    // 原理：浏览器会冻结/丢弃"完全后台"的标签页（timer 节流、JS 冻结、
    // 内存节省），导致 WS 断开后无法重连。两种状态可豁免：
    //   a. 画中画（PiP）小窗在播视频 —— 页面视为前台活跃，不冻结不节流；
    //   b. 标签页"正在播放音频" —— 不冻结、不深度节流、不被丢弃。
    // 两种保活相互独立：可只开一个，也可同时开启。
    //   小窗：canvas 视频流 + 画中画（需要用户手势，点开关即是）；
    //   音频：<audio> 循环播放生成的近无声 WAV（16Hz 正弦，能量非零——
    //         全零样本会被 iOS 判为无声会话收回豁免；16Hz 人耳不可闻、
    //         扬声器无法重放，但浏览器仍判定为"正在播放音频"）。

    const keepalive = {
        pip: false, // 小窗保活是否开启
        audio: false, // 后台音频保活是否开启
        screenLockOn: false, // 屏幕常亮开关（音频保活的加成项，耗电，默认关）
        videoEl: null,
        canvas: null,
        drawTimer: null,
        audioEl: null, // <audio> 近无声循环（iOS 兼容主路径）
        audioCtx: null,
        osc: null,
        wakeLock: null, // Screen Wake Lock（iOS 16.4+）
    };

    function drawKeepaliveFrame(canvas) {
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#111116";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#4ade80";
        ctx.font = "16px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("🐱 保活中", canvas.width / 2, canvas.height / 2 - 8);
        ctx.fillStyle = "#9a9aa8";
        ctx.font = "10px system-ui, sans-serif";
        ctx.fillText(
            new Date().toLocaleTimeString(),
            canvas.width / 2,
            canvas.height / 2 + 12
        );
    }

    // ---------- 小窗（画中画） ----------

    async function startPip() {
        if (keepalive.pip) return;
        // requestPictureInPicture 需要用户手势（点开关即是），且要求视频
        // 元数据就绪（readyState >= 1），所以先就绪、play，再请求 PiP
        let video = null;
        try {
            if (document.pictureInPictureEnabled === false) {
                throw new Error("浏览器不支持画中画");
            }
            const canvas = document.createElement("canvas");
            canvas.width = 256;
            canvas.height = 144;
            drawKeepaliveFrame(canvas);
            const stream = canvas.captureStream(1); // 1fps，极低开销
            video = document.createElement("video");
            video.srcObject = stream;
            video.muted = true;
            video.playsInline = true;
            video.style.cssText =
                "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
            document.documentElement.appendChild(video);
            if (!(await waitFor(() => video.readyState >= 1, 3000, 30))) {
                throw new Error("视频流未就绪");
            }
            await video.play();
            await video.requestPictureInPicture();
            video.addEventListener("leavepictureinpicture", () => {
                // 用户手动关掉小窗：同步关闭开关，避免面板显示"开着"但实际没在保活
                if (keepalive.pip) {
                    log("⚠ 小窗被关闭，小窗保活已停止（需要请重新打开开关）");
                    stopPip(true);
                }
            });
            keepalive.videoEl = video;
            keepalive.canvas = canvas;
            keepalive.drawTimer = setInterval(
                () => drawKeepaliveFrame(canvas),
                1000
            );
            keepalive.pip = true;
            log("✅ 小窗保活已开启");
        } catch (e) {
            if (video) {
                try {
                    video.pause();
                    video.srcObject = null;
                } catch (_) {}
                video.remove();
            }
            log("❌ 小窗保活开启失败：" + ((e && e.message) || e) + "（手机浏览器多数不支持，可改用后台音频）");
        }
        updatePanel();
    }

    function stopPip(silent) {
        const wasOn = keepalive.pip;
        keepalive.pip = false; // 先置位，避免 leavepictureinpicture 事件回调里重复停止
        try {
            if (document.pictureInPictureElement) document.exitPictureInPicture();
        } catch (_) {}
        if (keepalive.drawTimer) {
            clearInterval(keepalive.drawTimer);
            keepalive.drawTimer = null;
        }
        if (keepalive.videoEl) {
            try {
                keepalive.videoEl.pause();
                keepalive.videoEl.srcObject = null;
            } catch (_) {}
            keepalive.videoEl.remove();
            keepalive.videoEl = null;
        }
        keepalive.canvas = null;
        if (wasOn && !silent) log("🔴 小窗保活已关闭");
        updatePanel();
    }

    function togglePip() {
        if (!pipSupported()) {
            log("⚠ 当前浏览器不支持画中画（iPhone Safari），请改用后台音频保活");
            return;
        }
        if (keepalive.pip) {
            stopPip();
        } else {
            startPip().catch((e) =>
                log("❌ 小窗保活异常: " + ((e && e.message) || e))
            );
        }
    }

    // ---------- 后台音频 ----------
    // iOS 上 WebAudio 近无声振荡器（30Hz/0.001 增益）可能被判静音，
    // AudioContext 也常被系统中断。改为 <audio> 循环播放生成的近无声 WAV
    // + MediaSession 元数据——更接近 iOS 认可的"正在播放"。
    // 注意样本不能全零：iOS 会把"数字静音"会话判定为无声并收回播放豁免，
    // 改用 16Hz 低频正弦（振幅 64/32768 ≈ -54dBFS）：人耳听不见、手机
    // 扬声器也无法重放，但能量非零，系统视为真实播放中。
    // 桌面仍可用 AudioContext；实现按支持度自动选择，两者共用开关。

    const KEEPALIVE_WAV_SAMPLE_RATE = 8000;
    const KEEPALIVE_WAV_SECONDS = 8;
    const KEEPALIVE_WAV_FREQUENCY = 16;
    const KEEPALIVE_WAV_AMPLITUDE = 64;

    let keepaliveWavDataUrl = "";
    function makeNearSilentWavDataUrl() {
        if (keepaliveWavDataUrl) return keepaliveWavDataUrl; // 生成一次复用
        const numSamples = Math.floor(KEEPALIVE_WAV_SAMPLE_RATE * KEEPALIVE_WAV_SECONDS);
        const dataSize = numSamples * 2;
        const buf = new ArrayBuffer(44 + dataSize);
        const v = new DataView(buf);
        const wstr = (off, s) => {
            for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
        };
        wstr(0, "RIFF");
        v.setUint32(4, 36 + dataSize, true);
        wstr(8, "WAVE");
        wstr(12, "fmt ");
        v.setUint32(16, 16, true);
        v.setUint16(20, 1, true); // PCM
        v.setUint16(22, 1, true); // mono
        v.setUint32(24, KEEPALIVE_WAV_SAMPLE_RATE, true);
        v.setUint32(28, KEEPALIVE_WAV_SAMPLE_RATE * 2, true); // byte rate
        v.setUint16(32, 2, true); // block align
        v.setUint16(34, 16, true); // bits
        wstr(36, "data");
        v.setUint32(40, dataSize, true);
        // 近无声正弦样本（能量非零，见上方注释）
        for (let i = 0; i < numSamples; i++) {
            const phase = 2 * Math.PI * KEEPALIVE_WAV_FREQUENCY * i / KEEPALIVE_WAV_SAMPLE_RATE;
            v.setInt16(44 + i * 2, Math.round(KEEPALIVE_WAV_AMPLITUDE * Math.sin(phase)), true);
        }
        let bin = "";
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        keepaliveWavDataUrl = "data:audio/wav;base64," + btoa(bin);
        return keepaliveWavDataUrl;
    }

    async function startAudio() {
        if (keepalive.audio) return;
        let audioEl = null;
        let audioCtx = null;
        try {
            // 首选 <audio> 近无声 WAV 循环（iOS 兼容好）
            audioEl = document.createElement("audio");
            audioEl.src = makeNearSilentWavDataUrl();
            audioEl.loop = true;
            audioEl.volume = 1;
            audioEl.playsInline = true;
            audioEl.setAttribute("playsinline", "true");
            audioEl.preload = "auto";
            // iOS 需要播放手势解锁；点开关即是手势。挂在 DOM 上更接近
            // 正常媒体元素，部分浏览器对游离元素不维持媒体会话
            //（document-start 极早期 documentElement 可能尚不存在，此时
            //  以游离元素播放即可，不因此失败）
            if (document.documentElement) document.documentElement.appendChild(audioEl);
            const p = audioEl.play();
            if (p && typeof p.then === "function") await p;
            if (audioEl.paused) throw new Error("play() 后仍处于暂停状态");
            // MediaSession：向系统声明"正在播放"，降低被判闲置的概率
            try {
                if ("mediaSession" in navigator) {
                    navigator.mediaSession.metadata = new W.MediaMetadata({
                        title: "Catiecli 保活中",
                        artist: "catiecli",
                    });
                    navigator.mediaSession.setActionHandler("play", () => { if (!keepalive.audio) toggleAudio(); });
                    navigator.mediaSession.setActionHandler("pause", () => { if (keepalive.audio) toggleAudio(); });
                    navigator.mediaSession.setActionHandler("stop", () => { if (keepalive.audio) toggleAudio(); });
                }
            } catch (_) {}
            // 被系统中断（来电/切换音频源）时尽力恢复
            audioEl.addEventListener("pause", () => {
                if (keepalive.audio && audioEl) {
                    log("⚠ 后台音频被系统暂停，正在尝试恢复…");
                    audioEl.play().catch(() => {});
                }
            });
            keepalive.audioEl = audioEl;
            keepalive.audio = true;
            log("✅ 后台音频保活已开启（audio 近无声循环）");
        } catch (e1) {
            // audio 元素失败 → 回退 AudioContext（桌面浏览器）
            if (audioEl) {
                try { audioEl.pause(); } catch (_) {}
                try { audioEl.remove(); } catch (_) {}
                keepalive.audioEl = null;
            }
            try {
                const AudioCtx = W.AudioContext || W.webkitAudioContext;
                if (!AudioCtx) throw new Error("浏览器不支持音频播放");
                audioCtx = new AudioCtx();
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = "sine";
                osc.frequency.value = 30;
                gain.gain.value = 0.001;
                osc.connect(gain);
                gain.connect(audioCtx.destination);
                if (audioCtx.state === "suspended") await audioCtx.resume();
                osc.start();
                audioCtx.onstatechange = () => {
                    if (keepalive.audio && audioCtx && audioCtx.state !== "running") {
                        log("⚠ 后台音频被浏览器暂停，正在尝试恢复…");
                        audioCtx.resume().catch(() => {});
                    }
                };
                keepalive.audioCtx = audioCtx;
                keepalive.osc = osc;
                keepalive.audio = true;
                log("✅ 后台音频保活已开启（AudioContext）");
            } catch (e2) {
                if (audioCtx) {
                    try { audioCtx.close(); } catch (_) {}
                }
                log("❌ 后台音频保活开启失败：" + ((e2 && e2.message) || e2));
            }
        }
        // 可选加成：屏幕唤醒锁（iOS 16.4+）——独立开关，用户勾选才开
        if (keepalive.audio && keepalive.screenLockOn) requestWakeLock();
        updatePanel();
    }

    // ---------- 屏幕唤醒锁（独立开关；耗电，默认关） ----------

    async function requestWakeLock() {
        try {
            if (
                navigator.wakeLock &&
                typeof navigator.wakeLock.request === "function"
            ) {
                const lock = await navigator.wakeLock.request("screen");
                keepalive.wakeLock = lock;
                lock.addEventListener("release", () => {
                    if (keepalive.wakeLock === lock) keepalive.wakeLock = null;
                });
                log("✅ 屏幕常亮已开启（耗电会增加）");
            } else {
                log("⚠ 当前浏览器不支持屏幕唤醒锁（iOS 需 16.4+）");
                keepalive.screenLockOn = false;
            }
        } catch (e) {
            log("⚠ 屏幕唤醒锁申请失败: " + ((e && e.message) || e));
            keepalive.screenLockOn = false;
        }
        updatePanel();
    }

    function releaseWakeLock() {
        if (keepalive.wakeLock) {
            try { keepalive.wakeLock.release(); } catch (_) {}
            keepalive.wakeLock = null;
            log("🔴 屏幕常亮已关闭");
        }
    }

    function toggleScreenLock() {
        if (keepalive.screenLockOn) {
            keepalive.screenLockOn = false;
            releaseWakeLock();
            updatePanel();
        } else {
            keepalive.screenLockOn = true;
            requestWakeLock().then(updatePanel);
        }
    }

    function stopAudio() {
        const wasOn = keepalive.audio;
        keepalive.audio = false;
        if (keepalive.audioEl) {
            try {
                keepalive.audioEl.pause();
                keepalive.audioEl.removeAttribute("src");
                keepalive.audioEl.load();
                keepalive.audioEl.remove();
            } catch (_) {}
            keepalive.audioEl = null;
        }
        if (keepalive.osc) {
            try {
                keepalive.osc.stop();
            } catch (_) {}
            keepalive.osc = null;
        }
        if (keepalive.audioCtx) {
            try {
                keepalive.audioCtx.onstatechange = null;
                keepalive.audioCtx.close();
            } catch (_) {}
            keepalive.audioCtx = null;
        }
        // 音频关了，屏幕常亮跟着关（它只是音频保活的加成）
        keepalive.screenLockOn = false;
        releaseWakeLock();
        try {
            if ("mediaSession" in navigator) {
                navigator.mediaSession.metadata = null;
                navigator.mediaSession.setActionHandler("play", null);
                navigator.mediaSession.setActionHandler("pause", null);
                navigator.mediaSession.setActionHandler("stop", null);
            }
        } catch (_) {}
        if (wasOn) log("🔴 后台音频保活已关闭");
        updatePanel();
    }

    function toggleAudio() {
        if (keepalive.audio) {
            stopAudio();
        } else {
            startAudio().catch((e) =>
                log("❌ 后台音频保活异常: " + ((e && e.message) || e))
            );
        }
    }

    // 切回本页时：audio 元素被系统暂停则续播；AudioContext 被挂起则 resume；
    // wakeLock 随可见性自动释放，回前台时按开关状态重新申请
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "visible") return;
        if (keepalive.audio && keepalive.audioEl && keepalive.audioEl.paused) {
            keepalive.audioEl.play().catch(() => {});
        }
        if (
            keepalive.audio &&
            keepalive.audioCtx &&
            keepalive.audioCtx.state === "suspended"
        ) {
            keepalive.audioCtx.resume().catch(() => {});
        }
        if (keepalive.audio && keepalive.screenLockOn && !keepalive.wakeLock) {
            requestWakeLock().catch(() => {});
        }
    });

    // ==================== WS 心跳保活（worker 驱动） ====================
    // 后台标签页的主线程 setInterval 会被浏览器节流（隐藏 5 分钟后压到每分钟一次），
    // 心跳一断，中间的代理/CDN（wss 经 nginx 等）会按空闲超时掐掉连接——表现为
    // "后台挂一会儿就掉线、切回来才重连"。Worker 线程的定时器不受页面节流影响，
    // 由它 tick，主线程在 message 事件里补发心跳（message 派发不受节流限制）。
    // （照 aistudio-executor 的 startKeepAlive；worker 起不来时回退主线程定时器。）
    //
    // 注意：aistudio.google.com 全站开启 Trusted Types（require-trusted-types-for
    // 'script'），new Worker(blobURL) 的 URL 参数只接受 TrustedScriptURL，直接传
    // blob: 字符串会抛 "This assignment requires a TrustedScriptURL"。
    // Tampermonkey 沙箱里 createScriptURL 策略是页面提供的，不可靠，所以这里
    // 先探测 window.trustedTypes 可用性，构造失败/无策略一律走主线程定时器兜底。
    let kaWorker = null;
    let kaTimer = null;
    let pongSeen = false; // 后端是否应答过 ping（新版 pg_service 回 pong）
    let pingsOut = 0; // 已发出但未收到任何下行应答的心跳数

    function wsHeartbeat() {
        if (state.wsStatus !== "connected") return;
        // 半开检测：只有在后端确认会回 pong 的情况下才做判定——
        // 旧版后端不回，这里绝不能凭"没收到消息"就断线重连（空闲也连接健康）。
        if (pongSeen && pingsOut >= HEARTBEAT_MAX_SILENT_ROUNDS) {
            log(`⚠ 心跳 ${HEARTBEAT_MAX_SILENT_ROUNDS} 轮无应答（${(HEARTBEAT_MS / 1000) * HEARTBEAT_MAX_SILENT_ROUNDS}s 无下行），判定半开连接，主动断开重连`);
            pingsOut = 0;
            disconnectWs("heartbeat-timeout");
            scheduleConnect(1000);
            return;
        }
        if (wsSend({ type: "ping", ts: Date.now() })) pingsOut++;
    }

    function startHeartbeatWorker() {
        if (kaWorker || kaTimer) return;
        const fallbackToTimer = () => {
            if (kaTimer) return;
            try {
                if (kaWorker) kaWorker.terminate();
            } catch (_) {}
            kaWorker = null;
            kaTimer = setInterval(wsHeartbeat, HEARTBEAT_MS);
        };
        let url = null;
        try {
            url = URL.createObjectURL(
                new Blob(
                    [
                        "const t=setInterval(()=>postMessage('tick')," +
                            HEARTBEAT_MS +
                            ");onmessage=e=>{if(e.data==='stop'){clearInterval(t);close()}};",
                    ],
                    { type: "text/javascript" }
                )
            );
            // Trusted Types（require-trusted-types-for 'script'）下 Worker 的
            // scriptURL 是 TrustedScriptURL 槽位，传字符串会抛
            // "This assignment requires a TrustedScriptURL"。
            // 依次尝试：① 自建策略（CSP trusted-types 未锁名时可用）
            //          ② 页面 defaultPolicy（AI Studio 自建过默认策略时蹭用）
            //          ③ 无 TT 环境直接传 blob URL
            // 都不行就回退主线程定时器（配合面板的音频/小窗保活开关）。
            let workerUrl = null;
            const tt = W.trustedTypes;
            if (tt && tt.createPolicy) {
                try {
                    workerUrl = tt
                        .createPolicy("catiecli-ka", { createScriptURL: (s) => s })
                        .createScriptURL(url);
                } catch (_) {
                    if (tt.defaultPolicy) {
                        workerUrl = tt.defaultPolicy.createScriptURL(url);
                    }
                }
            } else {
                workerUrl = url;
            }
            if (!workerUrl) throw new Error("Trusted Types 锁定，无法构造 worker 脚本 URL");
            kaWorker = new Worker(workerUrl);
            kaWorker.onmessage = (ev) => {
                if (ev.data === "tick") wsHeartbeat();
            };
            kaWorker.onerror = () => {
                log("⚠ 心跳 worker 异常，回退主线程定时器");
                fallbackToTimer();
            };
        } catch (e) {
            log("⚠ 心跳 worker 不可用（" + ((e && e.message) || e) + "），用主线程定时器");
            fallbackToTimer();
        }
    }

    // ==================== 请求执行（协议无关） ====================

    function mkError(httpStatus, code, message, body) {
        return {
            httpStatus,
            code,
            message,
            // 上游原始响应体（仅供本地使用记录展示，不回传后端）
            body: body == null ? undefined : String(body).slice(0, MAX_ACTIVITY_ERROR_BODY_LENGTH),
            __pgError: true,
        };
    }

    // 稀疏 JSON 规范化：MakerSuite 错误体是稀疏数组（空槽省略，
    // 如 [,[8,"msg",...]] 实为 [null,[8,"msg",...]]），不是合法 JSON。
    // 逐字符扫描，字符串内原样保留；字符串外把 ,[ / ,, / ,] 的空槽补 null
    function normalizeSparseJSON(text) {
        let out = "";
        let inString = false;
        let escaped = false;
        let prev = "";
        for (const ch of text) {
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === "\\") escaped = true;
                else if (ch === '"') inString = false;
                out += ch;
                continue;
            }
            if (ch === '"') {
                inString = true;
                prev = '"';
                out += ch;
                continue;
            }
            if (ch === "," && (prev === "[" || prev === ",")) {
                prev = ",";
                out += "null,";
                continue;
            }
            if (ch === "]" && prev === ",") {
                prev = "]";
                out += "null]";
                continue;
            }
            if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") prev = ch;
            out += ch;
        }
        return out;
    }

    // 上游错误体解析：剥离 XSSI 前缀 )]}' 后解析 JSON，
    // 数组格式取 payload[1][1]（Google 常见嵌套错误），否则 error.message
    function parseUpstreamErrorBody(text) {
        const raw = String(text || "").trim();
        if (!raw) return null;
        let payload = null;
        try {
            payload = JSON.parse(raw.replace(/^\)\]\}'\s*/, ""));
        } catch (_) {
            // JSON.parse 失败：试稀疏数组规范化（[,[8,"msg",...]] → [null,[8,"msg",...]]）
            try {
                payload = JSON.parse(normalizeSparseJSON(raw.replace(/^\)\]\}'\s*/, "")));
            } catch (_) {
                return null;
            }
        }
        try {
            // direct 形态 [16,"msg",...]：root[0] 是数字、root[1] 是消息
            if (Array.isArray(payload) && typeof payload[0] === "number" &&
                typeof payload[1] === "string" && payload[1].trim()) {
                return payload[1].trim();
            }
            if (Array.isArray(payload) && Array.isArray(payload[1])) {
                const msg = payload[1][1];
                if (typeof msg === "string" && msg.trim()) return msg.trim();
                if (payload[1][1] && typeof payload[1][1] === "object") {
                    const inner = payload[1][1];
                    // 嵌套 [null,[null,"msg"]] 形态
                    if (Array.isArray(inner) && typeof inner[1] === "string" && inner[1].trim()) {
                        return inner[1].trim();
                    }
                    if (typeof inner.message === "string" && inner.message.trim()) {
                        return inner.message.trim();
                    }
                }
            }
            if (payload && typeof payload === "object" && !Array.isArray(payload)) {
                if (payload.error && typeof payload.error.message === "string" && payload.error.message.trim()) {
                    return payload.error.message.trim();
                }
            }
        } catch (_) {}
        return null;
    }

    // requestBody 结构（后端 pg_proxy 下发）：
    //   {"wire": [...], "binding": "..."}
    // 执行：digest=sha256(binding) → fresh proof 注入 wire[4]（与输入框
    // 内容无关，不写输入框）→ 页面 fetch → 回传原始文本。
    // onChunk 存在时切真流式：响应头到达后逐块读取逐块回调（增量下发），
    // 完整文本仍作为返回值（后端非流式路径与统计共用）
    async function runGenerate(requestId, payload, signal, tm, onChunk) {
        tm = tm || {};
        ensureWaaReady();
        const { wire, binding } = payload;
        if (!Array.isArray(wire) || typeof binding !== "string") {
            throw mkError(400, "invalid_payload", "requestBody 缺少 wire/binding 字段");
        }

        // 1. fresh proof 注入 field 5（wire[4]）——digest 与输入框无关
        let t = Date.now();
        const digest = await sha256Hex(binding);
        wire[4] = await takeProof(digest);
        tm.proof = Date.now() - t;

        // 2. 页面上下文发送（FETCH_TIMEOUT_MS 硬超时，防 fetch 永久挂起）
        //    使用原生 fetch（W.__pgOrigFetch），避免触发自己的请求头捕获
        const headers = await buildUpstreamHeaders();
        // 自管超时（覆盖"读取响应体"阶段），不依赖 AbortSignal.any
        // （部分手机浏览器没有它，会丢失取消信号）
        const fetchAc = new AbortController();
        let timedOut = false;
        const fetchTimer = setTimeout(() => {
            timedOut = true;
            try { fetchAc.abort(); } catch (_) {}
        }, FETCH_TIMEOUT_MS);
        const onOuterAbort = () => {
            try { fetchAc.abort(); } catch (_) {}
        };
        if (signal) {
            if (signal.aborted) onOuterAbort();
            else signal.addEventListener("abort", onOuterAbort, { once: true });
        }
        const doFetch = W.__pgOrigFetch || W.fetch;
        // CountTokens 保活：主请求期间向同端点发一次真实 CountTokens RPC
        //（对齐页面行为；同一连接池，防代理/NAT 连接级空闲超时）
        const stopCountTokensKeepAlive = startCountTokensKeepAlive(fetchAc.signal);
        t = Date.now();
        let gotResponseHeaders = false;
        try {
            const resp = await doFetch.call(W, GENERATE_URL, {
                method: "POST",
                headers,
                body: JSON.stringify(wire),
                credentials: "include",
                signal: fetchAc.signal,
            });
            gotResponseHeaders = true;

            if (!resp.ok) {
                const text = await resp.text().catch(() => "");
                // 剥 XSSI 前缀提取真实错误消息（Google 数组格式 [null,[null,"msg"]]）
                const realMsg = parseUpstreamErrorBody(text);
                throw mkError(
                    resp.status,
                    "upstream_http_error",
                    realMsg
                        ? `上游 HTTP ${resp.status}: ${realMsg.slice(0, 300)}`
                        : `上游 HTTP ${resp.status}` +
                          (text ? `: ${text.slice(0, 300)}` : ""),
                    text
                );
            }
            let raw;
            if (onChunk && resp.body && typeof resp.body.getReader === "function") {
                // 真流式：逐块读取逐块回调（上游 repeated 帧增量下发）。
                // 多字节 UTF-8 序列可能跨块：TextDecoder({stream:true}) 负责
                // 跨块拼接，不产生 U+FFFD。上游确认 200 后取消不再回滚已
                // 推送的块（后端已发头，只能继续或报错）
                const reader = resp.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let sent = 0;
                let acc = "";
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const piece = decoder.decode(value, { stream: true });
                    if (!piece) continue;
                    acc += piece;
                    try {
                        onChunk(piece);
                        sent++;
                    } catch (_) {
                        // 回调失败（WS 断开等）：deliverResult 内部已暂存 outbox，不中断读取
                    }
                }
                const tail = decoder.decode();
                if (tail) {
                    acc += tail;
                    try { onChunk(tail); sent++; } catch (_) {}
                }
                raw = acc;
                tm.fetch = Date.now() - t;
                if (sent === 0 && (!raw || !raw.trim())) {
                    throw mkError(502, "empty_response", "上游返回空内容");
                }
            } else {
                raw = await resp.text();
                tm.fetch = Date.now() - t;
            }
            if (signal && signal.aborted && !timedOut) {
                throw mkError(499, "cancelled", "请求已取消");
            }
            // 空响应不能当成功回传（否则后端拿到"完成"但没有任何文字）
            if (!raw || !raw.trim()) {
                throw mkError(502, "empty_response", "上游返回空内容");
            }
            return raw;
        } catch (e) {
            if (e && e.__pgError) throw e;
            if (timedOut) {
                throw mkError(
                    504,
                    "upstream_timeout",
                    `上游 ${FETCH_TIMEOUT_MS / 1000}s 无响应（页面可能被后台冻结，或上游卡住）`
                );
            }
            // TypeError: Failed to fetch —— 原生错误零细节，补齐现场用于定位：
            //   aborted（谁触发）/ 页面可见性 / navigator.onLine / 耗时 /
            //   请求头键名（判断是否引导）/ fetch 来源
            if (e instanceof TypeError || (e && e.name === "TypeError")) {
                const abortedBy =
                    fetchAc.signal.aborted
                        ? timedOut ? "自管超时" : (signal && signal.aborted ? "后端取消/硬超时" : "未知来源 abort")
                        : "无";
                const detail = [
                    `网络层 fetch 失败（TypeError: ${(e && e.message) || e}）`,
                    `阶段=${gotResponseHeaders ? "响应头已到，读正文时断流（请求已被上游受理，多为网络路径被切）" : "未收到响应头（建连失败或被上游掐断，查头/proof）"}`,
                    `abort=${abortedBy}`,
                    `耗时=${Date.now() - t}ms`,
                    `proof=${tm.proof || 0}ms`,
                    `页面可见性=${document.visibilityState}`,
                    `在线状态=${navigator.onLine ? "在线" : "离线"}`,
                    `请求头键=[${Object.keys(headers).join(",")}]`,
                    `x-goog-api-key=${headers["x-goog-api-key"] ? "有" : "无"}`,
                    `fetch来源=${W.__pgOrigFetch ? "原生 fetch（未被改写）" : "window.fetch（⚠ 可能被页面/其他脚本改写）"}`,
                ].join(" | ");
                log(`⚠ 上游 fetch 诊断 [${requestId.slice(0, 8)}]: ${detail}`);
                throw mkError(502, "upstream_fetch_failed", detail);
            }
            throw e;
        } finally {
            stopCountTokensKeepAlive();
            clearTimeout(fetchTimer);
            if (signal) signal.removeEventListener("abort", onOuterAbort);
        }
    }

        // 执行并投递：流式逐块 stream-chunk + stream-end，非流式整包
        // response。主路径与 401/403 重签重试共用；label 进日志
        //（"" / "重签后"）。
        async function executeAndDeliver(requestId, payload, model, stream, signal, tm, finishActivity, label) {
            const runner = runGenerate;
            if (stream) {
                // 真流式：逐块 stream-chunk（保序经 deliverResult 的 outbox
                // 直发/补发机制），读完后单发 stream-end
                let rawLen = 0;
                let rawBytes = 0; // 输出字节（UTF-8）
                let chunkCount = 0;
                const raw = await runner(requestId, payload, signal, tm, (piece) => {
                    chunkCount++;
                    rawLen += piece.length;
                    rawBytes += utf8Len(piece);
                    deliverResult({
                        type: "stream-chunk",
                        requestId,
                        chunkBody: piece,
                    });
                });
                if (state.aborted.has(requestId)) {
                    state.aborted.delete(requestId);
                    finishActivity("cancelled", `${label}流式中途取消（已发 ${chunkCount} 块 / ${rawBytes} 字节）`, null, rawBytes);
                    return;
                }
                const ok = deliverResult({ type: "stream-end", requestId, status: 200 });
                const info =
                    `${rawBytes}字节/${chunkCount}块 ` +
                    `proof${tm.proof || 0}ms 上游${Math.round((tm.fetch || 0) / 1000)}s`;
                log(
                    ok
                        ? `✔ 完成（${label}流式） ${requestId.slice(0, 8)} ${info}`
                        : `✔ 完成但 WS 未连接，已暂存待补发 ${requestId.slice(0, 8)} ${info}`
                );
                if (rawLen < 200) {
                    log("⚠ 响应内容很短: " + String(raw).slice(0, 160));
                }
                finishActivity(
                    "success",
                    `${label ? label + " " : ""}${rawBytes} 字节 / ${chunkCount} 块${ok ? "" : "（WS 断线，已暂存补发）"}`,
                    null,
                    rawBytes
                );
                saveReplayCache(model, true, raw); // ⚡ 断线补偿：缓存最新成功响应体
            } else {
                const raw = await runner(requestId, payload, signal, tm);
                if (state.aborted.has(requestId)) {
                    state.aborted.delete(requestId);
                    finishActivity("cancelled", `${label}请求已取消`);
                    return;
                }
                const ok = deliverResult({
                    type: "response",
                    requestId,
                    status: 200,
                    rawResponse: raw,
                });
                const rawBytes = utf8Len(raw);
                const info =
                    `${rawBytes}字节 ` +
                    `proof${tm.proof || 0}ms 上游${Math.round((tm.fetch || 0) / 1000)}s`;
                log(
                    ok
                        ? `✔ 完成${label ? `（${label}）` : ""} ${requestId.slice(0, 8)} ${info}`
                        : `✔ 完成但 WS 未连接，已暂存待补发 ${requestId.slice(0, 8)} ${info}`
                );
                if (raw.length < 200) {
                    log("⚠ 响应内容很短: " + raw.slice(0, 160));
                }
                finishActivity(
                    "success",
                    `${label ? label + " " : ""}${rawBytes} 字节${ok ? "" : "（WS 断线，已暂存补发）"}`,
                    null,
                    rawBytes
                );
                saveReplayCache(model, false, raw); // ⚡ 断线补偿：缓存最新成功响应体
            }
        }

    // 并发执行（无串行队列）：digest 与输入框无关，每请求
    // 独立 AbortController + 15 分钟硬超时；上游 401/403 自动重签一次。

    async function handleRequest(msg) {
        const { requestId, model, stream, requestBody } = msg;
        const startedAt = Date.now();
        const actRid = String(requestId || "-").slice(0, 12);
        const actModel = String(model || "-");
        // 使用记录：本请求的结果（成功/失败/取消），各出口调用一次；
        // 提前 return 未落账的由 finally 兜底补记
        let actResult = null;
        const inBytes = utf8Len(requestBody); // 输入：后端下发的请求体 UTF-8 字节数
        const finishActivity = (result, message, error, outBytes) => {
            if (actResult) return; // 只记第一条（重签成功以最终结果为准）
            actResult = { result, message, error };
            if (result === "success") {
                state.successCount++;
                saveActivityStats();
            } else if (result === "error") {
                state.failureCount++;
                saveActivityStats();
            }
            addActivity({
                at: Date.now(),
                requestID: actRid,
                model: actModel,
                stream: !!stream,
                result,
                message: message || "",
                error: error || null,
                durationMS: Date.now() - startedAt,
                inBytes,
                outBytes: typeof outBytes === "number" ? outBytes : 0,
            });
        };
        let payload;
        try {
            payload = JSON.parse(requestBody);
        } catch (e) {
            const detail = "requestBody 不是有效 JSON: " + e.message;
            sendError(requestId, 400, {
                code: "invalid_request_body",
                message: detail,
            });
            finishActivity("error", detail, {
                status: 400,
                code: "invalid_request_body",
                message: detail,
            });
            return;
        }
        // ⚡ 返回缓存内容：armed 时下一个请求直接回缓存（不引导、不发上游）
        if (tryReplayRequest(requestId, stream)) {
            finishActivity("success", "⚡ 缓存回传（未请求上游）", null,
                state.replayCache ? utf8Len(state.replayCache.body) : 0);
            return;
        }
        state.requestCount++;
        const inflight = state.controllers.size + 1;
        log(
            `▶ 请求 ${requestId.slice(0, 8)} model=${model}${stream ? " (stream)" : ""}` +
                `（进行中 ${inflight} 个）`
        );
        const tm = {};
        const controller = new AbortController();
        state.controllers.set(requestId, controller);
        // 硬超时：整个请求最长 REQUEST_HARD_TIMEOUT_MS，防止任何环节挂起
        const hardTimer = setTimeout(() => {
            try { controller.abort(); } catch (_) {}
        }, REQUEST_HARD_TIMEOUT_MS);
        try {
            // WAA 未就绪 → 单飞自动引导（并发请求共享同一次引导）。
            // pg 首请求随引导融合执行（页面点 Run 那一发被顶替：即时新鲜
            // 头 + fresh proof），融合完成即已投递，跳过常规 runGenerate；
            // 共享引导 / 拦截关闭时退回常规发送
            if (!state.waaReady) {
                const pendingReq = {
                    requestId,
                    payload,
                    model,
                    stream,
                    controller,
                    startedAt,
                    finishActivity,
                    inBytes,
                };
                const fused = await ensureBootstrapped("请求到达", pendingReq);
                if (fused) {
                    log(`✔ 融合完成，跳过常规发送 ${requestId.slice(0, 8)}`);
                    return;
                }
            }
            if (controller.signal.aborted) { // 引导期间被取消
                finishActivity("cancelled", "引导期间取消");
                return;
            }

            await executeAndDeliver(
                requestId, payload, model, stream,
                controller.signal, tm, finishActivity, ""
            );
        } catch (e) {
            // 上游 401/403：proof/凭据失效——自动重签一次（清 service 重新
            // 引导后重试）。仅重试一次，仍失败则把错误透传后端。
            if (
                e && e.__pgError &&
                (e.httpStatus === 401 || e.httpStatus === 403) &&
                !payload.__resigned &&
                !state.aborted.has(requestId)
            ) {
                payload.__resigned = true;
                log(`⚠ 上游 ${e.httpStatus}，尝试自动重签（清 service/headers 重新引导） ${requestId.slice(0, 8)}`);
                state.waaReady = false;
                W.__pgWaaService = null;
                W.__pgWaaHeaders = null; // 捕获的请求头可能同样失效，重引导会重新捕获
                try {
                    if (state.aborted.has(requestId)) {
                        state.aborted.delete(requestId);
                        finishActivity("cancelled", "重签引导期间取消");
                        return;
                    }
                    if (controller.signal.aborted) {
                        finishActivity("cancelled", "重签引导期间取消");
                        return;
                    }
                    // 重签融合：页面点 Run 那一发被顶替执行
                    //（fresh proof + 即时新鲜头），结果直接投递
                    const resignReq = {
                        requestId,
                        payload,
                        model,
                        stream,
                        controller,
                        startedAt,
                        finishActivity,
                        inBytes,
                    };
                    await reSignViaPageSend(resignReq);
                    log(`✔ 重签融合完成，跳过常规发送 ${requestId.slice(0, 8)}`);
                    return;
                } catch (e2) {
                    e = e2; // 重签/重试仍失败 → 走下方统一错误透传
                }
            }
            if (state.aborted.has(requestId)) {
                state.aborted.delete(requestId);
                sendError(requestId, 499, {
                    code: "cancelled",
                    message: "请求已取消",
                });
                log(`⊘ 取消 ${requestId.slice(0, 8)}`);
                finishActivity("cancelled", "请求已取消");
            } else if (e && e.__pgError) {
                sendError(requestId, e.httpStatus || 502, {
                    code: e.code,
                    message: e.message,
                });
                log(`✖ 失败 ${requestId.slice(0, 8)} [${e.httpStatus}] ${e.message}`);
                finishActivity("error", e.message, {
                    status: e.httpStatus || 502,
                    code: e.code,
                    message: e.message,
                    body: e.body,
                });
            } else {
                const eName = (e && e.name) || "Error";
                const eMsg = (e && e.message) || String(e);
                const stackHead = (e && e.stack) ? String(e.stack).split("\n").slice(0, 3).join(" ⏎ ").slice(0, 300) : "";
                sendError(requestId, 502, {
                    code: "executor_error",
                    message: `${eName}: ${eMsg}`,
                });
                log(`✖ 异常 ${requestId.slice(0, 8)}: ${eName}: ${eMsg}`);
                if (stackHead) log(`  异常堆栈: ${stackHead}`);
                log(`  现场: 可见性=${document.visibilityState} 在线=${navigator.onLine ? "是" : "否"} WAA=${state.waaReady ? "就绪" : "未就绪"} WS=${state.wsStatus}`);
                finishActivity("error", `${eName}: ${eMsg}`, {
                    status: 502,
                    code: "executor_error",
                    message: `${eName}: ${eMsg}`,
                    body: stackHead || "",
                });
            }
        } finally {
            clearTimeout(hardTimer);
            state.controllers.delete(requestId);
            // 兜底落账：提前 return（引导取消/上游 409 跳转临时页等）未
            // 显式记录的，按取消/失败补一条，保证每个请求都有账可查
            if (!actResult) {
                if (state.aborted.has(requestId)) {
                    state.aborted.delete(requestId);
                    finishActivity("cancelled", "请求已取消");
                } else {
                    finishActivity("error", "请求中断（提前结束）");
                }
            }
            updatePanel();
        }
    }

    // ==================== WS 客户端 ====================

    function wsSend(obj) {
        if (!state.ws || state.ws.readyState !== 1) return false;
        // 背压保护：积压超过 1MB（连接半死/大流式下行）时返回 false，
        // 让 deliverResult 走 outbox 暂存——避免内存无限膨胀
        try {
            if (state.ws.bufferedAmount > MAX_WS_BUFFERED_AMOUNT) return false;
        } catch (_) {}
        try {
            state.ws.send(JSON.stringify(obj));
            return true;
        } catch (e) {
            log("WS 发送失败: " + e.message);
            return false;
        }
    }

    // 断线续传保序：一旦有消息进入 outbox（断线），后续消息一律先排队，
    // 等 outbox 冲刷完再恢复直发——避免"新连接直发的新消息先于暂存的
    // 旧消息到达后端"造成流式乱序。
    let outboxHold = false;

    // 结果投递：在线且无积压则直发；断线或 outbox 未冲刷完则暂存。
    // request 的最终结果（response/stream-chunk+stream-end/error）允许迟到，
    // 后端会按 requestId 匹配等待中的请求（park/收养机制），顺序保持 FIFO。
    // stream-chunk 是原始文本的连续切片，天然可无损拼接：outbox 超容量时
    // 把最旧两条同请求相邻 chunk 合并成一条，既守容量上限又不丢内容
    // （避免长流断线暂存被 shift 截断造成中间内容缺失）
    function deliverResult(obj) {
        // outboxHold 且 WS 已恢复在线：先尝试冲刷（背压解除/重连成功后
        // 自动恢复直发），冲不动仍走暂存
        if (outboxHold) flushOutbox();
        if (!outboxHold && wsSend(obj)) return true;
        if (obj && obj.requestId) {
            state.outbox.push({ msg: obj, ts: Date.now() });
            while (state.outbox.length > OUTBOX_MAX_ITEMS) {
                const first = state.outbox[0];
                const second = state.outbox[1];
                if (
                    second &&
                    first.msg.type === "stream-chunk" &&
                    second.msg.type === "stream-chunk" &&
                    first.msg.requestId === second.msg.requestId
                ) {
                    second.msg.chunkBody =
                        (first.msg.chunkBody || "") + (second.msg.chunkBody || "");
                    state.outbox.shift();
                } else {
                    state.outbox.shift(); // 无可合并（边界/非 chunk）：退化为丢最旧
                }
            }
            if (!outboxHold) {
                outboxHold = true;
                log(`📤 进入补发模式（已暂存 ${String(obj.requestId).slice(0, 8)}，共 ${state.outbox.length} 条）`);
            }
        }
        return false;
    }

    // 重连注册成功后补发 outbox（按 FIFO 顺序）；排空前保持补发模式，
    // 排空后恢复直发。再次断线则维持补发模式留待下次重连。
    function flushOutbox() {
        if (!state.outbox.length) {
            outboxHold = false;
            return;
        }
        const now = Date.now();
        // 先清理过期条目
        state.outbox = state.outbox.filter(
            (item) => now - item.ts < OUTBOX_MAX_AGE_MS
        );
        let sent = 0;
        while (state.outbox.length) {
            const { msg } = state.outbox[0];
            if (!wsSend(msg)) break; // 再次断线，留待下次重连
            state.outbox.shift();
            sent++;
        }
        if (sent) log(`📤 补发完成，发出 ${sent} 条`);
        outboxHold = state.outbox.length > 0;
        if (state.outbox.length) {
            log(`⚠ 补发中断，剩余 ${state.outbox.length} 条待下次重连`);
        }
    }

    function sendError(requestId, status, error) {
        deliverResult({
            type: "error",
            requestId,
            status: Number(status) || 502,
            error: {
                code: error.code || "error",
                message: error.message || String(error),
            },
        });
    }

    function scheduleConnect(delayMs) {
        if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(() => connectWs(), delayMs || 0);
    }

    function disconnectWs(reason) {
        state.wsStatus = "disconnected";
        if (state.ws) {
            try {
                state.ws.close();
            } catch (_) {}
            state.ws = null;
        }
        stopDurationTimer(); // 使用记录：主动断开同样停表
        if (state.reconnectTimer) {
            clearTimeout(state.reconnectTimer);
            state.reconnectTimer = null;
        }
        updatePanel();
        if (reason) log("WS 断开: " + reason);
    }

    function connectWs() {
        if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) {
            return; // 已在连接/已连接
        }
        if (!cfg.apiKey) {
            log("未设置 API Key，跳过连接（菜单里设置后自动连接）");
            updatePanel();
            return;
        }
        state.wsStatus = "connecting";
        updatePanel();
        let ws;
        try {
            ws = new WebSocket(WS_URL);
        } catch (e) {
            log("WS 创建失败: " + e.message);
            state.wsStatus = "disconnected";
            scheduleConnect(5000);
            return;
        }
        state.ws = ws;
        pingsOut = 0;
        pongSeen = false;
        startHeartbeatWorker();

        ws.onopen = () => {
            log("WS 已连接，发送 register…");
            wsSend({
                type: "register",
                clientVersion: CLIENT_VERSION,
                apiKey: cfg.apiKey,
                executorType: EXECUTOR_TYPE,
            });
        };

        ws.onmessage = (ev) => {
            pingsOut = 0; // 任何下行都证明连接活着
            let msg;
            try {
                msg = JSON.parse(ev.data);
            } catch (_) {
                return;
            }
            switch (msg.type) {
                case "registered":
                    state.wsStatus = "connected";
                    state.reconnectDelay = 1000;
                    state.connectedAt = Date.now();
                    startDurationTimer(); // 使用记录：本次连接时长开始计时
                    log("✅ 注册成功（playground executor 已在线）");
                    updatePanel();
                    flushOutbox();
                    break;
                case "pong":
                    pongSeen = true; // 后端支持 ping/pong：此后启用半开检测
                    break;
                case "request":
                    handleRequest(msg).catch((e) =>
                        log("handleRequest 异常: " + e)
                    );
                    break;
                case "cancel": {
                    const rid = msg.requestId;
                    if (rid) {
                        state.aborted.add(rid);
                        const c = state.controllers.get(rid);
                        if (c) {
                            try {
                                c.abort();
                            } catch (_) {}
                        }
                    }
                    break;
                }
                case "error": {
                    log("后端错误: " + (msg.message || msg.code || JSON.stringify(msg)));
                    break;
                }
                default:
                    break;
            }
        };

        ws.onclose = (ev) => {
            if (state.ws !== ws) return; // 旧连接（已被替换/主动断开）的迟到事件，忽略
            state.wsStatus = "disconnected";
            state.ws = null;
            stopDurationTimer(); // 使用记录：本次连接结束，停表归零
            updatePanel();
            const delay = Math.min(state.reconnectDelay, RECONNECT_MAX_DELAY_MS);
            state.reconnectDelay *= 2;
            if (ev.code === 4002) {
                log("WS 关闭(4002): API Key 已变更，请更新 Key 后重连");
                return; // 不自动重连
            }
            if (ev.code === 4001) {
                // 被新的浏览器连接顶替：不再重连，否则两个页面会无限互相顶替
                log("WS 关闭(4001): 本连接已被新的浏览器连接顶替（同账号在其他页面/设备连接时会发生）");
                return;
            }
            if (ev.code === 4008 || ev.code === 1008) {
                log(`WS 关闭(${ev.code}): ${ev.reason || "注册被拒绝"}`);
                return;
            }
            log(`WS 关闭(code=${ev.code})，${delay / 1000}s 后重连`);
            scheduleConnect(delay);
        };

        ws.onerror = () => {
            log("WS 连接错误: " + WS_URL);
        };
    }

    // ==================== 唤醒钩子（照 aistudio-executor 的 wake） ====================
    // 整页冻结醒来 / 网络恢复 / bfcache 回退时，立即查一次连接：
    // 健康时是空操作；断开时省掉最长 30 秒的退避等待——用户切回标签页的
    // 那一刻就该在线，而不是"再等 N 秒"。
    const wake = () => {
        if (document.visibilityState === "hidden") return;
        // 非 Playground 页（Google 登录流程 / Google 账号页）不连 WS：
        // main() 短路后页面无执行能力，连接只会空占连接位
        if (robinOnGoogleSignin() || restrictedOnGoogleAccountPage()) return;
        if (!cfg.apiKey) return;
        if (state.wsStatus === "connected") {
            // 已连接也可能被中间层单向掐断（半开）——心跳数据未超时则无害，直接补一发
            wsHeartbeat();
        } else if (!state.reconnectTimer) {
            state.reconnectDelay = 1000; // 用户在场，别再用大退避
            scheduleConnect(0);
        }
    };
    document.addEventListener("visibilitychange", wake);
    W.addEventListener("online", wake);
    W.addEventListener("pageshow", wake);

    // ==================== 主流程 ====================

    async function main() {
        // 生命体征：任何页面注入即打一行 console——验证脚本是否真的在跑
        //（在 Tampermonkey 弹窗/控制台看不到这行 = 脚本根本没注入，先查注入）
        try {
            console.log(`[PG-EXEC] 已注入 v${CLIENT_VERSION} @ ${W.location.hostname}${W.location.pathname}`);
        } catch (_) {}

        // 0. Google 登录流程页（v3/signin/*，含 EmbeddedSetup）：不跑任何
        //    Playground 逻辑（无 MakerSuite bundle，不装捕获、不连 WS，零副作用）。
        //    Robin 凭证推送走菜单：登录 + 点过「I agree」后，点 Tampermonkey
        //    菜单「🦜 推送 Robin 凭证」即弹窗完成绑定（见 pushRobinCredential）。
        if (robinOnGoogleSignin()) {
            await gmStore.preload();
            cfg.apiKey = gmStore.get(API_KEY_STORE_KEY, "");
            console.log(
                "[PG-EXEC] Robin 模式就绪：登录并点「I agree」后，点 Tampermonkey 菜单「🦜 推送 Robin 凭证」"
            );
            return;
        }

        // 0. Google 账号页（myaccount.google.com，含 restrictions 限制提示页）：
        //    AI Studio 被封禁的受限账号在这里补推 Cookie。不跑任何 Playground
        //    逻辑（无 bundle、不装捕获、不连 WS），推送走菜单（见
        //    pushRestrictedAccountCookies）。
        if (restrictedOnGoogleAccountPage()) {
            await gmStore.preload();
            cfg.apiKey = gmStore.get(API_KEY_STORE_KEY, "");
            console.log(
                "[PG-EXEC] 受限账号补推模式就绪：点 Tampermonkey 菜单「🚑 推送受限账号 Cookie (pggo)」即可推送"
            );
            return;
        }

        // 0. 最先安装 fetch/XHR 捕获（document-start，早于页面脚本取走 fetch 引用，
        try {
            installFetchCapture();
            installXhrCapture();
        } catch (e) {
            log("请求头捕获安装异常: " + e);
        }

        // 0.5 没有同步存储 API 的管理器：先把 GM.getValue 读进内存
        await gmStore.preload();
        cfg.apiKey = gmStore.get(API_KEY_STORE_KEY, "");
        loadActivities(); // 使用记录（表格 + 累计计数）
        loadReplayCache(); // ⚡ 断线补偿缓存（最新一条成功响应体）
        if (state.replayCache) {
            const c = state.replayCache;
            const ageS = Math.round((Date.now() - c.ts) / 1000);
            log(`⚡ 已恢复缓存响应（${c.body.length} 字节，${ageS}s 前${c.model ? "，model=" + c.model : ""}）——断线丢结果时点「⚡ 返回缓存内容」补发`);
        }

        // 1. 恢复持久化的请求头，并记录一次"页面(重)载入"用于排查后台被杀/刷新。
        //    仅恢复当前账号的记录：跨账号残留里的 x-goog-authuser/tier 是
        //    别的账号的值，恢复会污染后续 WS 重放与云端推送
        const persisted = persistedWaaForCurrentAccount();
        if (persisted) {
            W.__pgWaaHeaders = { ...persisted.headers, ...(W.__pgWaaHeaders || {}) };
            state.waaPersistedTs = persisted.ts;
            log(`页面(重)载入；已恢复持久化请求头，上次引导 ${fmtTime(persisted.ts)}`);
        } else {
            log("页面(重)载入；无持久化记录（或属其他账号），收到第一个请求时会自动引导");
        }

        // 面板尽早出现
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", buildPanel, { once: true });
        } else {
            buildPanel();
        }

        // 启动时后台静默检查更新（结果只进日志/面板，不打扰）
        checkForUpdate(false).catch(() => {});

        // 2. 等页面 bundle 暴露 default_MakerSuite（SPA，可能较慢）。
        //    不再超时后直接 return：等不到时保持重试循环继续扫。
        //    约 15s 后输入框已在 DOM 里、变量却还不存在 → 大概率隔离环境，
        //    只在日志/面板/诊断里如实提示（不做页面 <script> 注入——
        //    aistudio 的 Trusted Types/CSP 会拦，即便注入成功也要包装
        //    页面全部函数才能找 snapshot，实测会弄坏页面请求链路）。
        log("等待页面 bundle（default_MakerSuite）…");
        let isoReported = false;
        const waitStart = Date.now();
        const ok = await waitFor(
            () => {
                try {
                    if (W.default_MakerSuite != null) return true;
                } catch (_) {}
                if (
                    !isoReported &&
                    Date.now() - waitStart > BUNDLE_ISO_WARN_MS &&
                    promptBoxInDom()
                ) {
                    isoReported = true;
                    state.diag.inPageContext = false;
                    log("⚠ 页面已加载但读不到页面变量：脚本可能运行在隔离环境");
                    log("   请改用 Tampermonkey/Violentmonkey 等支持 unsafeWindow 的管理器");
                    updatePanel();
                }
                return false;
            },
            BUNDLE_WAIT_TIMEOUT_MS,
            500
        );
        if (ok) {
            state.bundleReady = true;
            state.diag.inPageContext = true;
            updatePanel();
        } else {
            log(`⚠ ${BUNDLE_WAIT_TIMEOUT_MS / 1000}s 内未找到 default_MakerSuite，继续后台重扫（页面可能加载慢或被改版）`);
        }

        // 3. 安装 snapshot hook（源码匹配），并启动持续重扫循环：
        //    no_snapshot_fn 不再放弃，页面 chunk 陆续就位/热更新替换函数后自动补装
        try {
            if (state.bundleReady) {
                const r = installSnapshotHook();
                if (r === "no_snapshot_fn") {
                    log("⚠ 源码匹配未找到 snapshot 函数（重扫会持续尝试；iOS 转译 bundle 场景请回传日志反馈）");
                } else {
                    log(`hook 安装完成 (snapshotKey=${state.waaSnapshotKey})，等待引导（请求到达自动 / 手动发消息）…`);
                }
            }
        } catch (e) {
            log("hook 安装异常: " + e);
        }
        startHookRescanLoop();
        updatePanel();

        // 4. WS 连接不再等 WAA 就绪：设置 apiKey 即连接（后端侧未就绪
        //    请求会触发自动引导）。唤醒钩子（visibilitychange 等）兜底重连。
        updatePanel(); // 按钮态/说明由 updatePanel 统一刷新
        scheduleConnect(0);
    }

    // ==================== SPA 路由 / 账号切换检测 ====================
    // AI Studio 是 SPA：点击侧栏/切换账号不整页刷新。捕获的 headers/
    // service 绑定捕获时的账号前缀（/u/N/）——前缀变化即作废，等下一个
    // 请求触发自动引导（或用户手动发消息）。

    let lastSeenPath = W.location.pathname;
    function onRouteChange() {
        const path = W.location.pathname;
        if (path === lastSeenPath) return;
        lastSeenPath = path;
        // 不是 prompts 页（如跳去模板库等）就不动作
        try {
            if (!/\/prompts(\/|$)/.test(path)) return;
        } catch (_) { return; }
        // 跨账号切换：捕获物（service/头）全部作废——内存头 + 24h 持久
        // 记录一起清，防止 getHeaders() 回退又捞回旧账号的头。
        // 判定不依赖 state.accountPrefix 是否已赋值（headers-only 捕获时
        // 它为 null）：只要内存里有捕获头就比对，宁可多一次重引导，
        // 不可用错账号。持久记录的前缀校验（persistedWaaForCurrentAccount）
        // 拦住纯持久回退场景
        const prefix = accountPathPrefix();
        const hasLiveCapture = state.waaReady || !!(W.__pgWaaHeaders && W.__pgWaaHeaders["x-goog-api-key"]);
        if (hasLiveCapture && prefix !== (state.accountPrefix || "")) {
            log("⚠ 检测到 Google 账号切换（" + (state.accountPrefix || "默认") + " → " + (prefix || "默认") + "），已作废捕获的请求头/service");
            state.waaReady = false;
            state.accountPrefix = null;
            W.__pgWaaService = null;
            W.__pgWaaHeaders = null;
            try { gmStore.set(WAA_STORE_KEY, ""); } catch (_) {}
            // 进行中的请求拿着旧账号凭据只会 401/403，直接取消
            for (const c of state.controllers.values()) {
                try { c.abort(); } catch (_) {}
            }
            updatePanel();
        }
        updateAccountMenu(); // 换号按钮/菜单跟随当前账号刷新
    }

    function installRouteHooks() {
        try {
            for (const name of ["pushState", "replaceState"]) {
                const orig = W.history[name];
                if (typeof orig !== "function" || orig.__pgRouteWrapped) continue;
                const wrapped = function (...args) {
                    const r = orig.apply(this, args);
                    setTimeout(onRouteChange, 0);
                    return r;
                };
                wrapped.__pgRouteWrapped = true;
                W.history[name] = wrapped;
            }
            W.addEventListener("popstate", onRouteChange);
            W.addEventListener("hashchange", onRouteChange);
        } catch (e) {
            log("路由钩子安装异常: " + e);
        }
    }

    main().catch((e) => log("主流程异常: " + e));
    // 路由钩子只对 AI Studio prompts SPA 有意义；accounts.google.com（Robin
    // 面板流程或其他账号页）与 myaccount.google.com（受限账号补推页）
    // 不装，避免在 Google 账号页包 history 触发风控
    if (
        W.location.hostname !== "accounts.google.com" &&
        W.location.hostname !== "myaccount.google.com"
    ) installRouteHooks();
})();