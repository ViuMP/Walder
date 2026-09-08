# Walder — the Windows half of the fullscreen watch.
#
# WHY THIS EXISTS. The macOS path asks `get-windows` for the active window, and
# on macOS that package runs a bundled Swift binary. On Windows it is a compiled
# N-API addon (`.node`), and a build produced on this Mac ships no Windows
# binary at all — so the Windows app would either fail to load the module or
# crash on first use, and the review found exactly that. Rebuilding a native
# addon per platform means a Windows build machine, node-gyp and a toolchain,
# for one question: "does the active window cover the display?" PowerShell can
# answer it with no compilation and no dependency, because it is already on
# every supported Windows.
#
# HOW IT IS SHAPED. This is a long-running helper, not a one-shot: `Add-Type`
# compiles the P/Invoke class on first use and that costs a few hundred
# milliseconds, which is fine once at startup and absurd every two seconds. So
# the class is declared once and the script then loops, writing one JSON line
# per sample to stdout. The parent (`main/fullscreen-watch.ts`) reads lines and
# keeps the newest; it never has to spawn anything again.
#
# HOW IT STOPS. The parent closes our stdin. A single pending async read of one
# byte completes as soon as that happens (0 bytes = the pipe is gone), which is
# checked once per loop — so the helper exits with the app rather than
# outliving it as an orphan. Nothing is ever *written* to our stdin, so any
# completion of that read means "stop".
#
# WINDOW COORDINATES. `GetWindowRect` and `GetMonitorInfo` both report physical
# pixels in virtual-screen space, and both are compared against each other only
# — never against Electron's logical pixels — so DPI scaling cancels out. The
# comparison against Electron's own display bounds happens in
# `core/fullscreen.ts`, which is fed the dog's display by the parent.
#
# NOTE: nothing in this file can be exercised from a macOS build, so it is kept
# deliberately dull: no modules, no cmdlets beyond `Add-Type`/`Start-Sleep`, no
# `ConvertTo-Json` (which pretty-prints by default on PowerShell 5.1 and would
# break the one-line contract), and every failure inside the loop is swallowed
# so a transient error cannot kill a helper that is meant to run for days.

$ErrorActionPreference = 'Stop'

Add-Type -Namespace Walder -Name Native -UsingNamespace System.Runtime.InteropServices -MemberDefinition @'
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO { public int Size; public RECT Monitor; public RECT Work; public uint Flags; }

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out RECT rect);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
'@

# MONITOR_DEFAULTTONEAREST: a window that is somehow on no monitor still gets
# the closest one, rather than a null handle we would have to special-case.
$nearestMonitor = 2

# How often a sample is written. Matches POLL_MS in main/fullscreen-watch.ts.
$pollMs = 2000

# The single pending read that tells us when the parent has gone.
$stdin = [Console]::OpenStandardInput()
$eofBuffer = New-Object byte[] 1
$eofRead = $stdin.ReadAsync($eofBuffer, 0, 1)

# The "nothing is focused" line. Emitted rather than staying silent, because
# silence is indistinguishable from a wedged helper: the parent treats a stale
# stream as a probe failure, so every loop must produce exactly one line.
$noWindow = '{"pid":0,"name":"","rect":{"l":0,"t":0,"r":0,"b":0},"monitor":{"l":0,"t":0,"r":0,"b":0}}'

while ($true) {
    $line = $noWindow

    try {
        $window = [Walder.Native]::GetForegroundWindow()
        if ($window -ne [IntPtr]::Zero) {
            $rect = New-Object Walder.Native+RECT
            if ([Walder.Native]::GetWindowRect($window, [ref] $rect)) {
                $processId = [uint32] 0
                [void] [Walder.Native]::GetWindowThreadProcessId($window, [ref] $processId)

                # The owner's process name, so the parent can recognise the
                # desktop shell (explorer.exe legitimately spans the whole
                # display, and sleeping on an empty desktop is the one moment
                # the owner is most likely to be looking at the dog).
                $name = ''
                try {
                    $name = [System.Diagnostics.Process]::GetProcessById([int] $processId).ProcessName
                } catch {
                    $name = ''
                }
                $name = $name -replace '\\', '\\\\' -replace '"', '\"'

                $info = New-Object Walder.Native+MONITORINFO
                $info.Size = [System.Runtime.InteropServices.Marshal]::SizeOf($info)
                $monitor = [Walder.Native]::MonitorFromWindow($window, $nearestMonitor)
                $ml = 0; $mt = 0; $mr = 0; $mb = 0
                if ($monitor -ne [IntPtr]::Zero -and [Walder.Native]::GetMonitorInfo($monitor, [ref] $info)) {
                    $ml = $info.Monitor.Left
                    $mt = $info.Monitor.Top
                    $mr = $info.Monitor.Right
                    $mb = $info.Monitor.Bottom
                }

                $line = '{"pid":' + $processId +
                    ',"name":"' + $name +
                    '","rect":{"l":' + $rect.Left + ',"t":' + $rect.Top +
                    ',"r":' + $rect.Right + ',"b":' + $rect.Bottom +
                    '},"monitor":{"l":' + $ml + ',"t":' + $mt +
                    ',"r":' + $mr + ',"b":' + $mb + '}}'
            }
        }
    } catch {
        # Any P/Invoke failure is "we cannot tell" for this sample only.
        $line = $noWindow
    }

    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()

    if ($eofRead.IsCompleted) { break }
    Start-Sleep -Milliseconds $pollMs
}
