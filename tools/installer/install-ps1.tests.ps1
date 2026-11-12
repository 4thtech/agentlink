# INSTALLER-1: script-level tests of installer/install.ps1, run by install-ps1.test.mjs with pwsh
# (on Linux in CI). It loads the installer's functions and its settings ($NodeVersion, $Package and
# the $Desktop* ones) from the parsed file, without running its main block, then replaces the parts that touch the
# network or the Windows registry: Invoke-WebRequest serves files from a folder, the user PATH is a
# variable. Prints "ok: <name>" per check; the first failed check throws (exit code 1).
param([string]$Script, [string]$Work)
$ErrorActionPreference = 'Stop'

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "install.ps1 does not parse: $($parseErrors[0].Message)" }
$found = $ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -or
    $node -is [System.Management.Automation.Language.AssignmentStatementAst]
  }, $true)
foreach ($statement in $found) {
  $isFunction = $statement -is [System.Management.Automation.Language.FunctionDefinitionAst]
  $isSetting = $statement -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    @('$NodeVersion', '$Package', '$DesktopReleased', '$DesktopVersion', '$DesktopReleases') -contains $statement.Left.Extent.Text
  if ($isFunction -or $isSetting) { . ([scriptblock]::Create($statement.Extent.Text)) }
}

function Check([string]$CheckLabel, [scriptblock]$CheckCondition) {
  if (-not (& $CheckCondition)) { throw "FAILED: $CheckLabel" }
  Write-Output "ok: $CheckLabel"
}

function Expect-Throw([string]$CheckLabel, [string]$CheckPattern, [scriptblock]$CheckAction) {
  $checkMessage = $null
  try { & $CheckAction *> $null } catch { $checkMessage = $_.Exception.Message }
  if (-not $checkMessage -or $checkMessage -notmatch $CheckPattern) { throw "FAILED: $CheckLabel (got: $checkMessage)" }
  Write-Output "ok: $CheckLabel"
}

# --- fakes ----------------------------------------------------------------------------------------
$script:UserPath = 'C:\Tools;%USERPROFILE%\bin'
function Get-UserPath { return $script:UserPath }
function Set-UserPath([string]$Value) { $script:UserPath = $Value }

