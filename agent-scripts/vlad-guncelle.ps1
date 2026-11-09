# vlad-guncelle (Windows PowerShell 5.1): Agent'in kendi vlad klonunu gunceller (selfUpdate). Adimlar: kirli degil mi -> fetch + pull --ff-only ->
# npm ci -> tsc --outDir dist-next -> dist'i degistir (dist -> dist-old, dist-next -> dist). Hata halinde ESKI dist aynen kalir.
# dist, derlendigi HEAD'i dist\.build-head'e yazar: HEAD ilerlemis ama derleme onceki kosuda basarisizsa tekrar derlenir.
# Basari: ok:true. Agent bunun uzerine (exit 0 + data.ok true) kendini yeniden baslatir. Yalniz ASCII (PS 5.1 BOM'suz dosyayi ANSI okur).
# $ErrorActionPreference Stop DEGIL: PS 5.1'de yerel komutun stderr'i hata olur; sonuc $LASTEXITCODE ile okunur.
# Not: `npm ci` node_modules'i siler; ortasinda kesilirse docs/agent-scripts.md "Kurtarma" adimlari uygulanir.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$env:GIT_TERMINAL_PROMPT = '0'

function Emit($Obj) { Write-Output ('@@VLAD-RESULT@@ ' + (ConvertTo-Json -InputObject $Obj -Compress)) }
function Fail($Step, $Summary) { Emit ([ordered]@{ ok = $false; step = $Step; summary = $Summary }); exit 1 }
function Git([string[]]$GitArgs) { $o = & git @GitArgs 2>&1; $script:gitCode = $LASTEXITCODE; return (@($o) -join "`n").Trim() }

$repo = $env:VLAD_REPO
if (-not $repo -or -not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { Fail 'setup' 'VLAD_REPO yok ya da git deposu degil' }
Set-Location -LiteralPath $repo

$st = Git @('status', '--porcelain', '--untracked-files=no')
if ($st) { Fail 'dirty' 'izlenen dosyalarda yerel degisiklik var; temizlenmeden guncellenmez' }
[void](Git @('symbolic-ref', '-q', 'HEAD'))
if ($script:gitCode -ne 0) { Fail 'detached' 'HEAD detached; bir dala gec' }
[void](Git @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'))
if ($script:gitCode -ne 0) { Fail 'no_upstream' 'dalin upstream''i yok' }

$from = Git @('rev-parse', '--short', 'HEAD')
[void](Git @('fetch', '--prune'))
if ($script:gitCode -ne 0) { Fail 'fetch' 'git fetch basarisiz' }
[void](Git @('pull', '--ff-only'))
if ($script:gitCode -ne 0) { Fail 'pull' 'git pull --ff-only basarisiz (ayrisik dal ya da catisma)' }
$to = Git @('rev-parse', '--short', 'HEAD')
$full = Git @('rev-parse', 'HEAD')

$stamp = Join-Path $repo 'dist\.build-head'
if (($from -eq $to) -and (Test-Path -LiteralPath $stamp) -and ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $full)) {
    Emit ([ordered]@{ ok = $true; changed = $false; from = $from; to = $to; summary = "vlad zaten guncel ($to)" }); exit 0
}

& npm.cmd ci --no-audit --no-fund 2>&1 | ForEach-Object { [Console]::Error.WriteLine($_) }
if ($LASTEXITCODE -ne 0) { Fail 'install' 'npm ci basarisiz; node_modules bozulmus olabilir (docs/agent-scripts.md Kurtarma)' }

if (Test-Path -LiteralPath 'dist-next') { Remove-Item -LiteralPath 'dist-next' -Recurse -Force }
& npx.cmd --no-install tsc --outDir dist-next 2>&1 | ForEach-Object { [Console]::Error.WriteLine($_) }
if (($LASTEXITCODE -ne 0) -or -not (Test-Path -LiteralPath 'dist-next\cli.js')) {
    if (Test-Path -LiteralPath 'dist-next') { Remove-Item -LiteralPath 'dist-next' -Recurse -Force -ErrorAction SilentlyContinue }
    Fail 'build' 'tsc derlemesi basarisiz; eski dist korundu'
}
[System.IO.File]::WriteAllText((Join-Path $repo 'dist-next\.build-head'), $full)

if (Test-Path -LiteralPath 'dist-old') { Remove-Item -LiteralPath 'dist-old' -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path -LiteralPath 'dist-old') { Remove-Item -LiteralPath 'dist-next' -Recurse -Force -ErrorAction SilentlyContinue; Fail 'swap' 'eski dist-old silinemedi (dosya kilidi?); eski dist korundu' }
if (Test-Path -LiteralPath 'dist') {
    try { Rename-Item -LiteralPath 'dist' -NewName 'dist-old' -ErrorAction Stop }
    catch { Remove-Item -LiteralPath 'dist-next' -Recurse -Force -ErrorAction SilentlyContinue; Fail 'swap' "dist dist-old'a tasinamadi (EPERM/kilit?); eski dist korundu" }
}
try { Rename-Item -LiteralPath 'dist-next' -NewName 'dist' -ErrorAction Stop }
catch {
    if (Test-Path -LiteralPath 'dist-old') { Rename-Item -LiteralPath 'dist-old' -NewName 'dist' -ErrorAction SilentlyContinue }
    Fail 'swap' "dist-next dist'e tasinamadi; eski dist geri yuklendi"
}
if (Test-Path -LiteralPath 'dist-old') { Remove-Item -LiteralPath 'dist-old' -Recurse -Force -ErrorAction SilentlyContinue }  # kilitliyse hata sayilmaz

Emit ([ordered]@{ ok = $true; changed = $true; from = $from; to = $to; summary = "vlad guncellendi: $from -> $to, dist yenilendi" })
