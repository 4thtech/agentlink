# INSTALLER-1: script-level tests of installer/install.ps1, run by install-ps1.test.mjs with pwsh
# (on Linux in CI). It loads the installer's functions and its two settings ($NodeVersion, $Package)
# from the parsed file, without running its main block, then replaces the parts that touch the
# network or the Windows registry: Invoke-WebRequest serves files from a folder, the user PATH is a
# variable. Prints "ok: <name>" per check; the first failed check throws (exit code 1).
param([string]$Script, [string]$Work)
$ErrorActionPreference = 'Stop'

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "install.ps1 does not parse: $($parseErrors[0].Message)" }
foreach ($statement in $ast.EndBlock.Statements) {
  $isFunction = $statement -is [System.Management.Automation.Language.FunctionDefinitionAst]
  $isSetting = $statement -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    @('$NodeVersion', '$Package') -contains $statement.Left.Extent.Text
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
function Invoke-WebRequest([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing) {
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
  $text = Format-Launcher 'C:\Users\Ana\AppData\Local\AgentLink\runtime\node'
  $lines = $text -split "`r`n"
  $lines[0] -eq '@echo off' -and $lines -contains 'setlocal' -and
  $lines -contains 'set "PATH=C:\Users\Ana\AppData\Local\AgentLink\runtime\node;%PATH%"' -and
  $lines[-1] -eq '"C:\Users\Ana\AppData\Local\AgentLink\runtime\node\npx.cmd" -y @4thtech-io/agentlink@latest %*'
}
Check 'a % in a folder name cannot expand in cmd.exe' {
  (Format-Launcher 'C:\100%\node') -match [regex]::Escape('"C:\100%%\node\npx.cmd"')
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
  (Get-Content -LiteralPath (Join-Path $bin 'agentlink.cmd') -Raw) -eq ((Format-Launcher $nodeDir) + "`r`n")
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
  [regex]::Escape('"C:\Program Files\nodejs\npx.cmd" -y @4thtech-io/agentlink@latest %*')
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
Write-Output 'all install.ps1 checks passed'
