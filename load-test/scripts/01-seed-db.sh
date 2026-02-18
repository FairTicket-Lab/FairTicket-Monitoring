#!/usr/bin/env bash
# 부하 테스트 전 DB 시드: 스케줄을 "이미 오픈" 상태로 변경 (2xx 응답을 위해)
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOAD_TEST_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SQL_FILE="$LOAD_TEST_DIR/data/seed-schedule.sql"

# Docker Postgres (FairTicket-BE docker-compose)
if docker exec fairticket-postgres pg_isready -U fairticket -d fairticket >/dev/null 2>&1; then
  echo "Applying seed via Docker (fairticket-postgres)..."
  docker exec -i fairticket-postgres psql -U fairticket -d fairticket < "$SQL_FILE"
  echo "Done. Schedules 1,2,3 are now OPEN with ticket_open_at in the past."
  exit 0
fi

# 로컬 psql
if command -v psql >/dev/null 2>&1; then
  echo "Applying seed via psql (localhost:5433)..."
  export PGPASSWORD="${PGPASSWORD:-fairticket123}"
  psql -h localhost -p 5433 -U fairticket -d fairticket -f "$SQL_FILE" 2>/dev/null || {
    echo "Tip: If using Docker, run 'docker compose up -d' in FairTicket-BE first, then run this script again."
    exit 1
  }
  echo "Done. Schedules 1,2,3 are now OPEN with ticket_open_at in the past."
  exit 0
fi

echo "Neither Docker (fairticket-postgres) nor psql found. Run the SQL manually:"
echo "  cat $SQL_FILE"
echo "  # then execute against your Postgres (e.g. docker exec -i fairticket-postgres psql -U fairticket -d fairticket < data/seed-schedule.sql)"
exit 1
