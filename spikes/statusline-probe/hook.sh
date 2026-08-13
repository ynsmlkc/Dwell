#!/usr/bin/env bash
# Kivilcim 1 — hook probe.  ATILACAK KOD.
#
# Tum hook event'lerini zaman damgasiyla log'lar. Amac:
#   - hangi hook'lar gercekten atesleniyor
#   - payload'da hangi alanlar var (session_id, cwd, tool adi …)
#   - PreToolUse -> PostToolUse arasi = bekleme suresi  → histogram
#
# ONEMLI: hicbir sey bloklamaz, her zaman 0 doner. Kullanicinin tool call'unu
# geciktirmek aninda uninstall sebebidir (bkz. §12.1 Kivilcim 1).

LOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/out"
mkdir -p "$LOG_DIR"

INPUT=$(cat)
TS=$(python3 -c 'import time; print(int(time.time()*1000))')

printf '%s' "$INPUT" \
  | jq -c --arg ts "$TS" '. + {_ts:($ts|tonumber)}' >> "$LOG_DIR/hooks.jsonl" 2>/dev/null

exit 0
