#requires -Version 5.1
<#
  CatLocal 安装脚本
  - 校验 Node / Python
  - 为 ..\aistudio-api 建 venv 并装依赖（失败回退清华镜像）
  - 缺 waa-signer.exe 时调用上游 build.ps1 自动编译
  - 生成 config.json（含随机口令）
  - 把 catiecli 用户脚本母版复制到 data\catiecli.user.js

  用法：
    .\scripts\install.ps1
    .\scripts\install.ps1 -Proxy http://127.0.0.1:7897 -SkipSigner
#>
[CmdletBinding()]
param(
    [string]$Proxy = "",
    [switch]$SkipStudio,
    [switch]$SkipSigner,
    [string]$CatScriptPath = ""
)

$ErrorActionPreference = "Stop"
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
    chcp 65001 > $null 2>&1
} catch {}

$Root = Split-Path -Parent $PSScriptRoot
$StudioDir = [IO.Path]::GetFullPath((Join-Path $Root "..\aistudio-api"))
$RobinDir = [IO.Path]::GetFullPath((Join-Path $Root "..\Summeretto\service"))
$DataDir = Join-Path $Root "data"
$VenvDir = Join-Path $StudioDir ".venv"
$VenvPy = Join-Path $VenvDir "Scripts\python.exe"
$Signer = Join-Path $StudioDir "waa-signer\bin\waa-signer.exe"

