# SmartView monitor wake-up for the Windows touch PC
# ---------------------------------------------------
# A web page may not switch on a monitor that Windows turned off. This script runs in the background, asks SmartView
# every second whether the doorbell rings (/api/ring) and then moves the mouse by one pixel - that wakes Windows and
# the monitor, and SmartView shows the camera picture.
#
# Settings (adjust):
#   $SmartView  address of SmartView in the LAN (http, port 8098) - with ?key=... if an access key is set
#   $WakeDuringDnd  $true = also wake while "Nicht stoeren" is on (the picture shows without a ring tone)
#
# Start: monitor-wecker.cmd (runs this script hidden); for every Windows start put a shortcut to monitor-wecker.cmd
# into the Autostart folder (Win+R -> shell:startup).

$SmartView = 'http://192.168.1.10:8098'
$Key = ''                 # access key of SmartView, empty if none is set
$WakeDuringDnd = $true

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class SvWake {
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);
    [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
}
"@

function Wake-Monitor {
    # a tiny mouse movement counts as user input: Windows switches the display on again
    [SvWake]::mouse_event(0x0001, 1, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [SvWake]::mouse_event(0x0001, -1, 0, 0, [UIntPtr]::Zero)
    # ES_DISPLAY_REQUIRED: display on (once, Windows may switch it off again later as usual)
    [SvWake]::SetThreadExecutionState(0x00000002) | Out-Null
}

$url = "$SmartView/api/ring"
if ($Key) { $url = "$url" + "?key=" + [uri]::EscapeDataString($Key) }
$wasRinging = $false
while ($true) {
    try {
        $r = Invoke-RestMethod -Uri $url -TimeoutSec 3 -UseBasicParsing
        $ringing = [bool]$r.ringing
        if ($ringing -and -not $wasRinging -and ($WakeDuringDnd -or -not $r.dnd)) {
            Wake-Monitor
        }
        $wasRinging = $ringing
    } catch {
        # SmartView not reachable (restart, network): just try again
    }
    Start-Sleep -Seconds 1
}
