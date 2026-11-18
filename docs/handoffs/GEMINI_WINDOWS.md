# Gemini on Windows: feasibility (2026-11-18)

Written from the code only, read-only, for the Windows session (`WINDOWS_SESSION_2026-11.md` step 5). Nothing here is implemented yet.


**Short answer: yes, probably, and the change is small.** The macOS code only uses three Unix tools (`pgrep`, `ps`, `lsof`) to find the Antigravity language server, its token and its ports. The HTTP request after that is the same on any platform. On Windows, one fixed PowerShell call (`Get-CimInstance Win32_Process` plus `Get-NetTCPConnection`) can do the finding. Before writing any code, a PC session has to confirm the process name, the form of the token argument and the listening address. I changed no files.

**One correction to the task.** `DISCOVERY_RE` has nothing to do with Gemini. It is defined in `src/providers/endpoint-discovery.ts:37` and only remembers which ChatGPT quota URLs chatgpt.com calls during the login window. All of the Gemini/Antigravity code is in `src/providers/antigravity.ts`, and it is wired up in `src/main/provider-chains.ts:440-446`.

## 1. How the macOS path works today (`src/providers/antigravity.ts`, checked on main 0474d00, version 0.3.0)

Every child process is started with `execFile`, an absolute binary path and an argument list, never a shell. Timeout 2 s (`EXEC_TIMEOUT_MS`), output cap 64 KB. A non-zero exit counts as an empty answer, and stderr is thrown away.

1. **Find candidate processes:** `/usr/bin/pgrep -U <own uid> -f language_server_macos_arm` returns this user's pids whose command line contains the server name (`ANTIGRAVITY_PROCESS`, line 81; `findPids`, around lines 165-195).
2. **Check the name:** `/bin/ps -o comm= -p <pid>` gives the name the process was started under. Only pids whose basename is exactly `language_server_macos_arm` go on, so a `tail -f` of its log is dropped. This is the scope Victor approved on 2026-11-14 (`docs/DECISIONS.md:56`).
3. **Read the token and ports** (`discover`, around lines 198-225):
   - `/bin/ps -o args= -p <pid>` gives the full command line. The regex `/--csrf_token[=\s]+(\S+)/` pulls out the token.
   - `/usr/sbin/lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` gives the listening ports, matched by `/:(\d+)\s*\(LISTEN\)/g`. A process with no token is skipped.
4. **Ask for the quota:** a `POST` to `http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary` (Connect-RPC).
   - Headers: `Content-Type: application/json` and `x-codeium-csrf-token: <token>`. Body `{}`. Timeout 3 s.
   - It goes through `httpNoCookies`, so no browser cookies ride along.
   - The server listens on two ports and only one speaks plain HTTP; the other answers 400. Each port is tried in order until one returns 200 with JSON.
5. **Read and remember:** `parseAntigravityUsage` (`src/core/buckets.ts`) turns `groups[].buckets[]` into card rows.
   - The working `{port, token}` pair is kept in memory only. It is never logged or saved.
   - Any failure clears it, so the next poll looks again.
   - `isAvailable()` runs steps 1 and 2 on every poll; `fetch()` runs them again when the remembered pair no longer answers.

**What is macOS-specific:** the three binary paths (`PGREP_BIN`, `PS_BIN`, `LSOF_BIN`), the process name `language_server_macos_arm`, the `-U uid` filter, and the `/` basename split. Everything from step 4 on works on any platform.

**What Windows does today:** `execFile('/usr/bin/pgrep')` fails, which counts as an empty answer, so no pids are found. Gemini then reports `unavailable` with "Antigravity is not running — open Antigravity…", even when Antigravity is open. The docs already say Gemini is macOS-only (`docs/what-the-card-shows.md:231`), but the text in Accounts is misleading on Windows. That is a small finding, not fixed.

## 2. The Windows equivalent

