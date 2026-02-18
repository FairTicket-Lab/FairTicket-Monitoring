#!/usr/bin/env bash
# FairTicket-BE 부하 테스트용 JWT 토큰 생성 및 JSON 형식 변환
# N명 signup → login 후 data/queue/tokens.txt 생성 → tokens.json 변환 (k6용)
#
# 사용법:
#   ./prepare-tokens.sh              # 토큰 생성 + JSON 변환
#   ./prepare-tokens.sh --skip-gen    # tokens.txt가 이미 있으면 JSON 변환만 수행

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOAD_TEST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# config.env 로드
if [ -f "$LOAD_TEST_DIR/data/config.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$LOAD_TEST_DIR/data/config.env"
  set +a
fi

# 변수는 config.env에서 로드됨 (기본값 없음)
BASE_URL="${BASE_URL}"
NUM_USERS="${NUM_USERS}"
DATA_DIR="$LOAD_TEST_DIR/data/queue"
SCENARIO="queue"
TOKENS_FILE="$LOAD_TEST_DIR/data/$SCENARIO/tokens.txt"
OUT_FILE_JSON="$LOAD_TEST_DIR/data/$SCENARIO/tokens.json"

# 옵션 파싱
SKIP_TOKEN_GEN=false
if [ "$1" = "--skip-gen" ]; then
  SKIP_TOKEN_GEN=true
fi

# 토큰 유효성 검증 함수 (401이 아니면 유효)
validate_token() {
  local token="$1"
  local schedule_id="${SCHEDULE_ID}"
  local http_code
  http_code=$(curl -sS -w "%{http_code}" -o /dev/null -X POST "$BASE_URL/api/v1/queue/$schedule_id/enter" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $token" \
    -d "" \
    --connect-timeout 3 --max-time 5 2>/dev/null || echo "000")
  [ "$http_code" != "401" ] && [ "$http_code" != "000" ]
}

# 1단계: 토큰 생성 (유효한 토큰은 유지하고 부족한 개수만 발급)
TMP_TOKENS=$(mktemp)
trap 'rm -f "$TMP_TOKENS"' EXIT

VALID_COUNT=0
if [ -f "$TOKENS_FILE" ]; then
  echo "=== 기존 토큰 유효성 검증 ==="
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    token=$(echo "$line" | cut -d',' -f2-)
    if validate_token "$token"; then
      echo "$line" >> "$TMP_TOKENS"
      VALID_COUNT=$((VALID_COUNT + 1))
    fi
  done < "$TOKENS_FILE"
  echo "유효한 토큰: ${VALID_COUNT}개"
fi

NEEDED=$((NUM_USERS - VALID_COUNT))
if [ "$NEEDED" -gt 0 ]; then
  echo "=== 부족한 토큰 발급 (${NEEDED}개) ==="
  echo "BASE_URL=$BASE_URL, NUM_USERS=$NUM_USERS, 기존 유효 토큰=$VALID_COUNT, 추가 필요=$NEEDED"
  
  # 기존 토큰 파일의 총 라인 수를 기반으로 시작 번호 결정
  # (tokens.txt에는 이메일이 없으므로 라인 수로 추정)
  if [ -f "$TOKENS_FILE" ]; then
    TOTAL_LINES=$(wc -l < "$TOKENS_FILE" | tr -d ' ')
    START_NUM=$((TOTAL_LINES + 1))
  else
    START_NUM=1
  fi
  END_NUM=$((START_NUM + NEEDED - 1))
  
  for i in $(seq "$START_NUM" "$END_NUM"); do
    email="loaduser${i}@test.com"
    password="Password1!"
    # signup (이미 있으면 무시)
    curl -s -X POST "$BASE_URL/api/v1/auth/signup" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$email\",\"password\":\"$password\",\"name\":\"User $i\"}" \
      > /dev/null || true
    # login
    res=$(curl -s -X POST "$BASE_URL/api/v1/auth/login" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"$email\",\"password\":\"$password\"}")
    if command -v jq >/dev/null 2>&1; then
      userId=$(echo "$res" | jq -r '.userId // empty')
      token=$(echo "$res" | jq -r '.token // empty')
    else
      userId=$(echo "$res" | sed -n 's/.*"userId": *\([0-9]*\).*/\1/p')
      token=$(echo "$res" | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p')
    fi
    if [ -n "$userId" ] && [ -n "$token" ]; then
      echo "$userId,$token" >> "$TMP_TOKENS"
    else
      echo "WARN: login failed for $email" >&2
    fi
  done
else
  echo "=== 추가 토큰 불필요 (유효한 토큰이 충분함: $VALID_COUNT/$NUM_USERS) ==="
fi

count=$(wc -l < "$TMP_TOKENS" | tr -d ' ')
mkdir -p "$DATA_DIR"
cp "$TMP_TOKENS" "$TOKENS_FILE"
echo "Total tokens: $count (유효한 기존 토큰: $VALID_COUNT, 새로 발급: $((count - VALID_COUNT)))"

# 2단계: JSON 형식 변환 (k6용)
echo "=== JSON 형식 변환 ==="
if [ ! -f "$TOKENS_FILE" ]; then
  echo "Error: $TOKENS_FILE not found" >&2
  exit 1
fi
echo "{" > "$OUT_FILE_JSON"
echo '  "tokens": [' >> "$OUT_FILE_JSON"
first=true
while IFS= read -r line; do
  [ -z "$line" ] && continue
  userId=$(echo "$line" | cut -d',' -f1)
  token=$(echo "$line" | cut -d',' -f2-)
  if [ "$first" = true ]; then first=false; else echo "," >> "$OUT_FILE_JSON"; fi
  printf '    {"userId": %s, "token": "%s"}' "$userId" "$token" >> "$OUT_FILE_JSON"
done < <(sed 's/,\s*/,/g' "$TOKENS_FILE")
echo "" >> "$OUT_FILE_JSON"
echo "  ]" >> "$OUT_FILE_JSON"
echo "}" >> "$OUT_FILE_JSON"

echo "Generated $OUT_FILE_JSON ($(wc -l < "$TOKENS_FILE") users)"
echo "Done."
