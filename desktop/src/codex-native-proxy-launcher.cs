using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

/// <summary>
/// Windows executable-name shim for the user-enabled Codex Desktop override.
/// It runs the bundled Node proxy with inherited stdio, cwd and environment;
/// the proxy then starts the original Codex CLI as its same app-server child.
/// </summary>
internal static class CodexNativeProxyLauncher
{
    private static string Quote(string value)
    {
        if (value == null) value = String.Empty;
        StringBuilder result = new StringBuilder();
        result.Append('"');
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\')
            {
                slashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', slashes * 2 + 1);
                result.Append('"');
                slashes = 0;
                continue;
            }
            if (slashes > 0)
            {
                result.Append('\\', slashes);
                slashes = 0;
            }
            result.Append(character);
        }
        if (slashes > 0) result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static void Pump(Stream source, Stream destination, bool closeDestination)
    {
        try
        {
            byte[] buffer = new byte[65536];
            while (true)
            {
                int count = source.Read(buffer, 0, buffer.Length);
                if (count <= 0) break;
                destination.Write(buffer, 0, count);
                destination.Flush();
            }
        }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        finally
        {
            if (closeDestination)
            {
                try { destination.Dispose(); } catch { }
            }
        }
    }

    private static Task StartPump(Stream source, Stream destination, bool closeDestination)
    {
        return Task.Factory.StartNew(
            delegate { Pump(source, destination, closeDestination); },
            CancellationToken.None,
            TaskCreationOptions.LongRunning,
            TaskScheduler.Default);
    }

    private static bool IsExistingFile(string path)
    {
        if (String.IsNullOrWhiteSpace(path) || !Path.IsPathRooted(path)) return false;
        try { return File.Exists(path); }
        catch { return false; }
    }

    private static int Main(string[] args)
    {
        string nodePath = Environment.GetEnvironmentVariable("CODEX_NATIVE_NODE_PATH");
        string realCliPath = Environment.GetEnvironmentVariable("CODEX_NATIVE_REAL_CLI_PATH");
        if (!IsExistingFile(nodePath) || !IsExistingFile(realCliPath)) return 126;

        string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
        string scriptPath = Environment.GetEnvironmentVariable("CODEX_NATIVE_PROXY_SCRIPT");
        if (!IsExistingFile(scriptPath))
        {
            scriptPath = Path.GetFullPath(Path.Combine(baseDirectory, "..", "src", "codex-native-proxy.js"));
        }
        if (!IsExistingFile(scriptPath)) return 126;

        ProcessStartInfo start = new ProcessStartInfo();
        start.FileName = nodePath;
        start.WorkingDirectory = Environment.CurrentDirectory;
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.WindowStyle = ProcessWindowStyle.Hidden;
        start.RedirectStandardInput = true;
        start.RedirectStandardOutput = true;
        start.RedirectStandardError = true;
        StringBuilder commandLine = new StringBuilder();
        commandLine.Append(Quote(scriptPath));
        foreach (string argument in args)
        {
            commandLine.Append(' ');
            commandLine.Append(Quote(argument));
        }
        start.Arguments = commandLine.ToString();
        start.EnvironmentVariables["CODEX_NATIVE_PROXY_SCRIPT"] = scriptPath;
        start.EnvironmentVariables["CODEX_NATIVE_PROXY_EXE_PATH"] = Assembly.GetExecutingAssembly().Location;

        Process child = new Process();
        child.StartInfo = start;
        try
        {
            if (!child.Start()) return 126;
        }
        catch { return 126; }

        Task input = StartPump(Console.OpenStandardInput(), child.StandardInput.BaseStream, true);
        Task output = StartPump(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), false);
        Task error = StartPump(child.StandardError.BaseStream, Console.OpenStandardError(), false);
        child.WaitForExit();
        try { Task.WaitAll(new Task[] { output, error }, 5000); } catch { }
        // The host owns the native child lifecycle. Do not terminate it or alter
        // the host process; returning mirrors the real CLI child's exit status.
        int exitCode = child.ExitCode;
        child.Dispose();
        GC.KeepAlive(input);
        return exitCode;
    }
}
