-- 부하 테스트용: 스케줄을 "이미 오픈된" 상태로 변경
-- ticket_open_at = 과거, ticket_close_at = 미래, status = 'OPEN'
-- → 대기열 시나리오에서 2xx 응답을 받기 위해 실행

-- schedule id 1 (기본 SCHEDULE_ID)
UPDATE schedules
SET
  ticket_open_at = NOW() - INTERVAL '1 hour',
  ticket_close_at = NOW() + INTERVAL '7 days',
  status = 'OPEN'
WHERE id = 1;

-- schedule id 2, 3 도 사용할 경우 함께 열어 둠
UPDATE schedules
SET
  ticket_open_at = NOW() - INTERVAL '1 hour',
  ticket_close_at = NOW() + INTERVAL '7 days',
  status = 'OPEN'
WHERE id IN (2, 3);

-- 대기열 시나리오: schedule 1에 등급·구역·좌석이 없으면 추가 (config.env 기본값 GRADE=VIP, ZONE=A 와 일치)
INSERT INTO grades (schedule_id, grade, price) VALUES (1, 'VIP', 120000)
ON CONFLICT (schedule_id, grade) DO NOTHING;

INSERT INTO zones (schedule_id, zone, grade, seat_count) VALUES (1, 'A', 'VIP', 10)
ON CONFLICT (schedule_id, zone) DO NOTHING;

INSERT INTO seats (schedule_id, grade, zone, seat_number, price, status) VALUES
  (1, 'VIP', 'A', '1', 120000, 'AVAILABLE'), (1, 'VIP', 'A', '2', 120000, 'AVAILABLE'),
  (1, 'VIP', 'A', '3', 120000, 'AVAILABLE'), (1, 'VIP', 'A', '4', 120000, 'AVAILABLE'),
  (1, 'VIP', 'A', '5', 120000, 'AVAILABLE'), (1, 'VIP', 'A', '6', 120000, 'AVAILABLE'),
  (1, 'VIP', 'A', '7', 120000, 'AVAILABLE'), (1, 'VIP', 'A', '8', 120000, 'AVAILABLE'),
  (1, 'VIP', 'A', '9', 120000, 'AVAILABLE'), (1, 'VIP', 'A', '10', 120000, 'AVAILABLE')
ON CONFLICT (schedule_id, zone, seat_number) DO NOTHING;

-- 적용 결과 확인 (선택)
-- SELECT id, concert_id, date_time, ticket_open_at, ticket_close_at, status FROM schedules;