$serve = Join-Path $Work 'serve'
New-Item -ItemType Directory -Path $serve | Out-Null
$script:Downloads = @()
function Invoke-WebRequest([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$MaximumRedirection = -1) {
  if ($MaximumRedirection -ne 0) { throw 'FAILED: downloads must refuse redirects (-MaximumRedirection 0)' }
  $script:Downloads += $Uri
  $file = Join-Path $serve ($Uri.Split('/')[-1])
  if (-not (Test-Path -LiteralPath $file)) { throw 'The remote server returned an error: (404) Not Found.' }
  Copy-Item -LiteralPath $file -Destination $OutFile
}
$script:ExistingNode = $null
function Get-ExistingNode { return $script:ExistingNode }

# The fixture Node.js archive and its SHASUMS256.txt.
$name = "node-v$NodeVersion-win-x64"
$build = Join-Path $Work 'build'
New-Item -ItemType Directory -Path (Join-Path $build $name) -Force | Out-Null
Set-Content -LiteralPath (Join-Path (Join-Path $build $name) 'npx.cmd') -Value '@echo npx'
Set-Content -LiteralPath (Join-Path (Join-Path $build $name) 'node.exe') -Value 'node'
Compress-Archive -Path (Join-Path $build $name) -DestinationPath (Join-Path $serve "$name.zip")
$fixtureSha = (Get-FileHash -LiteralPath (Join-Path $serve "$name.zip") -Algorithm SHA256).Hash.ToLowerInvariant()
$goodSums = "$('0' * 64)  other.zip`n$fixtureSha  $name.zip`n"
Set-Content -LiteralPath (Join-Path $serve 'SHASUMS256.txt') -Value $goodSums -NoNewline
$realPinned = ${function:Get-PinnedSha}
function Get-PinnedSha([string]$Platform) { if ($Platform -eq 'win-x64') { return $fixtureSha } return '' }

$savedPath = $env:Path
$roots = 0
function New-Root { $script:roots++; return (Join-Path $Work "root$($script:roots)") }
function Reset { $script:Downloads = @(); $env:Path = $savedPath }

# --- pure functions -------------------------------------------------------------------------------
Check 'Node.js 22.14 and newer is enough' {
  (Test-NodeVersion '22.14.0') -and (Test-NodeVersion 'v22.23.4') -and (Test-NodeVersion '24.1.0') -and
  -not (Test-NodeVersion '22.13.1') -and -not (Test-NodeVersion '20.18.0') -and -not (Test-NodeVersion '')
}
Check 'x64 and arm64 Windows map to the nodejs.org archive names' {
  (Get-AgentLinkPlatform 'AMD64') -eq 'win-x64' -and (Get-AgentLinkPlatform 'ARM64') -eq 'win-arm64'
}
Expect-Throw 'an unknown processor is refused in plain words' 'not supported yet' { Get-AgentLinkPlatform 'x86' }
Check 'the launcher is a .cmd that runs npx from the chosen Node.js' {
  $text = Format-Launcher 'C:\Users\Ana\AppData\Local\AgentLink\runtime\node' 'C:\Users\Ana\AppData\Local\AgentLink'
  $lines = $text -split "`r`n"
  $lines[0] -eq '@echo off' -and $lines -contains 'setlocal' -and
  $lines -contains 'set "PATH=C:\Users\Ana\AppData\Local\AgentLink\runtime\node;%PATH%"' -and
  $lines[-1] -eq '"C:\Users\Ana\AppData\Local\AgentLink\runtime\node\npx.cmd" -y --prefix="C:\Users\Ana\AppData\Local\AgentLink" --registry=https://registry.npmjs.org/ --@4thtech-io:registry=https://registry.npmjs.org/ @4thtech-io/agentlink@latest %*'
}
Check 'a % in a folder name cannot expand in cmd.exe' {
  $text = Format-Launcher 'C:\100%\node' 'C:\100%\AgentLink'
  $text.Contains('"C:\100%%\node\npx.cmd"') -and $text.Contains('--prefix="C:\100%%\AgentLink"')
}

# --- installs ------------------------------------------------------------------------------------
Reset
$root = New-Root
$out = Install-AgentLink -Root $root -Arch 'AMD64' -DryRun 6>&1 | Out-String
Check 'dry run: prints the plan, downloads and changes nothing' {
  $out -match 'would download https://nodejs\.org/dist/v[\d.]+/node-v[\d.]+-win-x64\.zip' -and
  $out -match 'Dry run: nothing was changed' -and $script:Downloads.Count -eq 0 -and
  -not (Test-Path -LiteralPath $root) -and $script:UserPath -eq 'C:\Tools;%USERPROFILE%\bin'
}

Reset
$root = New-Root
$out = Install-AgentLink -Root $root -Arch 'AMD64' 6>&1 | Out-String
$bin = Join-Path $root 'bin'
$nodeDir = Join-Path (Join-Path $root 'runtime') $name
Check 'no Node.js: downloads it and SHASUMS256.txt from nodejs.org, checks, installs' {
  $script:Downloads -contains "https://nodejs.org/dist/v$NodeVersion/$name.zip" -and
  $script:Downloads -contains "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -and
  $out -match 'matches nodejs\.org and this installer' -and
  (Test-Path -LiteralPath (Join-Path $nodeDir 'npx.cmd'))
}
Check 'writes agentlink.cmd for that Node.js' {
  (Get-Content -LiteralPath (Join-Path $bin 'agentlink.cmd') -Raw) -eq ((Format-Launcher $nodeDir $root) + "`r`n")
}
Check 'adds the bin folder to the user PATH once, keeping the other entries unexpanded' {
  $script:UserPath -eq "C:\Tools;%USERPROFILE%\bin;$bin"
}
Check 'not run from a terminal: does not start the app, says how' {
  $out -match 'To start it now, run:' -and $out -notmatch 'Starting AgentLink'
}

Reset
$out = Install-AgentLink -Root $root -Arch 'AMD64' 6>&1 | Out-String
Check 'running it again (an update) downloads nothing new and keeps one PATH entry' {
  $out -match 'already installed' -and $script:Downloads.Count -eq 0 -and
  $script:UserPath -eq "C:\Tools;%USERPROFILE%\bin;$bin"
}

Reset
$out = Install-AgentLink -Root $root -Arch 'AMD64' -Uninstall 6>&1 | Out-String
Check 'uninstall removes the command, the runtime and the PATH entry' {
  -not (Test-Path -LiteralPath $bin) -and -not (Test-Path -LiteralPath (Join-Path $root 'runtime')) -and
  $script:UserPath -eq 'C:\Tools;%USERPROFILE%\bin' -and $out -match 'were kept'
}

Reset
$root = New-Root
$script:ExistingNode = 'C:\Program Files\nodejs'
$null = Install-AgentLink -Root $root -Arch 'AMD64' 6>&1
Check 'a new enough Node.js already there is used, nothing is downloaded' {
  $script:Downloads.Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $root 'runtime')) -and
  (Get-Content -LiteralPath (Join-Path (Join-Path $root 'bin') 'agentlink.cmd') -Raw) -match
  [regex]::Escape('"C:\Program Files\nodejs\npx.cmd" -y --prefix="' + $root + '" --registry=https://registry.npmjs.org/ --@4thtech-io:registry=https://registry.npmjs.org/ @4thtech-io/agentlink@latest %*')
}
$script:ExistingNode = $null

