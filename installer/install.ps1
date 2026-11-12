# AgentLink installer for Windows (INSTALLER-1, owner Decision 58).
#
#   PowerShell:  irm https://agentlink.4thtech.io/install.ps1 | iex
#   cmd.exe:     powershell -ExecutionPolicy Bypass -c "irm https://agentlink.4thtech.io/install.ps1 | iex"
#   Options:     & ([scriptblock]::Create((irm https://agentlink.4thtech.io/install.ps1))) -DryRun
#                (or -Uninstall, -NoStart, -Desktop)
#   From an invite page: & ([scriptblock]::Create((irm https://agentlink.4thtech.io/install.ps1))) -Invite '<invite link>'
#
# What it does, and nothing more:
#   1. Uses your Node.js if it is 22.14 or newer. Otherwise it downloads the official Node.js
#      ($NodeVersion below) from nodejs.org into %LOCALAPPDATA%\AgentLink\runtime, after checking
#      its SHA-256 against nodejs.org's SHASUMS256.txt AND against the hash written in this file.
#   2. Writes a small `agentlink.cmd` to %LOCALAPPDATA%\AgentLink\bin and adds that folder to your
#      own (user) PATH. A .cmd file runs whatever the PowerShell execution policy is.
#   3. Starts AgentLink (only when run from a terminal window). With -Invite (the command on an
#      invite page), it opens AgentLink on that invite: `agentlink join` with the link. The link is
#      checked first, with the same patterns as `agentlink join`; anything else is refused with one
#      fixed line, and the link is never printed or stored by this script.
# With -Desktop (refused until the desktop app is released, $DesktopReleased below), it does none of
# the above. It downloads the AgentLink desktop app's per-user setup ($DesktopVersion below) from the
# AgentLink GitHub Release, checks its SHA-256 against the release's SHA256SUMS AND against the hash
# written in this file, and runs it (no admin: it installs into %LOCALAPPDATA%\Programs\AgentLink).
# It never removes the mark of the web from anything and never changes SmartScreen.
# No admin rights, no telemetry. It never asks for or prints a secret. Run it again to update.
# Your IDs and messages (in %USERPROFILE%\.agentlink) are never touched, not even by -Uninstall.
# Works on Windows PowerShell 5.1 and PowerShell 7. Source: installer/ in
# https://github.com/4thtech/agentlink (MIT).
param([switch]$DryRun, [switch]$Uninstall, [switch]$NoStart, [switch]$Desktop, $Invite, [Parameter(ValueFromRemainingArguments = $true)]$Rest)

