#!/usr/bin/env bash
# install.sh — instalator pluginu opencode-project-context
# Użycie:  bash install.sh [katalog-repo]
# Domyślnie instaluje w bieżącym katalogu.
# Skrypt jest idempotentny: można uruchamiać wielokrotnie.

set -euo pipefail

# --- konfiguracja -----------------------------------------------------------
TARGET="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLUGINS_SRC="$SCRIPT_DIR/.opencode/plugins/project-context.ts"
CMD_MEMORY_SRC="$SCRIPT_DIR/.opencode/command/memory.md"
CMD_CONTEXT_SRC="$SCRIPT_DIR/.opencode/command/context.md"
CMD_REGRESSION_SRC="$SCRIPT_DIR/.opencode/command/regression.md"
FACTS_TEMPLATE=''"'# Architektura
- (uzupełnij: stack, główne katalogi, warstwy)

# Konwencje
- (uzupełnij: reguły kodowania, testy)

# Komendy
- Build:
- Testy:
- Formatowanie:

# Ryzyka i znane problemy
- (uzupełnij)'"

# --- helpers ---------------------------------------------------------------
say()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; }

require_file() {
  if [[ ! -f "$1" ]]; then
    err "Brak pliku źródłowego: $1"
    err "Uruchom skrypt z katalogu zawierającego .opencode/plugins/project-context.ts"
    exit 1
  fi
}

ensure_dir() { mkdir -p "$1"; }

# --- walidacja -------------------------------------------------------------
require_file "$PLUGINS_SRC"
require_file "$CMD_MEMORY_SRC"
require_file "$CMD_CONTEXT_SRC"
require_file "$CMD_REGRESSION_SRC"

if [[ ! -d "$TARGET" ]]; then
  err "Katalog docelowy nie istnieje: $TARGET"
  exit 1
fi

TARGET="$(cd "$TARGET" && pwd)"
say "Instalacja opencode-project-context w: $TARGET"

# --- 1. plugin + komendy ---------------------------------------------------
ensure_dir "$TARGET/.opencode/plugins"
ensure_dir "$TARGET/.opencode/command"
ensure_dir "$TARGET/.opencode/memory"

cp "$PLUGINS_SRC"      "$TARGET/.opencode/plugins/project-context.ts"
cp "$CMD_MEMORY_SRC"   "$TARGET/.opencode/command/memory.md"
cp "$CMD_CONTEXT_SRC" "$TARGET/.opencode/command/context.md"
cp "$CMD_REGRESSION_SRC" "$TARGET/.opencode/command/regression.md"
say "Skopiowano plugin i komendy"

# --- 2. project-facts.md (tylko jeśli brak) ---------------------------------
if [[ ! -f "$TARGET/.opencode/memory/project-facts.md" ]]; then
  printf '%s\n' "$FACTS_TEMPLATE" > "$TARGET/.opencode/memory/project-facts.md"
  say "Utworzono szablon .opencode/memory/project-facts.md (uzupełnij go)"
else
  warn "project-facts.md już istnieje — zachowano"
fi

# --- 3. opencode.json — merge sekcji plugin + contextOptimizer -------------
OC="$TARGET/opencode.json"
if [[ ! -f "$OC" ]]; then
  cat > "$OC" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./.opencode/plugins/project-context.ts"],
  "contextOptimizer": {
    "enabled": true,
    "maxProjectMemoryTokens": 1500,
    "maxSessionHandoffTokens": 1000,
    "maxToolResultLines": 100,
    "maxDiffLines": 120,
    "maxSearchMatches": 40,
    "maxArtifactPreviewLines": 80,
    "deduplicateReadResults": true,
    "storeFullArtifacts": true,
    "persistentDedupCache": true,
    "maxDedupCacheEntries": 500,
    "maxTestHistoryEntries": 50,
    "regressionTrackHead": true,
    "regressionSafeRevertOnly": true,
    "autoExtractFacts": true,
    "autoExtractOnEvents": ["session.idle", "session.compacted"],
    "factsAutoGlobDepth": 3,
    "compactMode": "suggest",
    "maxContextTokens": 0,
    "compactThreshold": 80,
    "compactReservedTokens": 10000
  }
}
JSON
  say "Utworzono opencode.json"
else
  warn "opencode.json istnieje — sprawdzana jest obecność wpisów"
  # sprawdź plugin
  if ! grep -q 'project-context.ts' "$OC"; then
    warn "  → w opencode.json brak wpisu 'plugin' dla project-context.ts — dodaj ręcznie:"
    warn '      "plugin": ["./.opencode/plugins/project-context.ts"]'
  fi
  # sprawdź contextOptimizer
  if ! grep -q 'contextOptimizer' "$OC"; then
    warn "  → brak sekcji 'contextOptimizer' — dodaj ją ręcznie (zobacz README.md)"
  fi
fi

# --- 4. .gitignore — dopisz brakujące wpisy --------------------------------
GI="$TARGET/.gitignore"
GITIGNORE_ENTRIES=(
  '.opencode/memory/active-session.json'
  '.opencode/memory/session-history/'
  '.opencode/memory/artifacts/'
  '.opencode/memory/cache/'
  '.opencode/memory/index/'
  '.opencode/memory/plugin-errors.log'
  '.opencode/memory/project-facts.auto.md'
)

touch "$GI"
added=0
for entry in "${GITIGNORE_ENTRIES[@]}"; do
  if ! grep -qxF "$entry" "$GI"; then
    printf '%s\n' "$entry" >> "$GI"
    added=$((added + 1))
  fi
done
if (( added > 0 )); then
  say "Dopisano $added wpisów do .gitignore"
else
  say ".gitignore już kompletny"
fi

# --- 5. podsumowanie -------------------------------------------------------
cat <<EOF

\033[1;32mGotowe.\033[0m Następne kroki:

  1. Uzupełnij:  $TARGET/.opencode/memory/project-facts.md
  2. Zrestartuj OpenCode (konfiguracja nie przeładowuje się na gorąco)
  3. W TUI wpisz:  /memory status   aby zweryfikować działanie
  4. Komendy:     /memory status|show|save|clear-session|clear-project|compact|auto|auto-refresh
                 /context budget|artifacts

EOF