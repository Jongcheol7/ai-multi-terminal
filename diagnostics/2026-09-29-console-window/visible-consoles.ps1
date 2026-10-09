param([int]$SampleCount = 1)

# Read-only inventory. Does not activate, hide, close, or create any window.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class CodexVisibleConsoleInventory {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr param);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    public static string[] List() {
        var rows = new List<string>();
        EnumWindows((h, p) => {
            if (!IsWindowVisible(h)) return true;
            var cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            if (cls.ToString() != "CASCADIA_HOSTING_WINDOW_CLASS" && cls.ToString() != "ConsoleWindowClass") return true;
            var title = new StringBuilder(1024);
            GetWindowText(h, title, 1024);
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            rows.Add(pid + " | " + cls + " | " + title);
            return true;
        }, IntPtr.Zero);
        return rows.ToArray();
    }
}
'@

1..$SampleCount | ForEach-Object {
    [pscustomobject]@{
        SampleAt = (Get-Date -Format o)
        VisibleConsoles = @([CodexVisibleConsoleInventory]::List())
    } | ConvertTo-Json -Compress
    if ($_ -lt $SampleCount) { Start-Sleep -Milliseconds 300 }
}
