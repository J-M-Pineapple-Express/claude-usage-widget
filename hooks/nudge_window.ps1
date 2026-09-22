param(
    [Parameter(Mandatory=$true)][long]$Hwnd,
    [Parameter(Mandatory=$true)][string]$Message
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class AutoContinueWin32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

$hwndPtr = [IntPtr]$Hwnd

if (-not [AutoContinueWin32]::IsWindow($hwndPtr)) {
    Write-Error "Window no longer exists (hwnd=$Hwnd) - it was probably closed since being queued."
    exit 1
}

# Windows blocks SetForegroundWindow from a background process (anti focus-
# stealing) unless it looks like the user just did something. A harmless
# Alt press+release right before the call satisfies that check.
[AutoContinueWin32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[AutoContinueWin32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)

if ([AutoContinueWin32]::IsIconic($hwndPtr)) {
    [AutoContinueWin32]::ShowWindow($hwndPtr, 9) | Out-Null  # SW_RESTORE
}
[AutoContinueWin32]::SetForegroundWindow($hwndPtr) | Out-Null

# Wait until the window actually owns the foreground before sending input.
# Keystrokes sent mid-switch land nowhere, which is how the first characters
# of the message were getting dropped.
$deadline = (Get-Date).AddSeconds(3)
while ([AutoContinueWin32]::GetForegroundWindow() -ne $hwndPtr) {
    if ((Get-Date) -gt $deadline) {
        Write-Error "Window never took focus (hwnd=$Hwnd) - screen may be locked."
        exit 1
    }
    Start-Sleep -Milliseconds 50
}
Start-Sleep -Milliseconds 500

# Paste instead of typing: one Ctrl+V can't lose characters the way a
# stream of individual keystrokes can. Only text clipboard contents can
# be restored afterward; an image on the clipboard would be replaced.
$previous = $null
try { $previous = Get-Clipboard -Raw -ErrorAction Stop } catch {}

try {
    Set-Clipboard -Value $Message
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait("^v")
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
    Start-Sleep -Milliseconds 200
}
finally {
    if ($null -ne $previous) { Set-Clipboard -Value $previous }
}
