# 第三方脚本说明（NOTICE）

`catiecli.user.js` 是**第三方作品**，不是本仓库（CatLocal）的原创代码。

| 项 | 值 |
|---|---|
| 名称 | Catiecli Playground Executor |
| 版本 | 2.21.0 |
| 作者 | `catiecli` |
| 原始命名空间 | `https://catiecli.sukaka.top/` |
| 原始分发地址 | `https://catiecli.sukaka.top/api/pg/script.user.js` |
| 文件 SHA-256 | `9104A578096D6EDE7BF5165241DCB99A9FFE0729975235646FE3F5F02F6B5334` |

## 为什么放在这里

CatLocal 的 `browser` 通道需要页面侧执行器：由 Tampermonkey 里的这个脚本在 AI Studio 页面上
现场取 WAA proof、发起 MakerSuite RPC。没有它，`browser` 通道无法工作。

收录的是**未改动的原始母版**。CatLocal 在运行时会读取它并做本地化改写
（云端地址 → 本机网关地址、注入 `collect` 处理分支、可选的默认 Key 兜底），
改写只发生在内存与本机 `data/` 目录，回写到仓库文件。

## 权利归属

该脚本的全部权利归原作者 `catiecli` 所有。本仓库未获得明确的再分发许可，
之所以收录，是因为它无法从公开渠道稳定获取，且缺少它本项目的浏览器通道不可用。

- 仓库根目录的 [MIT](../LICENSE) **仅适用于 CatLocal 自身的代码**（`src/`、`scripts/`、`tests/`、`web/`）；
- 本文件所在的 `userscript/` 目录**不在 MIT 覆盖范围内**；
- 若原作者要求移除，删除本目录即可，CatLocal 会自动回退到
  `data/catiecli.user.js` 或 `config.json` 的 `cat.sourcePath`。

## 内嵌的公开 Key

母版中包含一个 `RESTRICTED_PUBLIC_WEB_API_KEY`（`AIza…`），这是 AI Studio
受限账号页面上**公开可见**的通用 Web API Key，由原作者写入脚本，用于跳过页面加载。
它不是任何个人账号的私有凭据。

## 如何获得更新

上游脚本由云端热更新（脚本头里的 `@updateURL` 指向作者服务）。本仓库内的母版是
2.21.0 的快照。要更新，请从上述原始分发地址下载后用同名文件替换，或放入
`data/catiecli.user.js`（优先级更高，不会被仓库版本覆盖）。
