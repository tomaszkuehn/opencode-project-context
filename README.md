# opencode-project-context

Lokalny plugin do [OpenCode](https://opencode.ai) ograniczający zużycie tokenów przez utrzymanie trwałej pamięci projektu per repozytorium, skracanie wyników narzędzi, deduplikację odczytów, zarządzanie budżetem kontekstu, auto-ekstrakcję faktów projektu oraz wykrywanie i cofanie regresji. Działa lokalnie, offline, bez zewnętrznych API. Do rozwiązywania problemu „model naprawił A, ale psuje B/C/D" służy sekcja `/regression` (lokalnie, po testach) oraz narzędzie IJFW `cross_audit` (gate na commit/PR z konsensusem 3 modeli) — porównanie w rozdziale [6. Audyt regresji wielomodelowy](#6-audyt-regresji-wielomodelowy--ijfw-cross_audit-trident).

Plugin zbudowany według specyfikacji `PLUGIN.md`.

---

## Spis treści

- [Wymagania](#wymagania)
- [Instalacja](#instalacja)
  - [Opcja A: skrypt instalacyjny (zalecane)](#opcja-a-skrypt-instalacyjny-zalecane)
  - [Opcja B: ręczna instalacja w istniejącym repo](#opcja-b-ręczna-instalacja-w-istniejącym-repo)
  - [Opcja C: globalny plugin (wszystkie projekty)](#opcja-c-globalny-plugin-wszystkie-projekty)
- [Struktura plików](#struktura-plików)
- [Konfiguracja](#konfiguracja)
- [Dostępne komendy](#dostępne-komendy)
  - [`/memory <subkomenda>`](#memory-subkomenda)
  - [`/context <subkomenda>`](#context-subkomenda)
  - [`/regression <subkomenda>`](#regression-subkomenda)
- [Narzędzie `read_artifact`](#narzędzie-read_artifact)
- [Jak to działa](#jak-to-działa)
- [Bezpieczeństwo](#bezpieczeństwo)
- [Dodatkowe funkcje (rozszerzenia)](#dodatkowe-funkcje-rozszerzenia)
  - [1. Trwały dyskowy cache deduplikacji (LRU)](#1-trwały-dyskowy-cache-deduplikacji-lru)
  - [2. Auto-ekstrakcja faktów projektu](#2-auto-ekstrakcja-faktów-projektu)
  - [3. Pamięć stanu testów w czasie](#3-pamięć-stanu-testów-w-czasie)
  - [4. Wykrywanie i cofanie regresji](#4-wykrywanie-i-cofanie-regresji-regression)
  - [5. Detekcja rozmiaru kontekstu i kompaktacja](#5-detekcja-rozmiaru-kontekstu-i-kompaktacja-compactmode)
  - [6. Audyt regresji wielomodelowy — IJFW cross_audit (Trident)](#6-audyt-regresji-wielomodelowy--ijfw-cross_audit-trident)
  - [7. Lekcje projektu (`/memory lesson`)](#7-lekcje-projektu--memory-lesson)
  - [8. Heurystyka trudnych problemów](#8-heurystyka-trudnych-problemów)
  - [9. Ekstraktory platformy docelowej](#9-ekstraktory-platformy-docelowej)
  - [10. Moduł AI (Opcja A — własny tani model)](#10-moduł-ai-opcja-a--własny-tani-model)
- [Przewodnik: 5 scenariuszy krok po kroku](#przewodnik-5-scenariuszy-krok-po-kroku)
- [Metryki i diagnostyka](#metryki-i-diagnostyka)
- [Rozwiązywanie problemów](#rozwiązywanie-problemów)

---

## Wymagania

- [OpenCode](https://opencode.ai) ≥ 1.18.x z obsługą pluginów (zobacz [docs/plugins](https://opencode.ai/docs/plugins/))
- Git w repozytorium (opcjonalnie, ale zalecane — wykorzystywany do stanu pracy)
- Dla instalacji skryptem: shell kompatybilny z POSIX (Git Bash na Windows, bash/zsh na Linuksie/macOS) oraz **npm** do instalacji zależności TUI
- **npm** — wymagany do instalacji bibliotek runtime TUI pluginu (serwer plugin nie ma zależności zewnętrznych)

### Dwa pluginy, dwa zestawy zależności

Ten projekt zawiera **dwa osobne pluginy** o różnych wymaganiach:

| Plugin | Plik | Rejestracja | Zależności npm |
| ------ | ---- | ---------- | -------------- |
| **Server plugin** (dedup, artefakty, regresja, fakty) | `project-context.ts` | `opencode.json` | Brak zewnętrznych — czysty TypeScript, tylko wbudowane moduły Node (`fs`, `path`, `crypto`) + API `@opencode-ai/plugin` |
| **TUI plugin** (pasek statusu na dole ekranu) | `memory-tui.tsx` | `.opencode/tui.json` | **Wymaga bibliotek runtime:** `@opentui/solid`, `@opentui/core`, `solid-js` — instalowane przez `npm install` |

> **Ważne:** TUI plugin jest konfigurowany w `.opencode/tui.json`, **nie** w `opencode.json`. Plik `opencode.json` jest configem pluginów SERWERA; `tui.json` jest configem pluginów TUI. To częsta pomyłka — jeśli wpiszesz `memory-tui.tsx` do `opencode.json`, zostanie potraktowany jako server plugin i zcrashuje (brak API `slots`, `theme`).

### Zależności TUI pluginu

TUI plugin importuje w runtime z trzech pakietów, które muszą być w `node_modules/` w katalogu repo (rozwiązywane w górę z `.opencode/plugins/`):

| Pakiet | Wersja | Dlaczego potrzebny |
| ------ | ------ | ----------------- |
| `solid-js` | 1.9.12 | `createSignal`, `createMemo` — reaktywność SolidJS |
| `@opentui/solid` | ≥ 0.5.1 | Renderer SolidJS dla OpenTUI (`<box>`, `<text>`, JSX runtime) |
| `@opentui/core` | ≥ 0.5.1 | Natywne binaria TUI (Zig), per-platform (np. `@opentui/core-win32-x64`) |

`@opencode-ai/plugin` (SDK + typy `tui.d.ts`) instalowany jest osobno w `.opencode/node_modules/` — potrzebny do typechecku (`tsc --noEmit`), nie do runtime. Skrypt instalacyjny tworzy oba pliki `package.json` i uruchamia `npm install` automatycznie.

---

## Instalacja

### Opcja A: skrypt instalacyjny (zalecane)

Najszybsza metoda — jeden skrypt `install.sh` kopiuje oba pluginy (server + TUI), komendy, tworzy katalogi pamięci, generuje `opencode.json` + `.opencode/tui.json` + dwa pliki `package.json`, uruchamia `npm install` (biblioteki runtime TUI + SDK), dopisuje `.gitignore` i tworzy szablon `project-facts.md`. Skrypt jest **idempotentny** — można uruchamiać wielokrotnie bez nadpisywania istniejącej konfiguracji i faktów.

```bash
# W katalogu repozytorium, gdzie skopiowano ten projekt:
bash install.sh

# Lub instalacja w innym katalogu docelowym:
bash install.sh /sciezka/do/twojego-repo
```

Co robi skrypt krok po kroku:

1. Kopiuje `project-context.ts` → `.opencode/plugins/` (server plugin)
2. Kopiuje `memory-tui.tsx` + `tsconfig.json` → `.opencode/plugins/` (TUI plugin)
3. Kopiuje `memory.md`, `context.md`, `regression.md` → `.opencode/command/`
4. Tworzy katalog `.opencode/memory/` i szablon `project-facts.md` (tylko jeśli brak)
5. Tworzy `opencode.json` z rejestracją server pluginu i konfiguracją (tylko jeśli brak)
6. Tworzy `.opencode/tui.json` z rejestracją TUI pluginu (tylko jeśli brak)
7. Tworzy `package.json` (root) z zależnościami runtime TUI (`@opentui/*`, `solid-js`) — tylko jeśli brak
8. Tworzy `.opencode/package.json` z SDK + typami dla typechecku — tylko jeśli brak
9. Uruchamia `npm install` (root + `.opencode`) — instaluje biblioteki runtime + SDK
10. Dopisuje brakujące wpisy do `.gitignore` (w tym `node_modules/`)
11. Wypisuje podsumowanie z kolejnymi krokami

Jeśli `opencode.json`, `tui.json` lub `package.json` już istnieją, skrypt ich nie nadpisuje, ale ostrzega o brakujących wpisach i podpowiada ręczną edycję. Istniejący `project-facts.md` jest zawsze zachowywany.

> **Brak `memory-tui.tsx` w katalogu źródłowym:** skrypt wykrywa to i kontynuuje w trybie server-only (bez TUI). Aby zainstalować TUI plugin, upewnij się że plik `.opencode/plugins/memory-tui.tsx` istnieje obok `install.sh`.

**Weryfikacja po instalacji:**

```bash
ls .opencode/plugins/project-context.ts   # server plugin
ls .opencode/plugins/memory-tui.tsx       # TUI plugin
ls .opencode/tui.json                      # rejestracja TUI
ls node_modules/@opentui/solid             # biblioteki runtime TUI
cat opencode.json                          # rejestracja server pluginu
```

Następnie zrestartuj OpenCode i wpisz `/memory status`, aby potwierdzić działanie server pluginu. Na dole ekranu TUI powinien pojawić się pasek statusu `memory: tools: ...` (TUI plugin).

### Opcja B: ręczna instalacja w istniejącym repo

**Server plugin:**

1. Umieść plugin w repozytorium docelowym:

```
<twoje-repo>/.opencode/plugins/project-context.ts
```

2. Skopiuj komendy:

```
<twoje-repo>/.opencode/command/memory.md
<twoje-repo>/.opencode/command/context.md
<twoje-repo>/.opencode/command/regression.md
```

3. Dodaj do `<twoje-repo>/opencode.json` sekcję rejestrującą plugin i konfigurację budżetu:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["./.opencode/plugins/project-context.ts", {
      "enabled": true,
      "maxProjectMemoryTokens": 1500,
      "maxToolResultLines": 100,
      "deduplicateReadResults": true,
      "storeFullArtifacts": true,
      "persistentDedupCache": true,
      "autoExtractFacts": true,
      "compactMode": "suggest"
    }]
  ]
}
```

**TUI plugin (pasek statusu):**

4. Skopiuj TUI plugin + tsconfig:

```
<twoje-repo>/.opencode/plugins/memory-tui.tsx
<twoje-repo>/.opencode/plugins/tsconfig.json
```

5. Utwórz `<twoje-repo>/.opencode/tui.json` (rejestracja TUI pluginu — **nie** `opencode.json`!):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["./plugins/memory-tui.tsx", { "enabled": true }]
  ]
}
```

6. Utwórz `<twoje-repo>/package.json` z zależnościami runtime TUI:

```json
{
  "private": true,
  "dependencies": {
    "@opentui/core": "^0.5.1",
    "@opentui/solid": "^0.5.1",
    "solid-js": "1.9.12"
  }
}
```

7. Utwórz `<twoje-repo>/.opencode/package.json` z SDK dla typechecku:

```json
{
  "dependencies": {
    "@opencode-ai/plugin": "1.18.10"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.0"
  }
}
```

8. Zainstaluj zależności:

```bash
cd <twoje-repo>
npm install                    # biblioteki runtime TUI
cd .opencode && npm install     # SDK + typy dla typechecku
```

**Wspólne:**

9. Dodaj wykluczenia do `<twoje-repo>/.gitignore`:

```gitignore
.opencode/memory/active-session.json
.opencode/memory/session-history/
.opencode/memory/artifacts/
.opencode/memory/cache/
.opencode/memory/index/
.opencode/memory/plugin-errors.log
.opencode/memory/project-facts.auto.md
.opencode/memory/tui-trace.log
node_modules/
.opencode/node_modules/
```

10. (Opcjonalnie) Utwórz plik faktów projektu `.opencode/memory/project-facts.md` — zobacz [strukturę poniżej](#project-factsmd).

11. **Zrestartuj OpenCode**, aby pluginy i komendy zostały załadowane. Konfiguracja nie przeładowuje się na gorąco.

### Opcja C: globalny plugin (wszystkie projekty)

Skopiuj `project-context.ts` do `~/.config/opencode/plugins/`. Pamiętaj jednak, że pamięć projektu jest zawsze per worktree — dane dwóch repozytoriów nie będą się mieszać. Konfigurację `contextOptimizer` dodaj wtedy w `~/.config/opencode/opencode.json`.

---

## Struktura plików

Plugin tworzy i utrzymuje następujący układ w repozytorium:

```
<repo>/
  .opencode/
    plugins/
      project-context.ts          # server plugin (wersjonowany)
      memory-tui.tsx              # TUI plugin — pasek statusu (wersjonowany)
      tsconfig.json               # typecheck config dla memory-tui.tsx (wersjonowany)
    command/
      memory.md                   # komenda /memory
      context.md                  # komenda /context
      regression.md               # komenda /regression
    memory/
      project-facts.md            # (zalecane) wersjonowane fakty projektu
      active-session.json         # bieżący handoff (gitignore)
      session-history/
        <session-id>.json          # historia sesji (gitignore)
      artifacts/
        <hash>.log                # pełne wyniki narzędzi (gitignore)
      cache/
        tool-results.json          # cache (gitignore)
        metrics.json              # statystyki (gitignore)
        dedup-seen.json           # trwały cache deduplikacji LRU (gitignore)
        session-trace.json        # zagregowane statystyki sesji (gitignore)
        proposed-facts.md         # bufor propozycji faktów (gitignore)
        test-history.json         # historia uruchomień testów/buildów (gitignore)
      index/
        files.json                # indeks plików (gitignore)
      plugin-errors.log           # log błędów fail-open (gitignore)
    tui.json                       # rejestracja TUI pluginu (wersjonowany)
    node_modules/                  # SDK + typy (gitignore)
  opencode.json                   # rejestracja server pluginu + konfiguracja
  package.json                    # zależności runtime TUI (gitignore lub wersjonowany)
  node_modules/                    # biblioteki TUI runtime (gitignore)
  .gitignore
```

### `project-facts.md`

Plik przechowuje informacje wysokiej wartości, niskiej objętości (docelowo 1500–2000 tokenów). Przykładowy szablon:

```md
# Architektura
- Firmware: ESP-IDF, komponenty w `components/`.
- Komunikacja radiowa: warstwa HAL oddzielona od logiki protokołu.
- Synchronizacja: kolejki FreeRTOS; bez blokowania w ISR.

# Konwencje
- Bez dynamicznej alokacji w ścieżkach krytycznych.
- Publiczne API wymaga testu.
- Logowanie przez modułową warstwę loggera.

# Komendy
- Build: `idf.py build`
- Testy: `pytest -q tests/`
- Formatowanie: `clang-format -i <files>`

# Ryzyka i znane problemy
- Retry transmisji musi respektować duty-cycle.
```

Plugin automatycznie ucina plik przekraczający `maxProjectMemoryTokens` i loguje ostrzeżenie w treści.

### `active-session.json`

Format handoffu sesji:

```json
{
  "schemaVersion": 1,
  "sessionId": "ses_abc123",
  "updatedAt": "2026-07-30T15:00:00Z",
  "goal": "Naprawić retry transmisji po timeout downlinku",
  "currentStatus": "Zidentyfikowano błąd w src/radio/retry.c",
  "modifiedFiles": ["src/radio/retry.c", "tests/test_retry.py"],
  "decisions": ["Maksymalnie 3 retry", "Backoff wykładniczy z limitem 30 s"],
  "commands": { "build": "idf.py build", "test": "pytest -q tests/test_retry.py" },
  "testStatus": { "lastCommand": "pytest -q tests/test_retry.py", "exitCode": 1, "summary": "1 failed, 14 passed" },
  "blockers": ["Brak testu integracyjnego dla symulowanego downlinku"],
  "lspErrors": []
}
```

Plugin nigdy nie zapisuje w tym pliku pełnych promptów, odpowiedzi modelu, sekretów ani kompletnego kodu.

---

## Konfiguracja

Wszystkie pola sekcji `contextOptimizer` w `opencode.json` są opcjonalne — brak sekcji oznacza wartości domyślne.

| Pole                       | Domyślnie | Opis                                              |
| -------------------------- | --------- | ------------------------------------------------- |
| `enabled`                  | `true`    | Globalny wyłącznik pluginu                        |
| `maxProjectMemoryTokens`   | `1500`    | Limit wstrzykiwanego kontekstu na start sesji      |
| `maxSessionHandoffTokens`  | `1000`    | Limit serializowanego handoffu                     |
| `maxToolResultLines`       | `100`     | Globalny limit linii wyniku narzędzia              |
| `maxDiffLines`             | `120`     | Limit linii skróconego `git diff`                  |
| `maxSearchMatches`         | `40`      | Limit dopasowań `grep`/`rg`                         |
| `maxArtifactPreviewLines`  | `80`      | Domyślny limit podglądu `read_artifact`            |
| `deduplicateReadResults`   | `true`    | Deduplikacja powtórzonych odczytów tego samego pliku |
| `storeFullArtifacts`       | `true`    | Zapis pełnych wyników jako artefakty               |
| `persistentDedupCache`     | `true`    | Zapis dedup-cache na dysk (zachowanie po restarcie) |
| `maxDedupCacheEntries`     | `500`     | Maksymalna liczba wpisów w LRU                     |
| `maxTestHistoryEntries`    | `50`      | Maksymalna liczba zapamiętanych uruchomień testów |
| `regressionTrackHead`      | `true`    | Zapisuj git SHA przy każdym uruchomieniu testów (korelacja regresji) |
| `regressionSafeRevertOnly` | `true`    | Wymagaj `confirm` przy `git checkout <sha> -- <file>`; bez auto `--hard` |
| `autoExtractFacts`         | `true`    | Włącz deterministyczne ekstraktory budujące `project-facts.auto.md` |
| `autoExtractOnEvents`      | `["session.idle","session.compacted"]` | Zdarzenia, na których regenerowany jest `.auto.md`; pusta lista = tylko ręcznie (`/memory auto-refresh`) |
| `factsAutoGlobDepth`       | `3`       | Głębokość skanowania katalogów dla sekcji Architektura |
| `compactMode`             | `"suggest"` | Tryb kompaktacji: `auto` (OpenCode kompaktuje sam), `suggest` (toast + status), `confirm` (toast + ręczne potwierdzenie), `off` |
| `maxContextTokens`        | `0`       | Limit kontekstu dla progu kompaktacji; `0` = autodetekcja z `Model.limit.context` (fallback 200000) |
| `compactThreshold`         | `80`      | Próg kompaktacji w procentach limitu (0-100) |
| `compactReservedTokens`    | `10000`   | Bufor tokenów zostawiany przy kompaktacji (odzwierciedla `compaction.reserved`) |
| `ai`                      | *(objekt)* | Konfiguracja własnego taniego modelu AI (Opcja A). Domyślnie wyłączone. Zobacz sekcję **AI module** poniżej. |

Zmiany konfiguracji wymagają restartu OpenCode.

### AI module (`ai`)

Plugin może wołać tani model AI (niezależny od modelu kodującego) do 3 zadań: podsumowanie sesji (handoff), ekstrakcja konwencji/ryzyka z dokumentacji (README/CLAUDE.md), oraz triage nieudanych testów. Model jest konfigurowany w sekcji `ai` plugin options:

```jsonc
"plugin": [["./.opencode/plugins/project-context.ts", {
  // ...
  "ai": {
    "enabled": true,
    "provider": "openai-compatible",        // | "ollama" | "anthropic"
    "baseUrl": "",                           // puste = domyślny per provider
    "apiKey": "${OPENAI_API_KEY}",           // env interpolation; ollama nie wymaga
    "model": "gpt-4o-mini",                  // tani model
    "maxTokens": 800,
    "temperature": 0,
    "timeoutMs": 15000,
    "fallbackChain": ["ollama:qwen2.5:7b"]   // kolejne modele do spróbowania
  }
}]]
```

| Pole           | Domyślnie             | Opis |
| -------------- | --------------------- | ---- |
| `enabled`      | `false`               | Włącz moduł AI |
| `provider`     | `"openai-compatible"` | Jeden z: `openai-compatible` (OpenAI/Together/etc.), `ollama` (lokalny, bez apiKey), `anthropic` |
| `baseUrl`      | `""`                  | Puste = domyślny per provider (`https://api.openai.com/v1`, `http://localhost:11434`, `https://api.anthropic.com/v1`) |
| `apiKey`       | `""`                  | Klucz API; wspiera interpolację `${ENV_VAR}`. Dla `ollama` nie wymagany |
| `model`        | `"gpt-4o-mini"`       | Nazwa modelu (np. `gpt-4o-mini`, `qwen2.5:7b`, `claude-3-5-haiku-20241022`) |
| `maxTokens`    | `800`                 | Limit tokenów odpowiedzi |
| `temperature`  | `0`                   | Temperatura (0 = deterministyczne) |
| `timeoutMs`    | `15000`               | Timeout żądania (AbortController) |
| `fallbackChain`| `[]`                  | Lista kolejnych modeli do spróbowania przy błędzie pierwszego |

**Fallback (warstwowo):** przy braku `enabled`/`apiKey` → moduł wyłączony, plugin działa deterministycznie (status quo). Przy błędzie sieci/HTTP/timeout → retry 1× + próba kolejnych modeli z `fallbackChain`. Przy złej odpowiedzi JSON → retry 1× z `temperature: 0`. W każdym przypadku `aiComplete()` zwraca `null` — wywołujący używa ścieżki deterministycznej. AI nigdy nie w ścieżce krytycznej.

**Komendy diagnostyczne:**
- `/memory ai status` — czy AI włączone, jaki model, liczniki wołań/ sukcesów/porażek, ostatni błąd
- `/memory ai triage` — analizuje ostatnie nieudane testy i proponuje root cause (fallback: lista testów)

**Pliki:**
- `.opencode/memory/project-facts.ai.md` — AI-ekstrahowane fakty z dokumentacji (regenerowane na `session.idle`, gitignored)
- `.opencode/memory/plugin-ai.log` — log błędów AI (gitignored)

---

## Dostępne komendy

Plugin udostępnia dwa zestawy komend wpisywane w TUI OpenCode: `/memory` (zarządzanie pamięcią projektu) oraz `/context` (diagnostyka budżetu i artefaktów), a także `/regression`. Obsługa odbywa się przez hooki `command.execute.before` i `tui.command.execute`. Wszystkie komendy działają lokalnie, modyfikują wyłącznie dane w `.opencode/memory/` i nie wpływają na pliki źródłowe projektu.

> **Ważne o ograniczeniach OpenCode (wykryte 2026-08-04):** komendy z plików `.opencode/command/*.md` są przez OpenCode **zawsze** wykonywane jako prompt do modelu (`command.execute.before` → `prompt()` → LLM). OpenCode nie wspiera jeszcze pomijania LLM dla komend (feature request #28292 — `noReply`). Dlatego:
> 1. Plugin liczy wynik deterministycznie i zapisuje go do `.opencode/memory/command_result.txt` (hook `command.execute.before`).
> 2. Szablony `.opencode/command/{memory,context,regression}.md` każą modelowi zwrócić ten plik 1:1 — wynik jest wtedy deterministyczny.
> 3. Gdy pluginu brak (np. projekt bez `.opencode/plugins/`), szablony zawierają **twarde zasady bezpieczeństwa**: model **nigdy** nie może wykonać `git commit`/`add`/`push`/`reset`/`clean`/`checkout <sha> -- .` ani modyfikować plików poza `.opencode/memory/`. To eliminuje przypadek, w którym `/memory save` było interpretowane jako „zacomituj zmiany".

### `/memory <subkomenda>`

Komendy zarządzania pamięcią projektu i bieżącą sesją.

#### `/memory status`

Wyświetla szybki przegląd stanu pamięci pluginu. Przydatne do weryfikacji, czy plugin poprawnie zidentyfikował worktree i czy pamięć jest zainicjowana.

Pokazuje:
- ścieżkę aktywnego worktree
- rozmiar `project-facts.md` (tokeny + znaki)
- identyfikator i czas ostatniej aktualizacji `active-session.json`
- liczbę wpisów deduplikacji (`SeenContext`) w bieżącej sesji
- liczbę artefaktów i łączny rozmiar katalogu `artifacts/`
- podsumowanie metryk: liczba wywołań narzędzi, procent redukcji, liczba deduplikowanych odczytów
- **oszczędność tokenów** (szacunek): łączna liczba zaoszczędzonych znaków z filtracji wyników narzędzi i deduplikacji odczytów, przeliczona na tokeny (chars/4)
- bieżący rozmiar kontekstu i limit (tryb kompaktacji)

Przykład wyjścia:

```
Worktree: /home/dev/projekt
Project facts: 412 tokens (1648 chars)
Active session: ses_abc123 (updated 2026-07-30T15:00:00Z)
Seen contexts: 7
Artifacts: 3 (84.2 KB)
Metrics: 42 tool calls, 76.9% reduction, 11 dedup reads
Saved: ~12340 tokens (49360 chars) — filtracja + deduplikacja
Context: 165432 / 200000 tokens (mode=suggest)
```

#### `/memory show`

Wyświetla pełną zawartość trzech elementów:
- `project-facts.md` (po ewentualnym ucięciu do budżetu)
- `active-session.json` (sformatowany JSON)
- ostatni wstrzyknięty kontekst sesji (`PROJECT MEMORY`)

Służy do inspekcji, co dokładnie agent otrzymał na starcie sesji i jakie dane są zapamiętane. Przydatne przy debugowaniu niespójności zachowania agenta między sesjami.

#### `/memory save`

Wymusza natychmiastowy zapis bieżącego handoffu do `active-session.json` oraz do `session-history/<session-id>.json`. Normalnie handoff zapisuje się automatycznie przy `session.idle` i `session.compacted` — ta komenda pozwala zachować stan w dowolnym momencie (np. przed ręcznym zakończeniem pracy).

#### `/memory clear-session`

Czyści nietrwałe dane bieżącej sesji:
- pamięć deduplikacji (`SeenContext`)
- liczniki metryk (`toolCalls`, `rawChars`, `deliveredChars`, `deduplicatedReads`)
- plik `active-session.json`
- katalog `cache/` (w tym `metrics.json`)

**Nie usuwa** `project-facts.md` ani artefaktów. Używaj, gdy sesja „zapchała się" powtórzonymi danymi lub chcesz zacząć czystą sesję z zachowaniem faktów projektu.

#### `/memory clear-project`

Usuwa **całą** pamięć lokalną projektu: cały katalog `.opencode/memory/` (w tym `project-facts.md`, `active-session.json`, historia sesji, artefakty, cache, indeksy). Po operacji katalog pamięci jest odtwarzany pusty.

> ⚠️ **Uwaga:** W MVP komenda nie pyta o potwierdzenie — wykonuje się natychmiast. Jeśli wersjonujesz `project-facts.md`, utracone fakty można odzyskać z Git. Po resecie utwórz ponownie szablon `project-facts.md`.

#### `/memory compact`

Ręcznie buduje krótki handoff z bieżącego stanu sesji (analogicznie do `session.compacted`) i zapisuje go do `active-session.json`. Przydatne, gdy chcesz wymusić odświeżenie handoffu bez czekania na zdarzenie `session.idle`, np. po zakończeniu istotnego etapu pracy.

#### `/memory propose`

Analizuje zagregowany ślad sesji (`session-trace.json`) i historię testów (`test-history.json`) oraz generuje **propozycje** wpisów do `project-facts.md`, nie modyfikując pliku. Propozycje zapisywane są w `.opencode/memory/cache/proposed-facts.md` i wypisywane w TUI.

Generowane sekcje (jeśli są dane):
- `## Komendy` — wykryte komendy builda/testów z licznikiem uruchomień w sesjach
- `## Hotspoty` — najczęściej edytowane pliki (top 10)
- `## Ostatnie nieudane testy` — 5 ostatnich nieudanych uruchomień z listą failed
- `## Ryzyka / powtarzające się blokery` — nazwy testów/błędów powtarzające się między sesjami

Służy do stopniowego budowania `project-facts.md` bez ręcznego notowania — plugin zbiera statystyki automatycznie, a Ty zatwierdzasz. Brak autozapisu do `project-facts.md` — kontrola pozostaje po stronie użytkownika.

Aby dopisać propozycje do faktów projektu:

```
/memory commit
```

#### `/memory commit`

Dopisuje wygenerowane wcześniej propozycje (z `/memory propose`) do `project-facts.md` pod markerem `<!-- === propozycje pluginu === -->`, czyści bufor propozycji i zachęca do ręcznego przejrzenia (aby utrzymać zwięzłość w budżecie tokenów).

#### `/memory auto`

Wyświetla zawartość `project-facts.auto.md` — pliku regenerowanego automatycznie przez deterministyczne ekstraktory (nie wymaga zatwierdzania).

#### `/memory auto-refresh`

Ręcznie uruchamia regenerację `project-facts.auto.md`. Przydatne po zmianie stacku, dodaniu manifestu (np. `Cargo.toml`, `pyproject.toml`) lub instalacji nowego narzędzia, bez czekania na `session.idle`.

#### `/memory init [--force]`

Inicjalizuje `project-facts.md` wstępnie wypełnionym szablonem z auto-wykrytymi podpowiedziami:

- **Architektura** — wykryty stack (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `CMakeLists.txt`, `pom.xml`, `build.gradle`) i główne katalogi
- **Komendy** — wykryte komendy build/test/format/lint z manifestów (npm scripts, Makefile, CMake, Cargo, Go, dotnet)
- **Środowisko** — wykryte wersje runtime (`.nvmrc`, `.python-version`, `.ruby-version`, `.tool-versions`, `mise.toml`, `Dockerfile FROM`)
- **Konwencje** i **Ryzyka** — pozostawione puste z markerem `(uzupełnij)` do ręcznego wypełnienia

Idempotentny: nie nadpisuje nietrywialnego `project-facts.md`. Nadpisuje tylko gdy plik nie istnieje lub jest domyślnym szablonem z `install.sh` (zawiera `# Architektura` + `(uzupełnij` w pierwszych liniach). `--force` nadpisuje zawsze (z backupem `.tpl.bak` dla domyślnego szablonu).

```
/memory init              # wypełnij szablon podpowiedziami (jeśli brak/domyślny)
/memory init --force      # nadpisz istniejący project-facts.md
```

#### `/memory compact-status`

Wyświetla stan detekcji rozmiaru kontekstu i progu kompaktacji: bieżący rozmiar (`AssistantMessage.tokens.input`), limit (ręczny/autodetekcja/fallback 200k), próg w procentach, wykorzystanie i pozostałe tokeny. Gdy próg przekroczony, podaje instrukcję zależną od `compactMode`.

Plugin śledzi rozmiar kontekstu na każdej wiadomości asystenta (`message.updated`/`message.completed`). Limit określany wg priorytetu: `maxContextTokens` > autodetekcja z `Model.limit.context` (przez `client.config.providers()`) > fallback 200000. Autodetekcja uruchamiana raz na sesję przy pierwszej wiadomości asystenta dla danego modelu.

```
=== Context compaction ===
Tryb:           suggest
Rozmiar:        165 432 tokens
Limit:          200 000 tokens (autodetekcja: anthropic/claude-sonnet-4-5)
Próg kompaktacji: 160 000 tokens (80%)
Wykorzystanie:  83%
Pozostało:      34 568 tokens
Sugestia pokazana: tak

⚠ Próg przekroczony — sugerowana kompaktacja.
Aby skompaktować: użyj natywnej komendy OpenCode (np. /compact w TUI) lub /memory compact-now.
```

#### `/memory compact-now`

Próbuje wymusić kompaktację przez `tui.executeCommand` (komenda `session.compact`). Jeśli OpenCode nie wspiera tej komendy przez API, wypisuje instrukcję ręczną. W trybie `auto` z `compaction.auto: true` (konfiguracja OpenCode) kompaktacja nastąpi automatycznie przy następnym `message`.

#### `/memory compact-reset`

Resetuje flagę sugestii (żeby toast mógł się pokazać ponownie przy kolejnym przekroczeniu). Nie wpływa na sam rozmiar kontekstu.

#### `/memory test-history`

Wyświetla historię uruchomień testów/buildów (najnowsze na górze, domyślnie 15 pozycji). Dla każdego wpisu pokazuje: timestamp, status (OK/FAIL), komendę, podsumowanie i listę failed testów. Służy do śledzenia, kiedy dany test zaczął padać lub kiedy build się zepsuł, bez ponownego analizowania logów. Maksymalnie `maxTestHistoryEntries` (domyślnie 50) ostatnich uruchomień.

Przykład wyjścia:

```
=== Test history (najnowsze na górze) ===
[2026-07-30T15:12:33Z] FAIL(1)  pytest -q tests/test_retry.py
    1 failed, 14 passed
    failed: tests/test_retry.py::test_retry_delay
[2026-07-30T14:55:01Z] OK  idf.py build
    Build complete
```

#### `/memory ai status`

Pokazuje stan modułu AI: czy włączony, provider, model, liczniki wołań/ sukcesów/porażek, ostatni czas odpowiedzi i ostatni błąd. Gdy AI wyłączone, podpowiada jak je skonfigurować.

#### `/memory ai triage`

Analizuje ostatnie nieudane testy (do 3 z historii) i proponuje prawdopodobny root cause. Wymaga włączonego `ai`. Przy braku AI lub błędzie — fallback: deterministyczna lista nieudanych testów (jak `/memory test-history` filtrowana po FAIL).

#### `/memory lesson <opis>`

Ręcznie dopisuje lekcję do wersjonowanego `project-facts.md` (sekcja `## Lekcje`, z datą ISO). Służy do zapisywania **trudnych problemów rozwiązanych po wielu iteracjach**, nietrywialnych decyzji i pułapek, na które agent może natrafić ponownie w przyszłej sesji. Lekcje są widoczne dla agenta na starcie każdej sesji (w ramach `project-facts`).

Walidacja: tekst niepusty, do 600 znaków (skróć do: problem + rozwiązanie + dlaczego). Jeśli sekcja `## Lekcje` nie istnieje w `project-facts.md`, jest tworzona; jeśli istnieje, lekcja jest dopisywana pod nią.

```
/memory lesson SDK TUI: slots.register kontrakt to {slots:{name:(ctx,props)=>JSX}}, nie {name,render} — zajęło 3 iteracje
/memory lesson regressionRevert: git checkout <sha> -- <file> w trybie bezpiecznym wymaga confirm — bez tego silent no-op
```

Lekcje można potem swobodnie edytować w `project-facts.md` (sekcja wersjonowana w Git). Są wstrzykiwane razem z auto-faktami w ramach budżetu `maxProjectMemoryTokens`.

> **Wskazówka:** Jeśli problem był naprawdę trudny (≥3 iteracje build/test, zakończone sukcesem), komenda `/memory propose` automatycznie go wykryje i podpowie dodanie lekcji — patrz [Heurystyka trudnych problemów](#8-heurystyka-trudnych-problemów).

#### `/memory tui`

Tekstowy odpowiednik widoku TUI — działa w trybie CLI (non-interactive), gdzie sloty TUI nie są renderowane. Zwraca 5-linijkowy blok z tymi samymi danymi co pasek TUI: oszczędność tokenów, rozmiar na dysku vs limit 200 MB, budżet kontekstu vs próg kompaktacji, stan sesji (handoff, modified, decisions, blockers, HEAD, dirty, LSP, last-good), limity cache (dedup, test-history). Ostrzeżenia (`⚠`) markują przekroczenia: dysk ≥90%, kontekst ≥ próg kompaktacji.

Przykład wyjścia:

```
memory: tools:18 · saved:~65k tok · 85% reduc. · dedup:2 · art:1 (3.0KB)
disk: 349KB / 200.0MB (0%) · art 308KB · cache 34KB
ctx: 12.0k/200.0k tok (6%, compact@80%) · facts: 480/1.5k (32%) [suggest]
handoff: 12m · mod:3 · dec:0 · blk:0 · HEAD:abc12345 (dirty:2) · lsp:3err · last-good:abc12345
dedup cache: 127/500 · tests: 14/50
```

W trybie TUI (interaktywnym) ten sam widok jest odświeżany na żywo co 3 s w pasku statusu pluginu `memory-tui.tsx`.

#### `/memory dashboard`

Pełnoekranowy dashboard TUI — własny route `memory-dashboard` z 8 sekcjami: oszczędność tokenów, dysk, budżet kontekstu, sesja (goal/status/blokery/błędy LSP), cache, **AI module** (model, liczniki wołań, ostatni błąd), historia testów (10 ostatnich), artefakty (10 największych). Odświeżanie co 3 s. Dostępny w trybie interaktywnym przez `api.route.navigate("memory-dashboard")` lub toast przy przekroczeniu progu.

### Powiadomienia TUI (toast + dialog)

Plugin `memory-tui.tsx` automatycznie pokazuje powiadomienia w trybie interaktywnym:

- **Toast warning** gdy kontekst ≥ próg kompaktacji (mode=suggest) — `Kontekst 82% — /memory compact-now`
- **Dialog confirm** gdy kontekst ≥ próg kompaktacji (mode=confirm) — `Skompaktować sesję? [Y/N]`
- **Toast error** gdy dysk ≥ 90% limitu 200 MB — `Pamięć pluginu 180MB (90%) — /memory clear-session`

Sprawdzanie co 5 s, deduplikacja (toast nie powtarza się dopóki warunek nie zniknie i nie wróci).

### Sidebar enrichment

W slocie `sidebar_content` plugin dokłada blok z aktualnymi blokerami i błędami LSP (z `active-session.json`), jeśli jakieś są. Odświeżanie co 5 s. Skrócone do 60 znaków, max 3 pozycje na kategorię.

### `/context <subkomenda>`

Komendy diagnostyki budżetu kontekstu i artefaktów.

#### `/context budget`

Pokazuje aktualne wykorzystanie limitów skonfigurowanych w sekcji `contextOptimizer`. Pomaga zdiagnozować, czy limity nie są zbyt restrykcyjne lub zbyt luźne dla danego projektu.

Pokazuje:
- `Project facts` — aktualne tokeny vs `maxProjectMemoryTokens`
- `Handoff` — tokeny `active-session.json` vs `maxSessionHandoffTokens`
- `Tool result limit`, `Diff limit`, `Search matches`, `Artifact preview` — wartości limitów w liniach/matchach

Przykład wyjścia:

```
Project facts:  412 / 1500 tokens
Handoff:        318 / 1000 tokens
Tool result limit: 100 lines
Diff limit:     120 lines
Search matches: 40
Artifact preview: 80 lines
```

#### `/context artifacts`

Wyświetla listę ostatnio zapisanych artefaktów (pełnych wyników narzędzi) posortowaną od najnowszego, maksymalnie 20 pozycji. Dla każdego artefaktu pokazuje:
- nazwę pliku (`<hash>.log`)
- rozmiar w KB
- czas ostatniej modyfikacji (ISO 8601)

Służy do szybkiego podglądu, które pełne logi/diffy są dostępne do selektywnego odczytu przez narzędzie `read_artifact` (patrz [rozdział poniżej](#narzędzie-read_artifact)). Przydatne, gdy agent odwołuje się do `artifact://<id>`, a chcesz zweryfikować, czy artefakt jeszcze istnieje (TTL 7 dni, limit 200 MB).

Przykład wyjścia:

```
a71d8c.log  84.2 KB  2026-07-30T15:12:33Z
b3e9f1.log  12.5 KB  2026-07-30T14:55:01Z
c8d2a7.log   3.1 KB  2026-07-30T14:30:18Z
```

### `/regression <subkomenda>`

Komendy wykrywania i cofania regresji. Wykorzystują `test-history.json` (wyniki testów + git SHA) oraz `session-trace.json` (edytowane pliki), by powiązać regresję ze zmianami bez zewnętrznego LLM. Działają lokalnie, przez `git`. Modyfikują pliki projektu **tylko na żądanie i z potwierdzeniem** w trybie bezpiecznym (`regressionSafeRevertOnly: true`).

#### `/regression last-good`

Pokazuje „okno regresji": ostatni udany uruchomienie testu (last-good, exit=0) i pierwszy nieudany (first-red, exit≠0 z failed), wraz z git HEAD SHA i nazwą padającego testu. Podstawa do dalszej analizy.

Przykład wyjścia:

```
=== Regression window ===
Last good:  2026-07-30T14:55:01Z  exit=0  idf.py build
            HEAD: a1b2c3d
            Build complete
First red:  2026-07-30T15:12:33Z  exit=1  pytest -q tests/test_retry.py
            HEAD: e4f5a6b
            1 failed, 14 passed
            failed: tests/test_retry.py::test_retry_delay
Failing test: tests/test_retry.py::test_retry_delay
```

#### `/regression suspect`

Koreluje okno regresji ze zmianami w repozytorium. Wypisuje:

- padający test
- okno czasowe last-good → first-red
- listy commitów między SHA (gdy `regressionTrackHead: true`)
- **podejrzane pliki** — posortowane wg prawdopodobieństwa winy, scalone z:
  1. plików obecnie zmodyfikowanych (stan roboczy `git status`) — waga 100
  2. plików zmienionych między last-good a first-red (`git diff --name-only`) — waga 50
  3. plików najczęściej edytowanych w `session-trace.json` — waga = licznik edycji
- podpowiedź komend do przywrócenia

Nie modyfikuje żadnych plików — tylko diagnozuje. To najmniej destrukcyjne narzędzie i zazwyczaj wystarcza, by wskazać winnego.

Przykład wyjścia:

```
=== Regression suspects ===
Failing test: tests/test_retry.py::test_retry_delay
Okno: 2026-07-30T14:55:01Z → 2026-07-30T15:12:33Z
Commity w oknie:
  c3d4e5f fix: retry backoff
  b2a1c9d refactor: radio module
Pliki zmienione w oknie (posortowane wg prawdopodobieństwa):
  src/radio/retry.c
  src/radio/backoff.c
  tests/test_retry.py

Podpowiedź: przywróć podejrzany plik do wersji last-good:
  /regression revert <plik>      (wymaga /regression revert confirm)
  /regression revert stash       (zachowaj wszystkie zmiany w stash)
```

#### `/regression revert <file|all|stash>`

Przywraca pliki do wersji z last-good (`git checkout <last-good-sha> -- <file>`). W trybie `regressionSafeRevertOnly: true` (domyślnie) każda operacja modyfikująca pliki wymaga drugiego kroku `confirm`:

| Komenda                             | Działanie                                                        |
| ----------------------------------- | ---------------------------------------------------------------- |
| `/regression revert`                | Pokazuje pomoc i listę podejrzanych plików                       |
| `/regression revert <plik>`         | W trybie bezpiecznym: prosi o `confirm`. Bezpieczny: przywraca jeden plik |
| `/regression revert confirm <plik>` | Wykonuje `git checkout <sha> -- <plik>`                          |
| `/regression revert all`            | W trybie bezpiecznym: prosi o `confirm all`                      |
| `/regression revert all confirm`    | Przywraca wszystkie podejrzane pliki do last-good                |
| `/regression revert stash`          | `git stash` wszystkich niezatwierdzonych zmian (zawsze bezpieczne) |

**Bezpieczeństwo:** Plugin **nigdy** nie wykonuje `git reset --hard` ani `git clean`. `stash` jest operacją odwracalną (`git stash pop`). `checkout <sha> -- <file>` nadpisuje tylko wskazane pliki i można to cofnąć przez `git checkout HEAD -- <file>` lub `git restore`. W trybie `regressionSafeRevertOnly: false` pojedynczy plik przywracany jest bez potwierdzenia — używać ostrożnie.

#### `/regression feature <add|list|mark|check>`

Punkt odniesienia dla opcji, które działają **w środowisku docelowym** — tam, gdzie „testy przechodzą, ale realny feature nie działa". Feature definiujesz raz, a po weryfikacji w środowisku oznaczasz go jako działający na bieżącym commicie (`git notes`). Nota siedzi na commicie, więc historia pozostaje nienaruszona, a punkt odniesienia nie ginie po commicie zmian.

| Komenda                          | Działanie                                                                  |
| -------------------------------- | -------------------------------------------------------------------------- |
| `/regression feature add <nazwa> [opis]` | Definiuje feature (zapis do `.opencode/memory/cache/features.json`) |
| `/regression feature list`       | Lista feature'ów + status: `ok @ <sha>` (ostatnio oznaczony) / `nieoznaczony` |
| `/regression feature mark <nazwa> [uwaga]` | Oznacza feature jako **działający** na HEAD (`git notes append` — wielokrotne marki kumulują się w jednej nocie) |
| `/regression feature check <nazwa>` | Znajduje ostatni commit, na którym feature był oznaczony jako działający; pokazuje okno zmian od tego commita do HEAD (commity, pliki, diff) **oraz gotowy prompt dla modelu kodującego** — model dostaje tylko zmiany w oknie, nie cały kod |

**Workflow:** po zweryfikowaniu w środowisku docelowym, że np. opcja `retry-delay` działa → `/regression feature mark retry-delay`. Gdy później opcja padnie mimo zielonych testów → `/regression feature check retry-delay` pokazuje dokładnie, jakie zmiany od znanego-dobrego commita mogły ją złamać, i daje prompt gotowy do wklejenia modelowi. 

#### Typowy workflow: „model naprawił A, ale zepsuł B, C, D"

To klasyczny scenariusz dla `/regression`: agent dostaje zgłoszenie o błędzie w module A, poprawia go, ale przy okazji dotyka modułów B/C/D i łamie je. Plugin powiąże regresję ze zmianami lokalnie, bez LLM.

```text
1. Uruchom testy (cały suite, nie tylko testy modułu A):
   $ pytest -q

   Plugin zapisuje wpis do test-history.json:
     timestamp=2026-08-04T12:30Z  exit=1
     failed: tests/test_retry.py::test_retry_delay
     HEAD: e4f5a6b

2. /regression last-good
   Pokazuje okno regresji:
     Last good:  2026-08-04T11:00Z  exit=0   HEAD: a1b2c3d
     First red:  2026-08-04T12:30Z  exit=1   HEAD: e4f5a6b
     Failing test: tests/test_retry.py::test_retry_delay

   Pokażę różnicę: commit e4f5a6b (= fix w module A) zepsuł test_retry.

3. /regression suspect
   Scala podejrzane pliki z 3 źródeł:
     - stan roboczy git status (waga 100)
     - git diff a1b2c3d..e4f5a6b (waga 50)
     - trace edycji sesji (waga = licznik edycji)
   Sortuje wg prawdopodobieństwa winy, np.:
     1. src/radio/backoff.c      # dotknięty "przy okazji", łamie test_retry
     2. src/radio/retry.c        # cel zmiany — testy retry jeszcze działają
     3. tests/test_retry.py
   Nie modyfikuje plików — tylko diagnozuje.

4. /regression revert <podejrzany plik>
   W trybie bezpiecznym (domyślnym) prosi o potwierdzenie:
     /regression revert confirm src/radio/backoff.c
   Wykonuje: git checkout a1b2c3d -- src/radio/backoff.c
   (cofnięcie: git checkout HEAD -- src/radio/backoff.c)

5. Uruchom testy ponownie, by potwierdzić:
   $ pytest -q tests/test_retry.py
   Jeśli zielono — winny plik znaleziony. Jeśli czerwono:
     - /regression revert stash   (odkładając wszystkie zmiany, odwracalne)
     - lub powtarzaj krok 4 dla kolejnego podejrzanego pliku
```

**Kluczowa zasada:** uruchom pełen suite testów (a nie tylko testy zmienianego modułu) przed i po zmianie — tylko wtedy `test-history.json` zawiera pełne okno regresji i komendy `/regression` potrafią wskazać winowajcę.

### Szybkie przykłady

```
/memory status            # czy plugin działa poprawnie?
/memory show              # co agent dostał na starcie?
/memory save               # zachowaj stan przed przerwą
/memory clear-session     # wyczyść sesję, zostaw fakty
/memory clear-project     # usuń całą pamięć projektu (uwaga: niszczy project-facts.md)
/memory compact           # odśwież handoff ręcznie
/memory compact-status   # rozmiar kontekstu + próg kompaktacji
/memory compact-now      # wymuś kompaktację (tui.executeCommand: session.compact)
/memory compact-reset    # zresetuj flagę sugestii
/memory propose           # zobacz propozycje faktów z sesji
/memory commit            # dopisz propozycje do project-facts.md
/memory auto              # pokaż auto-wygenerowane fakty (.auto.md)
/memory auto-refresh     # ręcznie zregeneruj .auto.md
/memory init             # wypełnij project-facts.md podpowiedziami z repo
/memory test-history      # historia uruchomień testów/buildów
/memory lesson <text>    # zapisz trudną lekcję do project-facts.md (sekcja ## Lekcje)
/memory ai status         # czy AI włączone? jaki model? liczniki wołań
/memory ai triage         # root-cause ostatnich nieudanych testów (AI lub fallback)
/memory tui              # tekstowy widok TUI (działa w CLI)
/memory dashboard        # pełnoekranowy dashboard TUI (route: memory-dashboard)
/context budget           # czy limity są dobrze dobrane?
/context artifacts        # które pełne logi są dostępne?
/regression last-good     # kiedy testy przeszły ostatnio?
/regression suspect       # które pliki/commity spowodowały regresję?
/regression revert stash  # zstashuj zmiany (odwracalne)
/regression feature add <nazwa> [opis]  # zdefiniuj feature do śledzenia
/regression feature list  # status feature'ów (ok @ sha / nieoznaczony)
/regression feature mark <nazwa> [uwaga]  # oznacz feature jako działający na HEAD (git notes)
/regression feature check <nazwa>  # okno zmian od znanego-dobrego commita + prompt dla modelu
```

---

## Narzędzie `read_artifact`

Plugin rejestruje narzędzie `read_artifact`, dostępne dla agenta obok wbudowanych narzędzi OpenCode. Służy do pobierania pełnych wyników zapisanych wcześniej jako artefakty, fragmentami.

Parametry:

```json
{
  "artifactId": "a71d8c",
  "offset": 0,
  "limit": 100,
  "search": "error"
}
```

- `artifactId` — krótki hash z komunikatu skróconego wyniku (`artifact://a71d8c`)
- `offset` / `limit` — paginacja linii (domyślnie `limit = maxArtifactPreviewLines`)
- `search` — opcjonalne filtrowanie linii zawierających tekst

Dzięki temu agent pobiera dokładnie interesujący fragment logu/diffu zamiast ponownie otrzymywać pełny output.

---

## Jak to działa

### 1. Inicjalizacja sesji (`session.created`)

1. Ustala root repo i bieżący worktree.
2. Odczytuje `project-facts.md` (z ucięciem do budżetu).
3. Odczytuje ostatni `active-session.json`.
4. Pobiera minimalny stan Git (branch, krótki SHA HEAD, zmodyfikowane pliki, ostatnie 20 zmian).
5. Buduje zwięzły blok `PROJECT MEMORY` i wstrzykuje go do sesji (≤ `maxProjectMemoryTokens`).

### 2. Handoff sesji (`session.idle` / `session.compacted`)

Aktualizuje `active-session.json`: cel pracy, edytowane pliki, decyzje, ostatni wynik builda/testów, błędy LSP, blokery. Serializacja do ≤ `maxSessionHandoffTokens` (przy przekroczeniu pola są przycinane).

### 3. Filtr wyników narzędzi (`tool.execute.after`)

| Narzędzie / komenda                       | Reguła skracania                                                |
| ----------------------------------------- | --------------------------------------------------------------- |
| `pytest`, `idf.py build`, `cmake`, `make`, `cargo test`, `npm test`, `jest`, `vitest` | Exit code + pierwszy błąd/stack trace + końcowe podsumowanie |
| `git diff`                                | Lista plików, statystyki, 1–3 najistotniejsze hunki, artefakt pełnego diffu |
| `grep`, `rg`                              | Grupowanie po pliku, dedup identycznych, max `maxSearchMatches`, preferencja plików aplikacyjnych |
| `read`                                    | Deduplikacja po hash + zakresie linii; unieważnienie przy zmianie pliku |
| dowolny wynik > `maxToolResultLines`      | Zapis artefaktu + skrót z odniesieniem `artifact://...`          |

Plugin zawsze zachowuje: kod wyjścia, pierwszy właściwy błąd, lokalizację błędu i końcowe podsumowanie.

### 4. Deduplikacja

Pamięć krótkotrwała sesji (`SeenContext`) śledzi hash treści i zakres linii odczytanych plików. Drugi identyczny odczyt zwraca skrót z hashem zamiast pełnej treści. Modyfikacja pliku (`file.edited`) unieważnia wpis cache. Cache jest per sesja i per worktree — nie przenosi się między projektami.

### 5. Budżet kontekstu

Plugin zarządza kontekstem jako budżetem. Priorytety danych (od najwyższego):

1. Aktualny komunikat użytkownika
2. Błędy builda/testów i diagnostyka LSP
3. Kod aktualnie modyfikowany
4. Projektowe fakty i konwencje
5. Ostatni handoff
6. Wyniki wyszukiwania kodu
7. Stare logi, pełne diffy, powtarzalne dane

Przy przekroczeniu limitu odrzucane są dane od końca listy, nigdy dane krytyczne dla poprawności.

### 6. Artefakty

Pełne wyniki skracanych narzędzi zapisywane w `.opencode/memory/artifacts/<sha256>.log`. Skróty zawierają odniesienie `artifact://<id>`. Limit katalogu: **200 MB**; TTL artefaktów: **7 dni**. Po przekroczeniu usuwane są najstarsze (poza aktywną sesją).

### 7. Wykrywanie i cofanie regresji

Plugin śledzi wyniki uruchomień testów/buildów wraz z git HEAD SHA (`test-history.json`) oraz edytowane pliki (`session-trace.json`). Gdy testy przestają przechodzić, komendy `/regression` korelują osie czasowe:

- **`/regression last-good`** — identyfikuje okno regresji (ostatni zielony → pierwszy czerwony)
- **`/regression suspect`** — scala podejrzane pliki z 3 źródeł (stan roboczy, `git diff` między SHA, trace edycji) i sortuje wg prawdopodobieństwa winy; pokazuje commity w oknie
- **`/regression revert`** — przywraca pliki do wersji last-good przez `git checkout <sha> -- <file>`, z potwierdzeniem w trybie bezpiecznym; `stash` jako odwracalna alternatywa

Pełen opis w rozdziale [Dodatkowe funkcje → 4. Wykrywanie i cofanie regresji](#4-wykrywanie-i-cofanie-regresji-regression).

---

## Bezpieczeństwo

Plugin **blokuje automatyczny odczyt** (w `tool.execute.before`) plików:

- `.env`, `.env.*`
- `id_rsa`, `*.pem`, `*.p12`, `*.kdbx`
- pliki pasujące do `credentials`, `secrets`

oraz komend typu `cat .env`, `type id_rsa`, `Get-Content ... .pem`.

Maskowanie wzorców sekretów (w wynikach, logach i artefaktach):

- `API_KEY=...`, `SECRET=...`, `TOKEN=...`, `PASSWORD=...`
- `Authorization: Bearer ...`
- Klucze AWS (`AKIA...`), GitHub PAT (`ghp_...`/`gho_...`), klucze OpenAI (`sk-...`)
- Bloki `-----BEGIN ... PRIVATE KEY-----`

Sekrety nie trafiają do `project-facts.md`, `active-session.json`, cache ani artefaktów.

---

## Dodatkowe funkcje (rozszerzenia)

Plugin zawiera trzy rozszerzenia wykraczające poza podstawowe MVP, skoncentrowane na redukcji tokenów i zapamiętywaniu istotnych informacji o rozwoju projektu. Wszystkie działają lokalnie, bez zewnętrznego LLM.

### 1. Trwały dyskowy cache deduplikacji (LRU)

`SeenContext` (pamięć odczytanych zakresów plików) jest zapisywany do `.opencode/memory/cache/dedup-seen.json` i ładowany przy starcie pluginu. Dzięki temu po restarcie OpenCode w tej samej sesji agent nie otrzyma ponownie tych samych odczytów.

- LRU eviction: po przekroczeniu `maxDedupCacheEntries` (domyślnie 500) usuwane są najstarsze wpisy (wg `deliveredAt`)
- Edycja pliku (`file.edited`) unieważnia wpis cache dla tego pliku i natychmiast zapisuje zaktualizowany cache
- `/memory clear-session` czyści cache; `project-facts.md` i zagregowany trace pozostają
- Wyłączalne przez `persistentDedupCache: false` (wtedy cache tylko w RAM, jak w podstawowym MVP)

### 2. Auto-ekstrakcja faktów projektu (`/memory propose` + `/memory commit` + `project-facts.auto.md`)

Plugin automatycznie zbiera statystyki w trakcie sesji i po jej zakończeniu (`session.idle`/`session.compacted`) agreguje je w `.opencode/memory/cache/session-trace.json` (utrwalane między sesjami):

- `buildTestCommands` — licznik uruchomień wykrytych komend builda/testów (`pytest`, `npm test`, `idf.py build`, `cmake --build`, `make`, `cargo test`, `jest`, `vitest`, `go test`, `mvn test`, `gradle test`)
- `editedFiles` — licznik edycji plików (z `file.edited`, ścieżki względne worktree)
- `blockers` — powtarzające się nazwy failed testów/błędów między sesjami

Komenda `/memory propose` generuje propozycje sekcji `# Komendy`, `# Hotspoty`, `# Ostatnie nieudane testy`, `# Ryzyka / powtarzające się blokery` i zapisuje je w `proposed-facts.md`. Komenda `/memory commit` dopisuje propozycje do `project-facts.md` pod markerem HTML. Te statystyki wymagają zatwierdzenia — użytkownik kontroluje rozrost `project-facts.md`.

**Deterministyczne auto-fakty (`project-facts.auto.md`)** — obok statystyk sesji, plugin czyta repozytorium i buduje osobny plik `project-facts.auto.md`, regenerowany automatycznie na `session.idle`/`session.compacted` (konfigurowalne przez `autoExtractOnEvents`). Wstrzykiwany razem z `project-facts.md` w ramach budżetu `maxProjectMemoryTokens`. Ekstraktory wykrywają:

- **Architekturę** — stack po manifestach (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `CMakeLists.txt`, `pom.xml`, `build.gradle`) i dominujących rozszerzeniach; główne katalogi (do `factsAutoGlobDepth`, domyślnie 3)
- **Komendy** — `package.json` scripts, `Makefile` targets, CMake (`cmake --build`, `ctest`), Cargo, Go, dotnet; sekcje Build/Test/Formatowanie/Lint
- **Środowisko** — `.nvmrc`, `.node-version`, `.python-version`, `.ruby-version`, `.tool-versions`, `mise.toml`, `Dockerfile` (FROM), **Host OS** (`process.platform`), **WSL detection** (Linux: `/proc/sys/fs/binfmt_misc/WSLInterop`; Windows: presence `*.sh` + `*.ps1` obok siebie → "cross-platform shell", sam `*.sh` → "WSL/bash wymagany")
- **Platforma docelowa** (nowe) — GitHub Actions `matrix.os`/`runs-on`, Electron (`electron-builder.*`), Tauri (`tauri.conf.json`), Capacitor (`capacitor.config.*`), Expo (`app.json` expo), `package.json` `os`/`cpu`/`main`, `tsconfig.json` `lib` (DOM/Node/hybrid)

Plik `.auto.md` jest dodawany do `.gitignore` (regenerowany, nie wersjonowany). `project-facts.md` pozostaje dla faktów ręcznych (ryzyka, konwencje zespołu, lekcje) i jest wersjonowany. Wstrzykiwany kontekst to połączenie obu, ucięte do budżetu. Komendy `/memory auto` i `/memory auto-refresh` pozwalają podejrzeć i ręcznie odświeżyć auto-fakty. Konfiguracja: `autoExtractFacts: false` wyłącza funkcję; `autoExtractOnEvents: []` wyłącza auto-regenerację, zostawiając tylko `/memory auto-refresh`.

Gdy włączony jest moduł `ai`, na `session.idle` plugin woła tani model i buduje dodatkowy plik `.opencode/memory/project-facts.ai.md` z konwencjami i ryzykami ekstrahowanymi z `README.md`/`CLAUDE.md`/`AGENTS.md`/`CONTRIBUTING.md`. Plik jest regenerowany (gitignored) i wstrzykiwany razem z auto-faktami w ramach budżetu `maxProjectMemoryTokens`. Brak AI = brak pliku (fallback deterministyczny).

### 3. Pamięć stanu testów w czasie (`test-history.json`)

Przy każdym uruchomieniu komendy build/test (wykrytej w `tool.execute.after`) plugin zapisuje wpis do `.opencode/memory/cache/test-history.json`:

```json
{
  "timestamp": "2026-07-30T15:12:33Z",
  "command": "pytest -q tests/test_retry.py",
  "exitCode": 1,
  "summary": "1 failed, 14 passed",
  "failed": ["tests/test_retry.py::test_retry_delay"],
  "sessionId": "ses_abc123"
}
```

Parser rozpoznaje formaty: pytest (`FAILED ...`), jest/vitest (`FAIL ...`), cargo (`failures:`), z fallbackiem na linie `FAIL`/`: error:`. Historia jest ograniczona do `maxTestHistoryEntries` (domyślnie 50). Komenda `/memory test-history` pokazuje najnowsze wpisy — pozwala śledzić, kiedy test zaczął padać lub kiedy build się zepsuł, bez ponownego analizowania logów. Krytyczne dla debugowania flaky testów w długich sesjach embedded/CI.

### Nowe pliki danych

Wszystkie w `.opencode/memory/cache/` (już wykluczone przez `.gitignore`):

| Plik                | Zawartość                                   | Funkcja            |
| ------------------- | ------------------------------------------- | ------------------ |
| `dedup-seen.json`   | trwały cache `SeenContext` (LRU)             | rozszerzenie 1     |
| `session-trace.json`| zagregowane statystyki komend/edycji/blokerów | rozszerzenie 2   |
| `proposed-facts.md` | bufor propozycji faktów                     | rozszerzenie 2     |
| `test-history.json` | historia uruchomień testów/buildów          | rozszerzenie 3     |

### 4. Wykrywanie i cofanie regresji (`/regression`)

Rozszerzenie wykorzystuje `test-history.json` (wyniki testów + git SHA) oraz `session-trace.json` (edytowane pliki), by powiązać regresję ze zmianami bez zewnętrznego LLM. Działa lokalnie, przez `git`, modyfikuje pliki projektu **tylko na żądanie i z potwierdzeniem** w trybie bezpiecznym (`regressionSafeRevertOnly: true`).

Pełny opis komend, przykłady wyjścia, tabela wariantów `revert` oraz typowy workflow debugowania znajdują się w rozdziale [Dostępne komendy → `/regression`](#regression-subkomenda).

**Kluczowe zasady bezpieczeństwa:**

- Plugin **nigdy** nie wykonuje `git reset --hard` ani `git clean`
- `stash` jest operacją odwracalną (`git stash pop`)
- `checkout <sha> -- <file>` nadpisuje tylko wskazane pliki — cofnięcie przez `git checkout HEAD -- <file>` lub `git restore`
- W trybie `regressionSafeRevertOnly: false` pojedynczy plik przywracany jest bez potwierdzenia — używać ostrożnie

### 5. Detekcja rozmiaru kontekstu i kompaktacja (`compactMode`)

Plugin śledzi rozmiar kontekstu sesji na podstawie `AssistantMessage.tokens.input` (pole `cost.tokens.input` z każdej wiadomości asystenta, aktualizowane na `message.updated`/`message.completed`). OpenCode ma natywną `compaction.auto`, ale plugin dodaje:

- **Precyzyjny próg**: `compactThreshold`% limitu (domyślnie 80%). Limit określany wg priorytetu: `maxContextTokens` (ręczny) → autodetekcja z `Model.limit.context` przez `client.config.providers()` (raz na sesję, dla pierwszego modelu) → fallback 200000.
- **Tryby** (`compactMode`):
  - `auto` — plugin nie interweniuje; OpenCode kompaktuje przy `compaction.auto: true`
  - `suggest` (domyślny) — toast + status w TUI gdy próg przekroczony; kompaktacja ręczna
  - `confirm` — toast + `/memory compact-now` do potwierdzenia; `/memory compact-reset` do odłożenia
  - `off` — detekcja wyłączona
- **Wzbogacanie kontekstu po kompaktacji**: hook `experimental.session.compacting` wstrzykuje `project-facts` (auto + ręczne) i handoff sesji do kontekstu kompaktacji, żeby agent nie stracił istotnego kontekstu projektu.
- **Reset po kompaktacji**: hook `experimental.compaction.autocontinue` resetuje `lastContextTokens` i flagę sugestii.

Komendy: `/memory compact-status`, `/memory compact-now`, `/memory compact-reset`. Stan pokazywany też w `/memory status` i `/context budget`.

### 6. Audyt regresji wielomodelowy — IJFW cross_audit (Trident)

Odrębne narzędzie od systemu **IJFW Memory MCP** (katalog `.ijfw/` w repo, nie mylić z pluginem `project-context`). Służy do wykrywania i naprawiania regresji wprowadzonych przez commit lub zakres commitów, z użyciem konsensusu 3 niezależnych modeli LLM. To **gate po commicie/PR**, nie monitor na żywo.

#### Kiedy stosować

Scenariusz klasyczny: model naprawił funkcjonalność A, ale psuje B, C, D. Lokalne `/regression` wymaga padającego testu, by powiązać winowajcę. Gdy testów brak, są one flaky, albo zmiana łamie coś, czego test nie pokrywa (UX, semantyka API, regresja wydajności), `/regression` nie wskaże winy. Wtedy stosuje się `cross_audit` — model czyta diff i ocenia, czy zmiana nie psuje kodu poza zakresem intencji.

#### Wywołanie

Narzędzie MCP `ijfw_cross_audit_converge` z jednym wymaganym argumentem:

```json
{
  "commitRange": "HEAD~1..HEAD",
  "lenses": ["codex", "gemini", "claude"],
  "maxIterations": 3,
  "autoFix": false
}
```

| Parametr       | Wymagany | Domyślnie                       | Opis                                                         |
| -------------- | -------- | ------------------------------- | ------------------------------------------------------------ |
| `commitRange`  | tak      | —                               | Zakres git do audytu, np. `HEAD~1..HEAD`, `main..feature/x`  |
| `lenses`       | nie      | `["codex","gemini","claude"]`   | Lista modeli (lenses) do uruchomienia równolegle            |
| `maxIterations`| nie      | `3` (cap 10)                    | Limit iteracji konwergencji; `1` = single-shot               |
| `autoFix`      | nie      | `false`                         | Opt-in: auto-poprawia błędy o zbieżności 2+ modeli           |

Zwraca: `{ verdict, iterations, findings, divergence?, stalled? }`. `verdict` ∈ `PASS | CONDITIONAL | FAIL | consensus_failed | UNREACHABLE`.

#### Jak działa — krok po kroku

```text
1. Dispatch równoległy
   Wszystkie lensy (codex, gemini, claude) dostają ten sam diff z commitRange
   i oceniają niezależnie: czy zmiana spełnia intencję i nie łamie niczego poza zakresem.

2. Zbieranie findings
   Każdy lens zwraca listę findings (HIGH/MEDIUM/LOW) z lokalizacją plik:linia,
   opisem problemu i sugerowaną poprawką.

3. Detekcja rozbieżności (divergence)
   Jeśli lensy nie zgadzają się co do werdyktu lub findings,
   uruchamiana jest iteracja konwergencji:
     - generowany jest podsumowanie dotychczasowych rozbieżności
     - lensy ponownie oceniają diff z tym podsumowaniem
   Pętla trwa do osiągnięcia konsensusu lub maxIterations.

4. Werdykt zbieżności
   PASS — żaden lens nie zgłosił HIGH, intencja spełniona
   CONDITIONAL — są findings MEDIUM/LOW do rozpatrzenia
   FAIL — 2+ lensy zgodne co do HIGH; regresja potwierdzona
   consensus_failed — po maxIterations lensy nadal się rozchodzą (wymaga człowieka)
   UNREACHABLE — błąd infrastruktury/dispatch

5. autoFix (opt-in, domyślnie wyłączone)
   Jeśli autoFix: true i werdykt != PASS, uruchamiany jest atomic per-finding fix loop:
     - bierze tylko HIGH findings, na które zgodziły się 2+ lensy
     - stosuje jedną poprawkę = jeden revertowalny git commit
     - dotyka maksymalnie 10 różnych plików na uruchomienie (po tym stop)
     - ograniczenie path-containment: nie pisze poza rootem audytowanego projektu
     - BUGI LOGICZNE NIE SĄ AUTOPOPRAWIANE — tylko oczywiste regresje, logiczne zostają człowiekowi
   Wynik autoFix pojawia się w result.autoFix; werdykt audytu się nie zmienia.
```

#### Typowy workflow: „model naprawił A, ale zepsuł B, C, D"

```text
1. Agent commituje zmianę naprawiającą moduł A.
   git commit -m "fix: A retry backoff"

2. Uruchom audyt na zakresie commitu:
   commitRange: "HEAD~1..HEAD"
   autoFix: false (najpierw tylko czytamy)

3. Interpretuj werdykt:
   PASS         — zmiana czysta, zatwierdź PR
   CONDITIONAL  — przejrzyj findings w polu `findings`, zdecyduj ręcznie
   FAIL         — regresja potwierdzona przez 2+ modele
                   → sprawdź result.findings dla lokalizacji plik:linia
                   → uruchom ponownie z autoFix: true, by automatycznie poprawić HIGH
                      (tylko te, na które zgodziły się 2+ modeli)
   consensus_failed — rozbierzność trwała, zbadaj `divergence` i `iterations` ręcznie

4. Jeśli autoFix poprawił:
   - przejrzyj wygenerowane commity (każdy revertowalny)
   - uruchom testy + pełen suite regresji
   - uruchom audyt ponownie na nowym commitRange, by potwierdzić PASS
```

**Ważne ograniczenia autoFix:**

- Modyfikuje pliki w repo bez pytania (to cel) — ale każda poprawka to osobny, revertowalny commit
- Nie poprawia bugów logicznych (deferred to humans)
- Maks. 10 różnych plików na uruchomienie; powyżej tego stopuje i raportuje zamiast masowo nadpisywać
- Nie pisze poza rootem audytowanego projektu (path-containment guard)

#### Porównanie: `/regression` vs `ijfw_cross_audit_converge`

| Cecha                 | `/regression` (plugin)                          | `ijfw_cross_audit_converge` (IJFW MCP)                 |
| --------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Tryb działania        | lokalne, offline, przez `git`                   | MCP, wymaga LLM API (3 modele równolegle)             |
| Sygnał wejściowy      | padający test (`test-history.json` + git SHA)   | diff z commitRange (nie wymaga testu)                  |
| Wykrywa               | który plik/commit zepsuł konkretny test          | czy zmiana psuje cokolwiek poza intencją (UX, API, semantyka) |
| Wymaga testów         | **tak** — bez testów nie ma okna regresji        | **nie** — model czyta diff                              |
| Modyfikuje pliki      | tylko na żądanie (`revert`, z potwierdzeniem)   | tylko gdy `autoFix: true` (opt-in, revertowalne commity) |
| Koszt                 | zero (lokalne)                                   | wywołania 3 modeli × iteracje konwergencji              |
| Werdykt               | lista podejrzanych plików                        | PASS / CONDITIONAL / FAIL / consensus_failed            |
| Kiedy stosować        | masz testy i padają, chcesz wskazać winowajcę    | gate na PR/commit, brak testów lub pokrycia, regresja semantyczna |
| Offline               | tak                                             | nie                                                    |

**Kiedy którego:**

- `/regression` — gdy masz padający test i chcesz lokalnie wskazać winny plik bez kosztu LLM
- `cross_audit` — gdy testów brak, są flaky, lub regresja jest semantyczna (UX, API, wydajność); jako gate na PR przed mergem
- Można łączyć: najpierw `cross_audit` na PR (wykrycie), a jeśli werdykt FAIL i są testy — `/regression suspect` dla dokładnej lokalizacji

---

### 7. Lekcje projektu (`/memory lesson`)

Wersjonowany `project-facts.md` ma teraz dedykowaną sekcję `## Lekcje` — miejsce na trudne problemy rozwiązane po wielu iteracjach, nietrywialne decyzje i pułapki, na które agent może natrafić ponownie. Komenda `/memory lesson <text>` dopisuje wpis z datą ISO (automatycznie tworzy sekcję, jeśli nie istnieje). Lekcje są wstrzykiwane agentowi na starcie każdej sesji razem z auto-faktami, w ramach budżetu `maxProjectMemoryTokens`.

Szczegóły w rozdziale [Dostępne komendy → `/memory lesson`](#memory-lesson-opis).

### 8. Heurystyka trudnych problemów

Komenda `/memory propose` automatycznie wykrywa **trudne problemy** — sytuacje, w których dana komenda build/test była uruchamiana ≥3 razy, z czego przynajmniej raz nieudanie (exit≠0) i ostatnie uruchomienie udane (exit=0). Taki wzorzec oznacza, że problem rozwiązano po iteracjach i jest warte zapisania lekcji, by przyszłe sesje nie musiały odkrywać tego od zera.

Generowana sekcja `## Trudne problemy (heurystyka: ≥3 iteracje → sukces)`:

```
- pytest -q tests/test_retry.py: rozwiązano po 4 iteracjach [2026-08-04..2026-08-04] (failed: tests/test_retry.py::test_retry_delay, test_retry_backoff)
- npm run build: rozwiązano po 3 iteracjach [2026-08-04]
> Jeśli któryś z tych problemów był nieoczywisty, rozważ: /memory lesson <krótki opis problem+rozwiązanie+why>
```

Heurystyka czyta `test-history.json` (zlicza uruchomienia per command, sprawdza exitCode). Jest deterministyczna — nie wymaga LLM. Propozycje zatwierdzane przez `/memory commit` lub ręcznie skopiowane do lekcji.

### 9. Ekstraktory platformy docelowej

Rozszerzenie `extractTargetPlatform` czyta repozytorium i wykrywa platformę docelową, na której projekt ma działać — to inne niż środowisko builda (host OS, WSL), bo skupia się na target runtime:

| Źródło | Wykrywanie |
| ------- | ---------- |
| `.github/workflows/*.yml` | `runs-on:` / `matrix.os:` → CI matrix (np. `ubuntu-latest, windows-latest`) |
| `electron-builder.*` | Electron desktop |
| `tauri.conf.json` | Tauri desktop |
| `capacitor.config.*` | Capacitor mobile |
| `app.json` (expo) | Expo/React Native mobile |
| `package.json` `os`/`cpu` | Target os/cpu constraints |
| `package.json` `main` | `dist/electron*` / `dist/tauri*` → desktop |
| `tsconfig.json` `lib` | `DOM` → browser, `Node` → node, oba → hybrid |

Wyjście trafia do sekcji `## Platforma docelowa` w `project-facts.auto.md`, regenerowanej automatycznie. Nie wymaga edycji ręcznej — deterministyczne.

```markdown
## Platforma docelowa
- CI matrix: ubuntu-latest, windows-latest  (.github/workflows)
- Target: Electron desktop  (electron-builder)
- tsconfig lib: DOM+Node  (hybrid/browser+node)
```

### 10. Moduł AI (Opcja A — własny tani model)

Plugin może wołać tani model AI **niezależny od modelu kodującego**, konfigurowany w sekcji `ai` plugin options. Moduł rozszerza 3 istniejące funkcje o inteligentne podsumowania, których deterministyczne ekstraktory nie potrafią:

| Funkcja | Bez AI (deterministycznie) | Z AI |
| ------- | -------------------------- | ---- |
| **Handoff sesji** (`session.idle`) | `currentStatus` puste lub wpisane ręcznie | Krótkie podsumowanie 1-2 zdania co zrobiono i na czym stiano |
| **Fakty projektu** (`project-facts.ai.md`) | Tylko auto-fakty z manifestów (build/test/arch) | Dodatkowo konwencje i ryzyka ekstrahowane z `README.md`/`CLAUDE.md`/`AGENTS.md`/`CONTRIBUTING.md` |
| **Triage testów** (`/memory ai triage`) | Lista nieudanych testów z `/memory test-history` | Proponowany root cause (max 5 krótkich punktów) |

**Konfiguracja** (w `opencode.json` plugin options):

```jsonc
"ai": {
  "enabled": true,
  "provider": "openai-compatible",   // | "ollama" (lokalny, bez apiKey) | "anthropic"
  "baseUrl": "",                      // puste = domyślny per provider
  "apiKey": "${OPENAI_API_KEY}",      // env interpolation ${VAR}; ollama nie wymaga
  "model": "gpt-4o-mini",             // tani model
  "maxTokens": 800,
  "temperature": 0,
  "timeoutMs": 15000,
  "fallbackChain": ["qwen2.5:7b"]     // kolejne modele do spróbowania
}
```

Szczegóły pól w [Konfiguracja → AI module](#ai-module-ai).

**Fallbacki (warstwowo):**

1. Brak `ai.enabled` lub brak `apiKey` (z wyjątkiem `ollama`) → moduł wyłączony cicho, plugin działa deterministycznie (status quo).
2. Błąd sieci / HTTP 4xx/5xx / timeout (`AbortController`) → retry 1× + próba kolejnych modeli z `fallbackChain` → `null`.
3. Zła odpowiedź JSON (gdy `jsonMode`) → retry 1× z `temperature: 0` → `null`.

W każdym przypadku `aiComplete()` zwraca `null` — wywołujący używa ścieżki deterministycznej. **AI nigdy nie w ścieżce krytycznej**: każde wywołanie jest opcjonalnym wzbogaceniem, nigdy blokadą.

**Pliki:**

- `.opencode/memory/project-facts.ai.md` — AI-ekstrahowane fakty z dokumentacji (regenerowane na `session.idle`, gitignored)
- `.opencode/memory/plugin-ai.log` — log błędów AI (gitignored)

**Komendy:**

- `/memory ai status` — czy AI włączone, provider, model, liczniki wołań/ sukcesów/porażek, ostatni czas i błąd
- `/memory ai triage` — analizuje ostatnie 3 nieudane testy i proponuje root cause (fallback: lista testów)

**Priorytet danych w readProjectFacts():** auto-fakty → AI-fakty → fakty ręczne (wersjonowane). Wszystko ucięte do budżetu `maxProjectMemoryTokens`.

**Bezpieczeństwo:**
- `apiKey` przez interpolację `${ENV_VAR}` — nigdy nie hardkodować w `opencode.json`
- AI czyta tylko pliki dokumentacji (`README.md`/`CLAUDE.md`/`AGENTS.md`/`CONTRIBUTING.md`), nie kod źródłowy
- Prompt systemowy zawsze po polsku, z limitem `maxTokens` (domyślnie 800)
- Timeout 15s domyślnie — AI nie blokuje `session.idle` na długo

---

## Przewodnik: 5 scenariuszy krok po kroku

Część dokumentacji napisana prostym językiem, jak dla kogoś, kto pierwszy raz widzi ten plugin. Każdy scenariusz to konkretna sytuacja + dokładne kroki.

### Scenariusz 1: Inicjalizacja środowiska po instalacji pluginu

**Sytuacja:** Zainstalowałeś plugin (`bash install.sh`), zrestartowałeś OpenCode, wpisujesz pierwszą komendę. Chcesz wiedzieć, co się dzieje i czy plugin działa.

**Co się dzieje automatycznie (nie musisz nic robić):**

1. **Na starcie sesji (`session.created`)** plugin:
   - czyta repozytorium i buduje `project-facts.auto.md` (Architektura, Komendy, Środowisko, Platforma docelowa)
   - łączy auto-fakty + ręczne `project-facts.md` (jeśli istnieje) i wstrzykuje agentowi jako `PROJECT MEMORY`
   - czyta `active-session.json` (handoff z poprzedniej sesji, jeśli był)
   - inicjalizuje metryki i dedup-cache

2. **Podczas sesji** plugin w tle:
   - skraca wyniki narzędzi (testy, buildy, diffy, grepy) do limitów z konfiguracji
   - deduplikuje powtórzone odczyty tego samego pliku (oszczędność tokenów)
   - zapisuje pełne wyniki jako artefakty (skrócone wersje + link `artifact://<id>`)
   - zapisuje każdy uruchom testu/build do `test-history.json` (z git HEAD SHA)
   - śledzi rozmiar kontekstu i pokazuje toast gdy ≥80% limitu

3. **Na koniec sesji (`session.idle`/`session.compacted`)** plugin:
   - regeneruje `project-facts.auto.md` (odświeżone po zmianach)
   - zapisuje handoff do `active-session.json` (cel, status, edytowane pliki, decyzje, blokery)
   - agreguje statystyki do `session-trace.json` (komendy, hotspoty, blokery — między sesjami)

**Jak zweryfikować, że działa:**

```text
/memory status
```

Powinieneś zobaczyć:
- `Worktree: /ścieżka/do/repo`
- `Project facts: XXX tokens` (auto-fakty + ręczne)
- `Metrics: N tool calls, X% reduction`
- `Context: ... / 200000 tokens (mode=suggest)`

Na dole ekranu TUI powinien pojawić się pasek `memory: tools:N · saved:~Xk tok · ...` (odświeżany co 3 s).

**Jeśli pasek TUI się nie pojawia:** sprawdź czy `node_modules/@opentui/solid` istnieje (TUI wymaga bibliotek runtime), czy `.opencode/tui.json` ma wpis `memory-tui.tsx`, i zrestartuj OpenCode. Pełna diagnoza w rozdziale [Rozwiązywanie problemów](#tui-plugin-pasek-statusu-na-dole-ekranu).

**Jeśli chcesz zobaczyć dokładnie co agent dostał na starcie:**

```text
/memory show
```

Trzy sekcje: `project-facts.md`, `active-session.json`, wstrzyknięty kontekst. Przydatne przy debugowaniu "dlaczego agent zachowuje się inaczej niż wczoraj".

**Pierwsze kroki po instalacji:**

1. `bash install.sh` — instalacja
2. Zrestartuj OpenCode
3. `/memory status` — weryfikacja
4. `/memory init` — opcjonalnie, tworzy szablon `project-facts.md` z auto-wykrytymi podpowiedziami (Architektura, Komendy, Środowisko wypełnione; Konwencje/Ryzyka puste z markerem `(uzupełnij)`)
5. Zedytuj `project-facts.md` — uzupełnij Konwencje (styl kodu, reguły zespołu) i Ryzyka (znane problemy). Ten plik jest wersjonowany w Git.
6. Pracuj normalnie — plugin zbiera statystyki w tle

### Scenariusz 2: Rozwiązanie problemu z popsuciem innych funkcji przy poprawianiu kodu

**Sytuacja:** Agent (model) dostał zadanie "napraw moduł A". Poprawił A, ale przy okazji dotknął B/C/D i coś zepsuł. Testy padają. Chcesz wiedzieć, który plik jest winny i jak go cofnąć bez psucia naprawy A.

Plugin oferuje dwie ścieżki: lokalną (`/regression`, darmowa) i wielomodelową (`cross_audit`, kosztuje LLM API).

**Ścieżka A — lokalna, przez `/regression` (gdy masz padający test):**

1. **Uruchom testy** (cały suite, nie tylko testy modułu A):

   ```text
   $ pytest -q
   ```

   Plugin zapisuje wpis do `test-history.json`: timestamp, exitCode=1, failed test names, git HEAD SHA.

2. **Zidentyfikuj okno regresji:**

   ```text
   /regression last-good
   ```

   Wyjście pokazuje ostatni zielony (exit=0) i pierwszy czerwony (exit≠0) wraz z SHA i nazwą padającego testu. Różnica między SHA = okno regresji.

3. **Znajdź winowajcę:**

   ```text
   /regression suspect
   ```

   Scala podejrzane pliki z 3 źródeł:
   - stan roboczy `git status` (waga 100)
   - `git diff --name-only` między SHA last-good a first-red (waga 50)
   - `session-trace.json` — najczęściej edytowane pliki (waga = licznik edycji)
   
   Sortuje wg prawdopodobieństwa winy. Nie modyfikuje żadnych plików.

4. **Cofnij winny plik do wersji last-good:**

   ```text
   /regression revert src/radio/retry.c
   ```

   W trybie bezpiecznym (`regressionSafeRevertOnly: true`, domyślnie) plugin prosi o potwierdzenie:

   ```text
   /regression revert confirm src/radio/retry.c
   ```

   Wykonuje `git checkout <last-good-sha> -- src/radio/retry.c`. To nadpisuje tylko ten jeden plik, nie psuje naprawy A. Można cofnąć przez `git checkout HEAD -- src/radio/retry.c` lub `git restore`.

5. **Uruchom testy ponownie**, by potwierdzić, że cofnięcie pomogło.

6. **Zapisz lekcję** (jeśli problem był nietrywialny):

   ```text
   /memory lesson Retry backoff: nie ruszać src/radio/backoff.c przy naprawie retry.c — backoff ma własny invariant, dotknięcie go łamie test_retry_delay
   ```

**Ścieżka B — wielomodelowa, przez `cross_audit` (gdy testów brak lub są flaky):**

1. Agent commituje zmianę (po naprawie A).
2. Uruchom audyt na zakresie commitu:

   ```json
   {
     "commitRange": "HEAD~1..HEAD",
     "lenses": ["codex", "gemini", "claude"],
     "autoFix": false
   }
   ```

3. Trzy modele równolegle czytają diff i oceniają niezależnie, czy zmiana nie psuje niczego poza intencją (UX, API, semantyka — rzeczy, których test nie pokryje).
4. Werdykt:
   - `PASS` — zmiana czysta
   - `CONDITIONAL` — są findings MEDIUM/LOW do rozpatrzenia
   - `FAIL` — 2+ modele zgodne co do HIGH; regresja potwierdzona
   - `consensus_failed` — modele się rozchodzą, wymaga człowieka
5. Jeśli `FAIL`, uruchom ponownie z `autoFix: true` — plugin automatycznie poprawi HIGH findings (na które zgodziły się 2+ modele), jako revertowalne commity.
6. Przejrzyj commity, uruchom testy, uruchom audyt ponownie by potwierdzić `PASS`.

**Kiedy której ścieżki:**

- `/regression` — masz padający test, chcesz wskazać winny plik lokalnie (zero kosztu LLM)
- `cross_audit` — testów brak, są flaky, lub regresja jest semantyczna; jako gate na PR przed mergem
- Można łączyć: `cross_audit` (wykrycie) → `/regression suspect` (dokładna lokalizacja) → `/regression revert` (cofnięcie)

### Scenariusz 3: Nawigowanie poprzez poprzednie wersje

**Sytuacja:** Pracowałeś nad feature przez kilka sesji. Teraz chcesz wrócić do stanu sprzed tygodnia, albo zobaczyć, jak wyglądał kod zanim wprowadzono regresję. Plugin zapamiętuje historię testów z git HEAD SHA — dzięki temu możesz precyzyjnie wskazać wersję, do której chcesz się cofnąć.

**Sprawdź historię testów:**

```text
/memory test-history
```

Pokazuje najnowsze uruchomienia (najnowsze na górze, domyślnie 15):

```
[2026-08-04T15:12:33Z] FAIL(1)  pytest -q tests/test_retry.py
    1 failed, 14 passed
    failed: tests/test_retry.py::test_retry_delay
[2026-08-04T14:55:01Z] OK  idf.py build
    Build complete
[2026-08-04T11:00:00Z] OK  pytest -q tests/test_retry.py
    15 passed
```

Każdy wpis ma `HEAD: <sha>` — git commit w momencie uruchomienia. To pozwala powiązać "ten test przechodził przy commit X, a pada przy commit Y".

**Znajdź ostatni dobry commit:**

```text
/regression last-good
```

Pokazuje:
- `Last good: <timestamp>  exit=0  HEAD: <sha>`  ← do tego commita chcesz się cofnąć
- `First red: <timestamp>  exit=1  HEAD: <sha>`  ← ten commit zepsuł test

**Cofnij konkretny plik do wersji z last-good** (nie cały commit, tylko winny plik):

```text
/regression revert src/radio/retry.c
/regression revert confirm src/radio/retry.c
```

Wykonuje `git checkout <last-good-sha> -- src/radio/retry.c`. Bezpieczne — nadpisuje tylko ten jeden plik. Pozostałe zmiany (np. naprawa A) zostają nietknięte.

**Cofnij wszystkie podejrzane pliki naraz:**

```text
/regression revert all
/regression revert all confirm
```

**Zachowaj bieżący stan w stash (odwracalne):**

```text
/regression revert stash
```

Wykonuje `git stash` — możesz potem przywrócić przez `git stash pop`.

**Ręcznie cofnąć przez git** (poza pluginem):

Jeśli znasz SHA z `/memory test-history` lub `/regression last-good`, możesz użyć standardowego gita:

```text
git checkout <sha> -- <plik>      # cofnij jeden plik
git stash                         # schowaj wszystko
git stash pop                     # przywróć
git log --oneline                 # zobacz historię commitów
git show <sha>                    # zobacz zmiany w commicie
```

**Bezpieczeństwo:** Plugin nigdy nie wykonuje `git reset --hard` ani `git clean`. Wszystkie operacje są odwracalne:
- `checkout <sha> -- <file>` cofa przez `git checkout HEAD -- <file>` lub `git restore`
- `stash` cofa przez `git stash pop`

### Scenariusz 4: Jak odczytywać informacje podane w TUI

**Sytuacja:** Na dole ekranu OpenCode pojawił się pasek pluginu `memory: tools:N · saved:~Xk tok · ...`. Chcesz rozumieć, co oznaczają poszczególne wartości i jak reagować na ostrzeżenia.

**Pasek statusu (slot `app_bottom`, odświeżany co 3 s):**

Trzy linie w trybie TUI (jedna w CLI):

```
memory: tools:18 · saved:~65k tok · 85% reduc. · dedup:2 · art:1 (3.0KB)
disk: 349KB / 200.0MB (0%) · art 308KB · cache 34KB
ctx: 12.0k/200.0k tok (6%, compact@80%) · facts: 480/1.5k (32%) [suggest]
```

**Linia 1 — oszczędność tokenów:**

| Fragment | Znaczenie | Jak interpretować |
| -------- | --------- | ----------------- |
| `memory:` | Prefiks (kolor: primary/akcent) | Pasek pluginu |
| `tools:N` | Liczba wywołań narzędzi w sesji | Im więcej, tym aktywniej pracujesz |
| `saved:~Xk tok` | Szacunek zaoszczędzonych tokenów (filtracja + dedup) | Koloryzacja: wartość na akcent/success — im więcej, tym lepiej |
| `X% reduc.` | Procent redukcji znaków w wynikach narzędzi | ≥50% zielony (success), ≥20% żółty (warning), <20% szary |
| `dedup:N` | Liczba deduplikowanych odczytów (gdy N>0) | Dobrze — nie wysyłamy tego samego contentu ponownie |
| `art:N (size)` | Liczba artefaktów i ich łączny rozmiar (gdy N>0) | Pełne wyniki zapisane na dysku, skrócone wysłane do modelu |

Jeśli widzisz `memory: idle` — brak wywołań narzędzi w tej sesji (np. zaraz po starcie).

**Linia 2 — dysk:**

| Fragment | Znaczenie | Jak interpretować |
| -------- | --------- | ----------------- |
| `disk: X / 200.0MB (Y%)` | Rozmiar katalogu `.opencode/memory/` vs limit 200 MB | Koloryzacja: ≥90% czerwony (error), ≥70% żółty (warning), <70% szary |
| `art X` | Rozmiar artefaktów (pełne wyniki narzędzi) | >10MB żółty — rozważ `/memory clear-session` |
| `cache X` | Rozmiar cache (dedup, test-history, metrics) | >50MB żółty — rozważ `/memory clear-session` |

Jeśli `disk` ≥90% — toast error na dole ekranu: `Pamięć pluginu 180MB (90%) — /memory clear-session`. Uruchom `/memory clear-session` by wyczyścić nietrwałe dane (zachowuje `project-facts.md` i artefakty).

**Linia 3 — kontekst + fakty:**

| Fragment | Znaczenie | Jak interpretować |
| -------- | --------- | ----------------- |
| `ctx: X/Y tok (Z%, compact@80%)` | Bieżący rozmiar kontekstu vs limit (autodetekcja z modelu lub 200k fallback); próg kompaktacji 80% | ≥80% — toast warning: `Kontekst 82% — /memory compact-now` |
| `facts: X/1.5k (Z%)` | Zużycie budżetu `maxProjectMemoryTokens` (auto + ręczne fakty) | >100% → plugin ucina kontekst + warning; rozważ skrócenie `project-facts.md` |
| `[suggest]` | Tryb kompaktacji: `suggest`/`confirm`/`auto`/`off` | `suggest` = toast + status; `confirm` = toast + dialog; `auto` = OpenCode kompaktuje sam; `off` = wyłączone |

**Dodatkowe w pasku (gdy są dane):**

Czwarta linia pojawia się gdy jest handoff lub zmiany w repo:

```
handoff: 12m · mod:3 · dec:0 · blk:0 · HEAD:abc12345 (dirty:2) · lsp:3err · last-good:abc12345
```

| Fragment | Znaczenie |
| -------- | --------- |
| `handoff: 12m` | Czas od ostatniego handoffu (`active-session.json`) |
| `mod:3` | Liczba zmodyfikowanych plików w sesji |
| `dec:0` | Liczba decyzji zapisanych w handoff |
| `blk:0` | Liczba blokerów w handoff |
| `HEAD:abc12345` | Bieżący git HEAD SHA (7 znaków) |
| `dirty:2` | Liczba plików zmienionych w `git status` |
| `lsp:3err` | Liczba błędów LSP (gdy >0) |
| `last-good:abc12345` | SHA ostatniego udanego testu (dla `/regression`) |

Piąta linia — limity cache:

```
dedup cache: 127/500 · tests: 14/50
```

| Fragment | Znaczenie |
| -------- | --------- |
| `dedup cache: 127/500` | Wpisy w LRU dedup-cache vs `maxDedupCacheEntries` |
| `tests: 14/50` | Wpisy w `test-history.json` vs `maxTestHistoryEntries` |

Szósta linia pojawia się tylko gdy moduł AI jest włączony (`ai.enabled: true`):

```
ai: openai-compatible/gpt-4o-mini · 3/3 ok · 1240ms
```

| Fragment | Znaczenie | Jak interpretować |
| -------- | --------- | ----------------- |
| `ai: provider/model` | Włączony model AI (Opcja A) | Tani model, niezależny od modelu kodującego |
| `N/M ok` | Sukcesy/wołania AI | Zielony: wszystko OK; żółty: częściowe porażki; czerwony: same porażki → fallback deterministyczny |
| `Xms` | Czas ostatniego wołania | Diagnostyka opóźnienia |
| `err: ...` | Ostatni błąd (gdy porażki >0) | Sprawdź `.opencode/memory/plugin-ai.log` i `/memory ai status` |

**Powiadomienia TUI (toast/dialog):**

Plugin automatycznie pokazuje:

| Typ | Kiedy | Co zrobić |
| --- | ----- | --------- |
| Toast warning | kontekst ≥ próg kompaktacji (mode=suggest) | `/memory compact-now` lub natywna komenda `/compact` |
| Dialog confirm | kontekst ≥ próg (mode=confirm) | Potwierdź `/memory compact-now` lub odłóż `/memory compact-reset` |
| Toast error | dysk ≥ 90% limitu 200 MB | `/memory clear-session` |

Sprawdzanie co 5 s, deduplikacja (toast nie powtarza się dopóki warunek nie zniknie i nie wróci).

**Pełny dashboard (route `memory-dashboard`):**

W trybie interaktywnym możesz przejść do pełnoekranowego dashboardu przez `api.route.navigate("memory-dashboard")` lub toast przy przekroczeniu progu. Pokazuje 8 sekcji: oszczędność tokenów, dysk, budżet kontekstu, sesja (goal/status/blokery/błędy LSP), cache, **AI module** (model, liczniki wołań/sukcesów/porażek, ostatni błąd), historia testów (10 ostatnich), artefakty (10 największych). Odświeżanie co 3 s.

**Sidebar enrichment:**

W slocie `sidebar_content` plugin dokłada blok z aktualnymi blokerami i błędami LSP (z `active-session.json`), jeśli jakieś są. Odświeżanie co 5 s. Skrócone do 60 znaków, max 3 pozycje na kategorię.

**CLI fallback (`/memory tui`):**

W trybie CLI (non-interactive, bez renderowania slotów) ten sam widok jest dostępny przez komendę `/memory tui` — zwraca 5-linijkowy blok z tymi samymi danymi. Przydatne w skryptach lub gdy TUI nie jest dostępne.

### Scenariusz 5: „Testy przechodzą, ale feature pada w środowisku docelowym"

**Sytuacja:** Opcja, którą rozwijasz (np. `retry-delay`), działa w testach jednostkowych i integracyjnych — wszystkie zielone. Po wdrożeniu w środowisku docelowym (fizyczne urządzenie, staging, produkcja) okazuje się, że feature nie działa. Chcesz mieć punkt odniesienia: „na którym commicie feature był ostatnio sprawdzony jako działający w realnym środowisku", żeby zawęzić okno zmian mogących go złamać.

To klasyczne zastosowanie `/regression feature` — znacznik `git notes` na commicie, niezależny od wyników testów lokalnych.

**Workflow:**

1. **Zdefiniuj feature do śledzenia** (raz na początek prac):

   ```text
   /regression feature add retry-delay Opcja retry-delay w module radiowym
   ```

   Zapis do `.opencode/memory/cache/features.json` — definicja jest trwała między sesjami.

2. **Po weryfikacji w środowisku docelowym** (urządzenie/staging/produkcja działa poprawnie):

   ```text
   /regression feature mark retry-delay
   ```

   Tworzy notę `git notes append` na HEAD z blokiem `feature:/status=ok/sha=<HEAD>/date=<ISO>/note=...`. Nota siedzi na commicie — historia commitów pozostaje nienaruszona, a punkt odniesienia nie ginie po commicie zmian. Wielokrotne `mark` kumulają się w jednej nocie.

3. **Gdy feature pada w środowisku docelowym** mimo zielonych testów:

   ```text
   /regression feature check retry-delay
   ```

   Znajduje ostatni commit z oznaczeniem `status=ok`, pokazuje:
   - okno czasowe: od znanego-dobrego commita do HEAD
   - commity w oknie (`git log`)
   - pliki zmienione w oknie (`git diff --name-only`)
   - diff zmian w oknie (skrócony)
   - **gotowy prompt dla modelu kodującego** — model dostaje tylko zmiany w oknie, nie cały kod

   Skopiuj prompt do nowej sesji agenta — model dostaje zawężone okno zmian i może wskazać, która z nich mogła złamać feature.

4. **Lista wszystkich śledzonych feature'ów + status:**

   ```text
   /regression feature list
   ```

   Pokazuje status per feature: `ok @ <sha>` (ostatnio oznaczony) / `nieoznaczony`.

**Kluczowa zasada:** `mark` wstawiaj **tylko** po rzeczywistej weryfikacji w środowisku docelowym, nie po testach lokalnych — celem jest punkt odniesienia dla opcji, których testy nie pokrywają pełni zachowania.

**Bezpieczeństwo:**
- `feature add` i `feature list` — read-only na `.opencode/memory/cache/features.json`
- `feature mark` — `git notes append` na HEAD (nie modyfikuje commitów, nie tworzy commitów)
- `feature check` — read-only (`git log`, `git diff`, `git notes show`)
- Żadna z operacji nie wykonuje `git commit`/`push`/`reset`

---

## Metryki i diagnostyka

Statystyki zapisywane w `.opencode/memory/cache/metrics.json`:

```json
{
  "sessionId": "ses_abc123",
  "toolCalls": 42,
  "rawChars": 485000,
  "deliveredChars": 112000,
  "deduplicatedReads": 11,
  "dedupSavedChars": 84000,
  "estimatedReductionPercent": 76.9,
  "estimatedSavedChars": 457000,
  "estimatedSavedTokens": 114250,
  "artifactsCreated": 7,
  "artifactBytes": 84000
}
```

**Oszczędność tokenów** (`estimatedSavedTokens`) to szacunek łącznej liczby tokenów, których plugin nie wysłał do modelu, z dwóch źródeł:

1. **Filtracja wyników narzędzi** — `rawChars - deliveredChars`: skracanie długich outputów (testy, build, git diff, grep) z zachowaniem kodu wyjścia, pierwszego błędu i podsumowania; limity linii (`maxToolResultLines`, `maxDiffLines`, `maxSearchMatches`).
2. **Deduplikacja odczytów** — `dedupSavedChars`: pełna długość odrzuconego contentu, gdy ten sam plik jest czytany ponownie w tej samej sesji (zgodność hash + zakres linii).

Tokeny = `chars / 4` (standardowe przybliżenie dla kodu/tekstu angielskiego; dokładna liczba zależy od tokenizatora modelu — to szacunek ±15%). Podgląd na bieżąco przez `/memory status` (aktualizowane po każdym wywołaniu narzędzia) lub `/context budget`. Metryki resetowane przez `/memory clear-session`.

Błędy pluginu logowane są w `.opencode/memory/plugin-errors.log`. Plugin działa w trybie **fail-open** — błąd nie zatrzymuje OpenCode.

---

## Rozwiązywanie problemów

### Server plugin (`/memory`, `/context`, `/regression`)

| Objaw                                     | Rozwiązanie                                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Plugin się nie ładuje                    | Sprawdź ścieżkę w `opencode.json` (`plugin: ["./.opencode/plugins/project-context.ts"]`) i zrestartuj OpenCode |
| Komendy `/memory`, `/context`, `/regression` nie działają | Upewnij się, że pliki `.md` są w `.opencode/command/` i zrestartuj OpenCode                  |
| Dane mieszają się między worktree          | Każdy worktree ma własny `.opencode/memory/` — nie współdziel katalogu między worktree       |
| Błąd w `plugin-errors.log`                | Plugin przeszedł w fail-open; sprawdź log, popraw przyczynę, usuń log                         |
| Brak redukcji wyników                      | Sprawdź `/context budget` czy limity nie są ustawione zbyt wysoko                            |
| `read_artifact` nie znajduje artefaktu     | Artefakt mógł zostać usunięty przez TTL/limit; uruchom ponownie narzędzie źródłowe            |
| Sekrety nadal widoczne                     | Dodaj własny wzorzec do `SECRET_PATTERNS` w `project-context.ts` i zgłoś w logach            |
| `/regression last-good` pokazuje „brak danych" | Uruchom testy/build, by plugin zebrał statystyki; sprawdź `/memory test-history` |
| `/regression suspect` nie pokazuje podejrzanych plików | Brak zmian w oknie lub brak SHA — włącz `regressionTrackHead: true` i uruchom test po commicie |
| `/regression revert` prosi o `confirm`      | Tryb bezpieczny (`regressionSafeRevertOnly: true`); wpisz `/regression revert confirm <plik>` lub ustaw `false` |
| Po restarcie deduplikacja nie działa        | Sprawdź `persistentDedupCache: true` i istnienie `.opencode/memory/cache/dedup-seen.json` |
| `/memory ai status` pokazuje "wyłączone"   | Dodaj sekcję `ai` w `opencode.json` plugin options z `enabled: true` i `apiKey` (lub `provider: "ollama"`) |
| `/memory ai triage` zwraca listę testów zamiast root cause | AI niedostępne (brak `apiKey`, błąd sieci, timeout) — fallback deterministyczny. Sprawdź `/memory ai status` i `.opencode/memory/plugin-ai.log` |
| `project-facts.ai.md` się nie tworzy         | Włącz `ai.enabled` i upewnij się że w repo istnieje `README.md`/`CLAUDE.md`/`AGENTS.md`/`CONTRIBUTING.md` |

### TUI plugin (pasek statusu na dole ekranu)

Pasek TUI nie pojawia się, albo pojawia się błąd? Diagnoza krok po kroku:

| Objaw | Przyczyna | Rozwiązanie |
| ----- | --------- | ----------- |
| Brak paska, brak błędów w logu | TUI plugin NIE zarejestrowany — wpis w `opencode.json` zamiast `.opencode/tui.json` | Przenieś wpis do `.opencode/tui.json` (format: `"plugin": [["./plugins/memory-tui.tsx", { "enabled": true }]]`). `opencode.json` jest tylko dla server pluginów. |
| Brak paska + `Plugin export is not a function` w logu | Plik `.tsx` wpisany do `opencode.json` jako server plugin | Jak wyżej — TUI pluginy idą do `tui.json`, NIE do `opencode.json`. |
| Brak paska po poprawnej rejestracji | Brak bibliotek runtime: `@opentui/solid`, `solid-js` | Uruchom `npm install` w katalogu repo (root `package.json` musi mieć zależności TUI). Sprawdź: `ls node_modules/@opentui/solid node_modules/solid-js`. |
| Brak paska, plugin-meta.json nie ma wpisu `memory-tui` | Moduł się nie załadował (błąd importu cichy) | Sprawdź `.opencode/memory/tui-trace.log` (jeśli istnieje — plugin ma wbudowane logowanie śladu). Brak pliku = import failed przed wykonaniem kodu. |
| Pasek był, zniknął po edycji pluginu | TUI cache — opencode może cacheować moduł | Pełny restart OpenCode (exit + `opencode --continue`). Konfiguracja TUI nie przeładowuje się na gorąco. |
| `tsc` błędy w `memory-tui.tsx` | Brak SDK/typów w `.opencode/node_modules/` | `cd .opencode && npm install` (tworzy `@opencode-ai/plugin` z `tui.d.ts`). |
| Błąd `failed to load plugin: solid-stub.d.ts` | Pozostały plik-stub w `.opencode/plugins/` skanowany przez auto-discovery server pluginów | Usuń `solid-stub.d.ts` z `.opencode/plugins/` (nie jest potrzebny — realny `@opentui/solid` jest w `node_modules/`). |

**Diagnostyka TUI — plik śladu:** Plugin zawiera wbudowane logowanie diagnostyczne do `.opencode/memory/tui-trace.log` (gitignored). Po restarcie OpenCode plik pokazuje kolejne fazy ładowania:

```
2026-08-04T13:47:06.403Z module-eval              ← moduł zaimportowany OK
2026-08-04T13:47:06.432Z tui-enter {...}          ← aktywacja tui() rozpoczęta
2026-08-04T13:47:06.432Z route-registered
2026-08-04T13:47:06.432Z sidebar-registered
2026-08-04T13:47:06.433Z app-bottom-registered     ← slot zarejestrowany
2026-08-04T13:47:06.433Z tui-done                 ← aktywacja OK (brak throw)
2026-08-04T13:47:06.486Z render-app_bottom {...}   ← host renderuje slot z danymi
```

Jeśli ślad kończy się na `module-eval` bez `tui-enter` — aktywacja się nie uruchomiła (plugin wyłączony w KV/`plugin_enabled`). Jeśli brak `render-app_bottom` — host nie renderuje slotu (sprawdź wersję OpenCode ≥ 1.18). Jeśli jest `tui-throw` lub `render-*-throw` — błąd w kodzie pluginu (zobacz `error` w śladzie).

**Plugin manager TUI:** Wewnątrz OpenCode otwórz paletę komend (domyślnie `Ctrl+P`) → wpisz „Plugins" → lista pokazuje każdy plugin z jego stanem `enabled`/`active`. `memory-tui` powinien być widoczny z `active=true`. Jeśli `active=false` mimo `enabled=true` — aktywacja zcrashowała (zobacz ślad).

### Modyfikacja pluginu

Plugin jest jednym plikiem TypeScript. Wszelkie reguły (filtry, maskowanie, limity, wzorce komend build/test) można dostosować bezpośrednio w `.opencode/plugins/project-context.ts`, a następnie zrestartować OpenCode.

### Reset pamięci

- Tylko bieżąca sesja: `/memory clear-session`
- Cały projekt: `/memory clear-project` (usuwa też `project-facts.md` — utwórz go ponownie po resecie)

---

## Licencja i status

Plugin jest prototypem MVP zgodnym z etapami 1–3 specyfikacji `PLUGIN.md`, rozszerzonym o trwały cache LRU, auto-ekstrakcję faktów, pamięć stanu testów oraz wykrywanie/cofanie regresji. Server plugin (`project-context.ts`) nie ma zewnętrznych zależności npm — czysty TypeScript z wbudowanymi modułami Node. TUI plugin (`memory-tui.tsx`) wymaga bibliotek runtime `@opentui/solid` + `@opentui/core` + `solid-js` (instalowane przez `npm install`). Brak zależności sieciowych, brak telemetrii, brak zewnętrznego LLM. Wszystkie operacje lokalne.