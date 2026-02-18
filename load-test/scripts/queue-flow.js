// k6: 한 사용자당 enter 1회 → status 반복(WAITING 대기) → READY 수신 흐름
// 부하 설계: TPS = 초당 enter 수. 진입한 사용자는 STATUS_POLL_MS 간격으로 status 폴링.
// 하트비트: enter 후 HEARTBEAT_INTERVAL_MS 간격으로 하트비트 전송 (기본 20초)
// 모든 변수는 config.env에서 로드됨 (기본값 없음)

import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

// 환경 변수 로드
const BASE_URL = __ENV.BASE_URL;
const SCHEDULE_ID = __ENV.SCHEDULE_ID;
const TARGET_TPS = parseFloat(__ENV.TARGET_TPS);
const STATUS_POLL_MS = parseFloat(__ENV.STATUS_POLL_MS);
const HEARTBEAT_INTERVAL_MS = parseFloat(__ENV.HEARTBEAT_INTERVAL_MS);
const VUS = parseFloat(__ENV.VUS) || parseFloat(__ENV.K6_VUS) || 100; // Virtual Users 수
const DURATION = __ENV.DURATION || __ENV.K6_DURATION || '30s';


// 토큰 로드 (JSON 형식) - k6의 open() 함수 사용
// 환경 변수로 절대 경로 또는 상대 경로 전달 가능
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

// constant-arrival-rate executor 사용
// 환경 변화와 관계없이 정확한 TPS를 유지하기 위해 arrival rate executor 사용
// rate: 초당 요청 수 (TPS)
// preAllocatedVUs: 초기 VU 수 (충분히 크게 설정하여 TPS 달성)
// maxVUs: 최대 VU 수 (필요시 자동 증가)

// 커스텀 메트릭
const readyCounter = new Counter('ready_received');
const statusCounter = new Counter('status_requests');
const heartbeatCounter = new Counter('heartbeat_requests');
const enterCounter = new Counter('enter_requests');
const enterDuration = new Trend('enter_duration');
const statusDuration = new Trend('status_duration');
const heartbeatDuration = new Trend('heartbeat_duration');
const readyTime = new Trend('ready_time'); // Enter부터 READY까지의 시간

// 실패 분석용 메트릭
const enterFailures = new Counter('enter_failures');
const statusFailures = new Counter('status_failures');
const heartbeatFailures = new Counter('heartbeat_failures');
const status404Counter = new Counter('status_404'); // NOT_IN_QUEUE
const status500Counter = new Counter('status_500'); // 서버 에러
const timeoutCounter = new Counter('timeout_errors');

// constant-arrival-rate executor 설정
// TARGET_TPS가 유효한 숫자인지 확인
const targetRate = (TARGET_TPS && !isNaN(TARGET_TPS)) ? TARGET_TPS : 100;
const testDuration = DURATION || '60s';
const preAllocVUs = Math.max(VUS || 100, targetRate);
const maxVUs = Math.max((VUS || 100) * 2, targetRate * 2);

// handleSummary에서 사용할 전역 변수
const CONFIGURED_DURATION = testDuration;
const CONFIGURED_TARGET_RATE = targetRate;


const arrivalRateConfig = {
  executor: 'constant-arrival-rate',
  rate: targetRate, // 초당 TPS
  timeUnit: '1s', // 시간 단위
  duration: testDuration, // 테스트 지속 시간
  preAllocatedVUs: preAllocVUs, // 초기 VU 수
  maxVUs: maxVUs, // 최대 VU 수
};

export const options = {
  scenarios: {
    constant_arrival_rate: arrivalRateConfig,
  },
  // threshold를 주석 처리하여 실패율이 높아도 테스트가 계속 진행되도록 함
  // 필요시 주석을 해제하여 성능 기준을 설정할 수 있음
  // thresholds: {
  //   http_req_duration: ['p(95)<2000'], // 95% 요청이 2초 이내
  //   http_req_failed: ['rate<0.1'], // 실패율 10% 미만
  // },
};