Reset
$root = New-Root
Set-Content -LiteralPath (Join-Path $serve 'SHASUMS256.txt') -Value "$('a' * 64)  $name.zip`n" -NoNewline
Expect-Throw 'a download that does not match SHASUMS256.txt stops the install' 'SHA-256 mismatch' {
  Install-AgentLink -Root $root -Arch 'AMD64'
}
Check '... and installs nothing' {
  -not (Test-Path -LiteralPath (Join-Path $root 'runtime')) -and -not (Test-Path -LiteralPath (Join-Path $root 'bin'))
}
Set-Content -LiteralPath (Join-Path $serve 'SHASUMS256.txt') -Value $goodSums -NoNewline

Reset
$root = New-Root
Set-Item -Path function:Get-PinnedSha -Value $realPinned
Expect-Throw 'a download that matches SHASUMS256.txt but not the pinned hash stops the install' 'SHA-256 mismatch' {
  Install-AgentLink -Root $root -Arch 'AMD64'
}
Check '... and installs nothing' { -not (Test-Path -LiteralPath (Join-Path $root 'bin')) }

Reset
$root = New-Root
Remove-Item -LiteralPath (Join-Path $serve "$name.zip")
Expect-Throw 'a failed download says so plainly' 'Could not download .*internet connection' {
  Install-AgentLink -Root $root -Arch 'AMD64'
}
$env:Path = $savedPath