| macOS step | Windows equivalent |
|---|---|
| `pgrep -f` plus the `ps -o comm=` name check | `Get-CimInstance Win32_Process -Filter "Name='<server>.exe'"` matches on the image name itself, which is stricter than `pgrep -f`, so the separate name check is not needed. `CommandLine` is only read for processes with that exact name. |
| `-U <uid>` (only my processes) | Keep only processes where `SessionId` equals the session of the PowerShell call (`(Get-Process -Id $PID).SessionId`). Also, a non-admin user gets `CommandLine = $null` for other users' processes, so they drop out anyway. |
| `ps -o args=` | `$_.CommandLine` (a Windows command line with a quoted path; the token regex still applies, but see the questions below) |
| `lsof … -sTCP:LISTEN` | `Get-NetTCPConnection -OwningProcess <pid> -State Listen` and its `LocalAddress` / `LocalPort`. This reads one pid only. `netstat -ano` would also work, but it lists every process's sockets, which is a wider scope. |
| Absolute binary path | `winPowerShellPath()` already exists at `src/main/fullscreen-watch.ts:783` (`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, audit W-7 rule). That file imports `electron`, so the helper should move to a small Electron-free module that both files import. |

A single PowerShell call replaces all four child processes. It is a fixed string with no values put into it, run with `-NoProfile -NonInteractive -Command`:

```powershell
$s=(Get-Process -Id $PID).SessionId; @(Get-CimInstance Win32_Process -Filter "Name='language_server_windows_x64.exe'" | ? { $_.SessionId -eq $s } | % { [pscustomobject]@{ pid=$_.ProcessId; args=$_.CommandLine; ports=@(Get-NetTCPConnection -OwningProcess $_.ProcessId -State Listen -ErrorAction SilentlyContinue | % LocalPort) } }) | ConvertTo-Json -Compress -Depth 3
```

**Known PowerShell 5.1 quirk:** `ConvertTo-Json` turns a one-item array into a plain object, and a single port into a plain number. The parser has to accept both shapes.

## 3. Known vs. to be confirmed on the PC

**Known, because it is in the code or is standard Windows:**
- The RPC path, header, body, two-port behaviour and payload shape are in the code and the recorded fixture `test/fixtures/antigravity-quota.json`. They should be the same on Windows, because they belong to the language server, not the OS.
- `Get-CimInstance`, `Get-NetTCPConnection` and `ConvertTo-Json` come with Windows 10/11 and PowerShell 5.1.
- Reading the command line of your own processes needs no admin rights.
- Walder ships Windows as x64 only (`electron-builder.yml:144`) and macOS as arm64 only (`electron-builder.yml:103`).

**Unconfirmed until the PC session:**
1. **The exact process name.** I expect `language_server_windows_x64.exe`, by analogy with the macOS name.
2. **The install path.** Probably a per-user install under `%LOCALAPPDATA%\Programs\Antigravity\…\extensions\antigravity\bin\`. Only needed for the fixture and the docs.
3. **The token argument on Windows.** Is `--csrf_token` present, and in which form (`--csrf_token X`, `--csrf_token=X`, or with quotes)? With quotes, `(\S+)` would capture the `"` characters.
4. **Ports.** Still two listening ports? Bound to `127.0.0.1`, `::1` or `0.0.0.0`? If only `::1`, the URL has to change.
5. **The answers.** Does the HTTP port answer 200 with the same `groups[].buckets[]` shape? Does the other port answer 400 or reset the connection?
6. **Speed.** A cold PowerShell 5.1 start can exceed the current 2 s exec timeout. Measure it; it may need a longer timeout on Windows.
7. **Several windows and the CLI.** Do two IDE windows mean two servers? Does Windows Defender or the firewall get in the way on loopback? (It should not.)
8. **Approval.** The approved scope is written in macOS terms (`DECISIONS.md:56`, `privacy.md:20`). Reading `CommandLine` and listening ports on Windows is the same scope on a new platform, but Victor should approve it in DECISIONS before it ships.

## 4. Minimal implementation plan (after the PC findings)

- **`src/providers/antigravity.ts`**
  - Add an optional `platform` (default `process.platform`) and an injectable `powershellPath` to `AntigravityDeps`.
  - On `win32`, `findPids` and `discover` become one `discoverWindows()`. It calls `exec(powershellPath, ['-NoProfile','-NonInteractive','-Command', WIN_DISCOVERY_SCRIPT])` and passes the output to a pure function `parseWindowsDiscovery(stdout): Endpoint[]`. That function accepts an object or an array, a number or an array of ports, and a missing `args`, and reuses `CSRF_ARG`.
  - `isAvailable` on Windows is "the endpoint list is not empty".
  - The cache, `tryEndpoint`, the error texts and the no-logging rule stay as they are.
  - Add the constant `ANTIGRAVITY_PROCESS_WIN`, and allow a per-platform exec timeout (for example 5 s on Windows) if the timing measurement calls for it.
- **The PowerShell path helper:** move `winPowerShellPath` out of `src/main/fullscreen-watch.ts` into an Electron-free module (for example `src/providers/win-powershell.ts`) and import it from both places. No other wiring changes; `provider-chains.ts` already creates the provider on every platform.
- **Tests in `test/providers.test.ts`, next to the existing `describe('antigravity')` block:**
  - New fixture `test/fixtures/antigravity-win-discovery.json`, recorded on the PC with the token replaced by `TOKEN` and the user name taken out of paths.
  - Cases:
    - platform win32 never calls `pgrep`/`ps`/`lsof` and calls PowerShell with the fixed script;
    - one-object and array output both parse;
    - a scalar port parses;
    - empty output ends as `unavailable`;
    - a missing token means no request is made;
    - the HTTPS port is skipped and the HTTP port is used;
    - the cache is reused and then dropped on failure.
  - A unit test for `parseWindowsDiscovery` on its own.
- **Docs:**
  - `docs/what-the-card-shows.md:231`: drop "macOS-only".
  - `docs/privacy.md:20`, `:70-83`, `:113`: add the Windows process name and say how it is read.
  - `docs/DECISIONS.md`: add a row for the Windows scope with Victor's approval.
  - `docs/QA-CHECKLIST` (the file named in AGENTS.md): add a Windows Gemini row.
  - `docs/OPEN_ITEMS.md`: left to the coordinator.

## 5. Checklist for the PC session (Antigravity installed, signed in, a workspace open)

Run these in a normal, non-admin PowerShell. Do not save the raw token anywhere: redact it before saving output.

1. `Get-CimInstance Win32_Process | ? Name -like 'language_server*' | select ProcessId,Name,SessionId,ExecutablePath` and record the exact name and path.
2. `$p = Get-CimInstance Win32_Process -Filter "Name='<name>'"; $p.CommandLine -replace '(--csrf_token[= ]+)\S+','$1TOKEN'` to record the token argument's form with the token hidden.
3. `Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen | select LocalAddress,LocalPort` and record how many ports, and on which addresses.
4. Put the token in a variable without printing it: `$t = [regex]::Match($p.CommandLine,'--csrf_token[= ]+(\S+)').Groups[1].Value`. Then for each port: `curl.exe -s -o NUL -w "%{http_code}" -X POST -H "Content-Type: application/json" -H "x-codeium-csrf-token: $t" -d "{}" http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`. Record which port gives 200 and which gives 400 or an error.
5. For the 200 port, save the body with the values redacted, or just its key tree, and compare it with `test/fixtures/antigravity-quota.json`.
6. `Measure-Command { powershell.exe -NoProfile -NonInteractive -Command "<the one-shot script>" }`, run cold and warm, to set the Windows timeout. Save the script's output, redacted, as the discovery fixture.
7. Open a second IDE window and repeat steps 1 and 3 (one server or two?). Close the IDE and confirm the script prints nothing.
8. After implementing: `npm run typecheck && npm test && npm run build` on the Mac, then on the PC run `npm run probe -- --keys` (`scripts/probe.ts`). Then run Walder on the PC: the GEMINI section appears; closing the IDE gives "not running"; restarting the IDE finds the new port within one poll.

I did not check whether `scripts/probe.ts` runs on Windows, and I did not check `src/core/buckets.ts` beyond its name. The real risk is the open questions in section 3: if the Windows process name or token argument differs, the script and parser change, which is why the PC session comes before any code.
