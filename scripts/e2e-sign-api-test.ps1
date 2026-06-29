# E2E Sign Test - API驱动
# 通过API触发签收任务，监控任务日志直到完成

$baseUrl = "http://localhost:3200"

# Step 1: 触发签收任务
Write-Host "===== 步骤1: 创建签收任务 =====" -ForegroundColor Cyan
$body = @{
    site = "site-1782121346155"
    assignments = @(
        @{
            staffName = "刘磊"
            waybillNos = @("JD-VERIFY-001")
            signer = "本人"
            pageSize = 200
        }
    )
} | ConvertTo-Json -Depth 5

try {
    $response = Invoke-RestMethod -Uri "$baseUrl/api/operations/sign" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 15
    $taskId = $response.taskId
    Write-Host "任务已创建: taskId=$taskId" -ForegroundColor Green
} catch {
    Write-Host "创建任务失败: $_" -ForegroundColor Red
    exit 1
}

# Step 2: 轮询日志
Write-Host "`n===== 步骤2: 监控任务日志 =====" -ForegroundColor Cyan
$lastLogCount = 0
$maxWaitSeconds = 180
$startTime = Get-Date
$allLogs = @()

while (((Get-Date) - $startTime).TotalSeconds -lt $maxWaitSeconds) {
    try {
        $logsResponse = Invoke-RestMethod -Uri "$baseUrl/api/operations/$taskId/logs?limit=200&offset=0" -Method Get -TimeoutSec 10
        $logs = if ($logsResponse.logs) { $logsResponse.logs } elseif ($logsResponse -is [array]) { $logsResponse } else { @() }
        
        $newCount = $logs.Count - $lastLogCount
        if ($newCount -gt 0) {
            for ($i = $lastLogCount; $i -lt $logs.Count; $i++) {
                $log = $logs[$i]
                $level = $log.level
                $msg = $log.message
                $time = $log.timestamp
                
                $color = "White"
                if ($level -eq "error") { $color = "Red" }
                elseif ($level -eq "warning") { $color = "Yellow" }
                elseif ($level -eq "success") { $color = "Green" }
                
                Write-Host "[$time] " -NoNewline
                Write-Host "[$level] " -NoNewline -ForegroundColor $color
                Write-Host $msg
                $allLogs += $log
            }
            $lastLogCount = $logs.Count
        }
        
        # 检查任务状态
        try {
            $taskResponse = Invoke-RestMethod -Uri "$baseUrl/api/operations/$taskId" -Method Get -TimeoutSec 10
            $status = $taskResponse.status
        } catch {
            $status = "unknown"
        }
        
        if ($status -eq "completed" -or $status -eq "failed" -or $status -eq "cancelled") {
            Write-Host "`n===== 任务结束: status=$status =====" -ForegroundColor $(if ($status -eq "completed") { "Green" } else { "Red" })
            
            # 打印摘要
            if ($taskResponse.summary) {
                Write-Host "摘要: $($taskResponse.summary | ConvertTo-Json)" -ForegroundColor Cyan
            }
            break
        }
        
        Start-Sleep -Seconds 3
    } catch {
        if ($_.Exception.Message -match "timeout|operation timed out") {
            Write-Host "." -NoNewline
        } else {
            Write-Host "`n轮询错误(忽略): $($_.Exception.Message)" -ForegroundColor DarkGray
        }
        Start-Sleep -Seconds 3
    }
}

if (((Get-Date) - $startTime).TotalSeconds -ge $maxWaitSeconds) {
    Write-Host "`n===== 超时 ($maxWaitSeconds 秒) =====" -ForegroundColor Red
}

# Step 3: 打印结果摘要
Write-Host "`n===== 结果摘要 =====" -ForegroundColor Cyan
$errorLogs = $allLogs | Where-Object { $_.level -eq "error" }
$warnLogs = $allLogs | Where-Object { $_.level -eq "warning" }
$infoLogs = $allLogs | Where-Object { $_.level -eq "info" }

Write-Host "总日志数: $($allLogs.Count)" 
Write-Host "  信息: $($infoLogs.Count)"
Write-Host "  警告: $($warnLogs.Count)"
Write-Host "  错误: $($errorLogs.Count)"

if ($errorLogs.Count -gt 0) {
    Write-Host "`n错误详情:" -ForegroundColor Red
    foreach ($err in $errorLogs) {
        Write-Host "  [$($err.timestamp)] $($err.message)" -ForegroundColor Red
    }
}
