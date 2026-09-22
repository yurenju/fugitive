# fugitive installer for Windows: `irm <origin>/install.ps1 | iex`. Does what install.sh does, in PowerShell,
# because Windows has no sh until Git for Windows is installed. The helper itself stays a /bin/sh script: git runs
# credential helpers through a shell, which on Windows is the sh that ships with Git for Windows.
$ErrorActionPreference = 'Stop'
# git config --unset-all and --unset exit 5 when there is nothing to unset; the read-back below is the real check.
$PSNativeCommandUseErrorActionPreference = $false
$origin = '__ORIGIN__'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw 'fugitive: git not found; install Git for Windows first (MinGit is not enough: the helper needs its curl and openssl)'
}

$dir = Join-Path $env:LOCALAPPDATA 'fugitive'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$helper = Join-Path $dir 'git-credential-fugitive'
Invoke-WebRequest -UseBasicParsing "$origin/git-credential-fugitive" -OutFile $helper

# git appends the operation and hands the whole value to sh as a command line, so backslashes would be escapes and
# %LOCALAPPDATA% usually holds a space. A quoted path is no longer recognised as a path, hence the leading !.
# A quote in the path (the profile directory of an O'Brien) would end the quoting: close, escape, reopen.
$value = "!'" + $helper.Replace('\', '/').Replace("'", "'\''") + "'"
# PowerShell 7.3+ passes an empty argument through (as Standard, or as Windows, which is Standard for anything but
# cmd and friends). Windows PowerShell has neither the variable nor the behaviour, and needs the quoted form.
$empty = if ($PSNativeCommandArgumentPassing -in 'Standard', 'Windows') { '' } else { '""' }

# An empty helper first clears helpers like Manager that would store the token as a password; then add ours.
git config --global --unset-all "credential.$origin.helper"
git config --global --add "credential.$origin.helper" $empty
git config --global --add "credential.$origin.helper" $value
# Stage 1's helper signed with this key; nothing reads it any more.
git config --global --unset fugitive.key

# The empty entry is the part that can go missing without any error, so check before claiming success.
$entries = @(git config --global --get-all "credential.$origin.helper")
if ($entries.Count -ne 2 -or $entries[0] -ne '' -or $entries[1] -ne $value) {
  throw "fugitive: git config was not written as expected: $($entries -join ' | ')"
}

Write-Host "fugitive: credential helper installed for $origin"
Write-Host "fugitive: the first clone or push opens a sign-in page in your browser"
