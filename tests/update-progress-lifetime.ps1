# Runs only controlled fixtures, never Setup or the installed SnapOverLAN app.
param([string]$Compiler = "$PSScriptRoot/../.cache/popup-close-tools/tcc/tcc.exe")
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path "$PSScriptRoot/..").Path
$cache = "$project/.cache/update-lifetime-tests"
New-Item -ItemType Directory -Force $cache | Out-Null
$nsisCompiler = Get-ChildItem "$env:LOCALAPPDATA/electron-builder/Cache" -Recurse -Filter makensis.exe |
 Where-Object { $_.Directory.Name -ne 'Bin' } | Select-Object -First 1 -ExpandProperty FullName
$resources = Get-ChildItem "$env:LOCALAPPDATA/electron-builder/Cache" -Recurse -Filter StdUtils.dll |
 Where-Object { $_.Directory.Name -eq 'x86-unicode' } | Select-Object -First 1
$resourcesRoot = $resources.Directory.Parent.Parent.FullName
$fixture = "$cache/startup-fixture.exe"
& $Compiler '-Wl,-subsystem=windows' -o $fixture "$PSScriptRoot/fixtures/update-startup-window.c" -luser32
if ($LASTEXITCODE -ne 0) { throw 'Startup fixture compilation failed' }
& $nsisCompiler /V2 "/DHARNESS_OUTPUT=$cache/lifetime-harness.exe" "/DPROJECT_ROOT=$project" `
 "/DBUILDER_TEMPLATES=$project/node_modules/app-builder-lib/templates/nsis" "/DNSIS_RESOURCES=$resourcesRoot" `
 /DSNAPOVERLAN_UPDATE_READY_TIMEOUT=5000 (Resolve-Path "$PSScriptRoot/fixtures/update-progress-lifetime.nsi").Path
if ($LASTEXITCODE -ne 0) { throw 'Lifecycle harness compilation failed' }

