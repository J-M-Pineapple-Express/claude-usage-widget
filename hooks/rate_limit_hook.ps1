# Auto Continue - StopFailure(rate_limit) hook.
#
# Registered in ~/.claude/settings.json by the widget when Auto Continue is
# switched on. Claude Code's matcher only fires it for rate-limit stops.
# It records which window the stalled session lives in (so the widget can
# message it once the limit resets) and which subagents/teammates were cut
# off. One queue entry per session; a failing subagent (payload carries
# agent_id) is added to that session's failed_agents list.
#
# PowerShell rather than Python so it runs on any Windows machine with no
# extra installs. Always exits 0: a hook that errors on every rate limit is
# worse than one that silently skips queuing once.

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 attaches extra type data to arrays, which makes
# ConvertTo-Json emit {"value": [...], "Count": n} instead of a plain array.
Remove-TypeData System.Array -ErrorAction SilentlyContinue

$claudeDir  = Join-Path $env:USERPROFILE '.claude'
$queuePath  = Join-Path $claudeDir 'auto-continue-queue.json'
$lockPath   = Join-Path $claudeDir 'auto-continue-queue.lock'
$configPath = Join-Path $claudeDir 'auto-continue.json'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Test-Enabled {
    try {
        $cfg = [IO.File]::ReadAllText($configPath) | ConvertFrom-Json
        return ($cfg.enabled -eq $true)
    } catch {
        return $false
    }
}

function Find-SessionWindow {
    # Map every visible, titled top-level window to its owning pid, then walk
    # up the process tree from this hook until an ancestor owns one. That
    # ancestor is the terminal or the app hosting the Claude session.
    Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class AcWindows {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public static Dictionary<uint, object[]> ByPid() {
        var map = new Dictionary<uint, object[]>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512);
            GetWindowText(h, sb, 512);
            if (sb.Length == 0) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            if (!map.ContainsKey(pid)) map[pid] = new object[] { h.ToInt64(), sb.ToString() };
            return true;
        }, IntPtr.Zero);
        return map;
    }
}
"@
    $windows = [AcWindows]::ByPid()
    $parents = @{}
    Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId |
        ForEach-Object { $parents[[uint32]$_.ProcessId] = [uint32]$_.ParentProcessId }

    $procId = [uint32]$PID
    for ($i = 0; $i -lt 25 -and $procId -ne 0; $i++) {
        if ($windows.ContainsKey($procId)) {
            $hit = $windows[$procId]
            return @{ pid = $procId; hwnd = [long]$hit[0]; title = [string]$hit[1] }
        }
        if (-not $parents.ContainsKey($procId)) { break }
        $next = $parents[$procId]
        if ($next -eq $procId) { break }
        $procId = $next
    }
    return @{ pid = $null; hwnd = $null; title = $null }
}

function Enter-QueueLock {
    # Exclusive-create lock file shared with the widget. A batch of teammates
    # failing together fires their hooks at the same moment; without this,
    # concurrent read-modify-write cycles drop each other's agents.
    $deadline = (Get-Date).AddSeconds(8)
    while ($true) {
        try {
            $fs = [IO.File]::Open($lockPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $fs.Close()
            return
        } catch [System.IO.IOException] {
            try {
                if (((Get-Date) - (Get-Item $lockPath).LastWriteTime).TotalSeconds -gt 30) {
                    Remove-Item $lockPath -Force
                    continue
                }
            } catch {}
            if ((Get-Date) -gt $deadline) { throw 'auto-continue queue lock busy' }
            Start-Sleep -Milliseconds 50
        }
    }
}

function Exit-QueueLock {
    Remove-Item $lockPath -Force -ErrorAction SilentlyContinue
}

function Read-Queue {
    $list = New-Object System.Collections.ArrayList
    if (-not (Test-Path $queuePath)) { return ,$list }
    try {
        $text = [IO.File]::ReadAllText($queuePath)
        if ($text.Trim()) {
            foreach ($item in ($text | ConvertFrom-Json)) { [void]$list.Add($item) }
        }
    } catch {}
    return ,$list
}

function Write-Queue($queue) {
    $json = ConvertTo-Json -InputObject $queue -Depth 6
    $tmp = "$queuePath.tmp"
    [IO.File]::WriteAllText($tmp, $json, $utf8)
    Move-Item -Path $tmp -Destination $queuePath -Force
}

try {
    if (-not (Test-Enabled)) { exit 0 }

    $raw = [Console]::In.ReadToEnd()
    $payload = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { [pscustomobject]@{} }
    $sessionId = $payload.session_id
    $agentId = $payload.agent_id

    # Window lookup is the slow part and doesn't touch the queue, so it runs
    # before taking the lock.
    $win = Find-SessionWindow

    if (-not (Test-Path $claudeDir)) { New-Item -ItemType Directory -Path $claudeDir | Out-Null }
    Enter-QueueLock
    try {
        $queue = Read-Queue
        $entry = $queue | Where-Object { $_.session_id -eq $sessionId -and -not $_.nudged } | Select-Object -First 1

        if (-not $entry) {
            $entry = [pscustomobject]@{
                id              = [guid]::NewGuid().ToString()
                session_id      = $sessionId
                cwd             = $payload.cwd
                transcript_path = $payload.transcript_path
                window_pid      = $win.pid
                hwnd            = $win.hwnd
                window_title    = $win.title
                queued_at       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() / 1000.0
                failed_agents   = @()
                nudged          = $false
            }
            [void]$queue.Add($entry)
        } else {
            # Whichever hook created the entry may have had less to go on
            # (subagent payloads can lack cwd); fill in anything missing.
            if (-not $entry.hwnd -and $win.hwnd) {
                $entry.window_pid = $win.pid
                $entry.hwnd = $win.hwnd
                $entry.window_title = $win.title
            }
            if (-not $entry.cwd -and $payload.cwd) { $entry.cwd = $payload.cwd }
            if (-not $entry.transcript_path -and $payload.transcript_path) { $entry.transcript_path = $payload.transcript_path }
        }

        if ($agentId) {
            if (-not ($entry.PSObject.Properties.Name -contains 'failed_agents')) {
                $entry | Add-Member -NotePropertyName failed_agents -NotePropertyValue @()
            }
            $agents = @($entry.failed_agents)
            if (-not ($agents | Where-Object { $_.agent_id -eq $agentId })) {
                $entry.failed_agents = $agents + [pscustomobject]@{ agent_id = $agentId; agent_type = $payload.agent_type }
            }
        }

        Write-Queue $queue
    } finally {
        Exit-QueueLock
    }
} catch {
    # Swallow everything; see header.
}
exit 0
