# 이 스크립트를 실행하면 "EmailTaskTrackerAutomation" 이름의 Windows 작업 스케줄러 작업이 등록됩니다.
# 5분마다 watch_and_run.py를 실행해서 새 할일을 자동으로 Claude Code에 넘깁니다.
#
# 실행 방법 (PowerShell을 열어서):
#   cd "C:\Users\etners\Desktop\ETNS_VIBE\email-task-tracker\automation"
#   .\setup_scheduled_task.ps1
#
# 등록을 취소하려면:
#   schtasks /delete /tn "EmailTaskTrackerAutomation" /f

$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$pythonPath = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $pythonPath) {
    Write-Error "python을 찾을 수 없습니다. Python이 설치되어 있고 PATH에 등록되어 있는지 확인하세요."
    exit 1
}

$scriptPath = Join-Path $scriptDir "watch_and_run.py"
$action = "`"$pythonPath`" `"$scriptPath`""

schtasks /create `
    /tn "EmailTaskTrackerAutomation" `
    /tr $action `
    /sc minute `
    /mo 5 `
    /f

Write-Host ""
Write-Host "등록 완료: 5분마다 watch_and_run.py가 실행됩니다."
Write-Host "실행 기록은 $scriptDir\automation.log 에서 확인할 수 있습니다."
Write-Host "지금 바로 한 번 테스트하려면: schtasks /run /tn `"EmailTaskTrackerAutomation`""
