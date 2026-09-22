# For each Claude Code process id, find the window hosting it: walk up from
# the process until an ancestor owns a visible, titled top-level window (the
# terminal, VS Code, or the Claude desktop app). Prints JSON:
#   { "<pid>": { "title": "...", "process": "Code" }, ... }
# Used by the widget's Sessions window to label where each session runs.

param([Parameter(Mandatory=$true)][string]$Pids)

$ErrorActionPreference = 'Stop'
Remove-TypeData System.Array -ErrorAction SilentlyContinue

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AcHostWindows {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public static Dictionary<uint, string> TitlesByPid() {
        var map = new Dictionary<uint, string>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            if (sb.Length == 0) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (!map.ContainsKey(pid)) map[pid] = sb.ToString();
            return true;
        }, IntPtr.Zero);
        return map;
    }
}
"@

$result = @{}
try {
    $titles = [AcHostWindows]::TitlesByPid()
    $parents = @{}
    $names = @{}
    Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name | ForEach-Object {
        $parents[[uint32]$_.ProcessId] = [uint32]$_.ParentProcessId
        $names[[uint32]$_.ProcessId] = [string]$_.Name
    }
    foreach ($p in ($Pids -split ',')) {
        if (-not $p.Trim()) { continue }
        $procId = [uint32]$p
        $found = $null
        for ($i = 0; $i -lt 25 -and $procId -ne 0; $i++) {
            if ($titles.ContainsKey($procId)) {
                $found = @{ title = $titles[$procId]; process = ($names[$procId] -replace '\.exe$', '') }
                break
            }
            if (-not $parents.ContainsKey($procId)) { break }
            $next = $parents[$procId]
            if ($next -eq $procId) { break }
            $procId = $next
        }
        $result[$p.Trim()] = $found
    }
} catch {}

ConvertTo-Json -InputObject $result -Depth 4 -Compress
