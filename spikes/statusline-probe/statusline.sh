#!/usr/bin/env bash
# Kivilcim 1 — statusLine probe.  ATILACAK KOD.
#
# Iki is yapiyor:
#   1. Her cagrildiginda log'a bir satir yaziyor (olcum)
#   2. Sahte bir reklam satiri basiyor (render testi)
#
# Gercek urunde bu script daemon'a baglanacak ve <50ms icinde donecek (ADR-003).
# Burada sadece olcuyoruz.

LOG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/out"
mkdir -p "$LOG_DIR"

# Claude Code stdin'den JSON gonderiyor
INPUT=$(cat)

TS=$(python3 -c 'import time; print(int(time.time()*1000))')
SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // "?"' 2>/dev/null)
MODEL=$(printf '%s' "$INPUT" | jq -r '.model.display_name // "?"' 2>/dev/null)

# olcum kaydi
printf '%s\n' "$(jq -nc --arg ts "$TS" --arg s "$SESSION" --arg m "$MODEL" --arg c "${COLUMNS:-?}" \
  '{ts:($ts|tonumber), session:$s, model:$m, columns:$c}')" >> "$LOG_DIR/statusline.jsonl"

# ilk cagrida ham payload'i sakla — hangi alanlar geliyor gormek icin
if [ ! -f "$LOG_DIR/statusline-payload-sample.json" ]; then
  printf '%s' "$INPUT" | jq . > "$LOG_DIR/statusline-payload-sample.json" 2>/dev/null
fi

# ── render testi ──
# ADR-013: her zaman ✶ glifi + marka adi. Reklam oldugu gizlenmez.
# ADR-007: gercekte metin sanitize edilir; burada sabit ve guvenli.
printf '\033[38;5;208m✶\033[0m \033[1mFirecrawl\033[0m — docs to LLM-ready markdown \033[2m· firecrawl.dev\033[0m'
