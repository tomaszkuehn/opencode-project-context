#!/usr/bin/env bash
# memory-tui-dump.sh — tekstowy widok pamięci pluginu (odpowiednik /memory tui)
# Działa niezależnie od OpenCode — czyta .opencode/memory/cache/metrics.json
# + active-session.json + git. Przydatne w trybie CLI / CI / skryptach.
set -euo pipefail

ROOT="${1:-$(pwd)}"
MEM="$ROOT/.opencode/memory"
METRICS="$MEM/cache/metrics.json"
SESSION="$MEM/active-session.json"

if [ ! -f "$METRICS" ]; then
  echo "memory: idle (brak metrics.json — uruchom OpenCode z pluginem)"
  exit 0
fi

# Wczytaj pola z metrics.json (czysty jq, fallback na 0)
get() { jq -r "$1 // 0" "$METRICS" 2>/dev/null || echo 0; }
gets() { jq -r "$1 // \"\"" "$METRICS" 2>/dev/null || echo ""; }

toolCalls=$(get '.toolCalls')
savedTokens=$(get '.estimatedSavedTokens')
reduction=$(get '.estimatedReductionPercent')
dedupReads=$(get '.deduplicatedReads')
artifactsCreated=$(get '.artifactsCreated')
artifactBytes=$(get '.artifactBytes')

contextTokens=$(get '.contextTokens')
contextLimit=$(get '.contextLimit')
compactThreshold=$(get '.compactThresholdPct')
compactMode=$(gets '.compactMode')
factsTokens=$(get '.factsTokens')
factsMaxTokens=$(get '.factsMaxTokens')

diskBytes=$(get '.diskBytes')
diskLimitBytes=$(get '.diskLimitBytes')
artifactsBytes=$(get '.artifactsBytes')
cacheBytes=$(get '.cacheBytes')

headSha=$(get '.headSha')
dirtyFiles=$(get '.dirtyFiles')
handoffAgeMin=$(get '.handoffAgeMin')
modifiedCount=$(get '.modifiedCount')
decisionsCount=$(get '.decisionsCount')
blockersCount=$(get '.blockersCount')
lspErrorsCount=$(get '.lspErrorsCount')
lastGoodHead=$(gets '.lastGoodHead')
revertsCount=$(get '.revertsCount')

dedupCacheCount=$(get '.dedupCacheCount')
dedupCacheMax=$(get '.dedupCacheMax')
testHistoryCount=$(get '.testHistoryCount')
testHistoryMax=$(get '.testHistoryMax')

# Fallback: jeśli nowe pola są 0 (stary metrics.json), policz z dysku
if [ "$diskBytes" -eq 0 ] && [ -d "$MEM/artifacts" ]; then
  diskBytes=$(du -sb "$MEM/artifacts" 2>/dev/null | cut -f1 || echo 0)
  artifactsBytes=$diskBytes
fi
if [ "$cacheBytes" -eq 0 ] && [ -d "$MEM/cache" ]; then
  cacheBytes=$(du -sb "$MEM/cache" 2>/dev/null | cut -f1 || echo 0)
  diskBytes=$((diskBytes + cacheBytes))
fi
if [ -z "$diskLimitBytes" ] || [ "$diskLimitBytes" -eq 0 ]; then
  diskLimitBytes=$((200 * 1024 * 1024))
fi
if [ -z "$contextLimit" ] || [ "$contextLimit" -eq 0 ]; then
  contextLimit=200000
fi
if [ -z "$factsMaxTokens" ] || [ "$factsMaxTokens" -eq 0 ]; then
  factsMaxTokens=1500
fi
if [ -z "$dedupCacheMax" ] || [ "$dedupCacheMax" -eq 0 ]; then
  dedupCacheMax=500
fi
if [ -z "$testHistoryMax" ] || [ "$testHistoryMax" -eq 0 ]; then
  testHistoryMax=50
fi

# Fallback: git HEAD i dirty (jeśli plugin nie ustawił)
if [ -z "$headSha" ] || [ "$headSha" = "0" ]; then
  headSha=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "-")
fi
if [ "$dirtyFiles" -eq 0 ]; then
  dirtyFiles=$(git -C "$ROOT" status --porcelain 2>/dev/null | wc -l || echo 0)
fi