# Everything below runs as one script block: nothing it defines stays in your PowerShell session,
# and a download cut off midway does not parse, so none of it runs.
& {
  param($Invocation)

  $NodeVersion = '22.23.4'
  $Package = '@4thtech-io/agentlink@latest'
  # The desktop app (-Desktop). Off until the desktop app is released: until then -Desktop is refused
  # before anything happens, and nothing else changes. Releasing it sets $DesktopReleased = $true,
  # $DesktopVersion and the hashes in Get-DesktopPinnedSha (installer/README.md, "For maintainers").
  $DesktopReleased = $false
  $DesktopVersion = '0.0.0'
  $DesktopReleases = 'https://github.com/4thtech/agentlink/releases/download'

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

  # True when $Link is a whole AgentLink invite link: the patterns of `agentlink join` (08 section 4),
  # case-sensitive, anchored at the very start and end (\z: no line break after it). None of these
  # characters is special to PowerShell or cmd.exe.
  function Test-InviteLink([string]$Link) {
    $prefix = [regex]::Escape('https://agentlink.4thtech.io/i#')
    return [regex]::IsMatch($Link, '\A' + $prefix + '(?:[A-Za-z0-9_-]{1,21846}|2\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048])\z')
  }

  # One fixed line; no part of the value is ever printed.
  function Assert-InviteLink([string]$Link) {
    if (-not (Test-InviteLink $Link)) {
      throw "This isn't a complete AgentLink invite. Open the link again and copy the command."
    }
  }

  # Anything the script does not know (a mistyped option, a link split by smart quotes) is refused
  # with one fixed line; no part of it is ever printed.
  function Assert-NoStrayArguments($Stray) {
    if (@($Stray).Count -gt 0) {
      throw 'This installer was given something it does not know. Copy the command again from the invite page.'
    }
  }

  # Runs agentlink.cmd with these arguments, in this window.
  function Invoke-Launcher([string]$Launcher, [string[]]$Arguments) {
    & $Launcher @Arguments
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
  function Format-Launcher([string]$NodeDir, [string]$Root) {
    $dir = $NodeDir.Replace('%', '%%')
    $prefix = $Root.Replace('%', '%%')
    return @(
      '@echo off'
      'rem AgentLink launcher, written by https://agentlink.4thtech.io/install.ps1.'
      'rem Remove with: irm https://agentlink.4thtech.io/install.ps1 | iex, run with -Uninstall.'
      'setlocal'
      # Tells AgentLink it was started by this launcher, so it names the `agentlink` command (D4).
      'set "AGENTLINK_LAUNCHER=installer"'
      "set `"PATH=$dir;%PATH%`""
      # npm reads a project .npmrc from the folder it is started in (node-options, proxies, TLS...).
      # --prefix points that lookup at our own folder instead, and the registry is pinned on the
      # command line. The start folder is kept: `agentlink verify .\pack` names files relative to it.
      "`"$dir\npx.cmd`" -y --prefix=`"$prefix`" --registry=https://registry.npmjs.org/ --@4thtech-io:registry=https://registry.npmjs.org/ $Package %*"
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
    param([string]$Root, [string]$Arch, [switch]$DryRun, [switch]$Uninstall, [switch]$NoStart, [switch]$Interactive, [string]$Invite)
    # 08 section 4: the invite is checked before anything else happens.
    if ($Invite) {
      Assert-InviteLink $Invite
      if ($Uninstall) { throw "-Invite can't be used with -Uninstall." }
    }
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
      if ($Invite) { Write-Host '  would open the invite in AgentLink' }
      Write-Host 'Dry run: nothing was changed.'
      return
    }
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
    [IO.File]::WriteAllText($launcher, (Format-Launcher $nodeDir $Root) + "`r`n", (New-Object Text.UTF8Encoding($false)))
    Add-UserPath $binDir
    if (-not (($env:Path -split ';') -contains $binDir)) { $env:Path = "$binDir;$env:Path" }

    Write-Host 'AgentLink is installed.'
    if ($Interactive -and -not $NoStart) {
      Write-Host 'Starting AgentLink. Your browser opens the app. Press Ctrl+C here to close it.'
      # The last line comes after the app closes, also on Ctrl+C (F43).
      try {
        if ($Invite) {
          Invoke-Launcher $launcher @('join', $Invite)
        } else {
          Invoke-Launcher $launcher @()
        }
      } finally {
        Write-Host 'Next time, open a new terminal and type: agentlink'
      }
    } else {
      Write-Host 'Next time, open a new terminal and type: agentlink'
      if ($Invite) {
        Write-Host 'To open the invite, run the command from the invite page again in your own terminal.'
      } else {
        Write-Host "To start it now, run: $launcher"
      }
    }
  }

  # --- the desktop app (-Desktop) ------------------------------------------------------------------

  # The SHA-256 of each desktop setup.exe of $DesktopVersion, taken from the owner-verified build
  # output or its provenance attestation, never from the release's own SHA256SUMS
  # (installer/README.md). With no mark of the web, SmartScreen never checks it: this hash is the
  # check. Empty: no desktop app for that computer.
  function Get-DesktopPinnedSha([string]$Platform) {
    switch ($Platform) {
      'win-x64' { return '' }
      default { return '' }
    }
  }

  # True when $Url may be fetched for the desktop app: https, exactly one of these hosts (no user
  # name, no port), and only the characters a GitHub Release download or its redirect uses.
  function Test-DesktopUrl([string]$Url) {
    # Case-sensitive (the .NET default), anchored at the very start and end (\z: no line break).
    $match = [regex]::Match([string]$Url, '\Ahttps:/{2}([a-z.]+)/[A-Za-z0-9._~/?=&%:+,;-]*\z')
    if (-not $match.Success) { return $false }
    return @('github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com') -ccontains $match.Groups[1].Value
  }

  # One HTTPS request that follows no redirect. A 200 is saved to $OutFile (at most 1 GiB, counted
  # byte by byte; Content-Length only stops it earlier), within 30 minutes; returns the status code
  # and, for a redirect, the Location header.
  function Get-HttpHop([string]$Url, [string]$OutFile) {
    $request = [Net.WebRequest]::Create($Url)
    $request.AllowAutoRedirect = $false
    $request.Timeout = 60000
    $request.ReadWriteTimeout = 60000
    $deadline = [DateTime]::UtcNow.AddMinutes(30)
    try {
      $response = $request.GetResponse()
    } catch {
      # A 4xx/5xx (and, on some .NET versions, a 3xx) comes as a WebException holding the response.
      $failure = $_.Exception
      if ($failure.InnerException -is [Net.WebException]) { $failure = $failure.InnerException }
      if (-not ($failure -is [Net.WebException]) -or -not $failure.Response) { throw }
      $response = $failure.Response
    }
    try {
      $status = [int]$response.StatusCode
      if ($status -ne 200) { return @{ Status = $status; Location = [string]$response.Headers['Location'] } }
      $limit = 1GB
      if ($response.ContentLength -gt $limit) { throw 'The download is too large.' }
      $in = $response.GetResponseStream()
      $out = [IO.File]::Create($OutFile)
      try {
        $buffer = New-Object byte[] 81920
        $total = 0
        while (($read = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $total += $read
          if ($total -gt $limit) { throw 'The download is too large.' }
          if ([DateTime]::UtcNow -gt $deadline) { throw 'The download took too long.' }
          $out.Write($buffer, 0, $read)
        }
      } finally {
        $out.Dispose()
        $in.Dispose()
      }
      return @{ Status = 200; Location = '' }
    } finally {
      $response.Close()
    }
  }

  # Downloads $Url into $OutFile, following at most 5 redirects itself and checking every address
  # (the first and each hop) with Test-DesktopUrl. Only $Url, a fixed address, is ever printed.
  function Save-ReleaseFile([string]$Url, [string]$OutFile) {
    $next = $Url
    for ($hop = 0; $hop -le 5; $hop++) {
      if (-not (Test-DesktopUrl $next)) {
        throw 'The desktop app download was sent to an unexpected address, so nothing was installed.'
      }
      try {
        $reply = Get-HttpHop $next $OutFile
      } catch {
        throw "Could not download $Url. Check your internet connection and run the installer again."
      }
      if ($reply.Status -eq 200) { return }
      if (@(301, 302, 303, 307, 308) -notcontains $reply.Status) {
        throw "Could not download $Url. Check your internet connection and run the installer again."
      }
      $next = [string]$reply.Location
    }
    throw 'The desktop app download was redirected too often, so nothing was installed.'
  }

  # Throws unless the file's SHA-256 equals both its SHA256SUMS line (exactly one line for the file)
  # and the pinned hash.
  function Assert-DesktopSetup([string]$Path, [string]$Sums, [string]$FileName, [string]$Pinned) {
    $listed = ''
    $count = 0
    foreach ($line in ($Sums -split "`n")) {
      $parts = $line.Trim() -split '\s+'
      if ($parts.Count -eq 2 -and $parts[1] -eq $FileName) { $listed = $parts[0].ToLowerInvariant(); $count++ }
    }
    if ($count -ne 1) { $listed = '' }
    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if (-not $Pinned -or $actual -ne $listed -or $actual -ne $Pinned) {
      throw 'The desktop app download did not pass its safety check (SHA-256 mismatch), so nothing was installed. Please try again later.'
    }
  }

  # Gives the per-run download folder an ACL of its own: only this user, nothing inherited.
  function Protect-Directory([string]$Path) {
    $me = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner($me)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
  }

  # Opens the file so nobody can change it while it stays open (read sharing only) and hashes it
  # through that handle; throws unless it is the pinned hash. The caller keeps it open while the
  # setup runs, then closes it.
  function Open-VerifiedFile([string]$Path, [string]$Pinned) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
      $sha = [Security.Cryptography.SHA256]::Create()
      try { $hash = $sha.ComputeHash($stream) } finally { $sha.Dispose() }
      $actual = ([BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
    } catch {
      $stream.Dispose()
      throw
    }
    if (-not $Pinned -or $actual -ne $Pinned) {
      $stream.Dispose()
      throw 'The desktop app download did not pass its safety check (SHA-256 mismatch), so nothing was installed. Please try again later.'
    }
    return $stream
  }

  # Runs the per-user setup silently (/S) and waits; returns its exit code.
  function Invoke-DesktopSetup([string]$Setup) {
    $process = Start-Process -FilePath $Setup -ArgumentList '/S' -Wait -PassThru
    return $process.ExitCode
  }

  # Starts the installed app, with these arguments, without waiting for it.
  function Start-DesktopApp([string]$Exe, [string[]]$Arguments) {
    if ($Arguments.Count -gt 0) { Start-Process -FilePath $Exe -ArgumentList $Arguments } else { Start-Process -FilePath $Exe }
  }

  # -Desktop: the desktop app (per user). No Node.js, no agentlink command, no PATH change: the app
  # brings its own. Nothing here touches the mark of the web or SmartScreen.
  function Install-AgentLinkDesktop {
    param([string]$ProgramsDir, [string]$Arch, [switch]$DryRun, [switch]$Uninstall, [switch]$NoStart, [switch]$Interactive, [string]$Invite)
    if (-not $DesktopReleased) { throw 'The AgentLink desktop app is not released yet. Run the installer without -Desktop.' }
    if ($Uninstall) { throw "-Desktop can't be used with -Uninstall. To remove the app, use Settings, Apps, AgentLink, Uninstall." }
    if ($Invite) { Assert-InviteLink $Invite }
    $platform = Get-AgentLinkPlatform $Arch
    $pinned = Get-DesktopPinnedSha $platform
    if (-not $pinned) { throw 'The desktop app is not available for this computer yet. Run the installer without -Desktop.' }
    $setupName = "AgentLink-$DesktopVersion-$platform-setup.exe"
    $sumsName = "SHA256SUMS-$platform"
    $release = "$DesktopReleases/v$DesktopVersion"
    $exe = Join-Path (Join-Path $ProgramsDir 'AgentLink') 'AgentLink.exe'
    Write-Host "Installing the AgentLink desktop app $DesktopVersion for Windows."
    Write-Host 'Downloading it from the AgentLink release on GitHub.'
    if ($DryRun) {
      Write-Host "  would download $release/$setupName and $sumsName, check SHA-256 $pinned,"
      Write-Host "  and run it (it installs AgentLink for you only)"
      if ($Invite) { Write-Host '  would open the invite in AgentLink' }
      Write-Host 'Dry run: nothing was changed.'
      return
    }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('agentlink-install-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      try {
        Protect-Directory $tmp
      } catch {
        throw 'Could not make a private temporary folder, so nothing was installed.'
      }
      $setup = Join-Path $tmp $setupName
      $sums = Join-Path $tmp $sumsName
      Save-ReleaseFile "$release/$setupName" $setup
      Save-ReleaseFile "$release/$sumsName" $sums
      Assert-DesktopSetup $setup ([IO.File]::ReadAllText($sums)) $setupName $pinned
      Write-Host 'Checked: the download matches the release and this installer.'
      # Checked again through a handle that keeps the file unchanged until the setup has run.
      $lock = Open-VerifiedFile $setup $pinned
      try {
        $code = Invoke-DesktopSetup $setup
      } finally {
        $lock.Dispose()
      }
      if ($code -ne 0) { throw "The desktop app setup stopped (exit code $code). Run the installer again." }
    } finally {
      Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (-not (Test-Path -LiteralPath $exe)) { throw 'The desktop app setup finished, but AgentLink is not in its folder. Run the installer again.' }
    Write-Host 'AgentLink is installed.'
    $nextTime = 'Next time, open AgentLink from the Start menu.'
    if ($Interactive -and -not $NoStart) {
      if ($Invite) {
        Write-Host 'Opening AgentLink on the invite.'
        # The app's own link (08 section 8): agentlink://join# and the checked payload, after "--".
        $payload = $Invite.Substring('https://agentlink.4thtech.io/i#'.Length)
        Start-DesktopApp $exe @('--', "agentlink://join#$payload")
      } else {
        Write-Host 'Opening AgentLink.'
        Start-DesktopApp $exe @()
      }
      Write-Host $nextTime
    } else {
      Write-Host $nextTime
      if ($Invite) {
        Write-Host 'To open the invite, run the command from the invite page again in your own terminal.'
      } else {
        Write-Host "To open it now, run: & '$($exe.Replace("'", "''"))'"
      }
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
      Assert-NoStrayArguments $Rest
      # An -Invite that is given must be a whole invite link: empty or not text is refused too.
      $inviteLink = ''
      if ($null -ne $Invite) {
        if ($Invite -is [string]) { $inviteLink = $Invite }
        Assert-InviteLink $inviteLink
      }
      $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
      $interactive = [Environment]::UserInteractive -and -not [Console]::IsOutputRedirected
      if ($Desktop) {
        Install-AgentLinkDesktop -ProgramsDir (Join-Path $env:LOCALAPPDATA 'Programs') -Arch $arch `
          -DryRun:$DryRun -Uninstall:$Uninstall -NoStart:$NoStart -Interactive:$interactive -Invite $inviteLink
        return
      }
      Install-AgentLink -Root (Join-Path $env:LOCALAPPDATA 'AgentLink') -Arch $arch `
        -DryRun:$DryRun -Uninstall:$Uninstall -NoStart:$NoStart -Interactive:$interactive -Invite $inviteLink
    } finally {
      [Net.ServicePointManager]::SecurityProtocol = $savedProtocol
    }
  } catch {
    Write-Host "AgentLink installer: $($_.Exception.Message)" -ForegroundColor Red
    # Run as a file (not through iex): end with exit code 1 for scripts that check it.
    if ($Invocation.MyCommand.Path) { exit 1 }
  }
} $MyInvocation