# --- WP-2: the one command from the invite page ----------------------------------------------------
# The link is checked with the patterns of `agentlink join` (08 section 4) before anything happens;
# anything else gets one fixed line, and no part of it is ever printed.
Set-Content -LiteralPath (Join-Path $serve 'SHASUMS256.txt') -Value $goodSums -NoNewline
Compress-Archive -Path (Join-Path $build $name) -DestinationPath (Join-Path $serve "$name.zip") -Force
function Get-PinnedSha([string]$Platform) { if ($Platform -eq 'win-x64') { return $fixtureSha } return '' }
$script:Launched = @()
function Invoke-Launcher([string]$Launcher, [string[]]$Arguments) {
  Write-Host 'LAUNCHED'
  $script:Launched += , @($Arguments)
}
$long = 'https://agentlink.4thtech.io/i#' + ('Ab9_-' * 40)
$short = 'https://agentlink.4thtech.io/i#2.' + ('a' * 42) + 'w'
$refused = "^This isn't a complete AgentLink invite\. Open the link again and copy the command\.$"
Check 'an AgentLink invite link, long or short, passes the check' {
  (Test-InviteLink $long) -and (Test-InviteLink $short) -and
  (Test-InviteLink ('https://agentlink.4thtech.io/i#' + ('A' * 21846)))
}
$badInvites = @(
  '', 'Ab9_-', 'http://agentlink.4thtech.io/i#Ab9_-', 'https://agentlink.4thtech.io/i#',
  'https://agentlink.4thtech.io/x#Ab9_-', 'https://agentlink.4thtech.io.evil.example/i#Ab9_-',
  'https://AGENTLINK.4thtech.io/i#Ab9_-', 'https://agentlinkx4thtech.io/i#Ab9_-',
  ("https://$([char]0x0430)gentlink.4thtech.io/i#Ab9_-"),
  "$long ", " $long", "$long`n", "$long`r`n", "'$long'", "$long'", "$long`"", "$long;calc",
  "$long`$(calc)", "$long``calc", "$long&calc", "$long|calc", "$long%41", "$long^", "$long!",
  "$long#x", ($long + [char]0x00e9), "$long.",
  ('https://agentlink.4thtech.io/i#' + ('A' * 21847)),
  ('https://agentlink.4thtech.io/i#2.' + ('a' * 42) + 'b'),
  ('https://agentlink.4thtech.io/i#2.' + ('a' * 41) + 'w'),
  ('https://agentlink.4thtech.io/i#2.' + ('a' * 43) + 'w'),
  "$([char]0x2018)$long$([char]0x2019)", "$([char]0x201C)$long$([char]0x201D)",
  ($long + [char]0x2019)
)
Check 'anything else fails the check (case, spaces, line breaks, quotes, shell characters, length)' {
  $passed = @($badInvites | Where-Object { Test-InviteLink $_ })
  $passed.Count -eq 0
}

Expect-Throw 'an unknown option or stray words are refused with a fixed line, naming nothing of them' '^This installer was given something it does not know\. Copy the command again from the invite page\.$' {
  Assert-NoStrayArguments @('-Bogus', 'secret-word')
}
Check 'no stray arguments passes the guard' {
  $null -eq (Assert-NoStrayArguments @()) -and $null -eq (Assert-NoStrayArguments $null)
}
Check 'the guard message echoes nothing it was given' {
  $m = $null
  try { Assert-NoStrayArguments @('-Bogus', 'secret-word') } catch { $m = $_.Exception.Message }
  $m -notmatch 'Bogus' -and $m -notmatch 'secret'
}

Reset
$root = New-Root
Expect-Throw 'a malformed invite is refused with the fixed line, naming nothing of it' $refused {
  Install-AgentLink -Root $root -Arch 'AMD64' -Invite "$long;calc"
}
Check '... before anything is downloaded or written' {
  $script:Downloads.Count -eq 0 -and -not (Test-Path -LiteralPath $root)
}
Expect-Throw 'an invite with -Uninstall is refused' 'Uninstall' {
  Install-AgentLink -Root $root -Arch 'AMD64' -Uninstall -Invite $short
}

Reset
$root = New-Root
$out = Install-AgentLink -Root $root -Arch 'AMD64' -Invite $short 6>&1 | Out-String
Check 'not run from a terminal, with an invite: installs, says how to open it, never prints it' {
  $out -match 'To open the invite, run the command from the invite page again in your own terminal\.' -and
  $out -notmatch 'aaaa' -and $out -notmatch 'LAUNCHED' -and
  (Test-Path -LiteralPath (Join-Path (Join-Path $root 'bin') 'agentlink.cmd'))
}

Reset
$script:Launched = @()
$out = Install-AgentLink -Root $root -Arch 'AMD64' -Interactive -Invite $short 6>&1 | Out-String
$lines = @($out -split "`r?`n")
Check 'in a terminal, with an invite: runs agentlink join with the link as one argument' {
  $script:Launched.Count -eq 1 -and $script:Launched[0].Count -eq 2 -and
  $script:Launched[0][0] -eq 'join' -and $script:Launched[0][1] -eq $short -and $out -notmatch 'aaaa'
}
Check 'F43: installed, then starting, then the app, then how to start it next time' {
  $installed = [array]::IndexOf($lines, 'AgentLink is installed.')
  $starting = [array]::IndexOf($lines, 'Starting AgentLink. Your browser opens the app. Press Ctrl+C here to close it.')
  $launched = [array]::IndexOf($lines, 'LAUNCHED')
  $next = [array]::IndexOf($lines, 'Next time, open a new terminal and type: agentlink')
  $installed -ge 0 -and $starting -gt $installed -and $launched -gt $starting -and $next -gt $launched
}