# Fallback: handoff age z active-session.json
if [ "$handoffAgeMin" -eq 0 ] && [ -f "$SESSION" ]; then
  updated=$(jq -r '.updatedAt // ""' "$SESSION" 2>/dev/null || echo "")
  if [ -n "$updated" ]; then
    # konwersja ISO na minuty (wymaga date z GNU/BSD; fallback 0)
    now=$(date +%s 2>/dev/null || echo 0)
    then=$(date -d "$updated" +%s 2>/dev/null || date -jf "%Y-%m-%dT%H:%M:%S" "${updated%%.*}" +%s 2>/dev/null || echo 0)
    if [ "$now" -gt 0 ] && [ "$then" -gt 0 ]; then
      handoffAgeMin=$(( (now - then) / 60 ))
    fi
  fi
  modifiedCount=$(jq -r '.modifiedFiles | length' "$SESSION" 2>/dev/null || echo 0)
  decisionsCount=$(jq -r '.decisions | length' "$SESSION" 2>/dev/null || echo 0)
  blockersCount=$(jq -r '.blockers | length' "$SESSION" 2>/dev/null || echo 0)
  lspErrorsCount=$(jq -r '.lspErrors | length' "$SESSION" 2>/dev/null || echo 0)
fi

# Formatowanie
fmt_tokens() {
  local n=$1
  if [ "$n" -ge 1000000 ] 2>/dev/null; then awk "BEGIN{printf \"%.1fM\", $n/1000000}"
  elif [ "$n" -ge 1000 ] 2>/dev/null; then awk "BEGIN{printf \"%.1fk\", $n/1000}"
  else echo "$n"
  fi
}
fmt_bytes() {
  local n=$1
  if [ "$n" -ge 1048576 ] 2>/dev/null; then awk "BEGIN{printf \"%.1fMB\", $n/1048576}"
  elif [ "$n" -ge 1024 ] 2>/dev/null; then awk "BEGIN{printf \"%.1fKB\", $n/1024}"
  else echo "${n}B"
  fi
}
pct() {
  local n=$1 den=$2
  [ "$den" -gt 0 ] 2>/dev/null && awk "BEGIN{printf \"%d\", ($n/$den)*100}" || echo 0
}
age_label() {
  local m=$1
  if [ "$m" -le 0 ]; then echo "now"
  elif [ "$m" -lt 60 ]; then echo "${m}m"
  elif [ "$m" -lt 1440 ]; then echo "$((m/60))h $((m%60))m"
  else echo "$((m/1440))d"
  fi
}

ctxPct=$(pct "$contextTokens" "$contextLimit")
factsPct=$(pct "$factsTokens" "$factsMaxTokens")
diskPct=$(pct "$diskBytes" "$diskLimitBytes")

warn() { [ "$1" -ge "$2" ] 2>/dev/null && echo " ⚠" || echo ""; }
diskWarn=$(warn "$diskPct" 90)
ctxWarn=$(warn "$ctxPct" "${compactThreshold:-80}")

# Linia 1: oszczędność
line1="memory: tools:${toolCalls} · saved:~$(fmt_tokens "$savedTokens") tok · ${reduction}% reduc."
[ "$dedupReads" -gt 0 ] 2>/dev/null && line1="$line1 · dedup:${dedupReads}"
[ "$artifactsCreated" -gt 0 ] 2>/dev/null && line1="$line1 · art:${artifactsCreated} ($(fmt_bytes "$artifactBytes"))"

# Linia 2: dysk
line2="disk: $(fmt_bytes "$diskBytes") / $(fmt_bytes "$diskLimitBytes") (${diskPct}%) · art $(fmt_bytes "$artifactsBytes") · cache $(fmt_bytes "$cacheBytes")${diskWarn}"

# Linia 3: kontekst
line3="ctx: $(fmt_tokens "$contextTokens")/$(fmt_tokens "$contextLimit") tok (${ctxPct}%, compact@${compactThreshold}%) · facts: $(fmt_tokens "$factsTokens")/$(fmt_tokens "$factsMaxTokens") (${factsPct}%) [${compactMode:-?}]${ctxWarn}"

# Linia 4: sesja + git
dirtyLabel=""
[ "$dirtyFiles" -gt 0 ] 2>/dev/null && dirtyLabel=" (dirty:${dirtyFiles})"
lspLabel=""
[ "$lspErrorsCount" -gt 0 ] 2>/dev/null && lspLabel=" · lsp:${lspErrorsCount}err"
lastGoodLabel=""
[ -n "$lastGoodHead" ] && [ "$lastGoodHead" != "0" ] && lastGoodLabel=" · last-good:${lastGoodHead}"
revertsLabel=""
[ "$revertsCount" -gt 0 ] 2>/dev/null && revertsLabel=" · reverts:${revertsCount}"
line4="handoff: $(age_label "$handoffAgeMin") · mod:${modifiedCount} · dec:${decisionsCount} · blk:${blockersCount} · HEAD:${headSha}${dirtyLabel}${lspLabel}${lastGoodLabel}${revertsLabel}"

# Linia 5: cache
line5="dedup cache: ${dedupCacheCount}/${dedupCacheMax} · tests: ${testHistoryCount}/${testHistoryMax}"

echo "$line1"
echo "$line2"
echo "$line3"
echo "$line4"
echo "$line5"