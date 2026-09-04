$ErrorActionPreference = 'Stop'

# npm test 的正式隔离回归入口。脚本只会删除它自己在系统临时目录中创建的目录。
$projectRoot = Split-Path -Parent $PSScriptRoot
$tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
$runPrefix = 'floating-schedule-verify-'
$runRoot = $null
$failed = $false

function Write-Result {
  param([string]$Message)
  Write-Host ("[verify] {0}" -f $Message)
}

function Quote-ProcessArgument {
  param([string]$Value)
  # ProcessStartInfo 不经过 shell；按 Windows 命令行规则引用路径参数。
  $escaped = $Value -replace '(\\*)"', '$1$1\"'
  $escaped = $escaped -replace '(\\+)$', '$1$1'
  return '"' + $escaped + '"'
}

function Get-DescendantProcessIds {
  param([int]$ParentId)
  $children = @()
  try {
    $children = @(Get-CimInstance -ClassName Win32_Process -Filter ("ParentProcessId = {0}" -f $ParentId) -ErrorAction Stop)
  } catch {
    try {
      $children = @(Get-WmiObject -Class Win32_Process -Filter ("ParentProcessId = {0}" -f $ParentId) -ErrorAction Stop)
    } catch {
      $children = @()
    }
  }
  foreach ($child in $children) {
    $childId = [int]$child.ProcessId
    Get-DescendantProcessIds -ParentId $childId
    $childId
  }
}

function Stop-ProcessTree {
  param([int]$ProcessId)
  $descendants = @(Get-DescendantProcessIds -ParentId $ProcessId)
  # 子进程先停，避免 Electron 的 renderer/helper 在主进程退出后遗留。
  foreach ($childId in ($descendants | Select-Object -Unique | Sort-Object -Descending)) {
    Stop-Process -Id $childId -Force -ErrorAction SilentlyContinue
  }
  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Invoke-ProcessChecked {
  param(
    [string]$FilePath,
    [string[]]$Arguments,
    [hashtable]$Environment,
    [int]$TimeoutMilliseconds,
    [string]$Label
  )

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = (($Arguments | ForEach-Object { Quote-ProcessArgument ([string]$_) }) -join ' ')
  $psi.WorkingDirectory = $projectRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  foreach ($entry in $Environment.GetEnumerator()) {
    $psi.EnvironmentVariables[$entry.Key] = [string]$entry.Value
  }

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  $stdout = ''
  $stderr = ''
  $timedOut = $false
  $exitCode = -1
  $started = $false
  try {
    if (-not $process.Start()) {
      throw "无法启动进程：$FilePath"
    }
    $started = $true
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutMilliseconds)) {
      $timedOut = $true
      Write-Result "$Label 超时（${TimeoutMilliseconds}ms），正在终止进程树"
      Stop-ProcessTree -ProcessId $process.Id
      [void]$process.WaitForExit(5000)
    }
    if ($stdoutTask.Wait(5000)) { $stdout = $stdoutTask.Result }
    if ($stderrTask.Wait(5000)) { $stderr = $stderrTask.Result }
    if (-not $timedOut -and $process.HasExited) {
      $exitCode = $process.ExitCode
    }
  } catch {
    $stderr = $_.Exception.Message
    Write-Result "$Label 启动或等待失败：$($_.Exception.Message)"
  } finally {
    if ($started -and $process -and -not $process.HasExited) {
      Stop-ProcessTree -ProcessId $process.Id
    }
    $process.Dispose()
  }

  if ($stdout) { Write-Host $stdout.TrimEnd() }
  if ($stderr) { Write-Host $stderr.TrimEnd() }
  if ($timedOut) {
    return [pscustomobject]@{ ExitCode = -1; TimedOut = $true; Output = ($stdout + "`n" + $stderr) }
  }
  return [pscustomobject]@{ ExitCode = $exitCode; TimedOut = $false; Output = ($stdout + "`n" + $stderr) }
}