Reset
$script:Launched = @()
$out = Install-AgentLink -Root $root -Arch 'AMD64' -Interactive 6>&1 | Out-String
Check 'in a terminal, without an invite: runs agentlink with no arguments' {
  $script:Launched.Count -eq 1 -and $script:Launched[0].Count -eq 0 -and
  $out -match 'Next time, open a new terminal and type: agentlink'
}

Check 'the launcher tells AgentLink it was started by the installer (D4)' {
  $text = Format-Launcher 'C:\node' 'C:\AgentLink'
  $lines = $text -split "`r`n"
  $set = [array]::IndexOf($lines, 'set "AGENTLINK_LAUNCHER=installer"')
  $set -gt [array]::IndexOf($lines, 'setlocal') -and $set -lt ($lines.Count - 1)
}
# --- -Desktop (the desktop app) -------------------------------------------------------------------
# The shipped script has it switched off. The checks below switch it on with version 9.9.9 and the
# fixture setup's hash pinned, and replace the parts that touch the network (Get-HttpHop), run the
# setup (Invoke-DesktopSetup) or start the app (Start-DesktopApp).
$script:Hops = @()
function Get-HttpHop([string]$Url, [string]$OutFile) {
  $script:Hops += $Url
  if ($script:Redirects.ContainsKey($Url)) { return @{ Status = 302; Location = $script:Redirects[$Url] } }
  $file = Join-Path $deskServe (($Url -split '\?')[0].Split('/')[-1])
  if (-not (Test-Path -LiteralPath $file)) { return @{ Status = 404; Location = '' } }
  Copy-Item -LiteralPath $file -Destination $OutFile
  return @{ Status = 200; Location = '' }
}
function Invoke-DesktopSetup([string]$Setup) {
  $script:SetupRuns += [IO.File]::ReadAllText($Setup)
  if ($script:SetupExit -eq 0) {
    $dir = Join-Path $script:Programs 'AgentLink'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $dir 'AgentLink.exe') -Value 'app'
  }
  return $script:SetupExit
}
function Start-DesktopApp([string]$Exe, [string[]]$Arguments) {
  Write-Host 'STARTED'
  $script:Started += , (@($Exe) + @($Arguments))
}
function Get-DesktopPinnedSha([string]$Platform) { if ($Platform -eq 'win-x64') { return $script:DeskPinned } return '' }
function New-Programs { $script:roots++; $script:Programs = Join-Path $Work "programs$($script:roots)"; return $script:Programs }

Check 'the desktop app ships switched off' { $DesktopReleased -eq $false }
Expect-Throw 'switched off: -Desktop is refused with one fixed line' '^The AgentLink desktop app is not released yet\. Run the installer without -Desktop\.$' {
  Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64' -Invite $short
}
Check '... before anything is downloaded or run' {
  $script:Hops.Count -eq 0 -and -not (Test-Path -LiteralPath $script:Programs)
}

$DesktopReleased = $true
$DesktopVersion = '9.9.9'
$release = "$DesktopReleases/v9.9.9"
$setupName = 'AgentLink-9.9.9-win-x64-setup.exe'
$sumsName = 'SHA256SUMS-win-x64'
$deskServe = Join-Path $Work 'desk-serve'
New-Item -ItemType Directory -Path $deskServe | Out-Null
Set-Content -LiteralPath (Join-Path $deskServe $setupName) -Value 'the AgentLink setup 9.9.9' -NoNewline
$deskSha = (Get-FileHash -LiteralPath (Join-Path $deskServe $setupName) -Algorithm SHA256).Hash.ToLowerInvariant()
$deskSums = "$('1' * 64)  AgentLink-9.9.9-win-x64.zip`n$deskSha  $setupName`n"
function Reset-Desktop {
  $script:Downloads = @()
  $script:Hops = @()
  $script:Redirects = @{}
  $script:SetupRuns = @()
  $script:SetupExit = 0
  $script:Started = @()
  $script:DeskPinned = $deskSha
  Set-Content -LiteralPath (Join-Path $deskServe $setupName) -Value 'the AgentLink setup 9.9.9' -NoNewline
  Set-Content -LiteralPath (Join-Path $deskServe $sumsName) -Value $deskSums -NoNewline
}
function Get-TempCount { return @(Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'agentlink-install-*' -ErrorAction SilentlyContinue).Count }

