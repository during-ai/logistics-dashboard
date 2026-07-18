# 물류 현황판 최초 배포 스크립트
# PowerShell에서 실행: .\deploy.ps1

Set-Location "C:\Users\user\Desktop\logistics-dashboard"

Write-Host "=== 1. Wrangler 로그인 ===" -ForegroundColor Cyan
npx wrangler login

Write-Host "`n=== 2. KV 네임스페이스 생성 ===" -ForegroundColor Cyan
$kvOutput = npx wrangler kv namespace create LOGISTICS_KV 2>&1
Write-Host $kvOutput

# KV ID 추출 및 wrangler.toml 자동 업데이트
$match = [regex]::Match($kvOutput, 'id\s*=\s*"([a-f0-9]+)"')
if ($match.Success) {
    $kvId = $match.Groups[1].Value
    Write-Host "KV ID: $kvId" -ForegroundColor Green
    (Get-Content wrangler.toml) -replace 'id = "PLACEHOLDER"', "id = `"$kvId`"" | Set-Content wrangler.toml
    Write-Host "wrangler.toml 업데이트 완료" -ForegroundColor Green
} else {
    Write-Host "KV ID를 자동 추출하지 못했습니다. wrangler.toml의 PLACEHOLDER를 수동으로 교체하세요." -ForegroundColor Yellow
}

Write-Host "`n=== 3. API_KEY 시크릿 설정 ===" -ForegroundColor Cyan
npx wrangler secret put API_KEY

Write-Host "`n=== 4. 배포 ===" -ForegroundColor Cyan
npx wrangler deploy

Write-Host "`n=== 5. GitHub Secrets 설정 안내 ===" -ForegroundColor Cyan
Write-Host "GitHub Actions 자동배포를 위해 아래 시크릿을 설정하세요:"
Write-Host "  Repository: https://github.com/during-ai/logistics-dashboard/settings/secrets/actions"
Write-Host "  CLOUDFLARE_API_TOKEN = (Cloudflare API Token)"

Write-Host "`n=== 완료! ===" -ForegroundColor Green
Write-Host "접속: https://logistics-dashboard.ai-during-smart.workers.dev"
