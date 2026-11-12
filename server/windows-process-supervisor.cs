using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// A fixed host helper, not a shell. The child starts suspended, enters a job
// that disallows breakaway, and only then runs. Closing the last job handle
// kills its tree; only observing ActiveProcesses == 0 produces an exit receipt.
internal static class WindowsProcessSupervisor
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint WAIT_OBJECT_0 = 0;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct StartupInfo {
        public uint cb;
        public string lpReserved, lpDesktop, lpTitle;
        public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public ushort wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo { public IntPtr hProcess, hThread; public uint processId, threadId; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting info, uint length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd,
        ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool DuplicateHandle(IntPtr sourceProcess,
        IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);

    private static void Require(bool success) {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    private static IntPtr Inherit(int standardHandle) {
        IntPtr copy;
        Require(DuplicateHandle(new IntPtr(-1), GetStdHandle(standardHandle), new IntPtr(-1), out copy, 0, true, 2));
        return copy;
    }
    private static string Quote(string value) {
        if (value == null || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid argument");
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') result.Append('\\', slashes * 2 + 1).Append(c);
            else result.Append('\\', slashes).Append(c);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    private static void WriteAtomic(string filename, object value) {
        string temporary = filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
        byte[] bytes = new UTF8Encoding(false).GetBytes(Json.Serialize(value));
        using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
        }
        File.Move(temporary, filename);
    }
    private static bool CancelRequested(string filename, string identity) {
        try { return File.Exists(filename) && new FileInfo(filename).Length < 1024 && File.ReadAllText(filename) == identity; }
        catch (IOException) { return false; }
    }

    public static int Main(string[] args) {
        if (args.Length != 1) return 125;
        IntPtr job = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        var handles = new List<IntPtr>();
        Dictionary<string, object> spec = null;
        bool assigned = false, resumed = false, confirmed = false, cancelled = false;
        uint exitCode = 125;
        string failure = null;
        try {
            if (new FileInfo(args[0]).Length > 1024 * 1024) throw new ArgumentException("Launch specification too large");
            spec = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(args[0], Encoding.UTF8));
            File.Delete(args[0]); // Prompts/arguments are not a durable process record.
            string executable = (string)spec["executable"];
            string cwd = (string)spec["cwd"];
            string identity = (string)spec["id"];
            if (!Path.IsPathRooted(executable) || !Path.IsPathRooted(cwd)) throw new ArgumentException("Absolute paths required");
            var command = new StringBuilder(Quote(executable));
            foreach (object argument in (IEnumerable)spec["args"]) command.Append(' ').Append(Quote((string)argument));
            if (command.Length >= 32767) throw new ArgumentException("Native argument limit exceeded");
            job = CreateJobObject(IntPtr.Zero, null);
            Require(job != IntPtr.Zero);
            var limits = new ExtendedLimits();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            Require(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)));
            var startup = new StartupInfo();
            startup.cb = (uint)Marshal.SizeOf(startup);
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = Inherit(-10); handles.Add(startup.hStdInput);
            startup.hStdOutput = Inherit(-11); handles.Add(startup.hStdOutput);
            startup.hStdError = Inherit(-12); handles.Add(startup.hStdError);
            Require(CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true,
                CREATE_SUSPENDED | CREATE_NO_WINDOW, IntPtr.Zero, cwd, ref startup, out child));
            Require(AssignProcessToJobObject(job, child.hProcess));
            assigned = true;
            WriteAtomic((string)spec["startPath"], new { version = 1, id = identity,
                supervisorPid = Process.GetCurrentProcess().Id, rootPid = child.processId,
                assignedBeforeResume = true, createdAt = DateTime.UtcNow.ToString("o") });
            cancelled = CancelRequested((string)spec["cancelPath"], identity);
            if (cancelled) Require(TerminateJobObject(job, 1223));
            else {
                if (ResumeThread(child.hThread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
                resumed = true;
            }
            foreach (IntPtr handle in handles) CloseHandle(handle);
            handles.Clear();
            while (true) {
                Accounting accounting;
                Require(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
                if (accounting.ActiveProcesses == 0) { confirmed = true; break; }
                if (!cancelled && CancelRequested((string)spec["cancelPath"], identity)) {
                    cancelled = true;
                    Require(TerminateJobObject(job, 1223));
                }
                Thread.Sleep(25);
            }
            Require(GetExitCodeProcess(child.hProcess, out exitCode));
        } catch (Exception error) {
            // Do not serialize arguments, environment values or provider output.
            failure = "Windows process supervision failed (" + error.GetType().Name + ")";
            if (child.hProcess == IntPtr.Zero) confirmed = true;
            else if (assigned) {
                if (TerminateJobObject(job, 125)) {
                    for (int count = 0; count < 200; count++) {
                        Accounting accounting;
                        if (QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)
                            && accounting.ActiveProcesses == 0) { confirmed = true; break; }
                        Thread.Sleep(25);
                    }
                }
            } else if (!resumed && TerminateProcess(child.hProcess, 125)) {
                // A suspended process that never entered user code cannot create children.
                confirmed = WaitForSingleObject(child.hProcess, 5000) == WAIT_OBJECT_0;
            }
        } finally {
            if (spec != null && confirmed) {
                try { WriteAtomic((string)spec["receiptPath"], new { version = 1, kind = "windows_job",
                    id = (string)spec["id"], issuedAt = (string)spec["issuedAt"],
                    supervisorPid = Process.GetCurrentProcess().Id, rootPid = child.processId,
                    assignedBeforeResume = assigned, neverResumed = !resumed,
                    activeProcesses = 0, treeExitConfirmed = true, exitCode = unchecked((int)exitCode),
                    cancelled = cancelled, error = failure, checkedAt = DateTime.UtcNow.ToString("o") }); }
                catch { exitCode = 125; }
            }
            foreach (IntPtr handle in handles) CloseHandle(handle);
            if (child.hThread != IntPtr.Zero) CloseHandle(child.hThread);
            if (child.hProcess != IntPtr.Zero) CloseHandle(child.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
        }
        return unchecked((int)exitCode);
    }
}