Check 'a desktop download address must be https on a GitHub Release host, nothing else' {
  $good = @(
    "$release/$setupName",
    'https://objects.githubusercontent.com/github-production-release-asset/1/x?a=1&b=x%3D',
    'https://release-assets.githubusercontent.com/github-production-release-asset/1/x?sp=r&sig=a%2Bb%3D&rsct=application%2Foctet-stream'
  )
  $bad = @(
    '', 'https://evil.example/x', 'http://github.com/4thtech/agentlink', 'https://github.com@evil.example/x',
    'https://github.com:8443/x', 'https://objects.githubusercontent.com.evil.example/x', 'https://GitHub.com/x',
    'https://github.com', '/relative/x', 'https://github.com/x y', 'https://github.com/x"y', "https://github.com/x`n",
    'https://github.com/x\y', "https://github.com/x$([char]0x00e9)", 'file:///etc/passwd'
  )
  @($good | Where-Object { -not (Test-DesktopUrl $_) }).Count -eq 0 -and
  @($bad | Where-Object { Test-DesktopUrl $_ }).Count -eq 0
}

Reset-Desktop
$programs = New-Programs
$tempBefore = Get-TempCount
$out = Install-AgentLinkDesktop -ProgramsDir $programs -Arch 'AMD64' 6>&1 | Out-String
Check 'desktop: downloads the setup and SHA256SUMS from the release, checks both hashes, runs the setup' {
  $script:Hops.Count -eq 2 -and $script:Hops[0] -eq "$release/$setupName" -and $script:Hops[1] -eq "$release/$sumsName" -and
  $script:SetupRuns.Count -eq 1 -and $script:SetupRuns[0] -eq 'the AgentLink setup 9.9.9' -and
  $out -match 'Checked: the download matches the release and this installer\.' -and $out -match 'AgentLink is installed\.'
}
Check 'desktop: app only (no Node.js, no command), temporary folder removed, not started without a terminal' {
  $script:Downloads.Count -eq 0 -and (Get-TempCount) -eq $tempBefore -and $script:Started.Count -eq 0 -and
  $out -match 'Next time, open AgentLink from the Start menu\.' -and $out -match 'To open it now, run:'
}

Reset-Desktop
$hop1 = "https://objects.githubusercontent.com/github-production-release-asset/1/$setupName" + '?a=1'
$hop2 = "https://release-assets.githubusercontent.com/github-production-release-asset/1/$setupName" + '?sp=r&sig=abc%3D'
$script:Redirects[$release + '/' + $setupName] = $hop1
$script:Redirects[$hop1] = $hop2
$out = Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64' 6>&1 | Out-String
Check 'desktop: follows GitHub redirects itself, checking each hop, printing none of them' {
  $script:Hops.Count -eq 4 -and $script:Hops[1] -eq $hop1 -and $script:Hops[2] -eq $hop2 -and
  $script:SetupRuns.Count -eq 1 -and $out -notmatch 'githubusercontent'
}

