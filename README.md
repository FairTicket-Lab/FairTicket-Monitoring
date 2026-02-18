# FairTicket Monitoring

FairTicket-BE의 모니터링 및 부하 테스트를 위한 프로젝트입니다.

## 개요

이 프로젝트는 FairTicket-BE 애플리케이션의 성능 모니터링과 부하 테스트를 수행하기 위한 인프라와 도구를 제공합니다.

**주요 기능:**
- k6 기반 대기열 시스템 부하 테스트
- Prometheus/Grafana를 통한 실시간 메트릭 수집 및 시각화
- Docker Compose 기반 로컬 테스트 환경 구성
- JVM 메트릭 모니터링 (CPU, Heap Memory, GC)

## 주요 구성 요소

- **부하 테스트**: k6를 사용한 대기열 시스템 성능 테스트
- **모니터링 스택**: Prometheus, Grafana, Loki, Promtail
- **테스트 환경**: Docker Compose 기반 로컬 개발 환경

## 빠른 시작

부하 테스트 실행 방법은 [load-test/LOCAL_LOAD_TEST.md](./load-test/LOCAL_LOAD_TEST.md)를 참고하세요.

## 디렉토리 구조

```
FairTicket-Monitoring/
├── load-test/          # 부하 테스트 관련 파일
│   ├── docker/         # Docker Compose 설정
│   ├── scripts/        # 테스트 실행 스크립트
│   ├── data/           # 테스트 데이터 및 설정
│   ├── dashboards/     # Grafana 대시보드
│   └── results/        # 테스트 결과
└── README.md
```

## 요구 사항

- Docker & Docker Compose
- k6 (부하 테스트 실행 시)
- FairTicket-BE 프로젝트 (동일한 레포지토리 루트에 위치)
