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
        $n = Seq; $text = $null; $png = $null
        if ([System.Windows.Forms.Clipboard]::ContainsText()) {
          $t = Retry { [System.Windows.Forms.Clipboard]::GetText([System.Windows.Forms.TextDataFormat]::UnicodeText) }
          if ($t) { $text = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t)) }
        }
        if (-not $text -and [System.Windows.Forms.Clipboard]::ContainsImage()) {
          $img = Retry { [System.Windows.Forms.Clipboard]::GetImage() }
          if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $png = [Convert]::ToBase64String($ms.ToArray()); $img.Dispose(); $ms.Dispose() }
        }
        Reply @{ id = $id; ok = $true; n = $n; after = (Seq); text = $text; png = $png }
      }
      'write' {
        $n = Seq
        if ($n -ne [int64]$p[3]) { Reply @{ id = $id; ok = $true; written = $false; n = $n }; break }
        $bytes = [Convert]::FromBase64String($p[4])
        if ($p[2] -eq 'text') {
          $s = [Text.Encoding]::UTF8.GetString($bytes)
          if ($s.Length -eq 0) { Retry { [System.Windows.Forms.Clipboard]::Clear() } } else { Retry { [System.Windows.Forms.Clipboard]::SetText($s, [System.Windows.Forms.TextDataFormat]::UnicodeText) } }
        } else {
          $ms = New-Object System.IO.MemoryStream(, $bytes); $img = [System.Drawing.Image]::FromStream($ms)
          Retry { [System.Windows.Forms.Clipboard]::SetImage($img) }
        }
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
