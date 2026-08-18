# -*- coding: utf-8 -*-
"""서버 생산계획 다운로더(gw-downloader, :8510)에서 최신 계획파일을 로컬로 동기화.

PC가 꺼져 있어도 서버(192.168.20.250)가 매일 생산계획을 받아두므로, PC측 소비자
(production_plan_push.py / inspection refresh_frozen.py 등)는 로컬에 최신 파일이
없을 때 여기서 받아와 쓴다. 서버가 안 잡히면 조용히 넘어가 기존 로컬 동작 유지.
"""
import os
import glob
import json
import urllib.parse
import urllib.request

SERVER = os.environ.get("PLAN_SERVER", "http://192.168.20.250:8510")
LOCAL_DIR = os.path.expanduser("~/Documents/HalIlApp/downloads")
TEAMS = ["권선", "사출", "전장"]


def _get_json(url, timeout=8):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def sync_from_server(teams=TEAMS, local_dir=LOCAL_DIR, verbose=False):
    """서버 매니페스트의 팀별 최신 파일이 로컬에 없으면 내려받는다.

    Returns: 새로 받은 파일 경로 리스트 (없으면 빈 리스트).
    """
    os.makedirs(local_dir, exist_ok=True)
    fetched = []
    try:
        man = _get_json(f"{SERVER}/manifest")
    except Exception as e:
        if verbose:
            print(f"[plan_sync] 서버 매니페스트 조회 실패(로컬 사용): {e}")
        return fetched

    latest = man.get("latest", {})
    have = {os.path.basename(f) for f in glob.glob(os.path.join(local_dir, "*"))}
    for team in teams:
        name = latest.get(team)
        if not name:
            continue
        if name in have:
            continue  # 이미 로컬에 있음
        try:
            url = f"{SERVER}/latest?team={urllib.parse.quote(team)}"
            dest = os.path.join(local_dir, name)
            tmp = dest + ".part"
            with urllib.request.urlopen(url, timeout=60) as r, open(tmp, "wb") as f:
                while True:
                    chunk = r.read(8192)
                    if not chunk:
                        break
                    f.write(chunk)
            os.replace(tmp, dest)
            fetched.append(dest)
            if verbose:
                print(f"[plan_sync] 서버에서 받음: {name}")
        except Exception as e:
            if verbose:
                print(f"[plan_sync] {team} 다운로드 실패: {e}")
    return fetched


if __name__ == "__main__":
    got = sync_from_server(verbose=True)
    print(f"동기화 완료: {len(got)}건")
    for p in got:
        print("  ", p)
