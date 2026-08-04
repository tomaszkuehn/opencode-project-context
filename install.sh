#!/usr/bin/env bash
# install.sh — instalator pluginu opencode-project-context (+ TUI plugin)
# Użycie:  bash install.sh [katalog-repo]
# Domyślnie instaluje w bieżącym katalogu.
# Skrypt jest idempotentny: można uruchamiać wielokrotnie.
#
# Instaluje dwa pluginy:
#   - project-context.ts   (server plugin — dedup, artefakty, regresja, facts)
#   - memory-tui.tsx       (TUI plugin   — pasek statusu na dole ekranu TUI)
# TUI plugin wymaga bibliotek runtime @opentui/solid + @opentui/core + solid-js,
# instalowanych przez npm w katalogu repo. Skrypt tworzy package.json i uruchamia
# npm install automatycznie (chyba że istnieje już package.json — wtedy szanuje go).

set -euo pipefail

# --- konfiguracja -----------------------------------------------------------
TARGET="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Server plugin + komendy
PLUGINS_SRC="$SCRIPT_DIR/.opencode/plugins/project-context.ts"
CMD_MEMORY_SRC="$SCRIPT_DIR/.opencode/command/memory.md"
CMD_CONTEXT_SRC="$SCRIPT_DIR/.opencode/command/context.md"
CMD_REGRESSION_SRC="$SCRIPT_DIR/.opencode/command/regression.md"

# TUI plugin
TUI_SRC="$SCRIPT_DIR/.opencode/plugins/memory-tui.tsx"
TUI_TSCONFIG_SRC="$SCRIPT_DIR/.opencode/plugins/tsconfig.json"

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

# Wersje bibliotek runtime TUI (zgodne z zainstalowanym opencode 1.18.x)
OPENTUI_VER="^0.5.1"
SOLID_JS_VER="1.9.12"
PLUGIN_SDK_VER="1.18.10"

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

have_npm() { command -v npm >/dev/null 2>&1; }

# --- walidacja -------------------------------------------------------------
require_file "$PLUGINS_SRC"
require_file "$CMD_MEMORY_SRC"
require_file "$CMD_CONTEXT_SRC"
require_file "$CMD_REGRESSION_SRC"

# TUI plugin jest opcjonalny — ostrzeż jeśli brak, ale kontynuuj (instalacja server-only)
TUI_AVAILABLE=true
if [[ ! -f "$TUI_SRC" ]]; then
  warn "Brak .opencode/plugins/memory-tui.tsx — instalacja server-only (bez paska TUI)"
  TUI_AVAILABLE=false
fi

if [[ ! -d "$TARGET" ]]; then
  err "Katalog docelowy nie istnieje: $TARGET"
  exit 1
fi

TARGET="$(cd "$TARGET" && pwd)"
say "Instalacja opencode-project-context w: $TARGET"

# --- 1. pluginy + komendy ---------------------------------------------------
ensure_dir "$TARGET/.opencode/plugins"
ensure_dir "$TARGET/.opencode/command"
ensure_dir "$TARGET/.opencode/memory"

cp "$PLUGINS_SRC"      "$TARGET/.opencode/plugins/project-context.ts"
cp "$CMD_MEMORY_SRC"   "$TARGET/.opencode/command/memory.md"
cp "$CMD_CONTEXT_SRC"  "$TARGET/.opencode/command/context.md"
cp "$CMD_REGRESSION_SRC" "$TARGET/.opencode/command/regression.md"
say "Skopiowano server plugin i komendy"

if [[ "$TUI_AVAILABLE" == "true" ]]; then
  cp "$TUI_SRC"         "$TARGET/.opencode/plugins/memory-tui.tsx"
  cp "$TUI_TSCONFIG_SRC" "$TARGET/.opencode/plugins/tsconfig.json"
  say "Skopiowano TUI plugin (memory-tui.tsx) i tsconfig.json"
fi

# --- 2. project-facts.md (tylko jeśli brak) ---------------------------------
if [[ ! -f "$TARGET/.opencode/memory/project-facts.md" ]]; then
  printf '%s\n' "$FACTS_TEMPLATE" > "$TARGET/.opencode/memory/project-facts.md"
  say "Utworzono szablon .opencode/memory/project-facts.md (uzupełnij go)"
else
  warn "project-facts.md już istnieje — zachowano"
fi

# --- 3. opencode.json — rejestracja SERVER pluginu -------------------------
OC="$TARGET/opencode.json"
if [[ ! -f "$OC" ]]; then
  cat > "$OC" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./.opencode/plugins/project-context.ts", {
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
    }]
  ]
}
JSON
  say "Utworzono opencode.json (server plugin)"
else
  warn "opencode.json istnieje — sprawdzana jest obecność wpisów"
  if ! grep -q 'project-context.ts' "$OC"; then
    warn "  → w opencode.json brak wpisu 'plugin' dla project-context.ts — dodaj ręcznie:"
    warn '      "plugin": ["./.opencode/plugins/project-context.ts"]'
  fi
fi

