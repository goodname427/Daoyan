[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $projectRoot

function Read-RequiredValue {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  do {
    $value = (Read-Host $Prompt).Trim()
    if (-not $value) {
      Write-Host '该项不能为空，请重新输入。' -ForegroundColor Yellow
    }
  } while (-not $value)

  return $value
}

Write-Host ''
Write-Host '道衍钉钉秘书本地配置' -ForegroundColor Cyan
Write-Host 'Client Secret 使用隐藏输入，不会写入聊天、终端历史或项目文件。'
Write-Host '配置会保存在当前 Windows 用户环境中；同一 Windows 账号下的进程仍可读取。'
Write-Host ''

$clientId = Read-RequiredValue '应用 Client ID'
$secureSecret = Read-Host '应用 Client Secret（输入不会显示）' -AsSecureString
if ($secureSecret.Length -eq 0) {
  throw 'Client Secret 不能为空。'
}

$allowedSenderIds = Read-RequiredValue '制作人 staffId/userId（不是手机号；多人用英文逗号分隔）'
$notifyUserId = (Read-Host '异步通知 staffId/userId（直接回车使用第一位授权人）').Trim()
if (-not $notifyUserId) {
  $notifyUserId = ($allowedSenderIds -split ',')[0].Trim()
}

$secretPointer = [IntPtr]::Zero
$plainSecret = $null

try {
  $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
  $plainSecret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)

  $settings = [ordered]@{
    DAOYAN_DINGTALK_CLIENT_ID          = $clientId
    DAOYAN_DINGTALK_CLIENT_SECRET      = $plainSecret
    DAOYAN_DINGTALK_ALLOWED_SENDER_IDS = $allowedSenderIds
    DAOYAN_DINGTALK_NOTIFY_USER_ID     = $notifyUserId
  }

  foreach ($entry in $settings.GetEnumerator()) {
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'User')
    Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value
  }

  $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
  Write-Host ''
  Write-Host '本地配置已保存，正在重启常驻秘书...' -ForegroundColor Green

  & $npm run secretary:stop
  if ($LASTEXITCODE -ne 0) {
    throw "停止常驻秘书失败（退出码 $LASTEXITCODE）。"
  }

  & $npm run secretary:start
  if ($LASTEXITCODE -ne 0) {
    throw "启动常驻秘书失败（退出码 $LASTEXITCODE）。"
  }

  Start-Sleep -Seconds 2
  & $npm run secretary:status
  if ($LASTEXITCODE -ne 0) {
    throw "读取秘书状态失败（退出码 $LASTEXITCODE）。"
  }

  Write-Host ''
  Write-Host '配置完成。现在可以在钉钉中向机器人发送：现在项目处于什么状态？' -ForegroundColor Green
}
finally {
  $plainSecret = $null
  if ($secretPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  }
  if ($null -ne $secureSecret) {
    $secureSecret.Dispose()
  }
}