function Get-CurrentEnvironment {
  $environment = @{}
  foreach ($key in [System.Environment]::GetEnvironmentVariables().Keys) {
    $environment[[string]$key] = [string][System.Environment]::GetEnvironmentVariable([string]$key)
  }
  return $environment
}

function New-ElectronEnvironment {
  param([string]$LogFile, [hashtable]$Hooks)
  $environment = Get-CurrentEnvironment
  # 清掉继承来的测试开关，避免调用者环境改变本次门禁范围。
  foreach ($name in @(
      'SCHEDULE_STORE_E2E', 'SCHEDULE_SHOT', 'SCHEDULE_E2E',
      'SCHEDULE_FAILURE_E2E', 'SCHEDULE_TEST_MIN_VIEWPORT',
      'SCHEDULE_TEST_RESIZE', 'SCHEDULE_EXPECT_WEEK', 'SCHEDULE_TEST_AUTOSTART'
    )) {
    [void]$environment.Remove($name)
  }
  $environment['SCHEDULE_TEST_MODE'] = '1'
  $environment['SCHEDULE_TEST_DATA_DIR'] = Join-Path $runRoot 'data'
  $environment['SCHEDULE_SHOT_DIR'] = Join-Path $runRoot 'shots'
  $environment['SCHEDULE_LOG_FILE'] = $LogFile
  $environment['SCHEDULE_ISOLATED_E2E'] = '1'
  foreach ($entry in $Hooks.GetEnumerator()) {
    $environment[$entry.Key] = [string]$entry.Value
  }
  return $environment
}

function Assert-ProcessResult {
  param([string]$Label, [pscustomobject]$Result)
  if ($Result.TimedOut) {
    $script:failed = $true
    Write-Result "$Label 失败：超时"
  } elseif ($Result.ExitCode -ne 0) {
    $script:failed = $true
    Write-Result "$Label 失败：退出码 $($Result.ExitCode)"
  } else {
    Write-Result "$Label 通过"
  }
}

function Assert-TestLog {
  param(
    [string]$Label,
    [string]$LogFile,
    [string[]]$ExpectedPassPatterns
  )
  if (-not (Test-Path -LiteralPath $LogFile -PathType Leaf)) {
    $script:failed = $true
    Write-Result "$Label 失败：缺少日志文件 $LogFile"
    return
  }
  $text = Get-Content -LiteralPath $LogFile -Raw -ErrorAction Stop
  if ($text -match '(?im)(?:\]\s+FAIL(?:\s|:)|\[SHOT\]\s+failed:)') {
    $script:failed = $true
    Write-Result "$Label 失败：日志含 FAIL/failed"
  }
  foreach ($pattern in $ExpectedPassPatterns) {
    if ($text -notmatch $pattern) {
      $script:failed = $true
      Write-Result "$Label 失败：缺少预期 PASS/证据：$pattern"
    }
  }
}

function Assert-ShotFile {
  param([string]$Name)
  $file = Join-Path (Join-Path $runRoot 'shots') $Name
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
    $script:failed = $true
    Write-Result "截图失败：缺少 $file"
  }
}

