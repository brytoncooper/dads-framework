#!/usr/bin/env bash
set -euo pipefail

proof=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
postgres=""
collector=""
cleanup() {
  if [ -n "$collector" ]; then docker rm -f "$collector" >/dev/null; fi
  if [ -n "$postgres" ]; then docker rm -f "$postgres" >/dev/null; fi
}
trap cleanup EXIT

postgres=$(docker run -d --publish 127.0.0.1::5432 \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16-alpine)
collector=$(docker run -d --publish 127.0.0.1::4318 \
  --mount "type=bind,source=$proof/collector.yaml,target=/etc/otelcol/config.yaml,readonly" \
  otel/opentelemetry-collector:0.139.0)
for attempt in $(seq 1 30); do
  if docker exec "$postgres" pg_isready -h 127.0.0.1 -U postgres >/dev/null \
    && docker logs "$collector" 2>&1 | grep -q "Everything is ready"; then
    break
  fi
  sleep 1
done

OTEL_EXPORTER_OTLP_ENDPOINT="http://$(docker port "$collector" 4318/tcp)" \
DADS_TEST_POSTGRES_URL="postgresql://postgres@$(docker port "$postgres" 5432/tcp)/postgres" \
node "$proof/trace-process.mjs"

traces=$(docker logs "$collector" 2>&1)
for expected in 'test-api' 'request-proof-1' 'dads.audit.actor.kind' 'postgres.query'; do
  if ! grep -Fq "$expected" <<< "$traces"; then
    printf 'Collector output missing %s\n' "$expected" >&2
    exit 1
  fi
done
if grep -Eq 'sensitive-|opaque-user-id|select \$1' <<< "$traces"; then
  printf 'Collector received sensitive test values\n' >&2
  exit 1
fi
printf 'Collector received HTTP and Postgres spans with safe attribution\n'
