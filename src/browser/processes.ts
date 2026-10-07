import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../data-dir.ts";

/**
 * Process and profile housekeeping shared by the launched-browser backends.
 * Each launch uses a private profile directory named `browser-profile-<pid of
 * this process>[-suffix]`, so a stale browser can never lock it and a crashed
 * run's leftovers can be recognised by a dead owner pid.
 */

const PROFILE_PREFIX = "browser-profile-";

/** True when a process with this pid is running. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Remove a profile directory; a helper that still holds a file leaves a harmless straggler. */
export function removeProfile(profile: string): void {
  try {
    rmSync(profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } catch {
    // a helper still holds a file; the stale profile is harmless
  }
}

/** Remove profiles left by Vise processes that are no longer running. */
export function sweepStaleProfiles(): void {
  if (!existsSync(dataDir)) return;
  for (const name of readdirSync(dataDir)) {
    if (!name.startsWith(PROFILE_PREFIX)) continue;
    const pid = Number(/^\d+/.exec(name.slice(PROFILE_PREFIX.length))?.[0]);
    if (isAlive(pid)) continue;
    // A crashed run leaves its headless browser holding the profile; reap it first.
    killBrowsersUsing(name);
    try {
      rmSync(join(dataDir, name), { recursive: true, force: true });
    } catch {
      // a straggler helper still holds a file; try again next launch
    }
  }
}

/** Kill a process and its children. */
export function killTree(pid: number): void {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
  });
}

/**
 * Kill every Edge/Chrome/Firefox process whose command line names this profile
 * directory. Matching on the (pid-unique) profile name finds a browser whose
 * owner died without recording its pid, and cannot hit a reused pid.
 */
export function killBrowsersUsing(profileName: string): void {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe' -or $_.Name -eq 'firefox.exe') -and $_.CommandLine -like '*" +
    profileName +
    "*' -and $_.CommandLine -notlike '*--type=*' -and $_.CommandLine -notlike '*-contentproc*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }";
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true },
  );
}
