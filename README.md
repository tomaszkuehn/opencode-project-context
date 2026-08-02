# opencode-project-context

Lokalny plugin do [OpenCode](https://opencode.ai) ograniczający zużycie tokenów przez utrzymanie trwałej pamięci projektu per repozytorium, skracanie wyników narzędzi, deduplikację odczytów, zarządzanie budżetem kontekstu, auto-ekstrakcję faktów projektu oraz wykrywanie i cofanie regresji. Działa lokalnie, offline, bez zewnętrznych API.

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
- [Metryki i diagnostyka](#metryki-i-diagnostyka)
- [Rozwiązywanie problemów](#rozwiązywanie-problemów)

---

## Wymagania

- [OpenCode](https://opencode.ai) z obsługą pluginów (zobacz [docs/plugins](https://opencode.ai/docs/plugins/))
- Runtime **Bun** uruchamiający OpenCode (pluginy ładowane są automatycznie z `.opencode/plugins/`)
- Git w repozytorium (opcjonalnie, ale zalecane — wykorzystywany do stanu pracy)
- Dla instalacji skryptem: shell kompatybilny z POSIX (Git Bash na Windows, bash/zsh na Linuksie/macOS) — brak dodatkowych zależności

Plugin to czysty TypeScript bez zewnętrznych zależności npm (używa wyłącznie API `@opencode-ai/plugin` oraz wbudowanych modułów Node: `fs`, `path`, `crypto`).

---

## Instalacja

### Opcja A: skrypt instalacyjny (zalecane)

Najszybsza metoda — jeden skrypt `install.sh` kopiuje plugin, komendy, tworzy katalogi pamięci, generuje `opencode.json`, dopisuje `.gitignore` i tworzy szablon `project-facts.md`. Skrypt jest **idempotentny** — można uruchamiać wielokrotnie bez nadpisywania istniejącej konfiguracji i faktów.

```bash
# W katalogu repozytorium, gdzie skopiowano ten projekt:
bash install.sh

# Lub instalacja w innym katalogu docelowym:
bash install.sh /sciezka/do/twojego-repo
```

Co robi skrypt krok po kroku:

1. Kopiuje `project-context.ts` → `.opencode/plugins/`
2. Kopiuje `memory.md` i `context.md` → `.opencode/command/`
3. Tworzy katalog `.opencode/memory/` i szablon `project-facts.md` (tylko jeśli brak)
4. Tworzy `opencode.json` z rejestracją pluginu i konfiguracją `contextOptimizer` (tylko jeśli brak)
5. Dopisuje brakujące wpisy do `.gitignore`
6. Wypisuje podsumowanie z kolejnymi krokami

Jeśli `opencode.json` już istnieje, skrypt nie nadpisuje go, ale ostrzega o brakujących wpisach (`plugin`, `contextOptimizer`) i podpowiada ręczną edycję. Istniejący `project-facts.md` jest zawsze zachowywany.

**Weryfikacja po instalacji:**

```bash
ls .opencode/plugins/project-context.ts   # plugin
ls .opencode/command/                       # komendy memory.md, context.md
cat opencode.json                           # rejestracja + konfiguracja
```

Następnie zrestartuj OpenCode i wpisz `/memory status`, aby potwierdzić działanie.

### Opcja B: ręczna instalacja w istniejącym repo

1. Umieść plugin w repozytorium docelowym:

```
<twoje-repo>/.opencode/plugins/project-context.ts
```

2. Skopiuj komendy:

```
<twoje-repo>/.opencode/command/memory.md
<twoje-repo>/.opencode/command/context.md
```

3. Dodaj do `<twoje-repo>/opencode.json` sekcję rejestrującą plugin i konfigurację budżetu:

```json
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
    "storeFullArtifacts": true
  }
}
```

4. Dodaj wykluczenia do `<twoje-repo>/.gitignore`:

```gitignore
.opencode/memory/active-session.json
.opencode/memory/session-history/
.opencode/memory/artifacts/
.opencode/memory/cache/
.opencode/memory/index/
.opencode/memory/plugin-errors.log
```

5. (Opcjonalnie) Utwórz plik faktów projektu `.opencode/memory/project-facts.md` — zobacz [strukturę poniżej](#project-factsmd).

6. **Zrestartuj OpenCode**, aby plugin i komendy zostały załadowane. Konfiguracja nie przeładowuje się na gorąco.

### Opcja C: globalny plugin (wszystkie projekty)

Skopiuj `project-context.ts` do `~/.config/opencode/plugins/`. Pamiętaj jednak, że pamięć projektu jest zawsze per worktree — dane dwóch repozytoriów nie będą się mieszać. Konfigurację `contextOptimizer` dodaj wtedy w `~/.config/opencode/opencode.json`.

---

## Struktura plików

Plugin tworzy i utrzymuje następujący układ w repozytorium:

```
<repo>/
  .opencode/
    plugins/
      project-context.ts          # kod pluginu (wersjonowany)
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
  opencode.json                   # rejestracja + konfiguracja
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

Zmiany konfiguracji wymagają restartu OpenCode.

---

## Dostępne komendy

Plugin udostępnia dwa zestawy komend wpisywane w TUI OpenCode: `/memory` (zarządzanie pamięcią projektu) oraz `/context` (diagnostyka budżetu i artefaktów). Obsługa odbywa się przez hook `tui.command.execute`. Wszystkie komendy działają lokalnie, modyfikują wyłącznie dane w `.opencode/memory/` i nie wpływają na pliki źródłowe projektu.

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

Próbuje wymusić kompaktację przez `tui.executeCommand` (komenda `/compact`). Jeśli OpenCode nie wspiera tej komendy przez API, wypisuje instrukcję ręczną. W trybie `auto` z `compaction.auto: true` (konfiguracja OpenCode) kompaktacja nastąpi automatycznie przy następnym `message`.

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

### Szybkie przykłady

```
/memory status            # czy plugin działa poprawnie?
/memory show              # co agent dostał na starcie?
/context budget           # czy limity są dobrze dobrane?
/context artifacts        # które pełne logi są dostępne?
/memory save               # zachowaj stan przed przerwą
/memory clear-session     # wyczyść sesję, zostaw fakty
/memory compact           # odśwież handoff ręcznie
/memory propose           # zobacz propozycje faktów z sesji
/memory commit            # dopisz propozycje do project-facts.md
/memory auto              # pokaż auto-wygenerowane fakty (.auto.md)
/memory auto-refresh     # ręcznie zregeneruj .auto.md
/memory init             # wypełnij project-facts.md podpowiedziami z repo
/memory compact-status   # rozmiar kontekstu + próg kompaktacji
/memory compact-now      # wymuś kompaktację (lub instrukcja)
/memory compact-reset    # zresetuj flagę sugestii
/memory test-history      # historia uruchomień testów/buildów
/memory tui              # tekstowy widok TUI (działa w CLI)
/regression last-good     # kiedy testy przeszły ostatnio?
/regression suspect       # które pliki/commity spowodowały regresję?
/regression revert stash  # zstashuj zmiany (odwracalne)
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
- **Środowisko** — `.nvmrc`, `.node-version`, `.python-version`, `.ruby-version`, `.tool-versions`, `mise.toml`, `Dockerfile` (FROM)

Plik `.auto.md` jest dodawany do `.gitignore` (regenerowany, nie wersjonowany). `project-facts.md` pozostaje dla faktów ręcznych (ryzyka, konwencje zespołu) i jest wersjonowany. Wstrzykiwany kontekst to połączenie obu, ucięte do budżetu. Komendy `/memory auto` i `/memory auto-refresh` pozwalają podejrzeć i ręcznie odświeżyć auto-fakty. Konfiguracja: `autoExtractFacts: false` wyłącza funkcję; `autoExtractOnEvents: []` wyłącza auto-regenerację, zostawiając tylko `/memory auto-refresh`.

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

### Modyfikacja pluginu

Plugin jest jednym plikiem TypeScript. Wszelkie reguły (filtry, maskowanie, limity, wzorce komend build/test) można dostosować bezpośrednio w `.opencode/plugins/project-context.ts`, a następnie zrestartować OpenCode.

### Reset pamięci

- Tylko bieżąca sesja: `/memory clear-session`
- Cały projekt: `/memory clear-project` (usuwa też `project-facts.md` — utwórz go ponownie po resecie)

---

## Licencja i status

Plugin jest prototypem MVP zgodnym z etapami 1–3 specyfikacji `PLUGIN.md`, rozszerzonym o trwały cache LRU, auto-ekstrakcję faktów, pamięć stanu testów oraz wykrywanie/cofanie regresji. Brak zależności sieciowych, brak telemetrii, brak zewnętrznego LLM. Wszystkie operacje lokalne.