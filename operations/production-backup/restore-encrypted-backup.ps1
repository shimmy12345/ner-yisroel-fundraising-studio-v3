param(
  [Parameter(Mandatory = $true)][string]$EncryptedPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$encrypted = (Resolve-Path -LiteralPath $EncryptedPath).Path
if ([IO.Path]::GetExtension($encrypted).ToLowerInvariant() -ne '.p7m') { throw 'Expected a CMS-encrypted .p7m backup.' }
$plaintext = Unprotect-CmsMessage -Path $encrypted
if ([string]::IsNullOrWhiteSpace($plaintext)) { throw 'Backup decryption produced no content.' }
$output = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $output) { throw 'Refusing to overwrite an existing restore file.' }
[IO.File]::WriteAllText($output, $plaintext, [Text.UTF8Encoding]::new($false))
Write-Output $output
