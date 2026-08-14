param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Entrypoint
)

$ErrorActionPreference = "Stop"
$distro = if ($env:AUTOAGENT_EVOLUTION_PLUGIN_WSL_DISTRO) { $env:AUTOAGENT_EVOLUTION_PLUGIN_WSL_DISTRO } else { "Ubuntu" }
$resolvedEntrypoint = (Resolve-Path -LiteralPath $Entrypoint).Path
$hostScript = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "evolution-plugin-sandbox-host.py")).Path
$entryLinux = ($null | & wsl.exe -d $distro -- wslpath -a $resolvedEntrypoint.Replace("\", "/")).Trim()
$hostLinux = ($null | & wsl.exe -d $distro -- wslpath -a $hostScript.Replace("\", "/")).Trim()
$bundleRoot = Split-Path -Parent $resolvedEntrypoint
while ((Split-Path -Leaf $bundleRoot) -ne "bundle") {
  $parent = Split-Path -Parent $bundleRoot
  if (-not $parent -or $parent -eq $bundleRoot) {
    throw "Plugin entrypoint is not inside an immutable bundle directory"
  }
  $bundleRoot = $parent
}
$bundleLinux = ($null | & wsl.exe -d $distro -- wslpath -a $bundleRoot.Replace("\", "/")).Trim()
$entryRelative = $resolvedEntrypoint.Substring($bundleRoot.Length).TrimStart([char[]]@("\", "/")).Replace("\", "/")

if (-not $entryLinux -or -not $hostLinux -or -not $bundleLinux -or -not $entryRelative) {
  throw "Unable to translate Plugin sandbox paths into WSL"
}

& wsl.exe -d $distro -- bwrap `
  --die-with-parent `
  --new-session `
  --unshare-all `
  --cap-drop ALL `
  --clearenv `
  --setenv PYTHONDONTWRITEBYTECODE 1 `
  --setenv PYTHONHASHSEED 0 `
  --ro-bind /usr /usr `
  --ro-bind /bin /bin `
  --ro-bind /lib /lib `
  --ro-bind /lib64 /lib64 `
  --proc /proc `
  --dev /dev `
  --tmpfs /tmp `
  --ro-bind $bundleLinux /bundle `
  --ro-bind $hostLinux /sandbox-host.py `
  --chdir /bundle `
  /usr/bin/python3 /sandbox-host.py "/bundle/$entryRelative"

exit $LASTEXITCODE
