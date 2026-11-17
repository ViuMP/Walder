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
# WINDOW COORDINATES. What `GetWindowRect` and `GetMonitorInfo` return depends
# on the DPI awareness of the *calling thread*, and `powershell.exe` 5.1 declares
# none: it is DPI-unaware (measured in the 2026-11 audit — no dpiAware element in
# its manifest, `GetProcessDpiAwareness` = UNAWARE, `GetDpiForSystem` = 96). An
# unaware caller gets every rect virtualised into a 96-DPI logical space in
# which each monitor keeps its *physical* top-left and shrinks by 96/dpi. That
# matches Electron's DIP displays on a single display at any scale, but not on
# mixed-scale layouts, where Chromium places its DIP displays edge to edge: a
# 100 % monitor right of a 150 % primary is at x = 1920 for an unaware caller
# and x = 1280 in Electron, so a film on it would never read as covering the
# dog's display (audit finding M3 - predicted from the documented behaviour of
# both sides; the audit PC has one display, so it was not seen on screen). An
# earlier version of this comment claimed both calls report
# physical pixels and are only compared with each other; neither was true —
# the window rect is compared with Electron's display bounds in DIPs.
#
# So each sample first makes this thread per-monitor DPI aware, which makes
# both calls report true physical virtual-screen pixels — the one space every
# process agrees on — and says so with `"physical":1`. The parent maps the
# window into DIPs through the display whose physical rect is this monitor
# (`main/win-dpi.ts`). Where the awareness call is unavailable (before Windows
# 10 1607, or before 1703 for per-monitor v2 — then v1 is tried) the sample is
# taken exactly as before and marked `"physical":0`, and the parent leaves its
# logical numbers alone: scaling them again would break the single-display
# case that works.
#
# NOTE: nothing in this file can be exercised from a macOS build, so it is kept
# deliberately dull: no modules, no cmdlets beyond `Add-Type`/`Start-Sleep`, no
# `ConvertTo-Json` (which pretty-prints by default on PowerShell 5.1 and would
# break the one-line contract), and every failure inside the loop is swallowed
# so a transient error cannot kill a helper that is meant to run for days.

$ErrorActionPreference = 'Stop'

# NO `-UsingNamespace System.Runtime.InteropServices` HERE. `-MemberDefinition`
# already wraps the snippet in `using System; using System.Runtime.InteropServices;`
# of its own, and Windows PowerShell 5.1 compiles with warnings as errors, so
# naming the namespace a second time was a compile error ("The using directive
# ... appeared previously in this namespace") — the helper exited with code 1
# on every launch and the dog never slept over a film on Windows. Found on the
# first Windows run, 2026-10-02; `test/fullscreen-win-helper.test.ts` runs the
# script for real on win32 so it cannot come back unnoticed.
Add-Type -Namespace Walder -Name Native -MemberDefinition @'
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

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr window, System.Text.StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr dpiContext);
'@

# The longest window class name Win32 allows (WNDCLASS names are capped at 256
# characters), so one buffer always fits. `System.Text.StringBuilder` is spelled
# out in the declaration above because `-MemberDefinition` brings in only
# `System` and `System.Runtime.InteropServices`, and adding a `using` of our own
# is exactly the kind of extra directive 5.1 has failed on before.
$maxClassName = 256

# MONITOR_DEFAULTTONEAREST: a window that is somehow on no monitor still gets
# the closest one, rather than a null handle we would have to special-case.
$nearestMonitor = 2

# DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (Windows 10 1703+) and its v1
# predecessor (1607+). Pseudo-handles, defined as negative constants in
# windef.h. Either makes GetWindowRect/GetMonitorInfo report physical pixels;
# v2 is preferred only because it is what Electron itself runs as.
$perMonitorAwareV2 = [IntPtr]::new(-4)
$perMonitorAware = [IntPtr]::new(-3)

# Make the calling thread per-monitor DPI aware; $true when it now is.
#
# Per *thread*, not per process, and asked before every sample rather than once:
# nothing promises that the loop below stays on the thread that ran the first
# iteration, and the call is a cheap no-op when the context is already set. A
# NULL return is "that context is not supported here" (v2 before 1703), so v1 is
# tried next; a missing entry point (before 1607) throws, and both end in $false
# — the sample is then taken unaware, exactly as before audit finding M3, rather
# than the helper dying over an optional improvement.
function Set-PhysicalPixels {
    try {
        if ([Walder.Native]::SetThreadDpiAwarenessContext($perMonitorAwareV2) -ne [IntPtr]::Zero) { return $true }
        if ([Walder.Native]::SetThreadDpiAwarenessContext($perMonitorAware) -ne [IntPtr]::Zero) { return $true }
    } catch {
        return $false
    }
    return $false
}

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
        # Before any rect is read, and on the same thread that reads it.
        $physical = if (Set-PhysicalPixels) { 1 } else { 0 }
        $window = [Walder.Native]::GetForegroundWindow()
        if ($window -ne [IntPtr]::Zero) {
            $rect = New-Object Walder.Native+RECT
            # A failed GetWindowRect (the window went away between the two calls)
            # leaves a zero rect and still reports owner and class: the parent reads
            # a zero rect as "no window" except for a shell surface, whose bounded
            # hold is decided by class alone and must not hinge on a rect (M3 x M5).
            if (-not [Walder.Native]::GetWindowRect($window, [ref] $rect)) {
                $rect = New-Object Walder.Native+RECT
            }
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

            # The window class, so the parent can tell a transient shell
            # surface (the tray overflow flyout, Alt+Tab, the taskbar) from
            # the real desktop (Progman/WorkerW) and from a File Explorer
            # folder window (CabinetWClass) — all of them explorer.exe, so
            # the name above cannot (M5, see core/fullscreen.ts). Empty when
            # the call fails, which the parent reads as "no class": the old
            # behaviour, never a hold.
            $cls = ''
            try {
                $classBuffer = New-Object System.Text.StringBuilder $maxClassName
                if ([Walder.Native]::GetClassName($window, $classBuffer, $maxClassName) -gt 0) {
                    $cls = $classBuffer.ToString()
                }
            } catch {
                $cls = ''
            }
            $cls = $cls -replace '\\', '\\\\' -replace '"', '\"'

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
                '","cls":"' + $cls +
                '","rect":{"l":' + $rect.Left + ',"t":' + $rect.Top +
                ',"r":' + $rect.Right + ',"b":' + $rect.Bottom +
                '},"monitor":{"l":' + $ml + ',"t":' + $mt +
                ',"r":' + $mr + ',"b":' + $mb + '},"physical":' + $physical + '}'
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
