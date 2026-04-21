#!/bin/bash
# ============================================================
# 연차관리 앱 Netlify 배포 스크립트
# 2026-04-23 크레딧 리셋 후 자동 실행용
# ============================================================

set -e

APP_DIR="/Users/salgi/eyepop-leave-management"
SITE_NAME="eyepop-leave-management"
LOG="/tmp/eyepop-leave-deploy.log"
SECRET_FILE="/Users/salgi/.secrets/eyepop-leave.env"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 배포 시작" | tee -a "$LOG"

cd "$APP_DIR"

# 1. 최신 코드 풀
echo "  → git pull" | tee -a "$LOG"
git pull origin main 2>&1 | tail -5 | tee -a "$LOG"

# 2. Netlify 사이트 생성 (처음 1회만)
if ! netlify sites:list 2>/dev/null | grep -q "$SITE_NAME "; then
  echo "  → Netlify 사이트 생성: $SITE_NAME" | tee -a "$LOG"
  netlify sites:create --name "$SITE_NAME" --account-slug EYEPOP 2>&1 | tee -a "$LOG"
fi

# 3. 환경변수 설정
if [ -f "$SECRET_FILE" ]; then
  source "$SECRET_FILE"
  echo "  → GIST_TOKEN 환경변수 설정" | tee -a "$LOG"
  netlify env:set GIST_TOKEN "$GIST_TOKEN" --scope functions --filter "$SITE_NAME" 2>&1 | tail -3 | tee -a "$LOG"
fi

# ADMIN_KEY 자동 생성 (이미 설정되어 있으면 skip)
if ! netlify env:get ADMIN_KEY --filter "$SITE_NAME" 2>/dev/null | grep -q "^[a-f0-9]"; then
  ADMIN_KEY=$(openssl rand -hex 16)
  echo "  → ADMIN_KEY 자동 생성" | tee -a "$LOG"
  netlify env:set ADMIN_KEY "$ADMIN_KEY" --scope functions --filter "$SITE_NAME" 2>&1 | tail -3 | tee -a "$LOG"
fi

# 4. 배포
echo "  → Netlify 배포" | tee -a "$LOG"
netlify deploy --prod --dir "$APP_DIR" --site "$SITE_NAME" 2>&1 | tee -a "$LOG"

# 5. Gist 초기화 (최초 1회)
if ! netlify env:get GIST_ID --filter "$SITE_NAME" 2>/dev/null | grep -q "."; then
  echo "  → Gist 최초 생성" | tee -a "$LOG"
  GIST_ID=$(curl -s "https://$SITE_NAME.netlify.app/.netlify/functions/init-gist" | grep -oE '"gistId":"[^"]+"' | cut -d'"' -f4)
  if [ -n "$GIST_ID" ]; then
    echo "  → GIST_ID: $GIST_ID" | tee -a "$LOG"
    netlify env:set GIST_ID "$GIST_ID" --scope functions --filter "$SITE_NAME" 2>&1 | tail -3 | tee -a "$LOG"
    # 환경변수 반영을 위해 재배포
    netlify deploy --prod --dir "$APP_DIR" --site "$SITE_NAME" 2>&1 | tail -5 | tee -a "$LOG"
  fi
fi

# 6. 배포 성공 알림 (텔레그램)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "https://$SITE_NAME.netlify.app/")
BOT_TOKEN="***REDACTED-OLD-TOKEN***"
CHAT_ID="8152882784"
if [ "$STATUS" = "200" ]; then
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=✅ 연차관리 앱 자동 배포 완료 ($(date '+%Y-%m-%d %H:%M'))
URL: https://${SITE_NAME}.netlify.app" > /dev/null
  echo "  → 배포 성공 ✅ (HTTP 200)" | tee -a "$LOG"
else
  curl -s -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${CHAT_ID}" \
    --data-urlencode "text=❌ 연차관리 앱 배포 실패 (HTTP ${STATUS})
로그: ${LOG}" > /dev/null
  echo "  → 배포 실패 ❌ (HTTP $STATUS)" | tee -a "$LOG"
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] 배포 완료" | tee -a "$LOG"
