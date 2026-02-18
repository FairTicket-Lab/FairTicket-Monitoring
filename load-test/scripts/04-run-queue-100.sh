#!/usr/bin/env bash
# 대기열 폭주 시나리오 (한 흐름: enter → status 반복 until READY)
# k6 기반 부하 테스트 - TPS 100용
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

# 변수는 config.env에서 로드됨 (TPS 100 전용 변수 사용)
BASE_URL="${BASE_URL}"
SCHEDULE_ID="${SCHEDULE_ID}"
CONCERT_ID="${CONCERT_ID}"
K6_VUS_100="${K6_VUS_100:-100}"
K6_DURATION_100="${K6_DURATION_100:-60s}"
TARGET_TPS_100="${TARGET_TPS_100:-100}"
STATUS_POLL_MS_100="${STATUS_POLL_MS_100:-1000}"
HEARTBEAT_INTERVAL_MS="${HEARTBEAT_INTERVAL_MS:-20000}"
SCENARIO_DATA="$LOAD_TEST_DIR/data/queue"
TOKEN_JSON_PATH="$SCENARIO_DATA/tokens.json"

# 스케줄 오픈 상태 확인 (GET /api/v1/concerts/{id} 의 dates[].available)
check_schedule_open() {
  local res code body
  res=$(curl -sS -w "\n%{http_code}" --connect-timeout 3 "$BASE_URL/api/v1/concerts/$CONCERT_ID" 2>/dev/null) || return 1
  code="${res##*$'\n'}"
  body="${res%$'\n'*}"
  if [ "$code" != "200" ]; then
    echo "  → 공연 조회 실패 (HTTP $code). 서버가 실행 중인지 확인: $BASE_URL" >&2
    return 1
  fi
  if command -v jq >/dev/null 2>&1; then
    local avail
    avail=$(echo "$body" | jq -r --arg sid "$SCHEDULE_ID" '.dates[] | select(.id == ($sid | tonumber)) | .available' 2>/dev/null)
    [ "$avail" = "true" ]
  else
    local avail
    avail=$(echo "$body" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    sid = int(\"$SCHEDULE_ID\")
    ok = any(s.get(\"id\") == sid and s.get(\"available\") for s in d.get(\"dates\", []))
    print(ok)
except Exception:
    print(False)
" 2>/dev/null)
    [ "$avail" = "True" ]
  fi
}

echo "=== 스케줄 오픈 상태 확인 (scheduleId=$SCHEDULE_ID) ==="
if ! check_schedule_open; then
  echo "스케줄이 아직 오픈되지 않았습니다. seed-db.sh 실행 후 재확인합니다."
  "$SCRIPT_DIR/01-seed-db.sh" || exit 1
  sleep 2
  if ! check_schedule_open; then
    echo "오류: 시드 적용 후에도 스케줄이 OPEN 상태가 아닙니다. DB/서버를 확인하세요."
    exit 1
  fi
  echo "스케줄이 오픈된 상태로 설정되었습니다."
else
  echo "스케줄이 이미 오픈된 상태입니다. 시나리오를 진행합니다."
fi
echo ""

echo "=== 토큰 재발급 (실행 시마다 새로 발급) ==="
NUM_USERS="$K6_VUS_100" "$SCRIPT_DIR/02-prepare-tokens.sh"
echo ""

echo "=== 환경 검증 (서버 연결, 스케줄 오픈, 토큰 유효성) ==="
"$SCRIPT_DIR/03-verify-env.sh"
echo ""

echo "=== 대기열 시나리오: enter → status (WAITING 대기) → READY 흐름 ==="
echo "k6 실행: VUs=$K6_VUS_100, Duration=$K6_DURATION_100, TPS=$TARGET_TPS_100"
echo ""

# 토큰 파일 존재 확인
if [ ! -f "$TOKEN_JSON_PATH" ]; then
  echo "오류: 토큰 파일이 없습니다: $TOKEN_JSON_PATH"
  echo "먼저 ./scripts/02-prepare-tokens.sh를 실행하세요."
  exit 1
fi

# k6 명령어 실행
# 현재 작업 디렉토리는 load-test/ (line 7에서 이동)
# k6 스크립트는 scripts/queue-flow.js를 상대 경로로 참조
# TOKEN_JSON_PATH는 절대 경로로 전달되어 k6의 open() 함수에서 정확히 로드됨
# k6 스크립트는 K6_VUS, TARGET_TPS 등의 환경 변수명을 기대하므로 매핑하여 전달
k6 run \
  --env BASE_URL="$BASE_URL" \
  --env SCHEDULE_ID="$SCHEDULE_ID" \
  --env TARGET_TPS="$TARGET_TPS_100" \
  --env STATUS_POLL_MS="$STATUS_POLL_MS_100" \
  --env HEARTBEAT_INTERVAL_MS="$HEARTBEAT_INTERVAL_MS" \
  --env VUS="$K6_VUS_100" \
  --env DURATION="$K6_DURATION_100" \
  --env TOKEN_JSON_PATH="$TOKEN_JSON_PATH" \
  scripts/queue-flow.js
