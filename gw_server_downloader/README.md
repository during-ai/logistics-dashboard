# gw-downloader — 그룹웨어 생산계획 상시 다운로더 (서버)

PC 전원상태와 무관하게 **항상 켜진 서버(192.168.20.250)**에서 그룹웨어 생산계획
Excel을 매일 자동 다운로드한다. 헤드리스 Chromium+Selenium으로 로그인 후 REST로
팀별(권선/사출/전장) 최신 첨부를 받아 Docker 볼륨(`gw-downloads`)에 저장하고,
:8510 HTTP로 서빙한다. PC측 소비자는 로컬에 최신본이 없을 때 여기서 받아 쓴다
(`plan_sync.py`).

## 구성
- `gw_download.py` — GW 로그인·첨부 다운로드 (env `CHROME_BIN`/`CHROMEDRIVER`/`DOWNLOAD_DIR` 지원)
- `server_downloader.py` — 스케줄러(기본 07:20,09:00,13:00,15:00,17:00 KST) + HTTP 서빙
- `Dockerfile` — python:3.12-slim + chromium + chromium-driver
- `gw_config.json` — **자격증명(비커밋).** `gw_config.sample.json` 참고해 서버에서 직접 생성

## 엔드포인트 (:8510)
- `GET /health` — 상태 + 마지막 실행 결과
- `GET /manifest` — 팀별 최신 파일 목록(JSON)
- `GET /latest?team=권선` — 해당 팀 최신 파일 바이너리
- `GET /files/<파일명>` — 파일 다운로드
- `POST /trigger` — 즉시 다운로드 1회

## 배포 (서버에서)
```bash
cd ~/gw_server_downloader           # Dockerfile·스크립트 위치
# gw_config.json 을 gw_config.sample.json 기준으로 생성(비밀번호 포함)
docker build -t gw-downloader .
docker volume create gw-downloads
docker rm -f gw-downloader 2>/dev/null
docker run -d --name gw-downloader --shm-size=1g \
  -v gw-downloads:/data/downloads -p 8510:8510 \
  --restart unless-stopped gw-downloader
```

## 점검
```bash
curl -s http://192.168.20.250:8510/health
curl -s http://192.168.20.250:8510/manifest
docker logs gw-downloader --tail 20
```