export default function () {
  if (tokensData.length === 0) {
    console.error('No tokens available');
    return;
  }

  // 현재 VU의 토큰 선택 (VU ID 기반)
  const tokenIndex = __VU % tokensData.length;
  const token = tokensData[tokenIndex].token;
  const userId = tokensData[tokenIndex].userId;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  // 1. Enter 요청
  const enterStartTime = Date.now();
  const enterUrl = `${BASE_URL}/api/v1/queue/${SCHEDULE_ID}/enter`;
  const enterRes = http.post(enterUrl, '', { 
    headers: headers,
    tags: { name: 'Enter' }
  });
  const enterEndTime = Date.now();
  
  enterCounter.add(1);
  enterDuration.add(enterRes.timings.duration);
  
  const enterSuccess = check(enterRes, {
    'enter status is 200 or 201': (r) => r.status === 200 || r.status === 201,
  });

  if (!enterSuccess) {
    enterFailures.add(1);
    if (enterRes.status === 0) {
      timeoutCounter.add(1);
      console.error(`Enter timeout for user ${userId}`);
    } else {
      console.error(`Enter failed for user ${userId}: HTTP ${enterRes.status}`);
    }
    return;
  }

  // 2. Enter 후 status 폴링 및 하트비트 전송 (delayEnterMs는 READY 수신 후 적용)
  let lastHeartbeatTime = Date.now();
  let readyReceived = false;
  const maxIterations = 1000; // 최대 반복 횟수 (무한 루프 방지)
  let iteration = 0;

  while (!readyReceived && iteration < maxIterations) {
    iteration++;
    const now = Date.now();
    const timeSinceLastHeartbeat = now - lastHeartbeatTime;

    // 하트비트가 필요한 경우
    if (timeSinceLastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      const heartbeatUrl = `${BASE_URL}/api/v1/queue/${SCHEDULE_ID}/heartbeat`;
      const heartbeatRes = http.post(heartbeatUrl, '', { 
        headers: headers,
        tags: { name: 'Heartbeat' }
      });
      
      heartbeatCounter.add(1);
      heartbeatDuration.add(heartbeatRes.timings.duration);
      
      const heartbeatSuccess = check(heartbeatRes, {
        'heartbeat status is 200 or 201': (r) => r.status === 200 || r.status === 201,
      });

      if (!heartbeatSuccess) {
        heartbeatFailures.add(1);
        if (heartbeatRes.status === 0) {
          timeoutCounter.add(1);
        } else if (heartbeatRes.status === 500) {
          status500Counter.add(1);
        }
      } else {
        lastHeartbeatTime = now;
      }
    }

    // Status 폴링
    const statusUrl = `${BASE_URL}/api/v1/queue/${SCHEDULE_ID}/status`;
    const statusRes = http.get(statusUrl, { 
      headers: { 'Authorization': `Bearer ${token}` },
      tags: { name: 'Status' }
    });
    
    statusCounter.add(1);
    statusDuration.add(statusRes.timings.duration);

    // 실패 분석
    if (statusRes.status === 0) {
      timeoutCounter.add(1);
      statusFailures.add(1);
    } else if (statusRes.status === 404) {
      status404Counter.add(1); // NOT_IN_QUEUE - heartbeat TTL 만료로 대기열에서 제거됨
      statusFailures.add(1);
    } else if (statusRes.status === 500) {
      status500Counter.add(1);
      statusFailures.add(1);
    } else if (statusRes.status !== 200) {
      statusFailures.add(1);
    }

    // READY 상태 확인
    if (statusRes.status === 200) {
      try {
        const body = JSON.parse(statusRes.body);
        if (body.status === 'READY') {
          const readyTimeMs = Date.now() - enterStartTime;
          readyCounter.add(1);
          readyTime.add(readyTimeMs);
          readyReceived = true;
          check(statusRes, {
            'status is READY': true,
          });
          // constant-arrival-rate executor가 TPS를 자동으로 유지하므로 추가 대기 불필요
          break;
        }
      } catch (e) {
        // JSON 파싱 실패 시 body 문자열에서 검색
        if (statusRes.body && statusRes.body.includes('"status"') && statusRes.body.includes('"READY"')) {
          const readyTimeMs = Date.now() - enterStartTime;
          readyCounter.add(1);
          readyTime.add(readyTimeMs);
          readyReceived = true;
          check(statusRes, {
            'status is READY': true,
          });
          // constant-arrival-rate executor가 TPS를 자동으로 유지하므로 추가 대기 불필요
          break;
        }
      }
    }

    // Status 폴링 간격 대기
    sleep(STATUS_POLL_MS / 1000);
  }

  if (!readyReceived && iteration >= maxIterations) {
    console.warn(`User ${userId} did not receive READY status within ${maxIterations} iterations`);
  }
}

