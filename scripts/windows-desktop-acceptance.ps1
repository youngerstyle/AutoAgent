param(
  [Parameter(Mandatory = $true)]
  [string]$WorkspaceRoot,
  [Parameter(Mandatory = $true)]
  [string]$ReportDir
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AutoAgentAcceptanceWindow {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
"@

function Send-HeldKey {
  param(
    [IntPtr]$WindowHandle,
    [int]$VirtualKey,
    [int]$HoldMilliseconds = 350
  )
  [AutoAgentAcceptanceWindow]::PostMessage($WindowHandle, 0x0100, [IntPtr]$VirtualKey, [IntPtr]1) | Out-Null
  Start-Sleep -Milliseconds $HoldMilliseconds
  [AutoAgentAcceptanceWindow]::PostMessage($WindowHandle, 0x0101, [IntPtr]$VirtualKey, [IntPtr]1) | Out-Null
  Start-Sleep -Milliseconds 180
}

function Save-WindowScreenshot {
  param(
    [IntPtr]$WindowHandle,
    [string]$Path
  )
  $rect = New-Object AutoAgentAcceptanceWindow+RECT
  if (-not [AutoAgentAcceptanceWindow]::GetWindowRect($WindowHandle, [ref]$rect)) {
    throw "Unable to read the desktop product window bounds"
  }
  $width = [Math]::Max(1, $rect.Right - $rect.Left)
  $height = [Math]::Max(1, $rect.Bottom - $rect.Top)
  $bitmap = New-Object System.Drawing.Bitmap $width, $height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(
      (New-Object System.Drawing.Point $rect.Left, $rect.Top),
      [System.Drawing.Point]::Empty,
      (New-Object System.Drawing.Size $width, $height)
    )
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Find-ProductWindow {
  param([datetime]$StartedAfter)
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $candidate = Get-Process python -ErrorAction SilentlyContinue |
      Where-Object {
        $_.StartTime -ge $StartedAfter -and
        $_.MainWindowHandle -ne [IntPtr]::Zero -and
        -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle)
      } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
    if ($candidate) { return $candidate }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  return $null
}

$entry = @(
  (Join-Path $WorkspaceRoot "dist\tank98.py"),
  (Join-Path $WorkspaceRoot "dist\tank98.pyz"),
  (Join-Path $WorkspaceRoot "tank98_app\__main__.py")
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $entry) {
  throw "No executable desktop Python artifact was found"
}

New-Item -ItemType Directory -Force -Path $ReportDir | Out-Null
$runtimeLogDir = Join-Path $ReportDir "desktop-runtime"
$startedAt = Get-Date
$process = Start-Process -FilePath "python" -ArgumentList @(
  "`"$entry`"",
  "--log-dir",
  "`"$runtimeLogDir`""
) -WorkingDirectory $WorkspaceRoot -PassThru

$windowProcess = Find-ProductWindow -StartedAfter $startedAt
if (-not $windowProcess) {
  throw "The desktop artifact started but no interactive window appeared within 15 seconds"
}

$handle = $windowProcess.MainWindowHandle
[AutoAgentAcceptanceWindow]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 500
$titleScreenshot = Join-Path $ReportDir "desktop-title.png"
Save-WindowScreenshot -WindowHandle $handle -Path $titleScreenshot

Send-HeldKey -WindowHandle $handle -VirtualKey 0x0D -HoldMilliseconds 500
Send-HeldKey -WindowHandle $handle -VirtualKey 0x26 -HoldMilliseconds 700
Send-HeldKey -WindowHandle $handle -VirtualKey 0x27 -HoldMilliseconds 700
Send-HeldKey -WindowHandle $handle -VirtualKey 0x20 -HoldMilliseconds 500
Start-Sleep -Seconds 2
$playingScreenshot = Join-Path $ReportDir "desktop-playing.png"
Save-WindowScreenshot -WindowHandle $handle -Path $playingScreenshot

$logPath = Join-Path $runtimeLogDir "tank98.log"
$gameEndDeadline = (Get-Date).AddSeconds(35)
do {
  $log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { "" }
  if ($log -match "game_end:") { break }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $gameEndDeadline)

$gameOverScreenshot = Join-Path $ReportDir "desktop-gameover.png"
Save-WindowScreenshot -WindowHandle $handle -Path $gameOverScreenshot
Send-HeldKey -WindowHandle $handle -VirtualKey 0x0D -HoldMilliseconds 500
Start-Sleep -Seconds 1
$restartScreenshot = Join-Path $ReportDir "desktop-restarted.png"
Save-WindowScreenshot -WindowHandle $handle -Path $restartScreenshot

$log = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { "" }
$result = [ordered]@{
  started = $true
  entry = $entry
  windowTitle = $windowProcess.MainWindowTitle
  enteredPlaying = $log -match "round_started"
  playerFired = $log -match "player_fire"
  enemySpawned = $log -match "enemy_spawn:"
  gameEnded = $log -match "game_end:"
  restarted = $log -match "title_screen"
  negativeBaseHp = $log -match "base_hp=-"
  logPath = $logPath
  screenshots = @(
    $titleScreenshot,
    $playingScreenshot,
    $gameOverScreenshot,
    $restartScreenshot
  )
}

Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "python.exe" -and
    $_.CommandLine -like "*$WorkspaceRoot*"
  } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

$result | ConvertTo-Json -Compress
