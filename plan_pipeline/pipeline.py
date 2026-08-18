# -*- coding: utf-8 -*-
"""생산계획 소비자 파이프라인 (서버 컨테이너용).

PC 전원상태와 무관하게 항상 켜진 서버에서 생산계획 소비 스크립트를 정시 실행한다.
계획파일은 gw-downloader(:8510)에서 plan_sync 가 받아온다.

소비자:
  1) production_plan_push.py  → 물류(생산계획) 대시보드(Cloudflare) push
  2) 13/refresh_frozen.py     → 공정검사 frozen.json 재매칭 → GitLab push → CI 재빌드

레이아웃(형제폴더 의존 유지):
  /app/09/production_plan_push.py, plan_sync.py   (이미지에 포함)
  /app/BOM_Project/…                              (사출 수지매핑용, 이미지에 포함)
  /app/13/                                         (GitLab inspection 저장소 클론 — entrypoint)

환경변수:
  RUN_TIMES     실행 시각 CSV, KST (기본 07:35,15:20)
  RUN_ON_START  기동 시 1회 즉시 실행 (기본 1)
  DO_PLAN_PUSH  production_plan_push 실행 (기본 1)
  DO_INSPECTION refresh_frozen 실행 (기본 1)
  INSP_DIR      inspection 저장소 경로 (기본 /app/13)
"""
import os
import time
import subprocess
import datetime

NINE_DIR = "/app/09"
INSP_DIR = os.environ.get("INSP_DIR", "/app/13")
RUN_TIMES = [t.strip() for t in os.environ.get("RUN_TIMES", "07:35,15:20").split(",") if t.strip()]
RUN_ON_START = os.environ.get("RUN_ON_START", "1") == "1"
DO_PLAN_PUSH = os.environ.get("DO_PLAN_PUSH", "1") == "1"
DO_INSPECTION = os.environ.get("DO_INSPECTION", "1") == "1"


def kst():
    return datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)


def log(msg):
    print(f"[{kst():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def run(cmd, cwd, label):
    log(f"▶ {label} 시작: {' '.join(cmd)} (cwd={cwd})")
    try:
        r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=600)
        out = (r.stdout or "").strip()
        err = (r.stderr or "").strip()
        tail = "\n".join((out + ("\n" + err if err else "")).splitlines()[-15:])
        log(f"  {label} exit={r.returncode}\n{tail}")
        return r.returncode
    except Exception as e:
        log(f"  {label} 예외: {e}")
        return 1


def run_plan_push():
    if not DO_PLAN_PUSH:
        return
    run(["python", "production_plan_push.py"], NINE_DIR, "생산계획 push(Cloudflare)")


def run_inspection():
    if not DO_INSPECTION:
        return
    # 저장소 최신화(다른 곳의 push와 충돌 방지) 후 재매칭·push
    run(["git", "pull", "--ff-only"], INSP_DIR, "inspection git pull")
    run(["python", "refresh_frozen.py"], INSP_DIR, "공정검사 frozen 재매칭+push")


def run_all(reason):
    log(f"===== 파이프라인 실행 ({reason}) =====")
    run_plan_push()
    run_inspection()
    log("===== 파이프라인 종료 =====")


def main():
    log(f"파이프라인 스케줄러 시작 · 시각(KST)={RUN_TIMES} · plan_push={DO_PLAN_PUSH} inspection={DO_INSPECTION}")
    if RUN_ON_START:
        run_all("기동")
    done = set()
    while True:
        now = kst()
        hhmm = now.strftime("%H:%M")
        day = now.strftime("%Y-%m-%d")
        done = {(d, t) for (d, t) in done if d == day}
        if hhmm in RUN_TIMES and (day, hhmm) not in done:
            done.add((day, hhmm))
            run_all(f"스케줄 {hhmm}")
        time.sleep(20)


if __name__ == "__main__":
    main()
