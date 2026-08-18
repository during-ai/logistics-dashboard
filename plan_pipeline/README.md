# plan-pipeline — 생산계획 소비자 서버 파이프라인

PC 전원상태와 무관하게 **항상 켜진 서버(192.168.20.250)**에서 생산계획 소비 스크립트를
정시 실행한다. 계획파일은 `gw-downloader`(:8510)에서 `plan_sync`로 받아온다.

## 소비자
1. **production_plan_push.py** (09) → 물류(생산계획) 대시보드(Cloudflare) push
2. **13/refresh_frozen.py** → 공정검사 frozen.json 재매칭 → GitLab push → CI 재빌드

## 구성 / 레이아웃(형제폴더 의존 유지)
- `/app/09/` production_plan_push.py, plan_sync.py — **이미지 포함**
- `/app/BOM_Project/` bom.py, utils.py, resin_spec.xlsx, BOM_DATA.xlsx — 사출 수지매핑용(**이미지 포함**)
- `/app/13/` — GitLab `inspection-dashboard` 저장소 **클론(entrypoint, 매 기동 시 fetch+reset)**
- `pipeline.py` — 스케줄러(기본 07:35, 15:20 KST)

## 네트워크
`--network host` 필수. 컨테이너가 호스트 서비스(gw-downloader :8510, GitLab :80)에 접근해야 함.

## 자격증명 (이미지에 넣지 않음)
- `GITLAB_URL` (env): 토큰 임베드된 inspection 저장소 URL. **커밋 금지**, `docker run -e`로만 주입.
- Cloudflare API 키는 기존 스크립트에 내장(변경 없음).

## 배포 (서버에서)
```bash
cd ~/plan_pipeline                     # Dockerfile·소스 위치
docker build -t plan-pipeline .
docker rm -f plan-pipeline 2>/dev/null
docker run -d --name plan-pipeline --network host --restart unless-stopped \
  -e GITLAB_URL='http://root:<PAT>@192.168.20.250/root/inspection-dashboard.git' \
  -e RUN_TIMES='07:35,15:20' -e RUN_ON_START=0 \
  plan-pipeline
```

## 점검
```bash
docker logs plan-pipeline --tail 30
# 즉시 1회 실행(테스트): RUN_ON_START=1 로 재기동하거나
docker exec plan-pipeline python /app/pipeline.py   # (스케줄러 재시작)
```

## PC측 정리
- `InspectionFrozenPush`(07:40) 비활성화됨 — 서버가 대체.
- `ProductionPlanMorning`(07:35)은 관리자권한 필요로 미변경. git 없이 Cloudflare 멱등 push라
  이중 실행돼도 무해(백업). 필요 시 관리자 PowerShell에서 `schtasks /Change /TN ProductionPlanMorning /DISABLE`.