export function handleSummary(data) {
  const indent = '  ';
  let output = '\n';
  output += `${indent}=== Load Test Summary ===\n\n`;
  
  // Percentile 값 추출 헬퍼 함수
  const getPercentile = (metric, p) => {
    if (!metric) return null;
    const key = `p(${p})`;
    if (metric[key] !== undefined) return metric[key];
    if (metric[`p${p}`] !== undefined) return metric[`p${p}`];
    if (p === 50 && metric.med !== undefined) return metric.med;
    return null;
  };
  
  // 요청 통계
  output += `${indent}=== 요청 통계 ===\n`;
  const enterCount = data.metrics?.enter_requests?.values?.count || 0;
  const statusCount = data.metrics?.status_requests?.values?.count || 0;
  const heartbeatCount = data.metrics?.heartbeat_requests?.values?.count || 0;
  const readyCount = data.metrics?.ready_received?.values?.count || 0;
  const totalRequests = data.metrics?.http_reqs?.values?.count || 0;
  const failedRate = data.metrics?.http_req_failed?.values?.rate || 0;
  
  output += `${indent}  Enter requests: ${enterCount}\n`;
  output += `${indent}  Status requests: ${statusCount}\n`;
  output += `${indent}  Heartbeat requests: ${heartbeatCount}\n`;
  output += `${indent}  READY received: ${readyCount}\n`;
  output += `${indent}  Total requests: ${totalRequests}\n`;
  output += `${indent}  Failed requests rate: ${(failedRate * 100).toFixed(2)}%\n\n`;
  
  // 실패 분석
  output += `${indent}=== 실패 분석 ===\n`;
  const enterFailCount = data.metrics?.enter_failures?.values?.count || 0;
  const statusFailCount = data.metrics?.status_failures?.values?.count || 0;
  const heartbeatFailCount = data.metrics?.heartbeat_failures?.values?.count || 0;
  const status404Count = data.metrics?.status_404?.values?.count || 0;
  const status500Count = data.metrics?.status_500?.values?.count || 0;
  const timeoutCount = data.metrics?.timeout_errors?.values?.count || 0;
  
  output += `${indent}  Enter 실패: ${enterFailCount}건\n`;
  output += `${indent}  Status 실패: ${statusFailCount}건\n`;
  output += `${indent}  Heartbeat 실패: ${heartbeatFailCount}건\n`;
  output += `${indent}  Status 404 (NOT_IN_QUEUE): ${status404Count}건 (heartbeat TTL 만료로 대기열 제거)\n`;
  output += `${indent}  Status 500 (서버 에러): ${status500Count}건\n`;
  output += `${indent}  타임아웃/연결 실패: ${timeoutCount}건\n`;
  if (status404Count > 0) {
    const status404Rate = ((status404Count / statusCount) * 100).toFixed(2);
    output += `${indent}  → Status 404 비율: ${status404Rate}% (Status 요청 중)\n`;
  }
  output += '\n';
  
  // 전체 HTTP 요청 지연시간
  output += `${indent}=== 전체 HTTP 요청 지연시간 (ms) ===\n`;
  const httpDuration = data.metrics?.http_req_duration?.values || {};
  output += `${indent}  min: ${(httpDuration.min || 0).toFixed(2)}\n`;
  output += `${indent}  avg: ${(httpDuration.avg || 0).toFixed(2)}\n`;
  output += `${indent}  max: ${(httpDuration.max || 0).toFixed(2)}\n`;
  output += `${indent}  p50: ${(getPercentile(httpDuration, 50) || httpDuration.med || 0).toFixed(2)}\n`;
  output += `${indent}  p90: ${(getPercentile(httpDuration, 90) || 0).toFixed(2)}\n`;
  output += `${indent}  p95: ${(getPercentile(httpDuration, 95) || 0).toFixed(2)}\n`;
  output += `${indent}  p99: ${(getPercentile(httpDuration, 99) || 0).toFixed(2)}\n\n`;
  
  // Enter API 지연시간 (태그 기반)
  output += `${indent}=== Enter API 지연시간 (ms) ===\n`;
  const enterMetrics = data.metrics?.['http_req_duration{name:Enter}']?.values || 
                       data.metrics?.enter_duration?.values || {};
  if (enterMetrics.count > 0 || enterMetrics.avg !== undefined) {
    output += `${indent}  count: ${enterMetrics.count || enterCount}\n`;
    output += `${indent}  min: ${(enterMetrics.min || 0).toFixed(2)}\n`;
    output += `${indent}  avg: ${(enterMetrics.avg || 0).toFixed(2)}\n`;
    output += `${indent}  max: ${(enterMetrics.max || 0).toFixed(2)}\n`;
    output += `${indent}  p50: ${(getPercentile(enterMetrics, 50) || enterMetrics.med || 0).toFixed(2)}\n`;
    output += `${indent}  p90: ${(getPercentile(enterMetrics, 90) || 0).toFixed(2)}\n`;
    output += `${indent}  p95: ${(getPercentile(enterMetrics, 95) || 0).toFixed(2)}\n`;
    output += `${indent}  p99: ${(getPercentile(enterMetrics, 99) || 0).toFixed(2)}\n`;
  } else {
    // 커스텀 메트릭에서 가져오기 시도
    const customEnter = data.metrics?.enter_duration?.values || {};
    if (customEnter.avg !== undefined) {
      output += `${indent}  count: ${enterCount}\n`;
      output += `${indent}  min: ${(customEnter.min || 0).toFixed(2)}\n`;
      output += `${indent}  avg: ${(customEnter.avg || 0).toFixed(2)}\n`;
      output += `${indent}  max: ${(customEnter.max || 0).toFixed(2)}\n`;
      output += `${indent}  p50: ${(getPercentile(customEnter, 50) || customEnter.med || 0).toFixed(2)}\n`;
      output += `${indent}  p90: ${(getPercentile(customEnter, 90) || 0).toFixed(2)}\n`;
      output += `${indent}  p95: ${(getPercentile(customEnter, 95) || 0).toFixed(2)}\n`;
      output += `${indent}  p99: ${(getPercentile(customEnter, 99) || 0).toFixed(2)}\n`;
    } else {
      output += `${indent}  데이터 없음 (커스텀 메트릭 확인 필요)\n`;
    }
  }
  output += '\n';
  
  // Status API 지연시간 (태그 기반)
  output += `${indent}=== Status API 지연시간 (ms) ===\n`;
  const statusMetrics = data.metrics?.['http_req_duration{name:Status}']?.values || 
                        data.metrics?.status_duration?.values || {};
  if (statusMetrics.count > 0 || statusMetrics.avg !== undefined) {
    output += `${indent}  count: ${statusMetrics.count || statusCount}\n`;
    output += `${indent}  min: ${(statusMetrics.min || 0).toFixed(2)}\n`;
    output += `${indent}  avg: ${(statusMetrics.avg || 0).toFixed(2)}\n`;
    output += `${indent}  max: ${(statusMetrics.max || 0).toFixed(2)}\n`;
    output += `${indent}  p50: ${(getPercentile(statusMetrics, 50) || statusMetrics.med || 0).toFixed(2)}\n`;
    output += `${indent}  p90: ${(getPercentile(statusMetrics, 90) || 0).toFixed(2)}\n`;
    output += `${indent}  p95: ${(getPercentile(statusMetrics, 95) || 0).toFixed(2)}\n`;
    output += `${indent}  p99: ${(getPercentile(statusMetrics, 99) || 0).toFixed(2)}\n`;
  } else {
    // 커스텀 메트릭에서 가져오기 시도
    const customStatus = data.metrics?.status_duration?.values || {};
    if (customStatus.avg !== undefined) {
      output += `${indent}  count: ${statusCount}\n`;
      output += `${indent}  min: ${(customStatus.min || 0).toFixed(2)}\n`;
      output += `${indent}  avg: ${(customStatus.avg || 0).toFixed(2)}\n`;
      output += `${indent}  max: ${(customStatus.max || 0).toFixed(2)}\n`;
      output += `${indent}  p50: ${(getPercentile(customStatus, 50) || customStatus.med || 0).toFixed(2)}\n`;
      output += `${indent}  p90: ${(getPercentile(customStatus, 90) || 0).toFixed(2)}\n`;
      output += `${indent}  p95: ${(getPercentile(customStatus, 95) || 0).toFixed(2)}\n`;
      output += `${indent}  p99: ${(getPercentile(customStatus, 99) || 0).toFixed(2)}\n`;
    } else {
      output += `${indent}  데이터 없음 (커스텀 메트릭 확인 필요)\n`;
    }
  }
  output += '\n';
  
  // Heartbeat API 지연시간
  if (heartbeatCount > 0) {
    output += `${indent}=== Heartbeat API 지연시간 (ms) ===\n`;
    const heartbeatMetrics = data.metrics?.['http_req_duration{name:Heartbeat}']?.values || 
                             data.metrics?.heartbeat_duration?.values || {};
    if (heartbeatMetrics.count > 0 || heartbeatMetrics.avg !== undefined) {
      output += `${indent}  count: ${heartbeatMetrics.count || heartbeatCount}\n`;
      output += `${indent}  min: ${(heartbeatMetrics.min || 0).toFixed(2)}\n`;
      output += `${indent}  avg: ${(heartbeatMetrics.avg || 0).toFixed(2)}\n`;
      output += `${indent}  max: ${(heartbeatMetrics.max || 0).toFixed(2)}\n`;
      output += `${indent}  p50: ${(getPercentile(heartbeatMetrics, 50) || heartbeatMetrics.med || 0).toFixed(2)}\n`;
      output += `${indent}  p90: ${(getPercentile(heartbeatMetrics, 90) || 0).toFixed(2)}\n`;
      output += `${indent}  p95: ${(getPercentile(heartbeatMetrics, 95) || 0).toFixed(2)}\n`;
      output += `${indent}  p99: ${(getPercentile(heartbeatMetrics, 99) || 0).toFixed(2)}\n`;
    } else {
      const customHeartbeat = data.metrics?.heartbeat_duration?.values || {};
      if (customHeartbeat.avg !== undefined) {
        output += `${indent}  count: ${heartbeatCount}\n`;
        output += `${indent}  min: ${(customHeartbeat.min || 0).toFixed(2)}\n`;
        output += `${indent}  avg: ${(customHeartbeat.avg || 0).toFixed(2)}\n`;
        output += `${indent}  max: ${(customHeartbeat.max || 0).toFixed(2)}\n`;
        output += `${indent}  p50: ${(getPercentile(customHeartbeat, 50) || customHeartbeat.med || 0).toFixed(2)}\n`;
        output += `${indent}  p90: ${(getPercentile(customHeartbeat, 90) || 0).toFixed(2)}\n`;
        output += `${indent}  p95: ${(getPercentile(customHeartbeat, 95) || 0).toFixed(2)}\n`;
        output += `${indent}  p99: ${(getPercentile(customHeartbeat, 99) || 0).toFixed(2)}\n`;
      } else {
        output += `${indent}  데이터 없음\n`;
      }
    }
    output += '\n';
  }
  
  // Enter부터 READY까지 소요 시간
  output += `${indent}=== Enter → READY 소요 시간 (ms) ===\n`;
  const readyTime = data.metrics?.ready_time?.values || {};
  if (readyTime.count > 0 || readyTime.avg !== undefined) {
    output += `${indent}  count: ${readyTime.count || readyCount}\n`;
    output += `${indent}  min: ${(readyTime.min || 0).toFixed(2)}\n`;
    output += `${indent}  avg: ${(readyTime.avg || 0).toFixed(2)}\n`;
    output += `${indent}  max: ${(readyTime.max || 0).toFixed(2)}\n`;
    output += `${indent}  p50: ${(getPercentile(readyTime, 50) || readyTime.med || 0).toFixed(2)}\n`;
    output += `${indent}  p90: ${(getPercentile(readyTime, 90) || 0).toFixed(2)}\n`;
    output += `${indent}  p95: ${(getPercentile(readyTime, 95) || 0).toFixed(2)}\n`;
    output += `${indent}  p99: ${(getPercentile(readyTime, 99) || 0).toFixed(2)}\n`;
  } else {
    output += `${indent}  데이터 없음\n`;
  }
  output += '\n';
  
  // RPS 계산
  // testRunDurationMs는 graceful stop 시간까지 포함하므로, 설정된 duration을 사용
  // constant-arrival-rate executor는 설정된 duration 동안만 요청을 생성함
  let testDurationMs = 0;
  
  // 설정된 duration 문자열 파싱
  const durationStr = CONFIGURED_DURATION || '60s';
  const durationMatch = durationStr.match(/(\d+)([smh])/);
  if (durationMatch) {
    const value = parseInt(durationMatch[1]);
    const unit = durationMatch[2];
    if (unit === 's') {
      testDurationMs = value * 1000;
    } else if (unit === 'm') {
      testDurationMs = value * 60 * 1000;
    } else if (unit === 'h') {
      testDurationMs = value * 60 * 60 * 1000;
    }
  }
  
  // testRunDurationMs가 설정된 duration보다 크면 (graceful stop 포함) 설정값 사용
  const configuredDurationMs = testDurationMs;
  const actualRunDurationMs = data.state?.testRunDurationMs || 0;
  
  // 실제 실행 시간이 설정 시간의 1.3배 이상이면 graceful stop 포함으로 간주하고 설정값 사용
  if (actualRunDurationMs > configuredDurationMs * 1.3 && configuredDurationMs > 0) {
    testDurationMs = configuredDurationMs;
  } else if (actualRunDurationMs > 0 && actualRunDurationMs <= configuredDurationMs * 1.3) {
    // 설정 시간과 비슷하면 실제 실행 시간 사용
    testDurationMs = actualRunDurationMs;
  }
  
  // 여전히 0이면 fallback
  if (testDurationMs === 0) {
    testDurationMs = configuredDurationMs || 60000; // 기본값 60초
  }
  
  const testDurationSec = testDurationMs / 1000;
  const actualRunDurationSec = actualRunDurationMs > 0 ? (actualRunDurationMs / 1000).toFixed(2) : 'N/A';
  const configuredDurationSec = configuredDurationMs / 1000;
  
  // 설정된 시간 기준 RPS (constant-arrival-rate executor는 설정된 duration 동안만 요청 생성)
  const totalRps = testDurationMs > 0 ? ((totalRequests / testDurationMs) * 1000).toFixed(2) : 'N/A';
  const enterRps = testDurationMs > 0 ? ((enterCount / testDurationMs) * 1000).toFixed(2) : 'N/A';
  const statusRps = testDurationMs > 0 ? ((statusCount / testDurationMs) * 1000).toFixed(2) : 'N/A';
  const heartbeatRps = testDurationMs > 0 && heartbeatCount > 0 ? ((heartbeatCount / testDurationMs) * 1000).toFixed(2) : '0.00';
  
  // 실제 실행 시간 기준 RPS (참고용)
  const actualTotalRps = actualRunDurationMs > 0 ? ((totalRequests / actualRunDurationMs) * 1000).toFixed(2) : 'N/A';
  const actualEnterRps = actualRunDurationMs > 0 ? ((enterCount / actualRunDurationMs) * 1000).toFixed(2) : 'N/A';
  const actualStatusRps = actualRunDurationMs > 0 ? ((statusCount / actualRunDurationMs) * 1000).toFixed(2) : 'N/A';
  const actualHeartbeatRps = actualRunDurationMs > 0 && heartbeatCount > 0 ? ((heartbeatCount / actualRunDurationMs) * 1000).toFixed(2) : 'N/A';
  
  output += `${indent}=== 처리량 ===\n`;
  output += `${indent}  설정된 테스트 시간: ${configuredDurationSec.toFixed(2)}초\n`;
  if (actualRunDurationMs > 0 && actualRunDurationMs !== testDurationMs) {
    output += `${indent}  실제 실행 시간: ${actualRunDurationSec}초 (graceful stop 포함)\n`;
  }
  output += `${indent}  RPS 계산 기준 시간: ${testDurationSec.toFixed(2)}초 (설정된 duration 기준)\n`;
  output += `${indent}  전체 평균 RPS: ${totalRps} (Enter + Status + Heartbeat 합계)\n`;
  output += `${indent}  Enter RPS: ${enterRps}\n`;
  output += `${indent}  Status RPS: ${statusRps}\n`;
  if (heartbeatCount > 0) {
    output += `${indent}  Heartbeat RPS: ${heartbeatRps}\n`;
  }
  output += `${indent}  실제 TPS (Enter/초): ${enterRps}\n`;
  output += `${indent}  목표 TPS: ${CONFIGURED_TARGET_RATE}\n`;
  const enterRpsNum = parseFloat(enterRps);
  output += `${indent}  TPS 달성률: ${testDurationMs > 0 && !isNaN(enterRpsNum) ? ((enterRpsNum / CONFIGURED_TARGET_RATE) * 100).toFixed(2) : 'N/A'}%\n`;
  
  // 실제 실행 시간 기준 RPS (참고용 - graceful stop 포함)
  if (actualRunDurationMs > 0 && actualRunDurationMs !== testDurationMs) {
    output += `\n${indent}=== 실제 실행 시간 기준 처리량 (참고용) ===\n`;
    output += `${indent}  전체 평균 RPS: ${actualTotalRps}\n`;
    output += `${indent}  Enter RPS: ${actualEnterRps}\n`;
    output += `${indent}  Status RPS: ${actualStatusRps}\n`;
    if (heartbeatCount > 0) {
      output += `${indent}  Heartbeat RPS: ${actualHeartbeatRps}\n`;
    }
  }
  
  
  return {
    stdout: output,
  };
}