Add-Type @'
using System;
using System.Runtime.InteropServices;
public class LifetimeWindows {
 public delegate bool EnumProc(IntPtr window, IntPtr data);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr data);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string cls, string title);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr window, string name);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
 [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr window, int index);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window, uint msg, IntPtr wp, IntPtr lp);
 public static IntPtr WindowFor(int pid) {
  IntPtr found = IntPtr.Zero;
  EnumWindows((w,d) => { uint p; GetWindowThreadProcessId(w,out p); if(p==pid) { found=w; return false; } return true; }, IntPtr.Zero);
  return found;
 }
}
'@
function Assert-True($condition, $message) { if (-not $condition) { throw $message } }
function Wait-Until([scriptblock]$condition, [string]$message) {
 $limit = [Diagnostics.Stopwatch]::StartNew()
 while (-not (& $condition)) {
  if ($limit.ElapsedMilliseconds -gt 4000) { throw $message }
  Start-Sleep -Milliseconds 25
 }
}
function Write-FixtureConfig($eventName, $exitEarly = 0) {
 "[test]`r`nReadyEvent=$eventName`r`nExitEarly=$exitEarly" | Set-Content "$cache/startup-fixture.ini" -Encoding Unicode
}
if ([LifetimeWindows]::FindWindow('#32770', 'SnapOverLAN Update') -ne [IntPtr]::Zero) {
 throw 'Wait for the existing update preview to exit before running lifecycle tests.'
}
foreach ($scenario in @('visible', 'hidden', 'timeout', 'launch-failed', 'old-process', 'wrong-image', 'manual')) {
 $eventName = 'Local\SnapOverLAN.LifetimeTest.' + [Guid]::NewGuid().ToString('N')
 $ready = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, $eventName)
 $extraReady = $null
 $harness = $null
 $oldProcess = $null
 $wrongProcess = $null
 try {
  Remove-Item -LiteralPath "$cache/lifetime-result.ini" -ErrorAction SilentlyContinue
  Write-FixtureConfig $eventName ([int]($scenario -eq 'launch-failed'))
  if ($scenario -eq 'old-process') {
   [void]$ready.Set()
   $oldProcess = Start-Process $fixture -WindowStyle Normal -PassThru
   Wait-Until { [LifetimeWindows]::IsWindowVisible([LifetimeWindows]::WindowFor($oldProcess.Id)) } 'Old fixture did not show'
   [void]$ready.Reset()
  }
  $elapsed = [Diagnostics.Stopwatch]::StartNew()
  if ($scenario -eq 'manual') {
   $harness = Start-Process "$cache/lifetime-harness.exe" -ArgumentList '--manual' -WindowStyle Normal -PassThru
   Assert-True ($harness.WaitForExit(2000)) 'Manual mode waited for readiness'
   Assert-True ($harness.ExitCode -eq 0) 'Manual mode failed'
   Assert-True ([LifetimeWindows]::FindWindow('#32770', 'SnapOverLAN Update') -eq [IntPtr]::Zero) 'Manual mode showed progress'
   'PASS: manual mode skips progress and readiness waiting.'
   continue
  }
  $harness = Start-Process "$cache/lifetime-harness.exe" -WindowStyle Normal -PassThru
  Wait-Until { [LifetimeWindows]::GetProp([LifetimeWindows]::FindWindow('#32770','SnapOverLAN Update'), 'SnapOverLAN.Test.Armed') -ne [IntPtr]::Zero } 'Popup was not armed'
  $popup = [LifetimeWindows]::FindWindow('#32770', 'SnapOverLAN Update')
  Assert-True ([LifetimeWindows]::IsWindowVisible($popup)) 'Popup not visible during launch'
  Assert-True (([LifetimeWindows]::GetWindowLong($popup, -16) -band 0x50000) -eq 0) 'Resize/maximize enabled'
  [void][LifetimeWindows]::SendMessage($popup, 0x112, [IntPtr]0xF020, [IntPtr]::Zero)
  Assert-True ([LifetimeWindows]::IsIconic($popup)) 'Minimize failed while waiting'
  [void][LifetimeWindows]::SendMessage($popup, 0x112, [IntPtr]0xF120, [IntPtr]::Zero)
  Assert-True (-not [LifetimeWindows]::IsIconic($popup)) 'Restore failed while waiting'
  if ($scenario -eq 'hidden') {
   [void][LifetimeWindows]::SendMessage($popup, 0x112, [IntPtr]0xF060, [IntPtr]::Zero)
   Assert-True (-not [LifetimeWindows]::IsWindowVisible($popup)) 'X did not hide'
  }
  $newProcess = $null
  if ($scenario -ne 'launch-failed') {
   Wait-Until {
    $script:fixtureProcess = Get-Process -Name startup-fixture -ErrorAction SilentlyContinue |
     Where-Object { $_.Path -eq $fixture.Replace('/','\') -and (-not $oldProcess -or $_.Id -ne $oldProcess.Id) } | Select-Object -First 1
    $script:fixtureProcess -and [LifetimeWindows]::WindowFor($script:fixtureProcess.Id) -ne [IntPtr]::Zero
   } 'Builder did not launch the hidden startup fixture'
   $newProcess = $script:fixtureProcess
   Assert-True (-not [LifetimeWindows]::IsWindowVisible([LifetimeWindows]::WindowFor($newProcess.Id))) 'Fixture showed before readiness'
  }
  if ($scenario -eq 'wrong-image') {
   Copy-Item -LiteralPath $fixture -Destination "$cache/wrong-fixture.exe" -Force
   $extraName = 'Local\SnapOverLAN.LifetimeTest.' + [Guid]::NewGuid().ToString('N')
   $extraReady = New-Object Threading.EventWaitHandle($true, [Threading.EventResetMode]::ManualReset, $extraName)
   Write-FixtureConfig $extraName
   $wrongProcess = Start-Process "$cache/wrong-fixture.exe" -WindowStyle Normal -PassThru
   Wait-Until { [LifetimeWindows]::IsWindowVisible([LifetimeWindows]::WindowFor($wrongProcess.Id)) } 'Wrong-image fixture did not show'
  }
  # Test-only startup delay; production has no sleep and responds to the event.
  Start-Sleep -Milliseconds 400
  Assert-True (-not $harness.HasExited -and [LifetimeWindows]::IsWindow($popup)) 'Popup ended before readiness'
  Assert-True ([LifetimeWindows]::IsWindowVisible($popup) -eq ($scenario -ne 'hidden')) 'Popup visibility changed during startup'
  if ($scenario -notin @('timeout', 'launch-failed')) { [void]$ready.Set() }
  Assert-True ($harness.WaitForExit(7500)) 'Readiness/fallback hung'
  Assert-True ($harness.ExitCode -eq 0) "Cleanup failed: $($harness.ExitCode)"
  Assert-True (-not [LifetimeWindows]::IsWindow($popup)) 'Banner survived cleanup'
  $result = Get-Content "$cache/lifetime-result.ini" -Raw
  if ($scenario -in @('timeout', 'launch-failed')) {
   Assert-True ($elapsed.ElapsedMilliseconds -ge 4900) 'Fallback was premature'
   Assert-True ($result -match 'readiness=0') 'Fallback result missing'
  } else {
   Assert-True ($result -match 'readiness=1') 'Did not observe readiness'
   Assert-True ([LifetimeWindows]::IsWindowVisible([LifetimeWindows]::WindowFor($newProcess.Id))) 'App not visible at popup cleanup'
   Assert-True ($elapsed.ElapsedMilliseconds -lt 4500) 'Readiness relied on timeout'
  }
  "PASS: $scenario; readiness/fallback, popup lifetime, hide-only X and final cleanup."
 } finally {
  if ($harness -and -not $harness.HasExited) { Stop-Process -Id $harness.Id }
  # Only test fixtures in our exact cache directory, never the installed app.
  Get-Process -Name startup-fixture,wrong-fixture -ErrorAction SilentlyContinue |
   Where-Object { $_.Path -in @($fixture.Replace('/','\'), "$cache/wrong-fixture.exe".Replace('/','\')) } |
   ForEach-Object { Stop-Process -Id $_.Id }
  $ready.Dispose()
  if ($extraReady) { $extraReady.Dispose() }
 }
}
