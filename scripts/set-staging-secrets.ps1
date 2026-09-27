# Set the staging Worker's secrets (PLAN §7.2). Run by the human, never by Claude Code.
#
#   powershell -ExecutionPolicy Bypass -File scripts\set-staging-secrets.ps1
#
# Staging only: the environment is fixed below and cannot be passed in. Production
# secrets are set by hand, one at a time, and never from a script (PLAN §7.2).
#
# - Internal keys are generated here from a CSPRNG and go straight to Cloudflare.
#   Generate them ONCE: a new TOKEN_ENC_KEY_V1 makes every stored Google grant
#   unreadable, and a new WA_VERIFY_TOKEN has to be pasted into Meta again.
# - External values (Meta, Groq, Google) are asked for with hidden input.
#   Leave one blank to skip it and set it on a later run.
# - Nothing is written to disk, and nothing is echoed except WA_VERIFY_TOKEN,
#   which Meta's webhook form needs pasted into it.

$ErrorActionPreference = 'Stop'
$Env = 'staging'
Set-Location (Split-Path -Parent $PSScriptRoot)

function Put-Secret([string]$Name, [string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { Write-Host "  skipped $Name"; return }
  $Value | npx wrangler secret put $Name --env $Env | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "wrangler failed to set $Name" }
  Write-Host "  set $Name"
}

function Random-Base64([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($buffer)
  $rng.Dispose()
  return [Convert]::ToBase64String($buffer)
}

function Random-Hex([int]$Bytes) {
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($buffer)
  $rng.Dispose()
  return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

function Read-Hidden([string]$Prompt) {
  $secure = Read-Host -Prompt $Prompt -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

Write-Host "Setting secrets for the '$Env' Worker (wa-assistant-staging)."
Write-Host ''

$generate = Read-Host 'Generate the internal keys? Only on the FIRST run [y/N]'
if ($generate -eq 'y') {
  $verify = Random-Hex 32
  Put-Secret 'TOKEN_ENC_KEY_V1' (Random-Base64 32)
  Put-Secret 'LOG_HASH_KEY' (Random-Base64 32)
  Put-Secret 'DEVICE_TOKEN_PEPPER' (Random-Base64 32)
  Put-Secret 'WA_VERIFY_TOKEN' $verify
  Write-Host ''
  Write-Host 'Paste this into Meta > WhatsApp > Configuration > Webhook > Verify token:'
  Write-Host "  $verify"
  Write-Host ''
}

Write-Host 'External values. Input is hidden; press Enter to skip one.'
Put-Secret 'GROQ_API_KEY' (Read-Hidden 'GROQ_API_KEY (console.groq.com > API Keys)')
Put-Secret 'WA_APP_SECRET' (Read-Hidden 'WA_APP_SECRET (Meta app > App settings > Basic > App secret)')
Put-Secret 'WA_ACCESS_TOKEN' (Read-Hidden 'WA_ACCESS_TOKEN (System User token, whatsapp_business_messaging)')
Put-Secret 'GOOGLE_CLIENT_SECRET' (Read-Hidden 'GOOGLE_CLIENT_SECRET (Google Cloud > Credentials > OAuth client)')
Put-Secret 'ALLOWLIST_WA_IDS' (Read-Host 'ALLOWLIST_WA_IDS (your number, digits only, e.g. 9725XXXXXXXX)')

Write-Host ''
Write-Host 'Done. Nothing was saved to disk.'
