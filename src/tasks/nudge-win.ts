import { NoWindowError, type NudgePane } from "./nudge.js";

/**
 * Windows çalışan penceresine metin yazma (F-vlad-370). Çalışan, WMI ile açılan bir powershell penceresinde (wt sekmesi ya da conhost)
 * `\vlad\<id>.ps1` betiğini çalıştırır; Agent'ın tuttuğu bir PTY yoktur. Bu yüzden pencere, betiğin komut satırından bulunan
 * powershell sürecinin konsoluna `AttachConsole` ile bağlanılıp `WriteConsoleInput` ile tuş olayları yazılarak hedeflenir
 * (Windows Terminal/ConPTY ve conhost'ta aynı çalışır). Teslim doğrulaması için ekran tamponu `ReadConsoleOutputCharacter` ile okunur
 * (Mac'teki `capture-pane` eşdeğeri). Parametreler (mod, görev betiği deseni, metin) ortam değişkeniyle taşınır: komut satırında tırnak/kaçış yok.
 *
 * Çıktı satırları: `PID <n>` | `NONE` (bulunamadı) | `OK` (yazıldı) | `SCREEN <base64(utf8)>` | `ERR <ileti>`.
 */
const NUDGE_PS = String.raw`
$ErrorActionPreference = 'Stop'
try {
$mode = $env:VLAD_NUDGE_MODE
$pat = $env:VLAD_NUDGE_SCRIPT
$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -match '^(powershell|pwsh)\.exe$' -and $_.CommandLine -and $_.CommandLine.ToLower().Contains($pat) })
if ($procs.Count -eq 0) { 'NONE'; exit 0 }
$target = [uint32]$procs[0].ProcessId
if ($mode -eq 'find') { 'PID ' + $target; exit 0 }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class VladCon {
  [StructLayout(LayoutKind.Explicit, Size = 16)]
  public struct KEY_EVENT_RECORD {
    [FieldOffset(0)] public int bKeyDown;
    [FieldOffset(4)] public ushort wRepeatCount;
    [FieldOffset(6)] public ushort wVirtualKeyCode;
    [FieldOffset(8)] public ushort wVirtualScanCode;
    [FieldOffset(10)] public ushort UnicodeChar;
    [FieldOffset(12)] public uint dwControlKeyState;
  }
  [StructLayout(LayoutKind.Explicit, Size = 20)]
  public struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
  }
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD dwSize; public COORD dwCursorPosition; public ushort wAttributes; public SMALL_RECT srWindow; public COORD dwMaximumWindowSize; }
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool WriteConsoleInputW(IntPtr h, INPUT_RECORD[] buf, uint n, out uint written);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ReadConsoleOutputCharacterW(IntPtr h, StringBuilder sb, uint len, COORD at, out uint read);
  public static IntPtr Open(string name) { return CreateFileW(name, 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); }
  static INPUT_RECORD Key(bool down, ushort vk, ushort scan, ushort ch) {
    INPUT_RECORD r = new INPUT_RECORD(); r.EventType = 1;
    r.KeyEvent.bKeyDown = down ? 1 : 0; r.KeyEvent.wRepeatCount = 1; r.KeyEvent.wVirtualKeyCode = vk; r.KeyEvent.wVirtualScanCode = scan; r.KeyEvent.UnicodeChar = ch;
    return r;
  }
  public static uint Type(IntPtr h, string text) {
    INPUT_RECORD[] b = new INPUT_RECORD[text.Length * 2];
    for (int i = 0; i < text.Length; i++) { b[2 * i] = Key(true, 0, 0, text[i]); b[2 * i + 1] = Key(false, 0, 0, text[i]); }
    uint w; if (!WriteConsoleInputW(h, b, (uint)b.Length, out w)) throw new Exception("WriteConsoleInput " + Marshal.GetLastWin32Error());
    return w;
  }
  public static uint Enter(IntPtr h) {
    INPUT_RECORD[] b = new INPUT_RECORD[] { Key(true, 0x0D, 0x1C, 13), Key(false, 0x0D, 0x1C, 13) };
    uint w; if (!WriteConsoleInputW(h, b, 2, out w)) throw new Exception("WriteConsoleInput " + Marshal.GetLastWin32Error());
    return w;
  }
  public static string Screen(IntPtr h) {
    CSBI i; if (!GetConsoleScreenBufferInfo(h, out i)) throw new Exception("GetConsoleScreenBufferInfo " + Marshal.GetLastWin32Error());
    int width = i.dwSize.X; StringBuilder all = new StringBuilder();
    for (int y = i.srWindow.Top; y <= i.srWindow.Bottom; y++) {
      StringBuilder sb = new StringBuilder(width); uint n; COORD c = new COORD(); c.X = 0; c.Y = (short)y;
      if (!ReadConsoleOutputCharacterW(h, sb, (uint)width, c, out n)) throw new Exception("ReadConsoleOutputCharacter " + Marshal.GetLastWin32Error());
      all.Append(sb.ToString().TrimEnd()).Append('\n');
    }
    return all.ToString();
  }
}
'@
[void][VladCon]::FreeConsole()
if (-not [VladCon]::AttachConsole($target)) { 'ERR AttachConsole ' + [Runtime.InteropServices.Marshal]::GetLastWin32Error(); exit 0 }
try {
  if ($mode -eq 'screen') {
    $h = [VladCon]::Open('CONOUT$')
    try { $s = [VladCon]::Screen($h) } finally { [void][VladCon]::CloseHandle($h) }
    'SCREEN ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
  } else {
    $h = [VladCon]::Open('CONIN$')
    try {
      if ($mode -eq 'type') { $t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:VLAD_NUDGE_TEXT_B64)); [void][VladCon]::Type($h, $t) }
      elseif ($mode -eq 'enter') { [void][VladCon]::Enter($h) }
      else { 'ERR bilinmeyen mod ' + $mode; exit 0 }
    } finally { [void][VladCon]::CloseHandle($h) }
    'OK'
  }
} finally { [void][VladCon]::FreeConsole() }
} catch { 'ERR ' + ($_.Exception.Message -replace '\s+', ' ') }
`;

