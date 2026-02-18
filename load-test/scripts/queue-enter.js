// k6: POST /api/v1/queue/{scheduleId}/enter (JWT)
// 개별 API 부하 테스트용 스크립트 (환경 변수로 직접 전달 필요)

import { check, sleep } from 'k6';
import http from 'k6/http';
// 환경 변수 로드 (기본값 제공)
const BASE_URL = __ENV.BASE_URL;
const SCHEDULE_ID = __ENV.SCHEDULE_ID;
const TARGET_RPS = parseFloat(__ENV.TARGET_RPS) || 100; // 기본값: 100 RPS
const VUS = parseFloat(__ENV.K6_VUS) || 100; // 기본값: 100 VUs
const DURATION = __ENV.K6_DURATION || '60s'; // 기본값: 60초

// 토큰 로드 (JSON 형식) - k6의 open() 함수 사용
const tokenJsonPath = __ENV.TOKEN_JSON_PATH || 'data/queue/tokens.json';
let tokensData = [];
try {
  const tokenData = open(tokenJsonPath);
  const parsed = JSON.parse(tokenData);
  tokensData = parsed.tokens || [];
  if (tokensData.length === 0) {
    console.warn(`Warning: No tokens found in ${tokenJsonPath}`);
    tokensData = [{ token: 'REPLACE_WITH_REAL_TOKEN', userId: 1 }];
  }
} catch (e) {
  console.error(`Failed to load tokens from ${tokenJsonPath}:`, e.message);
  console.error('Make sure to run ./scripts/02-prepare-tokens.sh first');
  tokensData = [{ token: 'REPLACE_WITH_REAL_TOKEN', userId: 1 }];
}

// 목표 RPS 제한: 각 VU당 간격 계산
// RPS = 초당 요청 수, VUS = 가상 사용자 수
// 각 VU는 초당 RPS/VUS 만큼 요청 수행
// 요청 간격 = 1000ms / (RPS/VUS) = 1000ms * VUS / RPS
const delayMs = Math.max(1, Math.floor(1000 * VUS / TARGET_RPS));

// 커스텀 메트릭
import { Counter } from 'k6/metrics';
const statusCodeCounter = new Counter('status_codes');

export const options = {
  stages: [
    { duration: '1s', target: VUS },
    { duration: DURATION, target: VUS },
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.1'],
  },
};

export default function () {
  if (tokensData.length === 0) {
    console.error('No tokens available');
    return;
  }

  // 현재 VU의 토큰 선택
  const tokenIndex = __VU % tokensData.length;
  const token = tokensData[tokenIndex].token;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  const url = `${BASE_URL}/api/v1/queue/${SCHEDULE_ID}/enter`;
  const res = http.post(url, '', { headers: headers });

  // 상태 코드 집계
  statusCodeCounter.add(1, { status: res.status.toString() });

  check(res, {
    'enter status is 200 or 201': (r) => r.status === 200 || r.status === 201,
  });

  // RPS 제한을 위한 대기
  sleep(delayMs / 1000);
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }),
  };
}

function textSummary(data, options) {
  const indent = options.indent || ' ';
  let output = '\n';
  output += `${indent}HTTP status breakdown:\n`;
  output += `${indent}  Total requests: ${data.metrics?.http_reqs?.values?.count || 0}\n`;
  output += `${indent}  Failed requests: ${data.metrics?.http_req_failed?.values?.rate || 0}\n`;
  return output;
}
