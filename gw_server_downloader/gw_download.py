# -*- coding: utf-8 -*-
"""
그룹웨어 생산계획 Excel 자동 다운로드

게시판(생산계획[주간])에서 팀별 최신 Excel 첨부파일을 다운로드하여
지정 폴더에 저장한다.

실행: python gw_download.py
테스트: python gw_download.py --dry-run
"""

import json
import sys
import os
import time
import argparse
from datetime import datetime, date
from pathlib import Path

import requests
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.chrome.options import Options

sys.stdout.reconfigure(encoding="utf-8")

SCRIPT_DIR = Path(__file__).parent
CONFIG_PATH = SCRIPT_DIR / "gw_config.json"


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")


def load_config():
    return json.load(open(CONFIG_PATH, encoding="utf-8"))


def gw_login(cfg):
    """Selenium으로 로그인 후 requests.Session 반환 (쿠키 이전)"""
    gw_url = cfg["gw_url"]

    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--window-size=1400,900")
    opts.add_argument("--log-level=3")
    opts.add_experimental_option("excludeSwitches", ["enable-logging"])
    # 컨테이너 환경: Chrome/Chromedriver 경로를 env로 지정(설정 없으면 PC 기본 동작)
    chrome_bin = os.environ.get("CHROME_BIN")
    if chrome_bin:
        opts.binary_location = chrome_bin
    driver_path = os.environ.get("CHROMEDRIVER")
    if driver_path:
        from selenium.webdriver.chrome.service import Service
        driver = webdriver.Chrome(service=Service(driver_path), options=opts)
    else:
        driver = webdriver.Chrome(options=opts)

    try:
        driver.get(gw_url + "/home.do")
        wait = WebDriverWait(driver, 15)
        wait.until(EC.presence_of_element_located((By.ID, "loginId"))).send_keys(
            cfg["login_id"]
        )
        driver.find_element(By.ID, "password").send_keys(cfg["login_pw"])
        driver.find_element(By.ID, "LoginTrigger").click()
        time.sleep(4)

        session = requests.Session()
        for cookie in driver.get_cookies():
            session.cookies.set(cookie["name"], cookie["value"])
        session.headers.update(
            {
                "Referer": gw_url + "/comContent.do",
                "X-Requested-With": "XMLHttpRequest",
                "Accept": "application/json, text/plain, */*",
                "User-Agent": driver.execute_script("return navigator.userAgent"),
            }
        )
        log("GW 로그인 성공")
        return session
    finally:
        driver.quit()


def fetch_posts(session, cfg, count=20):
    """게시판에서 최근 게시글 목록 조회"""
    gw_url = cfg["gw_url"]
    board_id = cfg["board_id"]
    resp = session.get(
        f"{gw_url}/rest/bbs/{board_id}/posts",
        params={"count": str(count)},
        timeout=15,
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get("data", [])


def fetch_attachments(session, cfg, post_id):
    """게시글의 첨부파일 목록 조회"""
    gw_url = cfg["gw_url"]
    url = f"{gw_url}/rest/common/file/getAttachedFileList/{post_id}/BBS_ATTACH"
    resp = session.get(url, timeout=15)
    if resp.status_code != 200:
        return []
    try:
        return resp.json()
    except Exception:
        return []


def download_file(session, cfg, post_id, file_id, display_name, save_dir):
    """첨부파일 다운로드"""
    gw_url = cfg["gw_url"]
    url = f"{gw_url}/rest/common/file/download/{post_id}/{file_id}"
    resp = session.get(url, timeout=60, stream=True)
    resp.raise_for_status()

    save_path = Path(save_dir) / display_name
    with open(save_path, "wb") as f:
        for chunk in resp.iter_content(8192):
            f.write(chunk)
    return save_path


def find_latest_per_team(posts, teams):
    """팀별 최신 게시글 1개씩 선별 (attachCount > 0)"""
    result = {}
    for team in teams:
        for post in posts:
            title = post.get("postTitle", "")
            ac = post.get("attachCount", 0) or 0
            if team in title and ac > 0:
                result[team] = post
                break
    return result


def download_latest_plans(dry_run=False):
    """팀별 최신 생산계획 Excel 다운로드. 다운로드된 파일 경로 dict 반환."""
    cfg = load_config()
    teams = cfg.get("teams", ["사출", "권선", "전장"])
    # 컨테이너에서는 env DOWNLOAD_DIR 우선(설정의 Windows 경로 무시)
    download_dir = os.environ.get("DOWNLOAD_DIR") or cfg.get("download_dir", str(SCRIPT_DIR / "downloads"))
    Path(download_dir).mkdir(parents=True, exist_ok=True)

    session = gw_login(cfg)

    # 게시글 목록 (최근 20건이면 팀별 최신 포함)
    posts = fetch_posts(session, cfg, count=20)
    log(f"게시글 {len(posts)}건 조회")

    team_posts = find_latest_per_team(posts, teams)
    downloaded = {}

    for team, post in team_posts.items():
        title = post.get("postTitle", "")
        pid = post.get("postId", "")
        log(f"[{team}] {title}")

        if dry_run:
            log(f"  (dry-run) 다운로드 생략")
            continue

        attachments = fetch_attachments(session, cfg, pid)
        for att in attachments:
            fname = att.get("displayName", "")
            fid = att.get("fileId", "")
            fsize = att.get("fileSize", 0)

            if not fname.lower().endswith((".xlsx", ".xlsm", ".xls")):
                continue

            log(f"  다운로드: {fname} ({fsize / 1024 / 1024:.1f}MB)")
            save_path = download_file(session, cfg, pid, fid, fname, download_dir)
            actual_size = save_path.stat().st_size
            log(f"  저장 완료: {save_path} ({actual_size / 1024 / 1024:.1f}MB)")
            downloaded[team] = save_path

    missing = [t for t in teams if t not in team_posts]
    if missing:
        log(f"미발견 팀: {', '.join(missing)}")

    return downloaded


def main():
    parser = argparse.ArgumentParser(description="그룹웨어 생산계획 Excel 자동 다운로드")
    parser.add_argument("--dry-run", action="store_true", help="다운로드하지 않고 목록만 확인")
    args = parser.parse_args()

    log("===== 그룹웨어 생산계획 다운로드 시작 =====")
    downloaded = download_latest_plans(dry_run=args.dry_run)
    log(f"===== 다운로드 완료: {len(downloaded)}건 =====")
    for team, path in downloaded.items():
        log(f"  [{team}] {path}")


if __name__ == "__main__":
    main()
