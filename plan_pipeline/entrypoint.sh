#!/bin/sh
set -e

INSP_DIR="${INSP_DIR:-/app/13}"

# git 사용자(커밋용)
git config --global user.email "${GIT_EMAIL:-pipeline@during.ai}"
git config --global user.name "${GIT_NAME:-plan-pipeline}"
git config --global --add safe.directory "$INSP_DIR"

# inspection 저장소 준비: 없으면 클론, 있으면 최신화
if [ -n "$GITLAB_URL" ]; then
  if [ -d "$INSP_DIR/.git" ]; then
    echo "[entrypoint] inspection 저장소 존재 → fetch/reset"
    git -C "$INSP_DIR" remote set-url origin "$GITLAB_URL"
    git -C "$INSP_DIR" fetch --depth 1 origin main || true
    git -C "$INSP_DIR" reset --hard origin/main || true
  else
    echo "[entrypoint] inspection 저장소 클론"
    git clone "$GITLAB_URL" "$INSP_DIR"
  fi
else
  echo "[entrypoint] 경고: GITLAB_URL 미설정 → inspection 비활성화"
  export DO_INSPECTION=0
fi

exec python /app/pipeline.py
