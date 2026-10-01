param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateNotNullOrEmpty()]
  [string] $InputPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $InputPath -PathType Leaf)) {
  throw "Windows signing input does not exist: $InputPath"
}

$signingEnv = @("ES_USERNAME", "ES_PASSWORD", "CREDENTIAL_ID", "ES_TOTP_SECRET")
$presentSigningEnv = @()
$missingSigningEnv = @()
foreach ($name in $signingEnv) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    $missingSigningEnv += $name
  } else {
    $presentSigningEnv += $name
  }
}

if ($presentSigningEnv.Count -eq 0) {
  Write-Host "Windows signing environment not present; leaving unsigned: $InputPath"
  exit 0
}

if ($missingSigningEnv.Count -gt 0) {
  throw "Missing Windows signing environment variables: $($missingSigningEnv -join ', ')"
}

$toolEnv = @("CODESIGNTOOL", "CODE_SIGN_TOOL_PATH")
$missingToolEnv = @()
foreach ($name in $toolEnv) {
  $value = [Environment]::GetEnvironmentVariable($name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    $missingToolEnv += $name
  }
}

if ($missingToolEnv.Count -gt 0) {
  throw "Missing Windows signing tool environment variables: $($missingToolEnv -join ', ')"
}

if (-not (Test-Path -LiteralPath $env:CODESIGNTOOL -PathType Leaf)) {
  throw "CODESIGNTOOL does not point at a file: $env:CODESIGNTOOL"
}

if (-not (Test-Path -LiteralPath $env:CODE_SIGN_TOOL_PATH -PathType Container)) {
  throw "CODE_SIGN_TOOL_PATH does not point at a directory: $env:CODE_SIGN_TOOL_PATH"
}

$codeSignTool = (Resolve-Path -LiteralPath $env:CODESIGNTOOL).ProviderPath
$toolRoot = (Resolve-Path -LiteralPath $env:CODE_SIGN_TOOL_PATH).ProviderPath
$resolvedInput = (Resolve-Path -LiteralPath $InputPath).ProviderPath
$extension = [System.IO.Path]::GetExtension($resolvedInput).ToLowerInvariant()
$temporaryPe = $null

if ($extension -notin @(".exe", ".dll", ".msi")) {
  $stream = [System.IO.File]::OpenRead($resolvedInput)
  try {
    $isPe = $stream.ReadByte() -eq 0x4d -and $stream.ReadByte() -eq 0x5a
  } finally {
    $stream.Dispose()
  }

  if (-not $isPe) {
    Write-Host "Authenticode check skipped for '$extension' input (not a PE file CodeSignTool signs): $resolvedInput"
    exit 0
  }

  # CodeSignTool selects supported formats by extension, while NSIS gives its PE uninstaller stub a .tmp name.
  $temporaryPe = Join-Path (Split-Path -Parent $resolvedInput) "$([System.IO.Path]::GetFileName($resolvedInput)).$([guid]::NewGuid().ToString('N')).exe"
}

try {
  $signTarget = $resolvedInput
  if ($temporaryPe) {
    Copy-Item -LiteralPath $resolvedInput -Destination $temporaryPe
    $signTarget = $temporaryPe
  }

  Write-Host "Signing Windows artifact: $signTarget"
  Push-Location -LiteralPath $toolRoot
  try {
    & $codeSignTool "sign" `
      "-username=$env:ES_USERNAME" `
      "-password=$env:ES_PASSWORD" `
      "-credential_id=$env:CREDENTIAL_ID" `
      "-totp_secret=$env:ES_TOTP_SECRET" `
      "-input_file_path=$signTarget" `
      "-override"
    if ($LASTEXITCODE -ne 0) {
      throw "CodeSignTool failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }

  # CodeSignTool can log a failed sign and still exit 0, so read the signature back before copying signed bytes into the stub.
  $signature = Get-AuthenticodeSignature -LiteralPath $signTarget
  if ($signature.Status -ne "Valid") {
    throw "CodeSignTool exited 0 but $signTarget is not signed: Authenticode status $($signature.Status)"
  }
  Write-Host "Authenticode signature verified: $signTarget ($($signature.Status), $($signature.SignerCertificate.Subject))"

  if ($temporaryPe) {
    Copy-Item -LiteralPath $signTarget -Destination $resolvedInput -Force
    Write-Host "Signed Windows PE restored: $resolvedInput"
  }
} finally {
  if ($temporaryPe -and (Test-Path -LiteralPath $temporaryPe)) {
    Remove-Item -LiteralPath $temporaryPe -Force
  }
}
