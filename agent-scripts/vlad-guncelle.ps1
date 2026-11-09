# vlad-guncelle (Windows PowerShell 5.1): Agent'in kendi vlad klonunu gunceller (selfUpdate). Adimlar: kirli degil mi -> fetch + pull --ff-only ->
# npm ci -> tsc --outDir dist-next -> dist'i degistir (dist -> dist-old, dist-next -> dist). Hata halinde ESKI dist aynen kalir.
# dist, derlendigi HEAD'i dist\.build-head'e yazar: HEAD ilerlemis ama derleme onceki kosuda basarisizsa tekrar derlenir.
# Basari: ok:true. Agent bunun uzerine (exit 0 + data.ok true) kendini yeniden baslatir. Yalniz ASCII (PS 5.1 BOM'suz dosyayi ANSI okur).
# $ErrorActionPreference Stop DEGIL: PS 5.1'de yerel komutun stderr'i hata olur; sonuc $LASTEXITCODE ile okunur.
# Geri alma: npm ci oncesi node_modules -> node_modules-old (isaret: .vlad-npm-ci-running); basarisizlikta ya da yarida kesilmede (sonraki kosunun
# basinda) eski node_modules geri gelir. dist-old ve node_modules-old BASARIDA SILINMEZ: yeni surec dinleyince Agent'in yardimci betigi siler,
# dinlemezse ayni yardimci dist + node_modules'i yedekten geri yukler.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$env:GIT_TERMINAL_PROMPT = '0'

function Emit($Obj) { Write-Output ('@@VLAD-RESULT@@ ' + (ConvertTo-Json -InputObject $Obj -Compress)) }
function Fail($Step, $Summary) { Emit ([ordered]@{ ok = $false; step = $Step; summary = $Summary }); exit 1 }
function Invoke-Git([string[]]$GitArgs) { $o = & git.exe @GitArgs 2>&1; $script:gitCode = $LASTEXITCODE; return (@($o) -join "`n").Trim() }

$repo = $env:VLAD_REPO
if (-not $repo -or -not (Test-Path -LiteralPath (Join-Path $repo '.git'))) { Fail 'setup' 'VLAD_REPO yok ya da git deposu degil' }
Set-Location -LiteralPath $repo

# yarida kalan npm ci kurtarma (her seyden once): eski node_modules geri
if (Test-Path -LiteralPath '.vlad-npm-ci-running') {
    if (Test-Path -LiteralPath 'node_modules-old') {
        try { if (Test-Path -LiteralPath 'node_modules') { Remove-Item -LiteralPath 'node_modules' -Recurse -Force -ErrorAction Stop }; Rename-Item -LiteralPath 'node_modules-old' -NewName 'node_modules' -ErrorAction Stop }
        catch { Fail 'setup' 'yarim node_modules yedekten geri yuklenemedi' }
    }
    if (((Get-Content -LiteralPath '.vlad-npm-ci-running' -Raw -ErrorAction SilentlyContinue) -replace '\s', '') -eq 'swap' -and (Test-Path -LiteralPath 'dist-old')) {
        try { if (Test-Path -LiteralPath 'dist') { Remove-Item -LiteralPath 'dist' -Recurse -Force -ErrorAction Stop }; Rename-Item -LiteralPath 'dist-old' -NewName 'dist' -ErrorAction Stop }
        catch { Fail 'setup' 'yarim dist yedekten geri yuklenemedi' }
    }
    Remove-Item -LiteralPath '.vlad-npm-ci-running' -Force -ErrorAction SilentlyContinue
}

$st = Invoke-Git @('status', '--porcelain', '--untracked-files=no')
if ($st) { Fail 'dirty' 'izlenen dosyalarda yerel degisiklik var; temizlenmeden guncellenmez' }
[void](Invoke-Git @('symbolic-ref', '-q', 'HEAD'))
if ($script:gitCode -ne 0) { Fail 'detached' 'HEAD detached; bir dala gec' }
$up = Invoke-Git @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
if ($script:gitCode -ne 0) { Fail 'no_upstream' 'dalin upstream''i yok' }
# yalniz varsayilan dal (origin/HEAD; yoksa main|master) ve upstream'i origin/<ayni dal> olan klon guncellenir
$cur = Invoke-Git @('symbolic-ref', '-q', '--short', 'HEAD')
$def = Invoke-Git @('symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD')
if ($script:gitCode -eq 0 -and $def) {
    $def = $def -replace '^origin/', ''
    if ($cur -ne $def) { Fail 'branch' "dal '$cur' varsayilan dal ('$def') degil" }
} elseif ($cur -ne 'main' -and $cur -ne 'master') { Fail 'branch' "dal '$cur' varsayilan dal degil (main/master)" }
if ($up -ne "origin/$cur") { Fail 'branch' "upstream '$up', beklenen 'origin/$cur'" }

