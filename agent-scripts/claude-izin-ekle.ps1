# claude-izin-ekle (Windows PowerShell 5.1): %USERPROFILE%\.claude\settings.json icindeki permissions.allow listesine
# gate/derleme komutlari icin SABIT kurallari ekler (kullanici karari 2026-11-24; yalniz eksik olanlar eklenir, baska anahtara dokunulmaz).
# Kural listesi bu dosyadadir; parametre/ortamdan kural alinmaz. Idempotent: ikinci kosu 0 ekler ve dosyayi yeniden yazmaz.
# Bozuk JSON'da dosyaya dokunulmaz (yedek de alinmaz, hata verilir). Yazmadan once settings.json.bak-<yyyyMMddHHmmss> yedegi alinir;
# yazilan icerik yeniden ayristirilip dogrulanir, dogrulama basarisizsa yedek geri konur.
# Sonuc: stdout'un son satirinda `@@VLAD-RESULT@@ {json}`. Yalniz ASCII (PS 5.1 BOM'suz dosyayi ANSI okur). Sir/anahtar basilmaz.
$ErrorActionPreference = 'Stop'

$rules = @(
    'Bash(git fetch origin vlad/*)',
    'PowerShell(git fetch origin vlad/*)',
    'Bash(git reset --hard FETCH_HEAD)',
    'PowerShell(git reset --hard FETCH_HEAD)',
    'Bash(git checkout --detach FETCH_HEAD)',
    'PowerShell(git checkout --detach FETCH_HEAD)',
    'Bash(powershell -NoProfile -File build.ps1*)',
    'PowerShell(powershell -NoProfile -File build.ps1*)',
    'PowerShell(.\build.ps1*)',
    'PowerShell(./build.ps1*)',
    'Bash(npm ci*)',
    'PowerShell(npm ci*)',
    'Bash(npm test*)',
    'PowerShell(npm test*)',
    'Bash(npm run build*)',
    'PowerShell(npm run build*)',
    'Bash(npm run lint*)',
    'PowerShell(npm run lint*)',
    'Bash(npx vitest run*)',
    'PowerShell(npx vitest run*)',
    'Bash(dotnet test*)',
    'PowerShell(dotnet test*)',
    'Bash(bash tools/gate.sh*)',
    'Bash(pip install -q -r tools/ci/requirements-ci.txt*)',
    'PowerShell(pip install -q -r tools/ci/requirements-ci.txt*)',
    'PowerShell(winget install --id OpenJS.NodeJS*)',
    'PowerShell(winget install --id Microsoft.VisualStudio.2022.BuildTools*)'
)

function Fail([string]$Why) {
    [Console]::Error.WriteLine("claude-izin-ekle: $Why")
    $r = [ordered]@{ ok = $false; reason = $Why }
    Write-Output ('@@VLAD-RESULT@@ ' + ($r | ConvertTo-Json -Compress))
    exit 1
}

if (-not $env:USERPROFILE) { Fail 'USERPROFILE tanimsiz' }
$dir = Join-Path $env:USERPROFILE '.claude'
$path = Join-Path $dir 'settings.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

# 1) Oku + ayristir (dosyaya henuz dokunulmadi)
$exists = Test-Path -LiteralPath $path -PathType Leaf
$cfg = $null
if ($exists) {
    try { $raw = [System.IO.File]::ReadAllText($path, $utf8) } catch { Fail 'settings.json okunamadi' }
    try { $cfg = ConvertFrom-Json -InputObject $raw } catch { Fail 'settings.json bozuk JSON; dokunulmadi' }
}
else {
    $cfg = ConvertFrom-Json -InputObject '{}'
}
if ($null -eq $cfg -or $cfg -isnot [System.Management.Automation.PSCustomObject]) { Fail 'settings.json kok degeri nesne degil; dokunulmadi' }

# 2) permissions.allow: yalniz eksik olanlari ekle (sira korunur, kopya yok)
if ($null -eq $cfg.PSObject.Properties['permissions']) { Add-Member -InputObject $cfg -MemberType NoteProperty -Name 'permissions' -Value (ConvertFrom-Json -InputObject '{}') }
$perm = $cfg.permissions
if ($null -eq $perm -or $perm -isnot [System.Management.Automation.PSCustomObject]) { Fail 'permissions nesne degil; dokunulmadi' }
if ($null -eq $perm.PSObject.Properties['allow']) { Add-Member -InputObject $perm -MemberType NoteProperty -Name 'allow' -Value @() }
$cur = $perm.allow
if ($null -eq $cur) { $cur = @() }
if ($cur -isnot [System.Array]) { Fail 'permissions.allow dizi degil; dokunulmadi' }
$list = New-Object System.Collections.ArrayList
foreach ($x in $cur) { [void]$list.Add($x) }
$added = 0
foreach ($r in $rules) {
    if (-not ($list -ccontains $r)) { [void]$list.Add($r); $added++ }
}

$backup = $null
if ($added -gt 0) {
    $perm.allow = $list.ToArray()
    $json = ConvertTo-Json -InputObject $cfg -Depth 100
    # Yazmadan once bellekte yeniden ayristir ve dogrula
    $chk = ConvertFrom-Json -InputObject $json
    foreach ($r in $rules) { if (-not (@($chk.permissions.allow) -ccontains $r)) { Fail "dogrulama basarisiz (bellek): $r yok" } }

    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { [void](New-Item -ItemType Directory -Path $dir) }
    if ($exists) {
        $backup = $path + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')
        Copy-Item -LiteralPath $path -Destination $backup
    }
    [System.IO.File]::WriteAllText($path, $json, $utf8)

    # Yazilani yeniden ayristirarak dogrula; basarisizsa yedegi geri koy
    $ok = $true
    try {
        $back = ConvertFrom-Json -InputObject ([System.IO.File]::ReadAllText($path, $utf8))
        foreach ($r in $rules) { if (-not (@($back.permissions.allow) -ccontains $r)) { $ok = $false } }
    }
    catch { $ok = $false }
    if (-not $ok) {
        if ($backup) { Copy-Item -LiteralPath $backup -Destination $path -Force } else { Remove-Item -LiteralPath $path -Force }
        Fail 'dogrulama basarisiz (dosya); onceki hal geri konuldu'
    }
}

$result = [ordered]@{
    ok      = $true
    summary = "$added kural eklendi (toplam $($list.Count))"
    added   = $added
    total   = $list.Count
    backup  = $backup
}
Write-Output ('@@VLAD-RESULT@@ ' + ($result | ConvertTo-Json -Compress))
exit 0
