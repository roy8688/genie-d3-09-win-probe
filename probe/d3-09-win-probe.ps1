$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Result($obj) {
  Write-Output ("RESULT " + ($obj | ConvertTo-Json -Depth 8 -Compress))
}

$base = 'C:\genie-d3-09'
$ws = Join-Path $base 'ws'
New-Item -ItemType Directory -Force -Path $ws | Out-Null

$group = 'GenieWorkspace'
$groupSid = $null
$groupCreated = $false
try {
  New-LocalGroup -Name $group -Description 'Genie D3-09 ACL probe' -ErrorAction Stop | Out-Null
  $groupCreated = $true
} catch {
  $groupCreated = $false
}
try {
  $groupSid = (Get-LocalGroup -Name $group -ErrorAction Stop).SID.Value
} catch {
  $groupSid = $null
}
if (-not $groupSid) {
  throw 'GROUP_MISSING GenieWorkspace'
}

# Deny write to the workspace group, allow the current administrator full control.
$icaclsOut = (& icacls $ws /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" /deny "$($group):(OI)(CI)W" 2>&1 | Out-String)

try {
$typeList = Add-Type -PassThru -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class GenieWinProbe {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)]
  public struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)]
  public struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)]
  public struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public LUID_AND_ATTRIBUTES Privileges; }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount;
    public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr CreateJobObject(IntPtr sec, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] public static extern bool AdjustTokenPrivileges(IntPtr token, bool disable,
    ref TOKEN_PRIVILEGES newState, uint len, IntPtr old, IntPtr ret);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool LookupPrivilegeValue(string system, string name, out LUID luid);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern bool CreateRestrictedToken(IntPtr existing, uint flags,
    uint disableCount, IntPtr disableSids, uint deleteCount, IntPtr deleteSids,
    uint restrictCount, IntPtr restrictSids, out IntPtr newToken);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool ConvertStringSidToSid(string sid, out IntPtr sidPtr);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CreateProcessAsUser(IntPtr token, string app, string cmd, IntPtr pa, IntPtr ta,
    bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

  public static string EnablePrivilege(string name) {
    IntPtr token = IntPtr.Zero;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) return "OPEN_TOKEN:" + Marshal.GetLastWin32Error();
    LUID luid;
    if (!LookupPrivilegeValue(null, name, out luid)) return "LOOKUP:" + Marshal.GetLastWin32Error();
    TOKEN_PRIVILEGES tp = new TOKEN_PRIVILEGES();
    tp.PrivilegeCount = 1; tp.Privileges.Luid = luid; tp.Privileges.Attributes = 2;
    AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
    int err = Marshal.GetLastWin32Error();
    CloseHandle(token);
    return err == 0 ? "OK" : "ADJUST:" + err;
  }

  public static string RunRestricted(string groupSid, string cwd, string cmd) {
    string priv = EnablePrivilege("SeAssignPrimaryTokenPrivilege") + "/" + EnablePrivilege("SeIncreaseQuotaPrivilege");
    IntPtr sid = IntPtr.Zero;
    if (!ConvertStringSidToSid(groupSid, out sid)) return "SID:" + Marshal.GetLastWin32Error();
    SID_AND_ATTRIBUTES sa = new SID_AND_ATTRIBUTES(); sa.Sid = sid; sa.Attributes = 0;
    IntPtr arr = Marshal.AllocHGlobal(Marshal.SizeOf(sa));
    Marshal.StructureToPtr(sa, arr, false);
    IntPtr current = IntPtr.Zero;
    if (!OpenProcessToken(GetCurrentProcess(), 0x2B, out current)) return "OPEN_TOKEN:" + Marshal.GetLastWin32Error();
    IntPtr restricted = IntPtr.Zero;
    bool ok = CreateRestrictedToken(current, 0x8, 0, IntPtr.Zero, 0, IntPtr.Zero, 1, arr, out restricted);
    int err = Marshal.GetLastWin32Error();
    CloseHandle(current); CloseHandle(sid); Marshal.FreeHGlobal(arr);
    if (!ok) return "priv=" + priv + " CREATE_RESTRICTED:" + err;
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si);
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    bool created = CreateProcessAsUser(restricted, null, cmd, IntPtr.Zero, IntPtr.Zero, false,
      0x00000400, IntPtr.Zero, cwd, ref si, out pi);
    int createErr = Marshal.GetLastWin32Error();
    CloseHandle(restricted);
    if (!created) return "CREATE_PROCESS:" + createErr;
    uint wait = WaitForSingleObject(pi.hProcess, 10000);
    uint code = 0; GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return "priv=" + priv + " wait=" + wait + " exit=" + code;
  }

  public static string RunJob(string cwd, string cmd) {
    STARTUPINFO si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si);
    PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
    bool created = CreateProcess(null, cmd, IntPtr.Zero, IntPtr.Zero, false,
      0x00000400, IntPtr.Zero, cwd, ref si, out pi);
    if (!created) return "CREATE_PROCESS:" + Marshal.GetLastWin32Error();
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return "CREATE_JOB:" + Marshal.GetLastWin32Error();
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = 0x2000;
    int size = Marshal.SizeOf(info);
    IntPtr ptr = Marshal.AllocHGlobal(size);
    Marshal.StructureToPtr(info, ptr, false);
    bool set = SetInformationJobObject(job, 9, ptr, (uint)size);
    int setErr = Marshal.GetLastWin32Error();
    Marshal.FreeHGlobal(ptr);
    if (!set) return "SET_JOB:" + setErr;
    bool assigned = AssignProcessToJobObject(job, pi.hProcess);
    int assignErr = Marshal.GetLastWin32Error();
    ResumeThread(pi.hThread);
    Thread.Sleep(600);
    bool closed = CloseHandle(job);
    uint wait = WaitForSingleObject(pi.hProcess, 3000);
    uint code = 0; GetExitCodeProcess(pi.hProcess, out code);
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return "created=" + created + " assigned=" + assigned + " assignErr=" + assignErr + " closed=" + closed + " wait=" + wait + " exit=" + code;
  }
}
'@
Write-Output ("ADDTYPE_TYPES " + (($typeList | ForEach-Object { $_.FullName }) -join ','))
if (-not ('GenieWinProbe' -as [type])) { Write-Output 'TYPE_MISSING'; exit 2 }
} catch {
  Write-Output ("ADDTYPE_FAIL " + $_.Exception.Message)
  exit 1
}

$result = [ordered]@{
  os = (Get-CimInstance Win32_OperatingSystem).Caption
  build = (Get-CimInstance Win32_OperatingSystem).BuildNumber
  admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  group = $group
  groupSid = $groupSid
  groupCreated = $groupCreated
  icacls = $icaclsOut.Trim()
  acl = $null
  job = $null
}

$controlFile = Join-Path $ws 'allowed.txt'
$blockedFile = Join-Path $ws 'blocked.txt'
Remove-Item $controlFile, $blockedFile -Force -ErrorAction SilentlyContinue
& cmd.exe /c "echo control> $controlFile" | Out-Null
$acl = [ordered]@{
  controlWrite = (Test-Path $controlFile)
  restricted = [GenieWinProbe]::RunRestricted($groupSid, $base, "cmd.exe /c `"echo blocked> $blockedFile`"")
  blockedExists = (Test-Path $blockedFile)
}
$acl['ran'] = ($acl.restricted -match 'wait=')
$acl['denied'] = ($acl.blockedExists -eq $false) -and $acl.ran
$result.acl = $acl

$result.job = [GenieWinProbe]::RunJob($base, "cmd.exe /c ping -n 21 127.0.0.1 > nul")

Write-Result $result
