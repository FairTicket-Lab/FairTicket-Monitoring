#!/usr/bin/env bash
# 부하 테스트 전 환경 검증: 스케줄 오픈 여부, 토큰 유효성(1건 curl로 실제 HTTP 코드 확인)
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOAD_TEST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$LOAD_TEST_DIR"

if [ -f "data/config.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "data/config.env"
  set +a
fi

# 변수는 config.env에서 로드됨 (기본값 없음)
BASE_URL="${BASE_URL}"
SCHEDULE_ID="${SCHEDULE_ID}"
CONCERT_ID="${CONCERT_ID}"
SCENARIO_DATA="$LOAD_TEST_DIR/data/queue"
TOKEN_FILE="$SCENARIO_DATA/tokens.txt"

echo "=== 1) 서버 연결 확인 ($BASE_URL) ==="
if ! curl -sS -o /dev/null -w "%{http_code}" --connect-timeout 3 "$BASE_URL/actuator/health" | grep -q 200; then
  echo "  실패: 서버에 연결할 수 없습니다. docker compose up 또는 서버 기동 후 다시 시도하세요."
  exit 1
fi
echo "  OK"
echo ""

echo "=== 2) 스케줄 오픈 여부 (CONCERT_ID=$CONCERT_ID, SCHEDULE_ID=$SCHEDULE_ID) ==="
RES=$(curl -sS -w "\n%{http_code}" "$BASE_URL/api/v1/concerts/$CONCERT_ID")
CODE="${RES##*$'\n'}"
BODY="${RES%$'\n'*}"
if [ "$CODE" != "200" ]; then
  echo "  실패: 공연 조회 HTTP $CODE"
  exit 1
fi
if command -v jq >/dev/null 2>&1; then
  AVAIL=$(echo "$BODY" | jq -r --arg sid "$SCHEDULE_ID" '.dates[] | select(.id == ($sid | tonumber)) | .available' 2>/dev/null)
else
  AVAIL=$(echo "$BODY" | python3 -c "
import sys, json
d = json.load(sys.stdin)
sid = int(\"$SCHEDULE_ID\")
ok = any(s.get(\"id\") == sid and s.get(\"available\") for s in d.get(\"dates\", []))
print('true' if ok else 'false')
" 2>/dev/null)
fi
if [ "$AVAIL" != "true" ]; then
  echo "  실패: 해당 회차(scheduleId=$SCHEDULE_ID)가 오픈 상태가 아닙니다. ./scripts/01-seed-db.sh 실행 후 재확인하세요."
  exit 1
fi
echo "  OK (해당 회차 오픈)"
echo ""

echo "=== 3) 토큰 1건으로 Queue Enter 실제 호출 (HTTP 코드 확인) ==="
if [ ! -f "$TOKEN_FILE" ]; then
  echo "  실패: $TOKEN_FILE 없음. ./scripts/02-prepare-tokens.sh 실행 후 다시 시도하세요."
  exit 1
fi
FIRST_LINE=$(head -n 1 "$TOKEN_FILE")
TOKEN=$(echo "$FIRST_LINE" | cut -d',' -f2-)
USER_ID=$(echo "$FIRST_LINE" | cut -d',' -f1)
RES=$(curl -sS -w "\n%{http_code}" -X POST "$BASE_URL/api/v1/queue/$SCHEDULE_ID/enter" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "")
HTTP_CODE="${RES##*$'\n'}"
BODY="${RES%$'\n'*}"
echo "  HTTP 상태: $HTTP_CODE"
echo "  응답 본문: ${BODY:0:200}"
if [ "$HTTP_CODE" = "200" ]; then
  echo "  OK — 토큰 유효, 2xx 기대 가능."
elif [ "$HTTP_CODE" = "401" ]; then
  echo ""
  echo "  원인: 401 Unauthorized — 토큰 만료 또는 서버 JWT secret 불일치."
  echo "  조치: 테스트할 서버(BASE_URL)가 떠 있는 상태에서 아래를 다시 실행하세요."
  echo "        ./scripts/02-prepare-tokens.sh"
  echo "  (서버 jwt.expiration 기본 1시간이므로, 1시간마다 재발급 필요)"
  exit 1
elif [ "$HTTP_CODE" = "429" ]; then
  echo "  원인: 429 Too Many Requests — Rate Limit. 잠시 후 다시 시도하거나 서버 MAX_REQUESTS_PER_MINUTE 확인."
  exit 1
else
  echo "  기타 4xx/5xx — 스케줄/콘서트 ID 또는 서버 로직 확인 필요."
  exit 1
fi
echo ""
echo "=== 검증 완료: 시나리오 실행 가능 상태입니다. ==="
