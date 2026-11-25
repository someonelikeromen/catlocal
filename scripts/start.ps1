#requires -Version 5.1
<#
  CatLocal 启动脚本
  - 保证 UTF-8 控制台（中文日志不乱码）
  - 缺配置时先跑一次 install.ps1
  - 前台运行网关；网关负责拉起/守护 studio 与 robin 两个引擎
  Ctrl+C 优雅停机（先关执行器，再停引擎）
#>
[CmdletBinding()]
param(
    [switch]$NoInstall
)

$ErrorActionPreference = "Stop"
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
    chcp 65001 > $null 2>&1
} catch {}

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Test-Path (Join-Path $Root "config.json"))) {
    if ($NoInstall) {
        Write-Host "缺少 config.json。先运行 .\scripts\install.ps1（或用 -NoInstall 跳过本提示）" -ForegroundColor Red
        exit 1
    }
    Write-Host "首次运行，先执行安装…" -ForegroundColor Cyan
    & (Join-Path $PSScriptRoot "install.ps1")
    if ($LASTEXITCODE -ne 0) { exit 1 }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "未找到 node，请安装 Node.js 22+" -ForegroundColor Red
    exit 1
}

Write-Host "启动 CatLocal…（Ctrl+C 优雅停机）" -ForegroundColor Cyan
& node "src/server.mjs"
exit $LASTEXITCODE