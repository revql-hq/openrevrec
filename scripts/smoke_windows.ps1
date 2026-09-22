param([string]$ReleaseDir = "release")

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$release = (Resolve-Path $ReleaseDir).Path
$installer = Get-ChildItem $release -Filter '*-setup.exe' | Select-Object -First 1
$portable = Get-ChildItem $release -Filter '*-portable.exe' | Select-Object -First 1
if (-not $installer -or -not $portable) { throw "NSIS and portable executables are required." }

$base = Join-Path $env:RUNNER_TEMP 'OpenRevRec Windows smoke'
$install = Join-Path $base 'Installed app'
$workspace = Join-Path $base 'Accounting workspace.orr'
$preferences = Join-Path $base 'Installed preferences'
$portablePreferences = Join-Path $base 'Portable preferences'
New-Item -ItemType Directory -Force -Path $base | Out-Null

function Invoke-DesktopSmoke([string]$executable, [string]$preferencesPath, [bool]$reopen) {
    $env:ORR_SMOKE_TEST = '1'
    $env:ORR_USER_DATA = $preferencesPath
    if ($reopen) {
        Remove-Item Env:ORR_WORKSPACE -ErrorAction SilentlyContinue
        $env:ORR_SMOKE_REOPEN = '1'
    } else {
        $env:ORR_WORKSPACE = $workspace
        Remove-Item Env:ORR_SMOKE_REOPEN -ErrorAction SilentlyContinue
    }
    $suffix = if ($reopen) { 'reopen' } else { 'first' }
    $resultFile = Join-Path $base "$([IO.Path]::GetFileNameWithoutExtension($executable))-$suffix.json"
    $env:ORR_SMOKE_RESULT = $resultFile
    Remove-Item $resultFile -ErrorAction SilentlyContinue
    $stdout = Join-Path $base "$([IO.Path]::GetFileNameWithoutExtension($executable))-$suffix.out"
    $stderr = Join-Path $base "$([IO.Path]::GetFileNameWithoutExtension($executable))-$suffix.err"
    $process = Start-Process -FilePath $executable -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if ($process.ExitCode -ne 0) { throw "Desktop smoke failed ($executable): $(Get-Content $stderr -Raw)" }
    if (-not (Test-Path $resultFile)) { throw "Desktop smoke did not write a result: $(Get-Content $stderr -Raw)" }
    $output = Get-Content $resultFile -Raw | ConvertFrom-Json
    if ($output.desktop_smoke -ne 'ok') { throw "Desktop smoke failed: $(Get-Content $resultFile -Raw) $(Get-Content $stderr -Raw)" }
    if ($reopen -and -not $output.reopened) { throw "Workspace preferences were not used on reopen: $(Get-Content $resultFile -Raw)" }
    Write-Host (Get-Content $resultFile -Raw)
}

$installProcess = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$install") -Wait -PassThru
if ($installProcess.ExitCode -ne 0) { throw "NSIS install failed with exit code $($installProcess.ExitCode)." }
$installedExe = Join-Path $install 'OpenRevRec.exe'
if (-not (Test-Path $installedExe)) { throw "Installed executable not found at $installedExe" }
$registration = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'OpenRevRec*' } | Select-Object -First 1
if (-not $registration) { throw "OpenRevRec was not registered in installed applications." }
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($installedExe)
if (-not $icon -or $icon.Width -lt 16) { throw "Installed executable icon is missing." }
$icon.Dispose()

Invoke-DesktopSmoke $installedExe $preferences $false
if (-not (Test-Path (Join-Path $workspace 'workspace.sqlite3'))) { throw "Initial workspace was not created." }
Invoke-DesktopSmoke $installedExe $preferences $true
Invoke-DesktopSmoke $portable.FullName $portablePreferences $false
Invoke-DesktopSmoke $portable.FullName $portablePreferences $true

$uninstaller = Get-ChildItem $install -Filter 'Uninstall*.exe' | Select-Object -First 1
if (-not $uninstaller) { throw "NSIS uninstaller is missing." }
$uninstallProcess = Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait -PassThru
if ($uninstallProcess.ExitCode -ne 0) { throw "NSIS uninstall failed with exit code $($uninstallProcess.ExitCode)." }
if (-not (Test-Path (Join-Path $workspace 'workspace.sqlite3'))) { throw "Uninstall removed the user workspace." }

Get-FileHash -Path @($installer.FullName, $portable.FullName) -Algorithm SHA256 | ForEach-Object { "$($_.Hash)  $([IO.Path]::GetFileName($_.Path))" } | Tee-Object -FilePath (Join-Path $release 'SHA256SUMS-windows.txt')
Write-Host 'Windows installed and portable desktop smoke passed.'
