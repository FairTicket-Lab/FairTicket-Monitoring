// k6: GET /api/v1/queue/{scheduleId}/status (JWT)
// 개별 API 부하 테스트용 스크립트 (환경 변수로 직접 전달 필요)

import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter } from 'k6/metrics';
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

// 목표 RPS 제한
const delayMs = Math.max(1, Math.floor(1000 * VUS / TARGET_RPS));

// 커스텀 메트릭
const statusCodeCounter = new Counter('status_codes');
const readyCounter = new Counter('ready_received');

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
    'Authorization': `Bearer ${token}`,
  };

  const url = `${BASE_URL}/api/v1/queue/${SCHEDULE_ID}/status`;
  const res = http.get(url, { headers: headers });

  // 상태 코드 집계
  statusCodeCounter.add(1, { status: res.status.toString() });

  // READY 상태 확인
  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      if (body.status === 'READY') {
        readyCounter.add(1);
      }
    } catch (e) {
      // JSON 파싱 실패 시 body 문자열에서 검색
      if (res.body && res.body.includes('"status"') && res.body.includes('"READY"')) {
        readyCounter.add(1);
      }
    }
  }

  check(res, {
    'status is 200': (r) => r.status === 200,
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
  output += `${indent}  READY received: ${data.metrics?.ready_received?.values?.count || 0}\n`;
  return output;
}
