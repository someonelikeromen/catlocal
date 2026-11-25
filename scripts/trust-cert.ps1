#requires -Version 5.1
<#
  把 data\tls\catlocal.crt 装进「当前用户 → 受信任的根证书」，
  这样浏览器（Chrome/Edge）访问 https://127.0.0.1:8789 和 wss:// 时不再拦截。
  只影响当前用户，不需要管理员；可随时用 certmgr.msc 手动移除。
#>
[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    chcp 65001 > $null 2>&1
} catch {}

$Root = Split-Path -Parent $PSScriptRoot
$Cert = Join-Path $Root "data\tls\catlocal.crt"

if (-not (Test-Path $Cert)) {
    Write-Host "找不到证书：$Cert" -ForegroundColor Red
    Write-Host "先生成：node scripts\make-cert.mjs" -ForegroundColor Yellow
    exit 1
}

Write-Host "正在把证书装进「当前用户 → 受信任的根证书」…" -ForegroundColor Cyan
& certutil -user -addstore -f Root $Cert | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "安装失败（certutil 返回 $LASTEXITCODE）。可改为手动导入：certmgr.msc → 受信任的根证书颁发机构 → 导入" -ForegroundColor Red
    exit 1
}
Write-Host "已信任：$Cert" -ForegroundColor Green
Write-Host "请重启浏览器（或至少关闭该站点的标签页），再打开 AI Studio 页面。" -ForegroundColor White
Write-Host "卸载：certmgr.msc 里删除 “CatLocal Local Gateway”，或执行" -ForegroundColor DarkGray
Write-Host "  certutil -user -delstore Root `"CatLocal Local Gateway`"" -ForegroundColor DarkGray