export type WinRun = (file: string, args: string[], env: Record<string, string>) => string;

const encoded = (): string => Buffer.from(NUDGE_PS, "utf16le").toString("base64");

/** Betik komut satırında aranacak ince desen: `closeWorkerWindow` ile aynı (`\vlad\<id>.ps1`, küçük harf). */
export const winScriptPattern = (taskId: string): string => `\\vlad\\${taskId}.ps1`.toLowerCase();

/** Windows penceresini `NudgePane` olarak sarar. `run` test dikişidir (sahte pencere). */
export function winPane(taskId: string, run: WinRun): NudgePane {
  const call = (mode: "find" | "type" | "enter" | "screen", extra: Record<string, string> = {}): string[] => {
    const out = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded()], { VLAD_NUDGE_MODE: mode, VLAD_NUDGE_SCRIPT: winScriptPattern(taskId), ...extra });
    const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const err = lines.find((l) => l.startsWith("ERR "));
    if (err) throw new Error(`Windows pencere hatası (${mode}): ${err.slice(4)}`);
    return lines;
  };
  return {
    exists: () => { if (!call("find").some((l) => /^PID \d+$/.test(l))) throw new NoWindowError(`çalışan penceresi yok: ${taskId} (pencere kapalı ya da çalışan bu makinede değil)`); },
    type: (text) => { if (!call("type", { VLAD_NUDGE_TEXT_B64: Buffer.from(text, "utf8").toString("base64") }).includes("OK")) throw new Error("Windows pencere: metin yazıldığı doğrulanamadı"); },
    enter: () => { if (!call("enter").includes("OK")) throw new Error("Windows pencere: Enter yazıldığı doğrulanamadı"); },
    capture: () => {
      const l = call("screen").find((x) => x.startsWith("SCREEN "));
      if (l === undefined) throw new Error("Windows pencere: ekran okunamadı");
      return Buffer.from(l.slice(7), "base64").toString("utf8");
    },
  };
}
