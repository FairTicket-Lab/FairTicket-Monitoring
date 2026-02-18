# Dockerfile for FairTicket-BE Spring Boot Application
# 
# 참고: 이 파일은 FairTicket-BE/Dockerfile과 동일하게 유지되어야 합니다.
# docker-compose.yml에서 build context를 ../../../FairTicket-BE로 지정했으므로,
# 실제 빌드 시에는 FairTicket-BE/Dockerfile이 사용됩니다.
# 이 파일은 참고용으로 동일한 내용을 유지합니다.
#
# Build stage
FROM eclipse-temurin:21-jdk-alpine AS builder
WORKDIR /app

COPY gradlew .
COPY gradle gradle
COPY build.gradle .
COPY settings.gradle* ./
RUN ./gradlew dependencies --no-daemon || true

COPY src src
RUN ./gradlew bootJar --no-daemon -x test

# Run stage
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app

RUN adduser -D -u 1000 appuser
USER appuser

COPY --from=builder /app/build/libs/*.jar app.jar

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
