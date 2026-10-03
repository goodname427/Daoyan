$ErrorActionPreference = 'Stop'
$folder = 'docs/versions/pilot-agent-intent-2026-09-24/tasks/design-acceptance-da-a-flow'
$result = Get-Content "$folder.json" -Raw -Encoding utf8 | ConvertFrom-Json
$base = $result.delivery.patchBoundary.base
$head = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $head -ne $base) { throw 'Delivery HEAD changed; re-audit the task boundary before delivery.' }
$committedPaths = @(git -c core.quotePath=false diff --name-only $base HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect committed task delta.' }
if (-not (Test-Path "$folder/delivery-scope.json")) { Set-Content "$folder/delivery-scope.json" '{}' -Encoding utf8 }
$status = @(git -c core.quotePath=false status --porcelain=v1 --untracked-files=all)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect workspace delta.' }
$historicalPaths = @(git -c core.quotePath=false diff --name-only 0f6b1f0 $base)
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect excluded historical delta.' }
$historicalCommits = @(git log --format='%H %s' "0f6b1f0..$base")
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect historical commits.' }
foreach ($p in $committedPaths + @($status | ForEach-Object { $_.Substring(3).Replace('\', '/') })) {
  if (-not ($p -eq "$folder.json" -or $p.StartsWith("$folder/"))) { throw "Outside writePaths: $p" }
}
[ordered]@{
  taskId = 'da-a-flow'
  deliveryBase = $base
  head = $head
  excludedHistoricalBase = '0f6b1f0'
  excludedHistoricalCommits = $historicalCommits
  excludedHistoricalPaths = $historicalPaths
  committedTaskPaths = $committedPaths
  workspaceTaskPaths = @($status | ForEach-Object { $_.Substring(3).Replace('\', '/') })
  outsideWritePaths = @()
  policy = 'Prior committed work is preserved and excluded from this task delivery; only contract writePaths may be staged by the delivery owner.'
} | ConvertTo-Json -Depth 8 | Set-Content "$folder/delivery-scope.json" -Encoding utf8
$status | node "$folder/validate.mjs"
if ($LASTEXITCODE -ne 0) { throw 'Task evidence validation failed.' }
