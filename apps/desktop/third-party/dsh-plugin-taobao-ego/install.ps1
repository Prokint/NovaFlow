# install.ps1 —— 一键安装 dsh-plugin-taobao-ego（装完需重启 DeepSeek Harness）
#
# ⚠️ 写文件的硬规则（2026-11-16 事故后补）：
#   profile 的 package.json / cordis.patch.yml 是 **JSON / YAML**，绝对不能带 UTF-8 BOM——
#   DSH 启动时 `JSON.parse()` 读到 BOM 会直接 fatal（壳进程弹崩溃窗）。
#   PowerShell 5.1 的 `Set-Content -Encoding UTF8` / `Out-File -Encoding utf8` 会**加 BOM**，
#   所以这里统一用 `Write-TextNoBom`（`UTF8Encoding($false)`），并在写完后 `Assert-NoBom` 自检 + JSON.parse 复验。
#   （本 .ps1 自身需要 BOM，否则 5.1 读中文会乱码——那是另一回事。）
$ErrorActionPreference = 'Stop'

$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcFull = [System.IO.Path]::GetFullPath($src).TrimEnd('\')
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$profile = Join-Path $dshHome 'profiles\desktop'
$pluginName = 'dsh-plugin-taobao-ego'
$pluginLib = $srcFull   # 默认「脚本所在目录就是插件目录」；如需从别的源安装，改这一行
$libFull = [System.IO.Path]::GetFullPath($pluginLib).TrimEnd('\')
$nmDst = Join-Path $profile "node_modules\$pluginName"

if (-not (Test-Path $profile)) { throw "找不到 DSH profile：$profile" }

function Write-TextNoBom([string]$path, [string]$text) {
  $enc = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($path, $text, $enc)
}

function Assert-NoBom([string]$path) {
  $bytes = [System.IO.File]::ReadAllBytes($path)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  if ($hasBom) {
    $rest = $bytes[3..($bytes.Length - 1)]
    [System.IO.File]::WriteAllBytes($path, $rest)
    Write-Host "[!] $path 曾有 BOM，已自动剥离（$($bytes.Length) -> $($rest.Length) 字节）"
    return $false
  }
  return $true
}

function Copy-Plugin([string]$dst) {
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $dst | Out-Null
  foreach ($item in @('lib', 'skill', 'scripts')) {
    Copy-Item (Join-Path $src $item) $dst -Recurse -Force
  }
  foreach ($f in @('package.json', 'cordis.patch.yml', 'README.md', 'NOTICE.txt', 'install.ps1')) {
    $p = Join-Path $src $f
    if (Test-Path $p) { Copy-Item $p $dst -Force }
  }
}

if ($srcFull -eq $libFull) {
  Write-Host "[i] 源目录就是 $pluginLib，跳过自身复制"
} else {
  Copy-Plugin $pluginLib
  Write-Host "[ok] 插件已复制到 $pluginLib"
}
Copy-Plugin $nmDst
Write-Host "[ok] 插件已复制到 $nmDst"

# ---- profile package.json：加 file: 依赖 + bundles 条目（无 BOM 写回）----
$pkgPath = Join-Path $profile 'package.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item $pkgPath "$pkgPath.bak-ego-$stamp" -Force
Assert-NoBom $pkgPath | Out-Null
$pkg = [System.IO.File]::ReadAllText($pkgPath) | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$pkg.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue "file:D:/dsh-plugins/$pluginName" -Force
if (-not $pkg.dsh) { $pkg | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile) { $pkg.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $pkg.dsh.profile.bundles) { $pkg.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() -Force }
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains $pluginName) { $bundles += $pluginName }
$pkg.dsh.profile.bundles = $bundles
Write-TextNoBom $pkgPath (($pkg | ConvertTo-Json -Depth 12) + "`r`n")
Assert-NoBom $pkgPath | Out-Null
# 写后必须能被严格 JSON.parse 解析（DSH 就是这么读的）
$jsonCheck = & node -e "const fs=require('fs');const t=fs.readFileSync(process.argv[1],'utf8');JSON.parse(t);console.log('ok')" $pkgPath 2>&1
if ("$jsonCheck".Trim() -ne 'ok') { throw "profile package.json 写坏了（JSON.parse 失败）：$jsonCheck" }
Write-Host "[ok] profile package.json 已加依赖与 bundles 条目（无 BOM，JSON.parse 通过）"

# ---- profile cordis.patch.yml：插入插件行 + config（无 BOM 写回）----
$patchPath = Join-Path $profile 'cordis.patch.yml'
Copy-Item $patchPath "$patchPath.bak-ego-$stamp" -Force
Assert-NoBom $patchPath | Out-Null
$txt = [System.IO.File]::ReadAllText($patchPath)
if ($txt -notmatch 'taobao-ego-listing') {
  $add = "`r`n# local ego plugin (taobao)`r`n- insert:`r`n    - id: taobao-ego-listing`r`n      name: `"$pluginName`"`r`n- id: taobao-ego-listing`r`n  config:`r`n    verbose: false`r`n"
  Write-TextNoBom $patchPath ($txt.TrimEnd() + $add)
  Assert-NoBom $patchPath | Out-Null
  Write-Host "[ok] cordis.patch.yml 已插入 taobao-ego-listing（无 BOM）"
} else {
  Write-Host "[i] cordis.patch.yml 已有 taobao-ego-listing，跳过"
}

Write-Host ''
Write-Host '[done] 请重启 DeepSeek Harness。重启后应有：'
Write-Host '  - 技能 taobao-ego-listing'
Write-Host '  - 工具 tb_ego_env / tb_ego_spaces / tb_ego_probe_shop / tb_ego_run_listing'
Write-Host ''
Write-Host '排障：设置 TB_EGO_DEBUG=1 后重启；日志默认写系统临时目录（TB_EGO_LOG 可覆盖）'