function Step($msg) { Write-Host "`n[CatLocal] $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "  ! $msg" -ForegroundColor Yellow }
function Fail($msg) { Write-Host "  ✗ $msg" -ForegroundColor Red }

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  CatLocal 安装：robin + studio + cat 脚本本地化" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

# ── 1. Node ────────────────────────────────────────────
Step "[1/6] 检查 Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "未找到 node，请先安装 Node.js 22+"; exit 1 }
$nodeVer = (& node -v) -replace '^v', ''
$nodeMajor = [int]($nodeVer.Split('.')[0])
if ($nodeMajor -lt 22) { Fail "Node 版本过低（$nodeVer），需要 22+"; exit 1 }
Ok "Node $nodeVer ($($node.Source))"

# ── 2. Python ──────────────────────────────────────────
Step "[2/6] 检查 Python（studio 引擎）"
$pyCmd = $null
$pyArgs = @()
foreach ($cand in @(@("python"), @("py", "-3"))) {
    $exe = Get-Command $cand[0] -ErrorAction SilentlyContinue
    if (-not $exe) { continue }
    $a = @()
    if ($cand.Length -gt 1) { $a = @($cand[1..($cand.Length - 1)]) }
    try {
        $ver = & $exe.Source @a -c "import sys;print('%d.%d' % (sys.version_info[0], sys.version_info[1]))" 2>$null
        if ($LASTEXITCODE -eq 0 -and $ver) {
            $maj = [int]$ver.Split('.')[0]; $min = [int]$ver.Split('.')[1]
            if ($maj -eq 3 -and $min -ge 11) { $pyCmd = $exe.Source; $pyArgs = $a; break }
        }
    } catch {}
}
if (-not $pyCmd) { Fail "未找到 Python 3.11+（studio 通道需要）"; exit 1 }
Ok "Python $ver ($pyCmd)"

# ── 3. 目录检查 ────────────────────────────────────────
Step "[3/6] 检查两个上游仓库"
if (-not (Test-Path (Join-Path $StudioDir "main.py"))) {
    Fail "找不到 aistudio-api：$StudioDir（应放在 catlocal 的同级目录）"; exit 1
}
Ok "studio 仓库：$StudioDir"
if (-not (Test-Path (Join-Path $RobinDir "server.mjs"))) {
    Warn "找不到 Summeretto：$RobinDir（robin 通道将不可用，可先只跑 studio）"
} else {
    Ok "robin 仓库：$RobinDir"
}
New-Item -ItemType Directory -Path $DataDir -Force | Out-Null

# ── 4. studio 依赖 ─────────────────────────────────────
if (-not $SkipStudio) {
    Step "[4/6] 准备 studio 的 Python 环境"
    if (-not (Test-Path $VenvPy)) {
        Write-Host "  正在创建 venv…"
        & $pyCmd @pyArgs -m venv $VenvDir
        if ($LASTEXITCODE -ne 0) { Fail "venv 创建失败"; exit 1 }
    }
    Ok "venv：$VenvDir"

    $pipArgs = @("-m", "pip", "install", "--disable-pip-version-check", "-q", "-r", (Join-Path $StudioDir "requirements.txt"))
    if ($Proxy) { $pipArgs += @("--proxy", $Proxy) }
    Write-Host "  正在安装依赖（首次可能需要几分钟）…"
    & $VenvPy @pipArgs
    if ($LASTEXITCODE -ne 0) {
        Warn "默认源安装失败，改用清华镜像重试…"
        $mirrorArgs = @("-m", "pip", "install", "--disable-pip-version-check", "-q",
            "-i", "https://pypi.tuna.tsinghua.edu.cn/simple",
            "-r", (Join-Path $StudioDir "requirements.txt"))
        if ($Proxy) { $mirrorArgs += @("--proxy", $Proxy) }
        & $VenvPy @mirrorArgs
        if ($LASTEXITCODE -ne 0) { Fail "依赖安装失败，请检查网络/代理后重试"; exit 1 }
    }
    & $VenvPy -c "import fastapi, httpx, pydantic, yaml, uvicorn, multipart" 2>$null
    if ($LASTEXITCODE -ne 0) { Fail "依赖自检失败（import 失败）"; exit 1 }
    Ok "依赖就绪（fastapi / httpx / pydantic / uvicorn / yaml / multipart）"
} else {
    Step "[4/6] 跳过 studio 依赖（-SkipStudio）"
}

# ── 5. WAA 签名器 ──────────────────────────────────────
if (-not $SkipSigner) {
    Step "[5/6] 检查 WAA 签名器（studio 的 BotGuard 证明）"
    if (Test-Path $Signer) {
        $check = & $Signer -check 2>$null
        if ($LASTEXITCODE -eq 0 -and $check -match '"ok":true') { Ok "waa-signer 可用：$Signer" }
        else { Warn "waa-signer 存在但自检失败：$check" }
    } else {
        Warn "未找到 waa-signer.exe，开始自动编译（下载 Go + Zig + SpiderMonkey，约 5–15 分钟）"
        $buildArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", (Join-Path $StudioDir "waa-signer\build.ps1"))
        if ($Proxy) { $buildArgs += @("-Proxy", $Proxy) }
        & powershell.exe @buildArgs
        if (Test-Path $Signer) { Ok "编译完成：$Signer" }
        else { Warn "编译未产出二进制；studio 通道会报「签名器不可用」，可稍后重试 build.ps1" }
    }
} else {
    Step "[5/6] 跳过签名器编译（-SkipSigner）"
}

# ── 6. 配置 + 脚本母版 ─────────────────────────────────
Step "[6/6] 生成配置与脚本母版"
Push-Location $Root
try {
    $reportRaw = & node "scripts\gen-config.mjs" 2>&1
    if ($LASTEXITCODE -ne 0) { Fail "配置生成失败：$reportRaw"; exit 1 }
    $report = $reportRaw | ConvertFrom-Json
} finally { Pop-Location }
Ok "config.json：$($report.config)"

# cat 脚本母版
$destScript = Join-Path $DataDir "catiecli.user.js"
if (-not (Test-Path $destScript)) {
    $candidates = @()
    if ($CatScriptPath) { $candidates += $CatScriptPath }
    $dl = Join-Path $env:USERPROFILE "Downloads"
    if (Test-Path $dl) { $candidates += (Get-ChildItem $dl -Filter "Catiecli Playground Executor*.txt" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName) }
    $found = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($found) {
        Copy-Item $found $destScript -Force
        Ok "脚本母版：$found"
    } else {
        Warn "未找到 catiecli 用户脚本母版；请把 Catiecli Playground Executor*.txt 放到 $destScript"
    }
} else {
    Ok "脚本母版已存在：$destScript"
}

# ── TLS 证书（浏览器执行器 wss:// 用） ─────────────────
Step "[6.5/6] 生成本机自签证书（wss 通道）"
$certFile = Join-Path $DataDir "tls\catlocal.crt"
if (Test-Path $certFile) {
    Ok "证书已存在：$certFile"
} else {
    Push-Location $Root
    try { & node "scripts\make-cert.mjs" } finally { Pop-Location }
    if ($LASTEXITCODE -eq 0 -and (Test-Path $certFile)) { Ok "证书已生成（浏览器首次访问 https://127.0.0.1:8789 需接受一次）" }
    else { Warn "证书生成失败；wss 通道不可用，但 Cookie 推送 / Robin 绑定不受影响" }
}

Write-Host ""
Write-Host "==================================================================" -ForegroundColor Green
Write-Host "  安装完成" -ForegroundColor Green
Write-Host "==================================================================" -ForegroundColor Green
Write-Host ("  网关地址 : http://{0}" -f $report.gateway)
Write-Host ("  wss 通道 : wss://127.0.0.1:8789/api/pg/ws")
if ($report.catScript.version) { Write-Host ("  脚本版本 : v{0}（{1} 字节，已本地化）" -f $report.catScript.version, $report.catScript.bytes) }
else { Write-Host ("  脚本缺口 : {0}" -f $report.catScript.error) -ForegroundColor Yellow }
Write-Host ""
Write-Host "  下一步：.\scripts\start.ps1  然后打开 http://$($report.gateway)/admin" -ForegroundColor White
Write-Host ""
Write-Host "  单机自用模式：管理面板免口令，脚本/客户端免 Key。" -ForegroundColor DarkGray
Write-Host "  要把端口开放到局域网/公网，请先在面板「运行设置」里设管理口令并开启 Key 校验。" -ForegroundColor DarkGray
Write-Host ""