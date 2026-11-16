using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using System.Windows.Forms;

[assembly: AssemblyTitle("PAPyrus")]
[assembly: AssemblyProduct("PAPyrus")]

internal static class PapyrusLauncher
{
    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            // node_modules/.cache/papyrus/PAPyrus.exe
            var root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", ".."));
            var electron = Path.Combine(root, "node_modules", "electron", "dist", "electron.exe");
            Process.Start(new ProcessStartInfo(electron, string.Join(" ", new[] { root }.Concat(args).Select(Quote)))
            {
                UseShellExecute = false,
                WorkingDirectory = Environment.CurrentDirectory,
            });
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "PAPyrus", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }

    static string Quote(string value)
    {
        // Escape quotes and double backslashes that precede the closing quote.
        return "\"" + Regex.Replace(value, "(\\\\*)(\"|$)", match =>
            new string('\\', match.Groups[1].Length * 2) +
            (match.Groups[2].Length == 0 ? "" : "\\\"")) + "\"";
    }
}
