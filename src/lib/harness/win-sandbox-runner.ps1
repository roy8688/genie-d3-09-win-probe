# Genie Windows 沙箱 runner（D3-09）
#
# 产品契约（由 sandbox.js 传入）：
#   --workspace <dir> --temp <dir> --mode <read-only|workspace-write>
#   --cwd <dir> --network <on|off> [--extra <dir> ...] -- <command> [args...]
#
# 真实执行链：
#   1. 建一个临时本地组，作为 restricted token 的 restricting SID；
#   2. 给工作区/临时目录写 ACE（workspace-write 给组 F，read-only 给组 R）；
#   3. CreateRestrictedToken(WRITE_RESTRICTED) 后 CreateProcessAsUser；
#   4. 子进程先挂进 Job Object（KILL_ON_JOB_CLOSE），再 Resume；
#   5. 子进程 stdout/stderr 落到临时文件，退出后回写父进程；
#   6. runner 退出/被外层杀掉时 Job 句柄关闭，整棵子进程树一起死。
#
# 明确边界：网络开关不在这里伪造。runner 只负责文件写侧 + 进程树；网络策略
# 需要额外的防火墙/AppContainer 能力，未接入前 sandbox 状态必须写 runner-defined。
$ErrorActionPreference = 'Stop'

$argv = @($args)
$workspace = ''
$tempDir = ''
$mode = 'workspace-write'
$cwd = ''
$network = 'off'
$extraRoots = @()
$commandParts = @()
$i = 0
while ($i -lt $argv.Count) {
  $a = $argv[$i]
  if ($a -eq '--') {
    $i++
    if ($i -ge $argv.Count) { throw 'WIN_SANDBOX_COMMAND_REQUIRED' }
    $commandParts = @($argv[$i..($argv.Count - 1)])
    break
  }
  switch ($a) {
    '--workspace' { $i++; $workspace = [string]$argv[$i] }
    '--temp' { $i++; $tempDir = [string]$argv[$i] }
    '--mode' { $i++; $mode = [string]$argv[$i] }
    '--cwd' { $i++; $cwd = [string]$argv[$i] }
    '--network' { $i++; $network = [string]$argv[$i] }
    '--extra' { $i++; $extraRoots += [string]$argv[$i] }
    default { throw ('WIN_SANDBOX_UNKNOWN_ARG:' + $a) }
  }
  $i++
}
if (-not $workspace) { throw 'WIN_SANDBOX_WORKSPACE_REQUIRED' }
if ($commandParts.Count -eq 0) { throw 'WIN_SANDBOX_COMMAND_REQUIRED' }
if (-not $cwd) { $cwd = $workspace }
if ($mode -ne 'workspace-write' -and $mode -ne 'read-only') { throw ('WIN_SANDBOX_MODE_INVALID:' + $mode) }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'WIN_SANDBOX_ADMIN_REQUIRED'
}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class GenieSandboxRunner {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct SECURITY_ATTRIBUTES {
    public int nLength;
    public IntPtr lpSecurityDescriptor;
    public bool bInheritHandle;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct SID_AND_ATTRIBUTES {
    public IntPtr Sid;
    public uint Attributes;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount;
    public ulong WriteOperationCount;
    public ulong OtherOperationCount;
    public ulong ReadTransferCount;
    public ulong WriteTransferCount;
    public ulong OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr sec, string name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint ResumeThread(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sec, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount, IntPtr disableSids, uint deleteCount, IntPtr deletePrivs, uint restrictCount, IntPtr restrictSids, out IntPtr newToken);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool ConvertStringSidToSid(string str, out IntPtr sid);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr h);

  const uint TOKEN_ASSIGN_PRIMARY = 0x0001;
  const uint TOKEN_DUPLICATE = 0x0002;
  const uint TOKEN_QUERY = 0x0008;
  const uint TOKEN_ADJUST_DEFAULT = 0x0080;
  const uint TOKEN_ADJUST_SESSIONID = 0x0100;
  const uint WRITE_RESTRICTED = 0x00000020;
  const uint CREATE_SUSPENDED = 0x00000004;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint STARTF_USESTDHANDLES = 0x00000100;
  const uint GENERIC_WRITE = 0x40000000;
  const uint GENERIC_READ = 0x80000000;
  const uint FILE_SHARE_READ = 1;
  const uint FILE_SHARE_WRITE = 2;
  const uint CREATE_ALWAYS = 2;
  const uint OPEN_EXISTING = 3;
  const uint FILE_ATTRIBUTE_NORMAL = 0x80;
  const int JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS = 9;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

  public static string Quote(string s) {
    if (s == null) return "\"\"";
    if (s.Length == 0) return "\"\"";
    if (s.IndexOfAny(new char[] { ' ', '\t', '"' }) < 0) return s;
    return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
  }

  public static string BuildCommandLine(string[] parts) {
    string out = "";
    for (int i = 0; i < parts.Length; i++) {
      if (i > 0) out += " ";
      out += Quote(parts[i]);
    }
    return out;
  }

  public static int Run(string groupSid, string cwd, string[] parts, string outFile, string errFile) {
    IntPtr sid = IntPtr.Zero;
    IntPtr restricted = IntPtr.Zero;
    IntPtr current = IntPtr.Zero;
    IntPtr job = IntPtr.Zero;
    IntPtr outHandle = IntPtr.Zero;
    IntPtr errHandle = IntPtr.Zero;
    IntPtr nulHandle = IntPtr.Zero;
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    try {
      if (!ConvertStringSidToSid(groupSid, out sid)) throw new Exception("WIN_SANDBOX_SID:" + Marshal.GetLastWin32Error());
      SID_AND_ATTRIBUTES sa = new SID_AND_ATTRIBUTES();
      sa.Sid = sid;
      sa.Attributes = 0;
      IntPtr arr = Marshal.AllocHGlobal(Marshal.SizeOf(sa));
      try {
        Marshal.StructureToPtr(sa, arr, false);
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID, out current)) {
          throw new Exception("WIN_SANDBOX_OPEN_TOKEN:" + Marshal.GetLastWin32Error());
        }
        if (!CreateRestrictedToken(current, WRITE_RESTRICTED, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, arr, out restricted)) {
          throw new Exception("WIN_SANDBOX_CREATE_RESTRICTED:" + Marshal.GetLastWin32Error());
        }
      } finally {
        Marshal.FreeHGlobal(arr);
      }

      SECURITY_ATTRIBUTES sec = new SECURITY_ATTRIBUTES();
      sec.nLength = Marshal.SizeOf(sec);
      sec.lpSecurityDescriptor = IntPtr.Zero;
      sec.bInheritHandle = true;
      outHandle = CreateFile(outFile, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, ref sec, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
      errHandle = CreateFile(errFile, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, ref sec, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
      nulHandle = CreateFile("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, ref sec, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
      if (outHandle == IntPtr.Zero || new IntPtr(-1) == outHandle) throw new Exception("WIN_SANDBOX_OUT:" + Marshal.GetLastWin32Error());
      if (errHandle == IntPtr.Zero || new IntPtr(-1) == errHandle) throw new Exception("WIN_SANDBOX_ERR:" + Marshal.GetLastWin32Error());
      if (nulHandle == IntPtr.Zero || new IntPtr(-1) == nulHandle) throw new Exception("WIN_SANDBOX_NUL:" + Marshal.GetLastWin32Error());

      STARTUPINFO si = new STARTUPINFO();
      si.cb = Marshal.SizeOf(si);
      si.dwFlags = (int)STARTF_USESTDHANDLES;
      si.hStdInput = nulHandle;
      si.hStdOutput = outHandle;
      si.hStdError = errHandle;

      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Exception("WIN_SANDBOX_JOB:" + Marshal.GetLastWin32Error());
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      if (!SetInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION_CLASS, ref info, Marshal.SizeOf(info))) {
        throw new Exception("WIN_SANDBOX_JOB_LIMIT:" + Marshal.GetLastWin32Error());
      }

      string cmdline = BuildCommandLine(parts);
      if (!CreateProcessAsUser(restricted, null, cmdline, IntPtr.Zero, IntPtr.Zero, true,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref si, out pi)) {
        throw new Exception("WIN_SANDBOX_CREATE_PROCESS:" + Marshal.GetLastWin32Error());
      }
      if (!AssignProcessToJobObject(job, pi.hProcess)) {
        TerminateProcess(pi.hProcess, 1);
        throw new Exception("WIN_SANDBOX_ASSIGN_JOB:" + Marshal.GetLastWin32Error());
      }
      if (ResumeThread(pi.hThread) == 0xFFFFFFFF) {
        TerminateJobObject(job, 1);
        throw new Exception("WIN_SANDBOX_RESUME:" + Marshal.GetLastWin32Error());
      }
      uint wait = WaitForSingleObject(pi.hProcess, 300000);
      if (wait == 258) {
        TerminateJobObject(job, 1);
        return 124;
      }
      uint code = 1;
      GetExitCodeProcess(pi.hProcess, out code);
      return unchecked((int)code);
    } finally {
      if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
      if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (outHandle != IntPtr.Zero) CloseHandle(outHandle);
      if (errHandle != IntPtr.Zero) CloseHandle(errHandle);
      if (nulHandle != IntPtr.Zero) CloseHandle(nulHandle);
      if (restricted != IntPtr.Zero) CloseHandle(restricted);
      if (current != IntPtr.Zero) CloseHandle(current);
      if (sid != IntPtr.Zero) LocalFree(sid);
    }
  }
}
'@ -PassThru | Out-Null

$groupName = 'GenieSbx_' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$groupCreated = $false
$outFile = [IO.Path]::Combine($env:TEMP, 'genie-sbx-out-' + $PID + '.txt')
$errFile = [IO.Path]::Combine($env:TEMP, 'genie-sbx-err-' + $PID + '.txt')
try {
  New-LocalGroup -Name $groupName -Description 'Genie per-call sandbox group' | Out-Null
  $groupCreated = $true
  $groupSid = (Get-LocalGroup -Name $groupName).SID.Value
  $user = $identity.Name

  $grant = @("$user:(OI)(CI)F")
  if ($mode -eq 'workspace-write') { $grant += "$groupName:(OI)(CI)F" } else { $grant += "$groupName:(OI)(CI)R" }
  & icacls.exe $workspace /inheritance:r /grant:r $grant | Out-Null
  if ($LASTEXITCODE -ne 0) { throw ('WIN_SANDBOX_ICACLS_WORKSPACE:' + $LASTEXITCODE) }

  if ($tempDir -and (Test-Path -LiteralPath $tempDir)) {
    & icacls.exe $tempDir /inheritance:r /grant:r "$user:(OI)(CI)F" "$groupName:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ('WIN_SANDBOX_ICACLS_TEMP:' + $LASTEXITCODE) }
  }
  foreach ($root in $extraRoots) {
    if ($root -and (Test-Path -LiteralPath $root)) {
      & icacls.exe $root /grant:r "$groupName:(OI)(CI)F" | Out-Null
      if ($LASTEXITCODE -ne 0) { throw ('WIN_SANDBOX_ICACLS_EXTRA:' + $LASTEXITCODE) }
    }
  }

  $code = [GenieSandboxRunner]::Run($groupSid, $cwd, $commandParts, $outFile, $errFile)
  if (Test-Path -LiteralPath $outFile) {
    $text = [IO.File]::ReadAllText($outFile, [Text.Encoding]::UTF8)
    if ($text.Length -gt 0) { [Console]::Out.Write($text) }
  }
  if (Test-Path -LiteralPath $errFile) {
    $text = [IO.File]::ReadAllText($errFile, [Text.Encoding]::UTF8)
    if ($text.Length -gt 0) { [Console]::Error.Write($text) }
  }
  exit $code
} finally {
  Remove-Item -LiteralPath $outFile, $errFile -Force -ErrorAction SilentlyContinue
  if ($groupCreated) {
    Remove-LocalGroup -Name $groupName -ErrorAction SilentlyContinue
  }
}
