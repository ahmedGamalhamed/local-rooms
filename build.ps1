# Builds dist\LocalShare.exe — a single portable executable (no Node install needed to run it).
# Requires Node.js 22+ on the build machine only.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

New-Item -ItemType Directory -Force dist | Out-Null

node --experimental-sea-config sea-config.json
if ($LASTEXITCODE -ne 0) { throw 'Failed to create SEA blob' }

$nodeExe = node -p "process.execPath"
Copy-Item $nodeExe dist\LocalShare.exe -Force

npx --yes postject@1.0.0-alpha.6 dist\LocalShare.exe NODE_SEA_BLOB dist\sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw 'Failed to inject blob into executable' }

Remove-Item dist\sea-prep.blob
Write-Host ''
Write-Host 'Built dist\LocalShare.exe' -ForegroundColor Green