$from = Invoke-Git @('rev-parse', '--short', 'HEAD')
[void](Invoke-Git @('fetch', '--prune'))
if ($script:gitCode -ne 0) { Fail 'fetch' 'git fetch basarisiz' }
[void](Invoke-Git @('pull', '--ff-only'))
if ($script:gitCode -ne 0) { Fail 'pull' 'git pull --ff-only basarisiz (ayrisik dal ya da catisma)' }
$to = Invoke-Git @('rev-parse', '--short', 'HEAD')
$full = Invoke-Git @('rev-parse', 'HEAD')

$stamp = Join-Path $repo 'dist\.build-head'
if (($from -eq $to) -and (Test-Path -LiteralPath $stamp) -and ((Get-Content -LiteralPath $stamp -Raw).Trim() -eq $full)) {
    Emit ([ordered]@{ ok = $true; changed = $false; from = $from; to = $to; summary = "vlad zaten guncel ($to)" }); exit 0
}

# onceki guncellemenin yedegi duruyorsa (yeni surec henuz dogrulanmadi / temizlenmedi) ustune yazilmaz
if (Test-Path -LiteralPath 'node_modules-old') { Fail 'install' 'node_modules-old zaten var (onceki guncellemenin yedegi); yeni surec dogrulanip temizlenene ya da elle silinene kadar guncellenmez' }
if (Test-Path -LiteralPath 'node_modules') {
    try { Rename-Item -LiteralPath 'node_modules' -NewName 'node_modules-old' -ErrorAction Stop }
    catch { Fail 'install' 'node_modules yedeklenemedi (kilit?); hicbir sey degismedi' }
}
[System.IO.File]::WriteAllText((Join-Path $repo '.vlad-npm-ci-running'), '')
# npm ci SONRASI her hata yolunda eski node_modules geri gelir (eski dist + yeni node_modules ile surmesin)
function Restore-Nm {
    if (Test-Path -LiteralPath 'node_modules') { Remove-Item -LiteralPath 'node_modules' -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath 'node_modules-old') { Rename-Item -LiteralPath 'node_modules-old' -NewName 'node_modules' -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath '.vlad-npm-ci-running' -Force -ErrorAction SilentlyContinue
}
& npm.cmd ci --ignore-scripts --no-audit --no-fund 2>&1 | ForEach-Object { [Console]::Error.WriteLine($_) }
if ($LASTEXITCODE -ne 0) { Restore-Nm; Fail 'install' 'npm ci basarisiz; eski node_modules geri yuklendi' }

if (Test-Path -LiteralPath 'dist-next') { Remove-Item -LiteralPath 'dist-next' -Recurse -Force }
& npx.cmd --no-install tsc --outDir dist-next 2>&1 | ForEach-Object { [Console]::Error.WriteLine($_) }
if (($LASTEXITCODE -ne 0) -or -not (Test-Path -LiteralPath 'dist-next\cli.js')) {
    if (Test-Path -LiteralPath 'dist-next') { Remove-Item -LiteralPath 'dist-next' -Recurse -Force -ErrorAction SilentlyContinue }
    Restore-Nm
    Fail 'build' 'tsc derlemesi basarisiz; eski dist ve eski node_modules korundu'
}
[System.IO.File]::WriteAllText((Join-Path $repo 'dist-next\.build-head'), $full)

if (Test-Path -LiteralPath 'dist-old') { Remove-Item -LiteralPath 'dist-old' -Recurse -Force -ErrorAction SilentlyContinue }
if (Test-Path -LiteralPath 'dist-old') { Remove-Item -LiteralPath 'dist-next' -Recurse -Force -ErrorAction SilentlyContinue; Restore-Nm; Fail 'swap' 'eski dist-old silinemedi (dosya kilidi?); eski dist ve node_modules korundu' }
[System.IO.File]::WriteAllText((Join-Path $repo '.vlad-npm-ci-running'), 'swap') # asama isareti: sonrasi kesilirse kurtarma dist'i de dist-old'dan geri yukler
if (Test-Path -LiteralPath 'dist') {
    try { Rename-Item -LiteralPath 'dist' -NewName 'dist-old' -ErrorAction Stop }
    catch { Remove-Item -LiteralPath 'dist-next' -Recurse -Force -ErrorAction SilentlyContinue; Restore-Nm; Fail 'swap' "dist dist-old'a tasinamadi (EPERM/kilit?); eski dist ve node_modules korundu" }
}
try { Rename-Item -LiteralPath 'dist-next' -NewName 'dist' -ErrorAction Stop }
catch {
    if (Test-Path -LiteralPath 'dist-old') { Rename-Item -LiteralPath 'dist-old' -NewName 'dist' -ErrorAction SilentlyContinue }
    Restore-Nm
    Fail 'swap' "dist-next dist'e tasinamadi; eski dist geri yuklendi"
}

Remove-Item -LiteralPath '.vlad-npm-ci-running' -Force -ErrorAction SilentlyContinue
Emit ([ordered]@{ ok = $true; changed = $true; from = $from; to = $to; summary = "vlad guncellendi: $from -> $to, dist yenilendi" })
