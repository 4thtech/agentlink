# AgentLink installer for Windows (INSTALLER-1, owner Decision 58).
#
#   PowerShell:  irm https://agentlink.4thtech.io/install.ps1 | iex
#   cmd.exe:     powershell -ExecutionPolicy Bypass -c "irm https://agentlink.4thtech.io/install.ps1 | iex"
#   Options:     & ([scriptblock]::Create((irm https://agentlink.4thtech.io/install.ps1))) -DryRun
#                (or -Uninstall, -NoStart)
#
# What it does, and nothing more:
#   1. Uses your Node.js if it is 22.14 or newer. Otherwise it downloads the official Node.js
#      ($NodeVersion below) from nodejs.org into %LOCALAPPDATA%\AgentLink\runtime, after checking
#      its SHA-256 against nodejs.org's SHASUMS256.txt AND against the hash written in this file.
#   2. Writes a small `agentlink.cmd` to %LOCALAPPDATA%\AgentLink\bin and adds that folder to your
#      own (user) PATH. A .cmd file runs whatever the PowerShell execution policy is.
#   3. Starts AgentLink (only when run from a terminal window).
# No admin rights, no telemetry. It never asks for or prints a secret. Run it again to update.
# Your IDs and messages (in %USERPROFILE%\.agentlink) are never touched, not even by -Uninstall.
# Works on Windows PowerShell 5.1 and PowerShell 7. Source: installer/ in
# https://github.com/4thtech/agentlink (MIT).
param([switch]$DryRun, [switch]$Uninstall, [switch]$NoStart)

