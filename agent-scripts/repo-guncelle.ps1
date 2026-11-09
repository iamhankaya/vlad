# repo-guncelle (Windows PowerShell 5.1): kok klasorlerdeki git depolarini `fetch --prune` + `pull --ff-only` ile gunceller.
# Parametre: VLAD_PARAM_ROOT (tek kok) ya da VLAD_ROOTS (';' ile ayrilmis). Agent'in kendi klonu (VLAD_REPO) atlanir:
# onu vlad-guncelle gunceller. Kirli, detached, upstream'siz ve ayrismis depolar atlanir (hata sayilmaz).
# Sonuc: stdout'un son satirlarinda `@@VLAD-RESULT@@ {json}`. Yalniz ASCII (PS 5.1 BOM'suz dosyayi ANSI okur).
# $ErrorActionPreference Stop DEGIL: PS 5.1'de git'in stderr'i NativeCommandError olur; sonuc $LASTEXITCODE ile okunur.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Continue'
$env:GIT_TERMINAL_PROMPT = '0'

$roots = @()
if ($env:VLAD_PARAM_ROOT) { $roots = @($env:VLAD_PARAM_ROOT) }
elseif ($env:VLAD_ROOTS) { $roots = @($env:VLAD_ROOTS -split ';' | Where-Object { $_ }) }

$agentRepo = $null
if ($env:VLAD_REPO -and (Test-Path -LiteralPath $env:VLAD_REPO)) { $agentRepo = (Resolve-Path -LiteralPath $env:VLAD_REPO).ProviderPath.TrimEnd('\') }

function Invoke-Git([string]$Dir, [string[]]$GitArgs) {
    $out = & git -C $Dir @GitArgs 2>$null
    return @{ Code = $LASTEXITCODE; Out = (@($out) -join "`n").Trim() }
}

$items = New-Object System.Collections.ArrayList
$script:upd = 0; $script:cur = 0; $script:skip = 0; $script:err = 0; $script:all = 0; $script:extra = 0
$maxItems = 80

function Add-Item($Item) {
    $script:all++
    if ($items.Count -ge $maxItems) { $script:extra++; return }
    [void]$items.Add($Item)
}
function Skip-Repo($Name, $Reason) { $script:skip++; Add-Item ([ordered]@{ name = $Name; status = 'skipped'; reason = $Reason }) }
function Fail-Repo($Name, $Reason) { $script:err++; Add-Item ([ordered]@{ name = $Name; status = 'error'; reason = $Reason }) }

foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { [Console]::Error.WriteLine("root yok: $root"); continue }
    foreach ($d in (Get-ChildItem -LiteralPath $root -Directory)) {
        $dir = $d.FullName
        if (-not (Test-Path -LiteralPath (Join-Path $dir '.git'))) { continue }
        $name = $d.Name
        $real = (Resolve-Path -LiteralPath $dir).ProviderPath.TrimEnd('\')
        if ($agentRepo -and ($real -ieq $agentRepo)) { Skip-Repo $name 'agent_repo'; continue }
        $b = Invoke-Git $dir @('symbolic-ref', '--short', '-q', 'HEAD')
        if ($b.Code -ne 0) { Skip-Repo $name 'detached'; continue }
        $u = Invoke-Git $dir @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
        if ($u.Code -ne 0) { Skip-Repo $name 'no_upstream'; continue }
        $s = Invoke-Git $dir @('status', '--porcelain')
        if ($s.Out) { Skip-Repo $name 'dirty'; continue }
        $f = Invoke-Git $dir @('fetch', '--prune')
        if ($f.Code -ne 0) { Fail-Repo $name 'fetch_failed'; continue }
        $from = (Invoke-Git $dir @('rev-parse', '--short', 'HEAD')).Out
        $p = Invoke-Git $dir @('pull', '--ff-only')
        if ($p.Code -eq 0) {
            $to = (Invoke-Git $dir @('rev-parse', '--short', 'HEAD')).Out
            if ($from -eq $to) { $script:cur++; Add-Item ([ordered]@{ name = $name; status = 'current' }) }
            else { $script:upd++; Add-Item ([ordered]@{ name = $name; status = 'updated'; branch = $b.Out; from = $from; to = $to }) }
        }
        else {
            $a1 = (Invoke-Git $dir @('merge-base', '--is-ancestor', 'HEAD', '@{u}')).Code
            $a2 = (Invoke-Git $dir @('merge-base', '--is-ancestor', '@{u}', 'HEAD')).Code
            if ($a1 -ne 0 -and $a2 -ne 0) { Skip-Repo $name 'diverged' } else { Fail-Repo $name 'pull_failed' }
        }
    }
}

$result = [ordered]@{
    ok      = $true
    summary = "$($script:all) repo: $($script:upd) guncellendi, $($script:cur) guncel, $($script:skip) atlandi, $($script:err) hata"
    repos   = @($items.ToArray())
}
if ($script:extra -gt 0) { $result['omitted'] = $script:extra }
Write-Output ('@@VLAD-RESULT@@ ' + ($result | ConvertTo-Json -Compress -Depth 5))
exit 0
