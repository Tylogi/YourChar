// YourChar Windows launcher.
//
// Double-click entry point for ordinary Windows users. It owns the whole
// startup chain: check WSL2, import the bundled YourChar WSL runtime on first
// run, start the Linux backend, wait for readiness, open the browser UI, watch
// the backend for the whole session and shut it down gracefully on exit.
//
// The user never types a WSL, PowerShell, npm, Node, Python or uv command.
// Built with the in-box .NET Framework compiler (see build.ps1), so end users
// install nothing: no .NET download, no runtime prerequisites.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace YourCharLauncher
{
    internal static class Cfg
    {
        public const string DistroName = "YourChar";
        public const string FallbackDistroName = "YourCharRuntime";
        public const string DistroMarker = "/opt/yourchar/BUILD-INFO.txt";
        public const string DistroEntrypoint = "/opt/yourchar/bin/yourchar-backend";
        public const string DistroStateDir = "/var/lib/yourchar";
        public const int Port = 8765;
        public const string HealthUrl = "http://127.0.0.1:8765/api/v1/health";
        public const string UiUrl = "http://127.0.0.1:8765/";

        // A hard-killed backend can leave the memory-vault writer lease taken for
        // about 20s. Never restart inside that window.
        public const int BackoffSeconds = 25;
        public const int MaxRecoveryAttempts = 3;
        public const int StableUptimeSeconds = 120;
        public const int ReadyTimeoutSeconds = 90;
        public const int ReadyTimeoutFirstRunSeconds = 180;
        public const int ImportTimeoutSeconds = 900;
        public const int StopTimeoutSeconds = 20;

        public const string MutexName = "Local\\YourCharLauncherSingleInstance";

        public static bool NoBrowser;

        public static string AppDir { get { return Path.GetDirectoryName(Application.ExecutablePath); } }
        public static string RuntimeDir { get { return Path.Combine(AppDir, "runtime"); } }
        public static string DataDir
        {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YourChar"); }
        }
        public static string DistroDir { get { return Path.Combine(DataDir, "distro"); } }
        public static string BackendLog { get { return Path.Combine(DataDir, "backend.log"); } }
        public static string LauncherLog { get { return Path.Combine(DataDir, "launcher.log"); } }
        public static string StatusFile { get { return Path.Combine(DataDir, "status.json"); } }
        public static string StopSentinel { get { return Path.Combine(DataDir, "stop.request"); } }
    }

    internal static class Log
    {
        static readonly object Gate = new object();

        public static void Write(string message)
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine;
            lock (Gate)
            {
                try { File.AppendAllText(Cfg.LauncherLog, line, new UTF8Encoding(false)); }
                catch { }
            }
        }

        public static void WriteException(string context, Exception error)
        {
            Write(context + ": " + error.GetType().Name + ": " + error.Message);
            Write(error.StackTrace);
        }
    }

    internal static class Wsl
    {
        public static readonly string Exe = Path.Combine(Environment.SystemDirectory, "wsl.exe");

        // MSVCRT argument quoting: wsl.exe hands these straight to the Linux side.
        public static string Quote(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
            StringBuilder sb = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"') { sb.Append('\\', backslashes * 2 + 1); sb.Append('"'); backslashes = 0; continue; }
                if (backslashes > 0) { sb.Append('\\', backslashes); backslashes = 0; }
                sb.Append(c);
            }
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        public static ProcessStartInfo StartInfo(string[] args, bool capture, Encoding encoding)
        {
            StringBuilder line = new StringBuilder();
            foreach (string arg in args)
            {
                if (line.Length > 0) line.Append(' ');
                line.Append(Quote(arg));
            }
            ProcessStartInfo psi = new ProcessStartInfo(Exe);
            psi.Arguments = line.ToString();
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            if (capture)
            {
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                psi.StandardOutputEncoding = encoding;
                psi.StandardErrorEncoding = encoding;
            }
            return psi;
        }

        // wsl.exe's own diagnostics are UTF-16LE; a relayed Linux command's bytes
        // come through untouched, so those must be read as UTF-8.
        public static readonly Encoding OwnOutput = Encoding.Unicode;
        public static readonly Encoding LinuxOutput = new UTF8Encoding(false);

        public static int Run(string[] args, int timeoutMs, Encoding encoding, out string stdout, out string stderr)
        {
            stdout = "";
            stderr = "";
            Process process = new Process();
            process.StartInfo = StartInfo(args, true, encoding);
            try
            {
                process.Start();
            }
            catch (Exception error)
            {
                stderr = error.Message;
                return -1;
            }
            string outText = null;
            string errText = null;
            Thread stdoutThread = new Thread(delegate() { try { outText = process.StandardOutput.ReadToEnd(); } catch { } });
            Thread stderrThread = new Thread(delegate() { try { errText = process.StandardError.ReadToEnd(); } catch { } });
            stdoutThread.IsBackground = true;
            stderrThread.IsBackground = true;
            stdoutThread.Start();
            stderrThread.Start();
            if (!process.WaitForExit(timeoutMs))
            {
                try { process.Kill(); } catch { }
                stdout = outText ?? "";
                return -1;
            }
            stdoutThread.Join(5000);
            stderrThread.Join(5000);
            stdout = outText ?? "";
            stderr = errText ?? "";
            return process.ExitCode;
        }
    }

    internal sealed class Engine
    {
        public volatile string StageName = "checking";
        public volatile string Message = "Checking Windows Subsystem for Linux...";
        public volatile string Action = "";
        public volatile bool Busy = true;
        public volatile bool Ready;
        public volatile bool Finished;

        public string Distro = Cfg.DistroName;

        readonly object logGate = new object();
        Process backend;
        StreamWriter backendLog;
        bool stopping;
        bool restartScheduled;
        bool suppressRecovery;
        bool importedThisRun;
        int failureCount;
        DateTime readyAt;

        public void Start()
        {
            Thread thread = new Thread(delegate()
            {
                try { Boot(); }
                catch (Exception error) { Log.WriteException("boot failed", error); Fail("YourChar could not start."); }
            });
            thread.IsBackground = true;
            thread.Start();
        }

        void Set(string stage, string message, bool busy, string action)
        {
            StageName = stage;
            Message = message;
            Busy = busy;
            Action = action;
            WriteStatus();
        }

        void WriteStatus()
        {
            try
            {
                StringBuilder sb = new StringBuilder();
                sb.Append("{\"stage\":\"").Append(StageName).Append("\",");
                sb.Append("\"distro\":\"").Append(Distro).Append("\",");
                sb.Append("\"url\":\"").Append(Cfg.UiUrl).Append("\",");
                sb.Append("\"backend\":\"").Append(BackendState()).Append("\"}");
                File.WriteAllText(Cfg.StatusFile, sb.ToString(), new UTF8Encoding(false));
            }
            catch { }
        }

        string BackendState()
        {
            if (backend == null) return "stopped";
            try { return backend.HasExited ? "exited" : "running"; }
            catch { return "unknown"; }
        }

        void Boot()
        {
            if (EnsureStopped()) return;
            Set("checking", "Checking Windows Subsystem for Linux...", true, "");
            if (!EnsureWsl())
            {
                Set("needs-wsl", "WSL2 is required.\n\nYourChar runs its own private Linux runtime and needs the Windows Subsystem for Linux 2. Windows may ask you to restart after setup.", false, "install-wsl");
                return;
            }
            if (HandleLeftoverBackend()) return;
            if (!EnsureDistro()) return;
            Set("verifying", "Checking YourChar runtime...", true, "");
            if (!Preflight())
            {
                Set("needs-repair", "YourChar runtime needs repair.\n\nRepairing reinstalls it; YourChar's stored conversations and characters are removed when you do.", false, "repair");
                return;
            }
            StartBackendAndFinish();
        }

        bool EnsureStopped()
        {
            return stopping;
        }

        bool EnsureWsl()
        {
            string stdout, stderr;
            int code = Wsl.Run(new string[] { "--status" }, 60000, Wsl.OwnOutput, out stdout, out stderr);
            if (code != 0)
            {
                Log.Write("wsl --status rc=" + code + " stderr=" + stderr.Trim());
                return false;
            }
            List<string> names;
            code = ListDistros(out names);
            Log.Write("wsl -l -q rc=" + code + " names=" + string.Join(",", names.ToArray()));
            return code == 0;
        }

        int ListDistros(out List<string> names)
        {
            names = new List<string>();
            string stdout, stderr;
            int code = Wsl.Run(new string[] { "-l", "-q" }, 60000, Wsl.OwnOutput, out stdout, out stderr);
            if (code != 0) return code;
            foreach (string raw in stdout.Replace("\0", "").Split('\n'))
            {
                string name = raw.Trim();
                if (name.Length > 0) names.Add(name);
            }
            return code;
        }

        static bool ContainsName(List<string> names, string name)
        {
            foreach (string candidate in names)
            {
                if (string.Equals(candidate, name, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        bool HasMarker(string distro)
        {
            string stdout, stderr;
            int code = Wsl.Run(new string[] { "-d", distro, "-u", "yourchar", "--exec", "/usr/bin/test", "-f", Cfg.DistroMarker }, 120000, Wsl.LinuxOutput, out stdout, out stderr);
            return code == 0;
        }

        bool EnsureDistro()
        {
            List<string> names;
            if (ListDistros(out names) != 0)
            {
                Fail("YourChar could not reach the Windows Subsystem for Linux.");
                return false;
            }
            if (ContainsName(names, Cfg.DistroName) && HasMarker(Cfg.DistroName))
            {
                Distro = Cfg.DistroName;
                return true;
            }
            if (ContainsName(names, Cfg.FallbackDistroName) && HasMarker(Cfg.FallbackDistroName))
            {
                Distro = Cfg.FallbackDistroName;
                return true;
            }
            if (!ContainsName(names, Cfg.DistroName))
            {
                Distro = Cfg.DistroName;
                return ImportDistro();
            }
            if (!ContainsName(names, Cfg.FallbackDistroName))
            {
                Distro = Cfg.FallbackDistroName;
                Log.Write("distro name " + Cfg.DistroName + " is taken by an unrelated distribution");
                return ImportDistro();
            }
            Log.Write("both " + Cfg.DistroName + " and " + Cfg.FallbackDistroName + " exist and neither is a YourChar runtime");
            Fail("YourChar cannot install its runtime because another WSL distribution already uses its name.\n\nRename or remove that distribution, then run YourChar again.");
            return false;
        }

        string FindPayload()
        {
            if (!Directory.Exists(Cfg.RuntimeDir)) return null;
            string[] candidates = Directory.GetFiles(Cfg.RuntimeDir, "YourChar-*-wsl-amd64.tar.gz");
            Array.Sort(candidates);
            return candidates.Length == 0 ? null : candidates[candidates.Length - 1];
        }

        bool VerifyPayload(string payload)
        {
            string sums = Path.Combine(Cfg.RuntimeDir, "SHA256SUMS.txt");
            if (!File.Exists(sums)) { Log.Write("no SHA256SUMS.txt next to the payload; skipping verification"); return true; }
            string expected = null;
            string fileName = Path.GetFileName(payload);
            foreach (string line in File.ReadAllLines(sums))
            {
                string[] parts = line.Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 2 && string.Equals(Path.GetFileName(parts[1]), fileName, StringComparison.OrdinalIgnoreCase))
                {
                    expected = parts[0].ToLowerInvariant();
                    break;
                }
            }
            if (expected == null) { Log.Write("payload " + fileName + " is not listed in SHA256SUMS.txt; skipping verification"); return true; }
            string actual;
            using (FileStream stream = File.OpenRead(payload))
            using (SHA256 sha = SHA256.Create())
            {
                byte[] digest = sha.ComputeHash(stream);
                StringBuilder sb = new StringBuilder();
                foreach (byte b in digest) sb.Append(b.ToString("x2"));
                actual = sb.ToString();
            }
            if (actual == expected) { Log.Write("payload verified " + fileName + " sha256=" + actual); return true; }
            Log.Write("payload mismatch for " + fileName + " expected=" + expected + " actual=" + actual);
            Fail("YourChar runtime files are damaged or incomplete.\n\nPlease download YourChar again.");
            return false;
        }

        bool ImportDistro()
        {
            string payload = FindPayload();
            if (payload == null)
            {
                Fail("YourChar runtime files are missing.\n\nPlease download YourChar again.");
                return false;
            }
            Set("verifying", "Verifying YourChar runtime...", true, "");
            if (!VerifyPayload(payload)) return false;

            Set("importing", "Preparing YourChar runtime.\n\nThis happens once and can take a few minutes.", true, "");
            try { Directory.CreateDirectory(Cfg.DistroDir); }
            catch (Exception error)
            {
                Log.WriteException("cannot create " + Cfg.DistroDir, error);
                Fail("YourChar could not prepare its runtime folder.");
                return false;
            }
            string stdout, stderr;
            int code = Wsl.Run(new string[] { "--import", Distro, Cfg.DistroDir, payload, "--version", "2" }, Cfg.ImportTimeoutSeconds * 1000, Wsl.OwnOutput, out stdout, out stderr);
            Log.Write("wsl --import " + Distro + " rc=" + code + " stderr=" + stderr.Trim());
            if (code != 0)
            {
                Fail("YourChar could not prepare its runtime.\n\nClose other WSL windows and try again.");
                return false;
            }
            importedThisRun = true;
            if (!HasMarker(Distro))
            {
                Log.Write("imported distribution is missing " + Cfg.DistroMarker);
                Fail("YourChar could not verify its runtime after installing it.");
                return false;
            }
            return true;
        }

        bool Preflight()
        {
            string stdout, stderr;
            int code = Wsl.Run(new string[] { "-d", Distro, "-u", "yourchar", "--exec", Cfg.DistroEntrypoint, "--check" }, Cfg.ReadyTimeoutFirstRunSeconds * 1000, Wsl.LinuxOutput, out stdout, out stderr);
            Log.Write("preflight rc=" + code + " out=" + stdout.Trim() + " err=" + stderr.Trim());
            return code == 0;
        }

        string ReadBackendPid()
        {
            string stdout, stderr;
            int code = Wsl.Run(new string[] { "-d", Distro, "-u", "yourchar", "--exec", "/bin/cat", Cfg.DistroStateDir + "/backend.pid" }, 60000, Wsl.LinuxOutput, out stdout, out stderr);
            if (code != 0) return "";
            return stdout.Trim();
        }

        public bool HealthResponds()
        {
            try
            {
                WebRequest request = WebRequest.Create(Cfg.HealthUrl);
                request.Timeout = 3000;
                using (WebResponse response = request.GetResponse())
                using (Stream stream = response.GetResponseStream())
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                {
                    return reader.ReadToEnd().IndexOf("\"ok\"", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch { return false; }
        }

        // A backend left behind by an earlier crashed launcher still holds the
        // memory-vault writer lease. Ask it to stop before starting a new one.
        bool HandleLeftoverBackend()
        {
            if (!HealthResponds()) return false;
            Log.Write("a YourChar backend is already responding; stopping it before start");
            string pid = ReadBackendPid();
            if (pid.Length == 0) return false;
            KillPid(pid);
            DateTime deadline = DateTime.UtcNow.AddSeconds(Cfg.StopTimeoutSeconds);
            while (DateTime.UtcNow < deadline && HealthResponds()) Thread.Sleep(500);
            return EnsureStopped();
        }

        void KillPid(string pid)
        {
            string stdout, stderr;
            int code = Wsl.Run(new string[] { "-d", Distro, "-u", "yourchar", "--exec", "/bin/kill", "-TERM", pid }, 60000, Wsl.LinuxOutput, out stdout, out stderr);
            Log.Write("kill -TERM " + pid + " rc=" + code + " err=" + stderr.Trim());
        }

        void StartBackendAndFinish()
        {
            restartScheduled = false;
            suppressRecovery = false;
            Set("starting", "Starting YourChar...", true, "");
            if (!StartBackend()) { Fail("YourChar could not start."); return; }
            Set("waiting", "Waiting for YourChar to be ready...", true, "");
            int timeout = importedThisRun ? Cfg.ReadyTimeoutFirstRunSeconds : Cfg.ReadyTimeoutSeconds;
            if (!WaitReady(timeout))
            {
                if (EnsureStopped()) return;
                if (backend != null && backend.HasExited) { HandleUnexpectedExit(); return; }
                Fail("YourChar did not become ready in time.\n\nAnother program may already be using its port.");
                return;
            }
            Ready = true;
            readyAt = DateTime.UtcNow;
            Set("ready", "YourChar is ready and running in your browser.", false, "open");
            if (!Cfg.NoBrowser) OpenUi();
        }

        bool StartBackend()
        {
            CloseBackendLog();
            try
            {
                Directory.CreateDirectory(Cfg.DataDir);
                FileStream stream = new FileStream(Cfg.BackendLog, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
                backendLog = new StreamWriter(stream, new UTF8Encoding(false));
                backendLog.AutoFlush = true;
                backendLog.WriteLine("--- launcher started the backend " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " ---");
            }
            catch (Exception error)
            {
                Log.WriteException("cannot open the backend log", error);
                return false;
            }
            // Write the pid before exec: the shell is replaced by the backend, so
            // the recorded pid is the backend pid and SIGTERM reaches it directly.
            string script = "mkdir -p " + Cfg.DistroStateDir + " && echo $$ > " + Cfg.DistroStateDir + "/backend.pid && exec " + Cfg.DistroEntrypoint;
            ProcessStartInfo psi = Wsl.StartInfo(new string[] { "-d", Distro, "-u", "yourchar", "--exec", "/bin/bash", "-c", script }, true, Wsl.LinuxOutput);
            Process process = new Process();
            process.StartInfo = psi;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { AppendBackendLog(e.Data); };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { AppendBackendLog(e.Data); };
            try
            {
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
            }
            catch (Exception error)
            {
                Log.WriteException("cannot start the backend", error);
                return false;
            }
            backend = process;
            Log.Write("backend started pid=" + process.Id);
            return true;
        }

        void AppendBackendLog(string line)
        {
            if (line == null) return;
            lock (logGate)
            {
                try { if (backendLog != null) backendLog.WriteLine(line); }
                catch { }
            }
        }

        void CloseBackendLog()
        {
            lock (logGate)
            {
                try { if (backendLog != null) backendLog.Dispose(); }
                catch { }
                backendLog = null;
            }
        }

        bool WaitReady(int timeoutSeconds)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(timeoutSeconds);
            while (DateTime.UtcNow < deadline)
            {
                if (EnsureStopped()) return false;
                if (backend != null && backend.HasExited) return false;
                if (HealthResponds()) return true;
                Thread.Sleep(1000);
            }
            return false;
        }

        public void OpenUi()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(Cfg.UiUrl);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch (Exception error) { Log.WriteException("cannot open the browser", error); }
        }

        void HandleUnexpectedExit()
        {
            if (restartScheduled) return;
            int code = -1;
            try { if (backend != null) code = backend.ExitCode; } catch { }
            Log.Write("backend exited unexpectedly rc=" + code);
            Ready = false;
            failureCount++;
            if (failureCount > Cfg.MaxRecoveryAttempts)
            {
                Set("failed", "YourChar stopped unexpectedly.\n\nOpen the log folder for details.", false, "retry");
                return;
            }
            restartScheduled = true;
            Set("recovering", "YourChar is recovering...\n\nPlease wait.", true, "");
            DateTime due = DateTime.UtcNow.AddSeconds(Cfg.BackoffSeconds);
            Thread thread = new Thread(delegate()
            {
                while (!EnsureStopped() && DateTime.UtcNow < due) Thread.Sleep(500);
                if (EnsureStopped()) return;
                try { StartBackendAndFinish(); }
                catch (Exception error) { Log.WriteException("recovery failed", error); Fail("YourChar could not restart."); }
            });
            thread.IsBackground = true;
            thread.Start();
        }

        public void Tick()
        {
            if (Finished) return;
            if (!stopping && File.Exists(Cfg.StopSentinel))
            {
                TryDelete(Cfg.StopSentinel);
                Log.Write("stop requested by another process");
                BeginStopAndExit();
                return;
            }
            if (backend == null) return;
            bool exited;
            try { exited = backend.HasExited; }
            catch { return; }
            if (!exited)
            {
                if (Ready && (DateTime.UtcNow - readyAt).TotalSeconds > Cfg.StableUptimeSeconds) failureCount = 0;
                return;
            }
            if (stopping || restartScheduled || suppressRecovery) return;
            HandleUnexpectedExit();
        }

        static void TryDelete(string path)
        {
            try { File.Delete(path); }
            catch { }
        }

        public void RunAction()
        {
            switch (Action)
            {
                case "open":
                    OpenUi();
                    break;
                case "install-wsl":
                    InstallWsl();
                    break;
                case "repair":
                    Repair(false);
                    break;
                case "retry":
                    failureCount = 0;
                    Set("checking", "Checking Windows Subsystem for Linux...", true, "");
                    Start();
                    break;
            }
        }

        void InstallWsl()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(Wsl.Exe);
                psi.Arguments = "--install --no-distribution";
                psi.UseShellExecute = true;
                psi.Verb = "runas";
                Process.Start(psi);
                Set("needs-wsl", "WSL2 setup has started.\n\nIf Windows asks you to restart, do that and then run YourChar again.", false, "retry");
            }
            catch (Exception error)
            {
                Log.WriteException("wsl --install failed", error);
                Set("needs-wsl", "WSL2 is required.\n\nInstalling it needs administrator approval. In an administrator PowerShell run: wsl --install --no-distribution", false, "");
            }
        }

        public void Repair(bool confirmed)
        {
            if (!confirmed)
            {
                DialogResult answer = MessageBox.Show(
                    "Repairing reinstalls YourChar's private Linux runtime.\n\nConversations, characters and memory stored inside it are removed. Continue?",
                    "Repair YourChar",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning);
                if (answer != DialogResult.Yes) return;
            }
            Thread thread = new Thread(delegate()
            {
                try
                {
                    Ready = false;
                    Set("preparing", "Repairing YourChar runtime...", true, "");
                    List<string> names;
                    if (ListDistros(out names) == 0 && ContainsName(names, Distro))
                    {
                        string stdout, stderr;
                        int code = Wsl.Run(new string[] { "--unregister", Distro }, 300000, Wsl.OwnOutput, out stdout, out stderr);
                        Log.Write("wsl --unregister " + Distro + " rc=" + code + " stderr=" + stderr.Trim());
                    }
                    importedThisRun = true;
                    if (!ImportDistro()) return;
                    if (!Preflight()) { Set("needs-repair", "YourChar runtime still needs repair.", false, "repair"); return; }
                    StartBackendAndFinish();
                }
                catch (Exception error) { Log.WriteException("repair failed", error); Fail("YourChar could not repair its runtime."); }
            });
            thread.IsBackground = true;
            thread.Start();
        }

        // Failures are reported from a background thread, so cleaning up the
        // backend here cannot block the UI.
        void Fail(string message)
        {
            // Deliberate cleanup: the monitor must not read it as a crash and
            // restart the backend behind a failed screen.
            suppressRecovery = true;
            Set("failed", message, false, "retry");
            StopBackend();
            WriteStatus();
        }

        public void BeginStopAndExit()
        {
            if (stopping) return;
            stopping = true;
            Set("stopping", "Stopping YourChar...", true, "");
            Thread thread = new Thread(delegate()
            {
                StopBackend();
                Finished = true;
                StageName = "stopped";
                Message = "YourChar has stopped.";
                Busy = false;
                Action = "";
                WriteStatus();
                Log.Write("launcher stopped");
            });
            thread.IsBackground = true;
            thread.Start();
        }

        void StopBackend()
        {
            if (backend == null) return;
            try
            {
                if (!backend.HasExited)
                {
                    string pid = ReadBackendPid();
                    if (pid.Length > 0) KillPid(pid);
                    if (!backend.WaitForExit(Cfg.StopTimeoutSeconds * 1000))
                    {
                        Log.Write("backend did not stop within " + Cfg.StopTimeoutSeconds + "s; terminating it");
                        backend.Kill();
                    }
                }
                Log.Write("backend stopped rc=" + backend.ExitCode);
            }
            catch (Exception error) { Log.WriteException("stop failed", error); }
            CloseBackendLog();
        }

        public bool SafeToClose { get { return Finished || backend == null; } }
    }

    internal sealed class MainForm : Form
    {
        readonly Engine engine;
        readonly Label status = new Label();
        readonly Button action = new Button();
        readonly Button quit = new Button();
        readonly Button logs = new Button();
        readonly ProgressBar progress = new ProgressBar();
        readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
        string shownMessage = null;
        string shownAction = null;
        bool shownBusy = true;

        public MainForm(Engine engine)
        {
            this.engine = engine;
            Text = "YourChar";
            Font = new Font("Segoe UI", 9F);
            ClientSize = new Size(472, 214);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;

            status.SetBounds(16, 12, 440, 92);
            status.Text = "Checking Windows Subsystem for Linux...";
            progress.SetBounds(16, 112, 440, 16);
            progress.Style = ProgressBarStyle.Marquee;
            logs.SetBounds(16, 146, 140, 30);
            logs.Text = "Open log folder";
            action.SetBounds(180, 146, 140, 30);
            quit.SetBounds(348, 146, 108, 30);
            quit.Text = "Quit";

            Controls.Add(status);
            Controls.Add(progress);
            Controls.Add(logs);
            Controls.Add(action);
            Controls.Add(quit);

            logs.Click += delegate { OpenFolder(Cfg.DataDir); };
            quit.Click += delegate { Close(); };
            action.Click += delegate { engine.RunAction(); };
            FormClosing += OnClosing;

            timer.Interval = 1000;
            timer.Tick += delegate { engine.Tick(); Repaint(); };
            timer.Start();
            Repaint();
        }

        static void OpenFolder(string path)
        {
            try
            {
                Directory.CreateDirectory(path);
                ProcessStartInfo psi = new ProcessStartInfo(path);
                psi.UseShellExecute = true;
                Process.Start(psi);
            }
            catch { }
        }

        void OnClosing(object sender, FormClosingEventArgs e)
        {
            if (engine.SafeToClose) return;
            e.Cancel = true;
            Hide();
            engine.BeginStopAndExit();
            Thread thread = new Thread(delegate()
            {
                while (!engine.Finished) Thread.Sleep(200);
                BeginInvoke(new Action(Close));
            });
            thread.IsBackground = true;
            thread.Start();
        }

        void Repaint()
        {
            // A stop requested from outside (YourChar.exe --stop) finishes the
            // engine without the user touching the window; close it then.
            if (engine.Finished) { Close(); return; }
            if (engine.Message != shownMessage)
            {
                shownMessage = engine.Message;
                status.Text = engine.Message;
            }
            if (engine.Busy != shownBusy)
            {
                shownBusy = engine.Busy;
                progress.Visible = engine.Busy;
            }
            if (engine.Action != shownAction)
            {
                shownAction = engine.Action;
                action.Visible = engine.Action.Length > 0;
                switch (engine.Action)
                {
                    case "install-wsl": action.Text = "Install WSL2"; break;
                    case "repair": action.Text = "Repair"; break;
                    case "retry": action.Text = "Try again"; break;
                    case "open": action.Text = "Open YourChar"; break;
                    default: action.Text = ""; break;
                }
            }
            string quitText = engine.Ready ? "Quit YourChar" : "Quit";
            if (quit.Text != quitText) quit.Text = quitText;
        }
    }

    // GUI-subsystem executables have no console of their own. CLI modes attach to
    // the parent console and also mirror their report to a file, so support and
    // automation get a deterministic result either way.
    internal sealed class TeeTextWriter : TextWriter
    {
        readonly TextWriter inner;
        readonly StringBuilder buffer = new StringBuilder();

        public TeeTextWriter(TextWriter inner) { this.inner = inner; }

        public override Encoding Encoding { get { return Encoding.UTF8; } }

        public override void Write(char value)
        {
            buffer.Append(value);
            inner.Write(value);
        }

        public override void Write(string value)
        {
            if (value == null) return;
            buffer.Append(value);
            inner.Write(value);
        }

        public override void WriteLine(string value)
        {
            buffer.Append(value).Append('\n');
            inner.WriteLine(value);
        }

        public void FlushTo(string directory)
        {
            try
            {
                inner.Flush();
                File.WriteAllText(Path.Combine(directory, "cli.txt"), buffer.ToString(), new UTF8Encoding(false));
            }
            catch { }
        }
    }
    internal static class Program
    {
        [DllImport("kernel32.dll")]
        static extern bool AttachConsole(int processId);

        [STAThread]
        static void Main(string[] args)
        {
            bool consoleMode = false;
            bool repair = false;
            bool status = false;
            bool stop = false;
            bool help = false;
            foreach (string arg in args)
            {
                string flag = arg.ToLowerInvariant();
                if (flag == "--no-browser") Cfg.NoBrowser = true;
                else if (flag == "--status") { status = true; consoleMode = true; }
                else if (flag == "--stop") { stop = true; consoleMode = true; }
                else if (flag == "--repair") { repair = true; consoleMode = true; }
                else if (flag == "--help" || flag == "-h") { help = true; consoleMode = true; }
            }
            try { Directory.CreateDirectory(Cfg.DataDir); }
            catch { }
            if (consoleMode)
            {
                AttachConsole(-1);
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true });
                Console.SetError(new StreamWriter(Console.OpenStandardError()) { AutoFlush = true });
            }
            if (help)
            {
                Console.WriteLine("YourChar launcher");
                Console.WriteLine("  YourChar.exe                 start YourChar and open it in the browser");
                Console.WriteLine("  YourChar.exe --no-browser    start YourChar without opening the browser");
                Console.WriteLine("  YourChar.exe --status        report WSL2, runtime and backend state");
                Console.WriteLine("  YourChar.exe --stop          stop a running YourChar");
                Console.WriteLine("  YourChar.exe --repair        reinstall YourChar's private WSL runtime");
                return;
            }
            Log.Write("launcher started args=" + string.Join(" ", args));

            if (status || stop || repair)
            {
                TeeTextWriter tee = new TeeTextWriter(Console.Out);
                Console.SetOut(tee);
                try
                {
                    if (status) Environment.ExitCode = ReportStatus();
                    else if (stop) Environment.ExitCode = StopRunning();
                    else
                    {
                        Engine repairEngine = new Engine();
                        repairEngine.Repair(true);
                        WaitForFinished(repairEngine);
                        Console.WriteLine("YourChar repair finished: " + repairEngine.StageName);
                    }
                }
                finally { tee.FlushTo(Cfg.DataDir); }
                return;
            }

            bool createdNew;
            Mutex mutex = new Mutex(true, Cfg.MutexName, out createdNew);
            if (!createdNew)
            {
                Log.Write("another launcher is already running; opening the UI instead");
                if (!Cfg.NoBrowser) new Engine().OpenUi();
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Engine engine = new Engine();
            engine.Start();
            Application.Run(new MainForm(engine));
            engine.BeginStopAndExit();
            WaitForFinished(engine);
            ReleaseInstanceMutex(mutex);
        }

        static void ReleaseInstanceMutex(Mutex mutex)
        {
            try { mutex.ReleaseMutex(); }
            catch { }
        }

        static void WaitForFinished(Engine engine)
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(Cfg.StopTimeoutSeconds + 10);
            while (!engine.Finished && DateTime.UtcNow < deadline) Thread.Sleep(200);
        }

        static int ReportStatus()
        {
            string stdout, stderr;
            int wslCode = Wsl.Run(new string[] { "--status" }, 60000, Wsl.OwnOutput, out stdout, out stderr);
            Console.WriteLine("wsl2: " + (wslCode == 0 ? "installed" : "missing"));
            if (wslCode != 0) return 1;
            List<string> found = ReadDistroNames();
            string distro = FindDistro(found);
            Console.WriteLine("runtime: " + (distro == null ? "not installed" : distro));
            Engine probe = new Engine();
            probe.Distro = distro ?? Cfg.DistroName;
            Console.WriteLine("backend: " + (probe.HealthResponds() ? "ready" : "not running"));
            Console.WriteLine("url: " + Cfg.UiUrl);
            Console.WriteLine("data: " + Cfg.DataDir);
            return 0;
        }

        static List<string> ReadDistroNames()
        {
            List<string> names = new List<string>();
            string stdout, stderr;
            if (Wsl.Run(new string[] { "-l", "-q" }, 60000, Wsl.OwnOutput, out stdout, out stderr) != 0) return names;
            foreach (string raw in stdout.Replace("\0", "").Split('\n'))
            {
                string name = raw.Trim();
                if (name.Length > 0) names.Add(name);
            }
            return names;
        }

        static string FindDistro(List<string> names)
        {
            foreach (string name in names)
            {
                if (string.Equals(name, Cfg.DistroName, StringComparison.OrdinalIgnoreCase)) return name;
            }
            foreach (string name in names)
            {
                if (string.Equals(name, Cfg.FallbackDistroName, StringComparison.OrdinalIgnoreCase)) return name;
            }
            return null;
        }

        static int StopRunning()
        {
            bool ignoredMutex;
            Mutex mutex = new Mutex(true, Cfg.MutexName, out ignoredMutex);
            bool launcherRunning;
            try { launcherRunning = !mutex.WaitOne(0); }
            catch { launcherRunning = false; }
            bool stopped = false;
            if (launcherRunning)
            {
                File.WriteAllText(Cfg.StopSentinel, "stop", new UTF8Encoding(false));
                for (int i = 0; i < 60 && File.Exists(Cfg.StopSentinel); i++) Thread.Sleep(500);
                stopped = true;
            }
            Engine probe = new Engine();
            if (probe.HealthResponds())
            {
                string distro = FindDistro(ReadDistroNames()) ?? Cfg.DistroName;
                probe.Distro = distro;
                string stdout, stderr;
                if (Wsl.Run(new string[] { "-d", distro, "-u", "yourchar", "--exec", "/bin/cat", Cfg.DistroStateDir + "/backend.pid" }, 60000, Wsl.LinuxOutput, out stdout, out stderr) == 0)
                {
                    string pid = stdout.Trim();
                    if (pid.Length > 0)
                    {
                        Wsl.Run(new string[] { "-d", distro, "-u", "yourchar", "--exec", "/bin/kill", "-TERM", pid }, 60000, Wsl.LinuxOutput, out stdout, out stderr);
                        stopped = true;
                    }
                }
            }
            Console.WriteLine(stopped ? "YourChar stopped." : "YourChar was not running.");
            return 0;
        }
    }
}