$badHops = @(
  'https://evil.example/x.exe', "http://objects.githubusercontent.com/$setupName", "https://github.com@evil.example/$setupName",
  "https://github.com:8443/$setupName", "https://objects.githubusercontent.com.evil.example/$setupName", '', "/x/$setupName"
)
Check 'desktop: a redirect anywhere else is refused before it is fetched, and nothing runs' {
  $ok = $true
  foreach ($to in $badHops) {
    Reset-Desktop
    $script:Redirects[$release + '/' + $setupName] = $to
    $m = $null
    try { Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64' *> $null } catch { $m = $_.Exception.Message }
    if ($m -ne 'The desktop app download was sent to an unexpected address, so nothing was installed.' -or
      $script:Hops.Count -ne 1 -or $script:SetupRuns.Count -ne 0) { $ok = $false }
  }
  $ok
}

Reset-Desktop
$script:Redirects[$release + '/' + $setupName] = 'https://objects.githubusercontent.com/hop1'
foreach ($n in 1..5) { $script:Redirects["https://objects.githubusercontent.com/hop$n"] = "https://objects.githubusercontent.com/hop$($n + 1)" }
Expect-Throw 'desktop: stops after 5 redirects' 'redirected too often' {
  Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64'
}
Check '... and runs nothing' { $script:SetupRuns.Count -eq 0 }

Reset-Desktop
Set-Content -LiteralPath (Join-Path $deskServe $sumsName) -Value "$('2' * 64)  $setupName`n" -NoNewline
Expect-Throw 'desktop: a setup that does not match SHA256SUMS stops the install' 'SHA-256 mismatch' {
  Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64'
}
Check '... and runs nothing' { $script:SetupRuns.Count -eq 0 }

Reset-Desktop
$script:DeskPinned = '3' * 64
Expect-Throw 'desktop: a setup that matches SHA256SUMS but not the pinned hash stops the install' 'SHA-256 mismatch' {
  Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64'
}
Check '... and runs nothing' { $script:SetupRuns.Count -eq 0 }

Reset-Desktop
Remove-Item -LiteralPath (Join-Path $deskServe $sumsName)
Expect-Throw 'desktop: a failed download says so plainly, naming only the fixed address' ([regex]::Escape("Could not download $release/$sumsName. Check your internet connection")) {
  Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64'
}

Reset-Desktop
$script:SetupExit = 2
Expect-Throw 'desktop: a setup that fails says so' 'exit code 2' {
  Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64'
}

Reset-Desktop
$out = Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64' -DryRun -Invite $short 6>&1 | Out-String
Check 'desktop: dry run prints the plan, downloads and runs nothing, never prints the link' {
  $script:Hops.Count -eq 0 -and $script:SetupRuns.Count -eq 0 -and -not (Test-Path -LiteralPath $script:Programs) -and
  $out -match ([regex]::Escape("would download $release/$setupName and $sumsName")) -and
  $out -match 'would open the invite in AgentLink' -and $out -notmatch 'aaaa'
}

Reset-Desktop
Expect-Throw 'desktop: -Uninstall is refused' "-Desktop can't be used with -Uninstall" {
  Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64' -Uninstall
}
Expect-Throw 'desktop: a malformed invite is refused with the fixed line' $refused {
  Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64' -Invite "$short;calc"
}
Expect-Throw 'desktop: no pinned app for this processor' 'not available for this computer yet' {
  Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'ARM64'
}
Check '... all before anything is downloaded' { $script:Hops.Count -eq 0 }

Reset-Desktop
$out = Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64' -Interactive -Invite $short 6>&1 | Out-String
Check 'desktop, in a terminal, with an invite: starts the app with -- and the agentlink:// link' {
  $exe = Join-Path (Join-Path $script:Programs 'AgentLink') 'AgentLink.exe'
  $payload = $short.Substring('https://agentlink.4thtech.io/i#'.Length)
  $script:Started.Count -eq 1 -and $script:Started[0].Count -eq 3 -and $script:Started[0][0] -eq $exe -and
  $script:Started[0][1] -eq '--' -and $script:Started[0][2] -eq "agentlink://join#$payload" -and $out -notmatch 'aaaa'
}

Reset-Desktop
$out = Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64' -Interactive 6>&1 | Out-String
Check 'desktop, in a terminal, without an invite: starts the app with no arguments' {
  $script:Started.Count -eq 1 -and $script:Started[0].Count -eq 1 -and $out -match 'Opening AgentLink\.'
}

Reset-Desktop
$out = Install-AgentLinkDesktop -ProgramsDir (New-Programs) -Arch 'AMD64' -Invite $long 6>&1 | Out-String
Check 'desktop, not in a terminal, with an invite: starts nothing, says how to open it, never prints it' {
  $script:Started.Count -eq 0 -and $out -notmatch 'Ab9_-' -and
  $out -match 'To open the invite, run the command from the invite page again in your own terminal\.'
}
$DesktopReleased = $false

Write-Output 'all install.ps1 checks passed'
