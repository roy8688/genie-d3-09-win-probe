# D3-11 ConPTY 宿主（2026-11-24）
# 零原生依赖：Windows PowerShell 5.1 的 Add-Type 调用 kernel32 CreatePseudoConsole。
# 只负责把 stdin/stdout 接到伪控制台，不解释命令；退出码透传子进程退出码。
param(
  [Parameter(Mandatory=$true)][string]$Exe,
  [Parameter(Mandatory=$true)][string]$Cwd,
  [Parameter(Mandatory=$true)][string]$ArgsB64,
  [int]$Cols = 120,
  [int]$Rows = 30
)
$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class GenieConPty {
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  // 全 IntPtr：blittable，避免 string 字段让 P/Invoke 重新编组 STARTUPINFOEX，
  // 导致 lpAttributeList 偏移与原生结构不一致（子进程拿不到伪控制台）。
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFO {
    public int cb;
    public IntPtr lpReserved; public IntPtr lpDesktop; public IntPtr lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags;
    public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO si; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }

  [DllImport("kernel32.dll", SetLastError=true)] static extern int CreatePseudoConsole(COORD size, IntPtr hInput, IntPtr hOutput, uint flags, out IntPtr phPC);
  [DllImport("kernel32.dll")] static extern void ClosePseudoConsole(IntPtr hPC);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr hRead, out IntPtr hWrite, IntPtr sa, int size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr hObject, int mask, int flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr hObject);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr prev, IntPtr ret);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true)]
  static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, IntPtr si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr h, out int code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadFile(IntPtr h, byte[] buf, uint n, out uint got, IntPtr ov);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr h, byte[] buf, uint n, out uint wrote, IntPtr ov);

  const int HANDLE_FLAG_INHERIT = 1;
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  static readonly IntPtr ATTR_PSEUDOCONSOLE = (IntPtr)0x00020016;

  static void PumpIn(IntPtr hWrite) {
    bool dbg = Environment.GetEnvironmentVariable("GENIE_CONPTY_DEBUG") == "1";
    var stdin = Console.OpenStandardInput();
    byte[] buf = new byte[4096];
    try {
      while (true) {
        int n = stdin.Read(buf, 0, buf.Length);
        if (dbg) Console.Error.WriteLine("[conpty] stdin read=" + n);
        if (n <= 0) break;
        uint wrote = 0;
        if (!WriteFile(hWrite, buf, (uint)n, out wrote, IntPtr.Zero)) {
          if (dbg) Console.Error.WriteLine("[conpty] WriteFile failed=" + Marshal.GetLastWin32Error());
          break;
        }
        if (dbg) Console.Error.WriteLine("[conpty] wrote=" + wrote);
      }
    } catch (Exception e) { if (dbg) Console.Error.WriteLine("[conpty] in exception " + e.Message); }
    CloseHandle(hWrite);
  }

  static void PumpOut(IntPtr hRead) {
    var stdout = Console.OpenStandardOutput();
    byte[] buf = new byte[65536];
    try {
      while (true) {
        uint got = 0;
        if (!ReadFile(hRead, buf, (uint)buf.Length, out got, IntPtr.Zero) || got == 0) break;
        if (Environment.GetEnvironmentVariable("GENIE_CONPTY_DEBUG") == "1") Console.Error.WriteLine("[conpty] out n=" + got);
        stdout.Write(buf, 0, (int)got);
        stdout.Flush();
      }
    } catch (Exception) {}
    CloseHandle(hRead);
  }

  public static int Run(string commandLine, string cwd, int cols, int rows) {
    IntPtr inRead = IntPtr.Zero, inWrite = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
    IntPtr hPC = IntPtr.Zero, attrList = IntPtr.Zero, attrSize = IntPtr.Zero;
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    STARTUPINFOEX siex = new STARTUPINFOEX();
    bool ok = false;
    try {
      // 与官方样例一致：SECURITY_ATTRIBUTES 为空，句柄默认不可继承。
      if (!CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0)) throw new Exception("CreatePipe(in) failed: " + Marshal.GetLastWin32Error());
      if (!CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0)) throw new Exception("CreatePipe(out) failed: " + Marshal.GetLastWin32Error());

      COORD size = new COORD(); size.X = (short)cols; size.Y = (short)rows;
      int hr = CreatePseudoConsole(size, inRead, outWrite, 0, out hPC);
      if (hr != 0) throw new Exception("CreatePseudoConsole failed: 0x" + hr.ToString("X8"));
      // 官方规范：这两个句柄必须等 CreateProcess 成功后再释放。
      // 提前关闭会让子进程不绑定伪控制台，banner/prompt 直接写回父进程 stdout。

      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
      attrList = Marshal.AllocHGlobal(attrSize);
      if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize)) throw new Exception("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
      if (!UpdateProcThreadAttribute(attrList, 0, ATTR_PSEUDOCONSOLE, hPC, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
        throw new Exception("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());

      siex.si.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      siex.lpAttributeList = attrList;
      if (Environment.GetEnvironmentVariable("GENIE_CONPTY_DEBUG") == "1") {
        Console.Error.WriteLine("[conpty] sizeof STARTUPINFO=" + Marshal.SizeOf(typeof(STARTUPINFO)) +
          " STARTUPINFOEX=" + Marshal.SizeOf(typeof(STARTUPINFOEX)) +
          " attrOffset=" + Marshal.OffsetOf(typeof(STARTUPINFOEX), "lpAttributeList").ToInt64() +
          " hPC=" + hPC.ToInt64() + " attrList=" + attrList.ToInt64());
      }
      // 显式把 STARTUPINFOEX 写进原生内存再传指针，彻底绕开 P/Invoke 的结构编组。
      IntPtr siPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(STARTUPINFOEX)));
      Marshal.StructureToPtr(siex, siPtr, false);
      try {
        ok = CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, false,
          EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, cwd, siPtr, out pi);
      } finally {
        Marshal.FreeHGlobal(siPtr);
      }
      if (!ok) throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
      // 子进程已创建：现在才能释放 CreatePseudoConsole 用的两个端点。
      CloseHandle(inRead); inRead = IntPtr.Zero;
      CloseHandle(outWrite); outWrite = IntPtr.Zero;
      if (Environment.GetEnvironmentVariable("GENIE_CONPTY_DEBUG") == "1") Console.Error.WriteLine("[conpty] child pid=" + pi.dwProcessId);

      Thread tin = new Thread(delegate() { PumpIn(inWrite); });
      Thread tout = new Thread(delegate() { PumpOut(outRead); });
      tin.IsBackground = true; tout.IsBackground = true;
      tin.Start(); tout.Start();

      WaitForSingleObject(pi.hProcess, 0xFFFFFFFF);
      int code = 0; GetExitCodeProcess(pi.hProcess, out code);
      Thread.Sleep(150);
      ClosePseudoConsole(hPC); hPC = IntPtr.Zero;
      tout.Join(1000);
      return code;
    } finally {
      if (ok) { CloseHandle(pi.hThread); CloseHandle(pi.hProcess); }
      if (attrList != IntPtr.Zero) { DeleteProcThreadAttributeList(attrList); Marshal.FreeHGlobal(attrList); }
      if (hPC != IntPtr.Zero) ClosePseudoConsole(hPC);
      if (inRead != IntPtr.Zero) CloseHandle(inRead);
      if (inWrite != IntPtr.Zero) CloseHandle(inWrite);
      if (outRead != IntPtr.Zero) CloseHandle(outRead);
      if (outWrite != IntPtr.Zero) CloseHandle(outWrite);
    }
  }
}
'@
Add-Type -TypeDefinition $src -Language CSharp
$argsText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ArgsB64))
$shellArgs = @($argsText -split "`n" | Where-Object { $_ -ne '' })
function QuoteArg([string]$s) {
  if ($s -notmatch '[ \t"]') { return $s }
  $out = '"'
  $bs = 0
  foreach ($ch in $s.ToCharArray()) {
    if ($ch -eq '\') { $bs++; continue }
    if ($ch -eq '"') { $out += ('\' * ($bs * 2 + 1)) + '"'; $bs = 0; continue }
    if ($bs -gt 0) { $out += ('\' * $bs); $bs = 0 }
    $out += $ch
  }
  if ($bs -gt 0) { $out += ('\' * ($bs * 2)) }
  return $out + '"'
}
$cmd = (QuoteArg $Exe) + ' ' + (($shellArgs | ForEach-Object { QuoteArg $_ }) -join ' ')
$code = [GenieConPty]::Run($cmd, $Cwd, $Cols, $Rows)
exit $code