try {
  if (-not (Test-Path -LiteralPath $projectRoot -PathType Container)) {
    throw "项目目录不存在：$projectRoot"
  }
  $runName = $runPrefix + [guid]::NewGuid().ToString('N')
  $runRoot = Join-Path $tempRoot $runName
  if (-not ([System.IO.Path]::GetFullPath($runRoot).StartsWith($tempRoot + '\', [System.StringComparison]::OrdinalIgnoreCase))) {
    throw "隔离目录不在系统临时目录内：$runRoot"
  }
  New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $runRoot 'data') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $runRoot 'shots') -Force | Out-Null
  Write-Result "隔离目录：$runRoot"

  $node = (Get-Command node.exe -ErrorAction Stop).Source
  $electron = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
  if (-not (Test-Path -LiteralPath $electron -PathType Leaf)) {
    throw "缺少 Electron 可执行文件：$electron（请先 npm install）"
  }

  foreach ($file in @('src\main.js', 'src\preload.js', 'src\renderer\app.js')) {
    $check = Invoke-ProcessChecked -FilePath $node -Arguments @('--check', (Join-Path $projectRoot $file)) -Environment (Get-CurrentEnvironment) -TimeoutMilliseconds 15000 -Label "node --check $file"
    Assert-ProcessResult -Label "node --check $file" -Result $check
  }

  $storeLog = Join-Path $runRoot 'store.log'
  [System.IO.File]::WriteAllText($storeLog, '')
  $storeEnv = New-ElectronEnvironment -LogFile $storeLog -Hooks @{ SCHEDULE_STORE_E2E = '1' }
  $store = Invoke-ProcessChecked -FilePath $electron -Arguments @('.') -Environment $storeEnv -TimeoutMilliseconds 45000 -Label 'Electron 存储 E2E'
  Assert-ProcessResult -Label 'Electron 存储 E2E' -Result $store
  Assert-TestLog -Label 'Electron 存储 E2E' -LogFile $storeLog -ExpectedPassPatterns @('\[STORE-E2E\]\s+PASS\s+normalize-and-backup-recovery')

  $shotLog = Join-Path $runRoot 'shot-e2e.log'
  [System.IO.File]::WriteAllText($shotLog, '')
  $shotEnv = New-ElectronEnvironment -LogFile $shotLog -Hooks @{
    SCHEDULE_SHOT = '1'
    SCHEDULE_E2E = '1'
    SCHEDULE_FAILURE_E2E = '1'
    SCHEDULE_TEST_MIN_VIEWPORT = '1'
  }
  $shot = Invoke-ProcessChecked -FilePath $electron -Arguments @('.') -Environment $shotEnv -TimeoutMilliseconds 120000 -Label 'Electron 截图与全量 E2E'
  Assert-ProcessResult -Label 'Electron 截图与全量 E2E' -Result $shot
  Assert-TestLog -Label 'Electron 截图与全量 E2E' -LogFile $shotLog -ExpectedPassPatterns @(
    '\[E2E\]\s+PASS\s+',
    '\[E2E3\]\s+PASS\s+',
    '\[E2E4\]\s+PASS\s+',
    '\[E2E-FAIL\]\s+PASS\s+',
    '\[E2E-LAYOUT\]\s+PASS\s+',
    '\[E2E-SECURITY\]\s+PASS\s+',
    '\[SHOT\]\s+settingsOpen=true',
    '\[SHOT\]\s+resized to .*"width":46[01].*"height":32[01]'
  )
  Assert-ShotFile -Name 'dev-screenshot.png'
  Assert-ShotFile -Name 'dev-screenshot-copy-confirm.png'
  Assert-ShotFile -Name 'dev-screenshot-settings.png'
} catch {
  $failed = $true
  Write-Result "门禁脚本异常：$($_.Exception.Message)"
} finally {
  if ($runRoot) {
    $safeToRemove = $false
    try {
      $rootItem = Get-Item -LiteralPath $runRoot -Force -ErrorAction Stop
      $rootFull = [System.IO.Path]::GetFullPath($rootItem.FullName).TrimEnd('\')
      $tempFull = [System.IO.Path]::GetFullPath($tempRoot).TrimEnd('\')
      $safeToRemove = $rootItem.PSIsContainer -and
        (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) -and
        $rootItem.Name.StartsWith($runPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
        ([System.IO.Path]::GetDirectoryName($rootFull).TrimEnd('\') -ieq $tempFull) -and
        $rootFull.StartsWith($tempFull + '\', [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
      $safeToRemove = $false
    }
    if ($safeToRemove) {
      try {
        Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction Stop
        Write-Result '已清理本次创建的临时目录'
      } catch {
        $failed = $true
        Write-Result "临时目录清理失败（已保守保留）：$runRoot"
      }
    } else {
      $failed = $true
      Write-Result "拒绝清理未通过安全校验的目录：$runRoot"
    }
  }
}

if ($failed) {
  Write-Result 'npm test 失败'
  exit 1
}
Write-Result 'npm test 通过'
exit 0
