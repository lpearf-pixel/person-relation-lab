#!/usr/bin/env bash
set -Eeuo pipefail

LOG_FILE=/tmp/person-relation-local-coder-task-latest.log
OUTPUT_FILE=/tmp/person-relation-local-coder-latest.md

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <task-file> [context-file ...]" >&2
  exit 2
fi

: > "$LOG_FILE"
{
  echo "LOCAL CODER TASK"
  echo "started_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
  echo "model=${LOCAL_CODER_MODEL:-qwen2.5-coder:7b-instruct}"
  echo "output=$OUTPUT_FILE"
  npm run build
  LOCAL_CODER_OUTPUT="$OUTPUT_FILE" npm run local-coder -- run "$@"
  echo "completed_at=$(date '+%Y-%m-%d %H:%M:%S %z')"
} 2>&1 | tee "$LOG_FILE"

echo "Model output: $OUTPUT_FILE"
echo "Log file: $LOG_FILE"
echo "The output was not applied or executed. Review it, then run npm run verify after any code change."

