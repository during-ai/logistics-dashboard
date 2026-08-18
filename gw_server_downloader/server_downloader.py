# -*- coding: utf-8 -*-
"""그룹웨어 생산계획 상시 다운로더 (서버 컨테이너용).

· PC 전원상태와 무관하게 항상 켜진 서버에서 정해진 시각마다 그룹웨어 생산계획
  Excel을 자동 다운로드(gw_download.download_latest_plans)한다.
· 다운로드 파일은 /data/downloads 볼륨에 저장하고, HTTP로 서빙한다.
  PC측 소비자(production_plan_push.py / refresh_frozen.py 등)가 로컬 파일이
  없을 때 여기서 최신 파일을 받아 쓸 수 있다.

엔드포인트(:8510):
  GET  /health            → 상태 + 마지막 실행 결과
  GET  /manifest          → 팀별 최신 파일 목록(JSON)
  GET  /files/<파일명>     → 파일 다운로드(원본명, URL 인코딩)
  GET  /latest?team=권선   → 해당 팀 최신 파일 바이너리
  POST /trigger           → 즉시 다운로드 1회 실행

환경변수:
  DOWNLOAD_DIR   저장 경로 (기본 /data/downloads)
  DOWNLOAD_TIMES 실행 시각 CSV, KST (기본 07:20,09:00,13:00,15:00,17:00)
  PORT           HTTP 포트 (기본 8510)
  RUN_ON_START   기동 시 1회 즉시 실행 (기본 1)
"""
import os
import io
import re
import json
import time
import glob
import threading
import datetime
import traceback
from urllib.parse import unquote, quote, urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import gw_download as gw

DOWNLOAD_DIR = os.environ.get("DOWNLOAD_DIR", "/data/downloads")
PORT = int(os.environ.get("PORT", "8510"))
TIMES = [t.strip() for t in os.environ.get(
    "DOWNLOAD_TIMES", "07:20,09:00,13:00,15:00,17:00").split(",") if t.strip()]
RUN_ON_START = os.environ.get("RUN_ON_START", "1") == "1"
STATE_PATH = os.path.join(os.path.dirname(DOWNLOAD_DIR) or ".", "downloader_state.json")
TEAMS = ["권선", "사출", "전장"]

os.makedirs(DOWNLOAD_DIR, exist_ok=True)

_state = {"lastRun": None, "lastResult": None, "runs": 0}
_lock = threading.Lock()


def kst():
    return datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=9)


def log(msg):
    print(f"[{kst():%Y-%m-%d %H:%M:%S}] {msg}", flush=True)


def _save_state():
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump(_state, f, ensure_ascii=False)
    except Exception:
        pass


def run_download():
    """다운로드 1회 실행 (예외 안전)."""
    with _lock:
        started = kst()
        log("다운로드 시작")
        try:
            # gw_download는 env DOWNLOAD_DIR 를 존중하도록 패치됨
            downloaded = gw.download_latest_plans(dry_run=False)
            names = {t: os.path.basename(str(p)) for t, p in downloaded.items()}
            _state["lastResult"] = {"ok": True, "count": len(downloaded), "files": names}
            log(f"다운로드 완료: {len(downloaded)}건 {names}")
        except Exception as e:
            _state["lastResult"] = {"ok": False, "error": str(e)}
            log(f"다운로드 실패: {e}\n{traceback.format_exc()}")
        _state["lastRun"] = started.strftime("%Y-%m-%dT%H:%M:%S")
        _state["runs"] += 1
        _save_state()
        return _state["lastResult"]


def scheduler():
    """매 분 KST 시각을 확인해 TIMES 에 도달하면 다운로드. 슬롯당 하루 1회."""
    done = set()  # (date, HH:MM)
    log(f"스케줄러 시작 · 실행시각(KST)={TIMES}")
    while True:
        now = kst()
        hhmm = now.strftime("%H:%M")
        day = now.strftime("%Y-%m-%d")
        # 날짜 바뀌면 슬롯 초기화
        done = {(d, t) for (d, t) in done if d == day}
        if hhmm in TIMES and (day, hhmm) not in done:
            done.add((day, hhmm))
            log(f"스케줄 트리거 {hhmm}")
            run_download()
        time.sleep(20)


def list_files():
    """DOWNLOAD_DIR 내 xlsx/xlsm 파일 메타 목록."""
    out = []
    for f in glob.glob(os.path.join(DOWNLOAD_DIR, "*")):
        base = os.path.basename(f)
        if base.startswith("~$"):
            continue
        if not base.lower().endswith((".xlsx", ".xlsm", ".xls")):
            continue
        st = os.stat(f)
        out.append({"name": base, "size": st.st_size, "mtime": int(st.st_mtime)})
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def latest_for_team(team):
    cands = [x for x in list_files() if team in x["name"]]
    return cands[0]["name"] if cands else None


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj, ctype="application/json"):
        body = obj if isinstance(obj, (bytes, bytearray)) else json.dumps(
            obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, name):
        safe = os.path.basename(unquote(name))
        path = os.path.join(DOWNLOAD_DIR, safe)
        if not os.path.isfile(path):
            return self._send(404, {"error": "not found", "name": safe})
        with open(path, "rb") as f:
            data = f.read()
        # 헤더는 latin-1 인코딩 → 한글 파일명은 RFC5987 퍼센트 인코딩 필수
        enc_name = quote(safe)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{enc_name}")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p == "/health":
            return self._send(200, {"ok": True, "now": kst().strftime("%Y-%m-%dT%H:%M:%S"),
                                    "times": TIMES, **_state})
        if p == "/manifest":
            files = list_files()
            latest = {t: latest_for_team(t) for t in TEAMS}
            return self._send(200, {"dir": DOWNLOAD_DIR, "files": files, "latest": latest,
                                    "lastRun": _state["lastRun"], "lastResult": _state["lastResult"]})
        if p == "/latest":
            q = parse_qs(u.query)
            team = (q.get("team") or [""])[0]
            name = latest_for_team(team)
            if not name:
                return self._send(404, {"error": "no file for team", "team": team})
            return self._send_file(name)
        if p.startswith("/files/"):
            return self._send_file(p[len("/files/"):])
        return self._send(404, {"error": "unknown", "path": p})

    def do_POST(self):
        if urlparse(self.path).path == "/trigger":
            res = run_download()
            return self._send(200, {"triggered": True, "result": res})
        return self._send(404, {"error": "unknown"})

    def log_message(self, *args):
        pass  # 액세스로그 억제


def main():
    threading.Thread(target=scheduler, daemon=True).start()
    if RUN_ON_START:
        threading.Thread(target=run_download, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    log(f"HTTP 서버 시작 :{PORT}  (DOWNLOAD_DIR={DOWNLOAD_DIR})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
