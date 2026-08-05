param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$DestinationDirectory,
  [Parameter(Mandatory = $true)][string]$RecipientCertificate
)

$source = (Resolve-Path -LiteralPath $InputPath).Path
$extension = [IO.Path]::GetExtension($source).ToLowerInvariant()
if ($extension -notin @('.sql', '.json')) { throw 'Only Fundraising OS SQL or JSON backups may be encrypted.' }
$destinationRoot = [IO.Path]::GetFullPath($DestinationDirectory)
New-Item -ItemType Directory -Path $destinationRoot -Force | Out-Null
$hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$stamp = Get-Date -Format 'yyyyMMddTHHmmssK'
$output = Join-Path $destinationRoot ("{0}-{1}-{2}.p7m" -f [IO.Path]::GetFileNameWithoutExtension($source), $stamp, $hash.Substring(0, 12))

Protect-CmsMessage -To $RecipientCertificate -Path $source -OutFile $output
if (-not (Test-Path -LiteralPath $output) -or (Get-Item -LiteralPath $output).Length -eq 0) { throw 'Encrypted backup verification failed.' }
@{
  encrypted_at = (Get-Date).ToUniversalTime().ToString('o')
  source_sha256 = $hash
  encrypted_file = [IO.Path]::GetFileName($output)
  encryption = 'CMS certificate envelope'
} | ConvertTo-Json | Set-Content -LiteralPath ($output + '.manifest.json') -Encoding UTF8
Write-Output $output
