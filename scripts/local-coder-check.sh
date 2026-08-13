#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE=/tmp/person-relation-local-coder-check-latest.log

: > "$LOG_FILE"
{
  echo "LOCAL CODER CHECK"
  echo "started_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "model=${LOCAL_CODER_MODEL:-qwen2.5-coder:7b-instruct}"
  echo "endpoint=${OLLAMA_URL:-http://127.0.0.1:11434}"
  npm run build
  npm run local-coder -- check
  echo "completed_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
} 2>&1 | tee "$LOG_FILE"

echo "Log file: $LOG_FILE"