# Everything below runs as one script block: nothing it defines stays in your PowerShell session,
# and a download cut off midway does not parse, so none of it runs.
& {
  param($Invocation)

  $NodeVersion = '22.23.4'
  $Package = '@4thtech-io/agentlink@latest'

  function Get-AgentLinkPlatform([string]$Arch) {
    switch ($Arch) {
      'AMD64' { return 'win-x64' }
      'ARM64' { return 'win-arm64' }
      default { throw "This computer's processor ($Arch) is not supported yet." }
    }
  }

  # The SHA-256 of each Node.js archive, copied from nodejs.org's SHASUMS256.txt for v22.23.4, whose
  # release signature (Antoine du Hamel, a Node.js release key) was checked when it was pinned.
  function Get-PinnedSha([string]$Platform) {
    switch ($Platform) {
      'win-x64' { return 'cbc74b5e0982c9dbb41525fd8fb5dcd32fbee237863f7829072f4639a1ce5f20' }
      'win-arm64' { return 'a8b8cd79cbbb3062435f449591d98dd63730bbbf30ce2d7cc3a6376c236cb111' }
      default { return '' }
    }
  }

  # True for Node.js 22.14 or newer.
  function Test-NodeVersion([string]$Version) {
    if ($Version -notmatch '^v?(\d+)\.(\d+)\.') { return $false }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    return ($major -gt 22) -or ($major -eq 22 -and $minor -ge 14)
  }

  # The folder of a `node` on PATH that is new enough and has npx.cmd next to it, or $null.
  function Get-ExistingNode {
    $cmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $cmd) { return $null }
    try {
      $version = (& $cmd.Source -p 'process.versions.node' 2>$null | Out-String).Trim()
    } catch {
      return $null
    }
    if (-not (Test-NodeVersion $version)) {
      if ($version) { Write-Host "Your Node.js $version is older than 22.14, so AgentLink gets its own copy." }
      return $null
    }
    $dir = Split-Path -Parent $cmd.Source
    if (-not (Test-Path -LiteralPath (Join-Path $dir 'npx.cmd'))) { return $null }
    Write-Host "Using your Node.js $version."
    return $dir
  }

  # Throws unless the file's SHA-256 equals both the SHASUMS256.txt line and the pinned hash.
  function Assert-NodeArchive([string]$Path, [string]$Shasums, [string]$FileName, [string]$Pinned) {
    $listed = ''
    foreach ($line in ($Shasums -split "`n")) {
      $parts = $line.Trim() -split '\s+'
      if ($parts.Count -eq 2 -and $parts[1] -eq $FileName) { $listed = $parts[0].ToLowerInvariant() }
    }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $Pinned -or $actual -ne $listed -or $actual -ne $Pinned) {
      throw 'The Node.js download did not pass its safety check (SHA-256 mismatch), so nothing was installed. Please try again later.'
    }
  }

  # The text of agentlink.cmd. % is doubled so a folder name cannot expand inside cmd.exe.
  function Format-Launcher([string]$NodeDir) {
    $dir = $NodeDir.Replace('%', '%%')
    return @(
      '@echo off'
      'rem AgentLink launcher, written by https://agentlink.4thtech.io/install.ps1.'
      'rem Remove with: irm https://agentlink.4thtech.io/install.ps1 | iex, run with -Uninstall.'
      'setlocal'
      "set `"PATH=$dir;%PATH%`""
      # The registry is pinned on the command line, which beats any .npmrc in the folder the app is
      # started from. The folder itself is kept: `agentlink verify .\pack` names files relative to it.
      "`"$dir\npx.cmd`" -y --registry=https://registry.npmjs.org/ --@4thtech-io:registry=https://registry.npmjs.org/ $Package %*"
    ) -join "`r`n"
  }

  # The user PATH, read raw from the registry so entries such as %USERPROFILE%\bin stay unexpanded.
  function Get-UserPath {
    $key = Get-Item -LiteralPath 'HKCU:\Environment'
    return [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  }

  function Set-UserPath([string]$Value) {
    Set-ItemProperty -LiteralPath 'HKCU:\Environment' -Name 'Path' -Value $Value -Type ExpandString
    # Setting any user variable through .NET tells open programs (Explorer) that the environment
    # changed, so new terminals see the new PATH; this one is set and removed again at once.
    [Environment]::SetEnvironmentVariable('AGENTLINK_INSTALLER_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('AGENTLINK_INSTALLER_REFRESH', $null, 'User')
  }

  function Add-UserPath([string]$Dir) {
    $entries = @((Get-UserPath) -split ';' | Where-Object { $_ })
    if ($entries -contains $Dir) { return }
    Set-UserPath (($entries + $Dir) -join ';')
  }

  function Remove-UserPath([string]$Dir) {
    $entries = @((Get-UserPath) -split ';' | Where-Object { $_ })
    if (-not ($entries -contains $Dir)) { return }
    Set-UserPath (($entries | Where-Object { $_ -ne $Dir }) -join ';')
  }

  function Save-Url([string]$Url, [string]$OutFile) {
    try {
      # nodejs.org/dist serves these files directly (HTTP 200, checked 2 Nov 2026): no redirect is followed.
      Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -MaximumRedirection 0
    } catch {
      throw "Could not download $Url. Check your internet connection and run the installer again."
    }
  }

  function Install-AgentLink {
    param([string]$Root, [string]$Arch, [switch]$DryRun, [switch]$Uninstall, [switch]$NoStart, [switch]$Interactive)
    $binDir = Join-Path $Root 'bin'
    $runtimeRoot = Join-Path $Root 'runtime'
    $launcher = Join-Path $binDir 'agentlink.cmd'

    if ($Uninstall) {
      Write-Host 'Removing the AgentLink command and its Node.js copy.'
      if ($DryRun) {
        Write-Host "  would remove $binDir and $runtimeRoot, and $binDir from your PATH"
      } else {
        Remove-Item -LiteralPath $binDir, $runtimeRoot -Recurse -Force -ErrorAction SilentlyContinue
        Remove-UserPath $binDir
      }
      Write-Host 'Done. Your IDs, contacts and messages in .agentlink were kept.'
      return
    }

    $platform = Get-AgentLinkPlatform $Arch
    Write-Host 'Installing AgentLink for Windows.'

    $nodeDir = Get-ExistingNode
    if (-not $nodeDir) {
      $name = "node-v$NodeVersion-$platform"
      $nodeDir = Join-Path $runtimeRoot $name
      if (Test-Path -LiteralPath (Join-Path $nodeDir 'npx.cmd')) {
        Write-Host "Node.js $NodeVersion is already installed for AgentLink."
      } else {
        $pinned = Get-PinnedSha $platform
        $dist = "https://nodejs.org/dist/v$NodeVersion"
        Write-Host "Downloading Node.js $NodeVersion from nodejs.org (about 35 MB)."
        if ($DryRun) {
          Write-Host "  would download $dist/$name.zip and SHASUMS256.txt, check SHA-256 $pinned,"
          Write-Host "  and unpack it into $runtimeRoot"
        } else {
          $tmp = Join-Path ([IO.Path]::GetTempPath()) ('agentlink-install-' + [Guid]::NewGuid().ToString('N'))
          New-Item -ItemType Directory -Path $tmp | Out-Null
          try {
            $zip = Join-Path $tmp "$name.zip"
            $sums = Join-Path $tmp 'SHASUMS256.txt'
            Save-Url "$dist/$name.zip" $zip
            Save-Url "$dist/SHASUMS256.txt" $sums
            Assert-NodeArchive $zip ([IO.File]::ReadAllText($sums)) "$name.zip" $pinned
            Write-Host 'Checked: the download matches nodejs.org and this installer.'
            Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
            New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
            Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter 'node-v*' |
              Remove-Item -Recurse -Force
            Move-Item -LiteralPath (Join-Path $tmp $name) -Destination $nodeDir
          } finally {
            Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
          }
        }
      }
    }

    Write-Host "Adding the agentlink command: $launcher"
    if ($DryRun) {
      Write-Host "  would run: $nodeDir\npx.cmd -y $Package"
      Write-Host "  would add $binDir to your PATH"
      Write-Host 'Dry run: nothing was changed.'
      return
    }
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    [IO.File]::WriteAllText($launcher, (Format-Launcher $nodeDir) + "`r`n", (New-Object Text.UTF8Encoding($false)))
    Add-UserPath $binDir
    if (-not (($env:Path -split ';') -contains $binDir)) { $env:Path = "$binDir;$env:Path" }

    Write-Host 'AgentLink is installed. Next time, open a new terminal and type: agentlink'
    if ($Interactive -and -not $NoStart) {
      Write-Host 'Starting AgentLink. Your browser opens the app. Press Ctrl+C here to close it.'
      & $launcher
    } else {
      Write-Host "To start it now, run: $launcher"
    }
  }

  # --- main: skipped when the tests load the functions above ---------------------------------------
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # the progress bar slows downloads in Windows PowerShell 5.1
  try {
    if ($PSVersionTable.PSEdition -eq 'Core' -and -not $IsWindows) {
      throw 'This installer is for Windows. On macOS and Linux, use: curl -fsSL https://agentlink.4thtech.io/install.sh | sh'
    }
    if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set.' }
    # Windows PowerShell 5.1 may not offer TLS 1.2 by default. Only TLS 1.2 and 1.3 are allowed for
    # the downloads (TLS 1.2 alone where this .NET has no TLS 1.3); the session's setting is put back.
    $savedProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
      try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13
      } catch {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      }
      $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
      $interactive = [Environment]::UserInteractive -and -not [Console]::IsOutputRedirected
      Install-AgentLink -Root (Join-Path $env:LOCALAPPDATA 'AgentLink') -Arch $arch `
        -DryRun:$DryRun -Uninstall:$Uninstall -NoStart:$NoStart -Interactive:$interactive
    } finally {
      [Net.ServicePointManager]::SecurityProtocol = $savedProtocol
    }
  } catch {
    Write-Host "AgentLink installer: $($_.Exception.Message)" -ForegroundColor Red
    # Run as a file (not through iex): end with exit code 1 for scripts that check it.
    if ($Invocation.MyCommand.Path) { exit 1 }
  }
} $MyInvocation
