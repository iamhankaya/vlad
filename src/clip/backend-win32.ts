// Windows pano yardımcısı: STA PowerShell, stdin satır protokolü (docs/aktarim-pano.md). Betik SABİTTİR (kullanıcı verisi kod olarak gömülmez);
// metin/resim yalnız stdin'den base64 gelir. İstek: `<id>\tcount` | `<id>\tread` | `<id>\twrite\t<text|image>\t<expect>\t<base64>`
// (JSON değil: Windows PowerShell 5.1 ConvertFrom-Json ~2 MiB üstünü reddeder). Yanıt tek satır JSON.
// NOT: Windows'ta çalıştırılıp doğrulanamadı (Mac'te yazıldı); gerçek makine doğrulaması V'nin elle listesinde.
export function winHelperScript(): string {
  return `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class VladClip { [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber(); }'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Reply($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function Seq { [int64][VladClip]::GetClipboardSequenceNumber() }
# Yazmada her gerçek deneme öncesi seq yeniden doğrulanır (bekleme/resim çözme sırasında yerel kopya ezilmesin): $false = yerel değişti
function WriteGuarded($f, $expect) { for ($i = 0; $i -lt 6; $i++) { if ((Seq) -ne $expect) { return $false }; try { $null = & $f; return $true } catch { if ($i -eq 5) { throw }; Start-Sleep -Milliseconds 40 } } }
function Retry($f) { for ($i = 0; $i -lt 5; $i++) { try { return (& $f) } catch { Start-Sleep -Milliseconds 40 } }; return (& $f) }
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $id = $null
  try {
    $p = $line.Split("\`t")
    $id = [int]$p[0]
    switch ($p[1]) {
      'count' { Reply @{ id = $id; ok = $true; n = (Seq) } }
      'read' {
        $n = Seq; $text = $null; $png = $null; $hidden = $false
        # Gizli/geçici kopya (parola yöneticileri): içeriği okuma, hidden:true dön
        if ([System.Windows.Forms.Clipboard]::ContainsData('ExcludeClipboardContentFromMonitorProcessing')) { $hidden = $true }
        elseif ([System.Windows.Forms.Clipboard]::ContainsData('CanIncludeInClipboardHistory')) {
          $d = [System.Windows.Forms.Clipboard]::GetData('CanIncludeInClipboardHistory')
          if ($d -is [System.IO.MemoryStream]) { $b = $d.ToArray(); if ($b.Length -ge 1 -and $b[0] -eq 0) { $hidden = $true } }
        }
        if ($hidden) { Reply @{ id = $id; ok = $true; n = $n; after = (Seq); text = $null; png = $null; hidden = $true }; break }
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
          $t = Retry { [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText) }
          if ($t) { $text = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }
        }
        if (-not $text -and [System.Windows.Forms.Clipboard]::ContainsImage()) {
          $img = Retry { [System.Windows.Forms.Clipboard]::GetImage() }
          $ms = $null
          try { if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $png = [Convert]::ToBase64String($ms.ToArray()) } }
          finally { if ($ms) { $ms.Dispose() }; if ($img) { $img.Dispose() } }
        }
        Reply @{ id = $id; ok = $true; n = $n; after = (Seq); text = $text; png = $png }
      }
      'write' {
        $expect = [int64]$p[3]
        if ((Seq) -ne $expect) { Reply @{ id = $id; ok = $true; written = $false; n = (Seq) }; break }
        $bytes = [Convert]::FromBase64String($p[4])
        $ok = $false
        if ($p[2] -eq 'text') {
          $s = [Text.Encoding]::UTF8.GetString($bytes)
          if ($s.Length -eq 0) { $ok = WriteGuarded { [System.Windows.Forms.Clipboard]::Clear() } $expect } else { $ok = WriteGuarded { [System.Windows.Forms.Clipboard]::SetText($s, [System.Windows.Forms.TextDataFormat]::UnicodeText) } $expect }
        } else {
          $ms = New-Object System.IO.MemoryStream(, $bytes); $img = $null
          try { $img = [System.Drawing.Image]::FromStream($ms); $ok = WriteGuarded { [System.Windows.Forms.Clipboard]::SetImage($img) } $expect }
          finally { if ($img) { $img.Dispose() }; $ms.Dispose() } # SetImage panoyu kopyalayarak koyar (copy=true), Dispose güvenli
        }
        if (-not $ok) { Reply @{ id = $id; ok = $true; written = $false; n = (Seq) }; break }
        Reply @{ id = $id; ok = $true; written = $true; n = (Seq) }
      }
      default { Reply @{ id = $id; ok = $false; err = 'bilinmeyen komut' } }
    }
  } catch { Reply @{ id = $id; ok = $false; err = $_.Exception.Message } }
}
`;
}

/** powershell.exe argv'si: betik UTF-16LE base64 olarak -EncodedCommand ile verilir; stdin protokole kalır. */
export function winHelperArgs(): string[] {
  return ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(winHelperScript(), "utf16le").toString("base64")];
}
