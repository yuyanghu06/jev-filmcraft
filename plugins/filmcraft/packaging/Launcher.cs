using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

// A Windows GUI entry point: no terminal, shell scripts, or separately installed Node needed.
internal static class Launcher
{
    [STAThread]
    private static int Main()
    {
        Application.EnableVisualStyles();
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            var start = new ProcessStartInfo
            {
                FileName = Path.Combine(root, "node", "node.exe"),
                Arguments = "\"" + Path.Combine(root, "runtime", "launch.mjs") + "\" desktop",
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            start.EnvironmentVariables.Remove("NODE_OPTIONS");
            start.EnvironmentVariables.Remove("NODE_PATH");
            using (var child = new Process { StartInfo = start })
            {
                // Drain native diagnostics without writing project contents or credentials to logs.
                child.OutputDataReceived += delegate { };
                child.ErrorDataReceived += delegate { };
                if (!child.Start()) return Failure();
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
                child.WaitForExit();
                return child.ExitCode == 0 ? 0 : Failure();
            }
        }
        catch (Exception)
        {
            return Failure();
        }
    }

    private static int Failure()
    {
        MessageBox.Show(
            "Close any other Jev FilmCraft window and try again. If it still fails, check providers.json in %LOCALAPPDATA%\\Jev FilmCraft, or extract a fresh copy of the entire app folder. Your projects have not been removed.",
            "Jev FilmCraft could not start", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }
}