# --- 4. tui.json — rejestracja TUI pluginu ---------------------------------
# UWAGA: TUI pluginy konfiguruje się w .opencode/tui.json, NIE w opencode.json.
# opencode.json jest config SERVER pluginów. tui.json jest config TUI pluginów.
if [[ "$TUI_AVAILABLE" == "true" ]]; then
  TUI_CFG="$TARGET/.opencode/tui.json"
  if [[ ! -f "$TUI_CFG" ]]; then
    cat > "$TUI_CFG" <<'JSON'
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["./plugins/memory-tui.tsx", { "enabled": true }]
  ]
}
JSON
    say "Utworzono .opencode/tui.json (rejestracja TUI pluginu)"
  else
    warn ".opencode/tui.json już istnieje — zachowano"
    if ! grep -q 'memory-tui.tsx' "$TUI_CFG"; then
      warn "  → w tui.json brak wpisu dla memory-tui.tsx — dodaj ręcznie:"
      warn '      "plugin": [["./plugins/memory-tui.tsx", { "enabled": true }]]'
    fi
  fi
fi

# --- 5. package.json (root) — zależności RUNTIME TUI -----------------------
# TUI plugin importuje z solid-js i @opentui/solid w runtime.
# Te biblioteki muszą być w node_modules/ w katalogu repo (rozwiązywane w górę
# z .opencode/plugins/). Server plugin nie ma zewnętrznych zależności.
if [[ "$TUI_AVAILABLE" == "true" ]]; then
  ROOT_PKG="$TARGET/package.json"
  if [[ ! -f "$ROOT_PKG" ]]; then
    cat > "$ROOT_PKG" <<JSON
{
  "private": true,
  "dependencies": {
    "@opentui/core": "$OPENTUI_VER",
    "@opentui/solid": "$OPENTUI_VER",
    "solid-js": "$SOLID_JS_VER"
  }
}
JSON
    say "Utworzono package.json (zależności runtime TUI)"
  else
    warn "package.json już istnieje — zachowano (sprawdź czy ma zależności TUI)"
    warn "  Wymagane: @opentui/core@^0.5.1, @opentui/solid@^0.5.1, solid-js@1.9.12"
  fi

  # --- 6. .opencode/package.json — SDK + typy (dla typechecku) -------------
  OC_PKG="$TARGET/.opencode/package.json"
  if [[ ! -f "$OC_PKG" ]]; then
    cat > "$OC_PKG" <<JSON
{
  "dependencies": {
    "@opencode-ai/plugin": "$PLUGIN_SDK_VER"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.0"
  }
}
JSON
    say "Utworzono .opencode/package.json (SDK + typy dla typechecku)"
  else
    warn ".opencode/package.json już istnieje — zachowano"
  fi

  # --- 7. npm install -----------------------------------------------------
  if have_npm; then
    say "Uruchamianie npm install (root — biblioteki TUI runtime)..."
    (cd "$TARGET" && npm install --no-audit --no-fund 2>&1 | tail -3) || warn "npm install (root) zakończone z ostrzeżeniem"
    say "Uruchamianie npm install (.opencode — SDK pluginu)..."
    (cd "$TARGET/.opencode" && npm install --no-audit --no-fund 2>&1 | tail -3) || warn "npm install (.opencode) zakończone z ostrzeżeniem"
  else
    warn "npm niedostępne — zależności TUI NIE zainstalowane!"
    warn "Ręcznie: w katalogu repo uruchom  npm install  (root package.json)"
    warn "          oraz  cd .opencode && npm install  (SDK + typy)"
  fi
fi

# --- 8. .gitignore — dopisz brakujące wpisy --------------------------------
GI="$TARGET/.gitignore"
GITIGNORE_ENTRIES=(
  '.opencode/memory/active-session.json'
  '.opencode/memory/session-history/'
  '.opencode/memory/artifacts/'
  '.opencode/memory/cache/'
  '.opencode/memory/index/'
  '.opencode/memory/plugin-errors.log'
  '.opencode/memory/project-facts.auto.md'
  '.opencode/memory/tui-trace.log'
  'node_modules/'
  '.opencode/node_modules/'
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

# --- 9. podsumowanie -------------------------------------------------------
if [[ "$TUI_AVAILABLE" == "true" ]]; then
cat <<EOF

\033[1;32mGotowe.\033[0m Zainstalowano:
  - Server plugin:  .opencode/plugins/project-context.ts  (opencode.json)
  - TUI plugin:     .opencode/plugins/memory-tui.tsx      (.opencode/tui.json)
  - Zależności:     node_modules/@opentui/*, solid-js      (npm install)
  - SDK + typy:     .opencode/node_modules/@opencode-ai/* (npm install)

Następne kroki:

  1. Uzupełnij:  $TARGET/.opencode/memory/project-facts.md
  2. Zrestartuj OpenCode (konfiguracja nie przeładowuje się na gorąco)
  3. W TUI wpisz:  /memory status   aby zweryfikować server plugin
  4. Na dole ekranu TUI powinien pojawić się pasek statusu "memory: tools: ..."

Jeśli pasek TUI się nie pojawia — zobacz sekcję "TUI plugin — rozwiązywanie" w README.

EOF
else
cat <<EOF

\033[1;32mGotowe.\033[0m Zainstalowano server plugin (bez TUI).

Następne kroki:

  1. Uzupełnij:  $TARGET/.opencode/memory/project-facts.md
  2. Zrestartuj OpenCode
  3. Wpisz:  /memory status   aby zweryfikować działanie

EOF
fi