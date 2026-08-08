

# zrob mi opis dla dewelopera, ktory mialby taki plugin zbudowac

Poniżej jest gotowy brief/PRD dla dewelopera. Zakłada lokalny plugin OpenCode, działający per repozytorium, którego celem jest ograniczenie tokenów bez pogorszenia jakości pracy agenta. OpenCode ładuje pluginy TypeScript/JavaScript z `.opencode/plugins/` i udostępnia m.in. hooki sesji, plików, narzędzi oraz LSP.[^1][^2]

# Specyfikacja: Project Context Optimizer

## Cel produktu

Zbudować plugin **`opencode-project-context`** dla OpenCode, który:

- utrzymuje trwałą pamięć kontekstu oddzielnie dla każdego projektu;
- automatycznie ogranicza objętość kontekstu wysyłanego do modelu;
- redukuje nadmiarowe wyniki narzędzi, logi, diffy oraz wielokrotne odczyty tych samych plików;
- zachowuje wystarczające dane techniczne, aby agent nadal poprawnie implementował, debugował i testował kod;
- działa lokalnie, offline i bez zależności od zewnętrznego API w wersji MVP.

Priorytetem jest redukcja tokenów wejściowych i stabilniejsze sesje przy pracy z dużymi repozytoriami, szczególnie C/C++, Python, TypeScript oraz projektami embedded.

## Zakres MVP

Wersja pierwsza ma obejmować:

1. Trwałą pamięć projektu.
2. Krótki handoff sesji.
3. Filtrowanie i skracanie wyników narzędzi.
4. Deduplicację odczytanego kontekstu.
5. Limit tokenowy/budżetowy dla kontekstu.
6. Podstawowe polecenia agenta do diagnostyki i ręcznego zarządzania pamięcią.

Wersja MVP **nie powinna** zawierać embeddingów, vector DB, chmury, zewnętrznego LLM ani automatycznego generowania streszczeń przez dodatkowy model. Wstępnie należy wykorzystywać reguły, metadane plików, Git i dane z bieżącej sesji.

## Integracja z OpenCode

Plugin ma być instalowany lokalnie w repozytorium:

```text
<repo>/
  .opencode/
    plugins/
      project-context.ts
```

Plugin OpenCode jest modułem JavaScript/TypeScript eksportującym funkcję, która otrzymuje m.in. dane projektu, katalog roboczy, worktree, klienta SDK oraz API shell Bun.[^1]

Wymagane hooki:


| Hook / zdarzenie | Zastosowanie |
| :-- | :-- |
| `session.created` | Inicjalizacja pamięci i wstrzyknięcie krótkiego kontekstu projektu |
| `session.idle` | Zapis bieżącego handoffu po zakończeniu aktywnej pracy |
| `session.compacted` | Zapis stanu przed/po kompaktacji oraz odtworzenie istotnego kontekstu |
| `session.deleted` | Opcjonalne usunięcie nietrwałych danych sesji |
| `tool.execute.before` | Limity, reguły bezpieczeństwa, deduplikacja i kontrola poleceń |
| `tool.execute.after` | Analiza wyniku, skracanie, cache i rejestr artefaktów |
| `file.edited` | Oznaczenie pliku jako zmienionego i aktualizacja stanu pracy |
| `lsp.client.diagnostics` | Zapamiętanie aktywnych błędów i diagnostyki bez pełnego logu |
| `command.executed` | Obsługa komend użytkownika, np. `/memory status` |

OpenCode wystawia hooki `tool.execute.before` i `tool.execute.after`, a także zdarzenia dotyczące sesji, plików, LSP i komend.[^2][^1]

## Struktura danych

Dane pluginu muszą być przypisane do aktualnego worktree/projektu.

```text
<repo>/
  .opencode/
    memory/
      project-facts.md
      active-session.json
      session-history/
        <session-id>.json
      artifacts/
        <hash>.log
      cache/
        tool-results.json
      index/
        files.json
```

Domyślnie do `.gitignore` należy dodać:

```gitignore
.opencode/memory/active-session.json
.opencode/memory/session-history/
.opencode/memory/artifacts/
.opencode/memory/cache/
.opencode/memory/index/
```

Plik `project-facts.md` może być wersjonowany, jeśli zespół zaakceptuje go jako część dokumentacji technicznej.

### `project-facts.md`

Ma przechowywać wyłącznie informacje wysokiej wartości i niskiej objętości:

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

Maksymalny docelowy rozmiar: **1 500–2 000 tokenów**. Plugin musi przy odczycie ucinać nadmiar i logować ostrzeżenie, że plik przekracza limit.

### `active-session.json`

Przykładowy format:

```json
{
  "schemaVersion": 1,
  "sessionId": "ses_abc123",
  "updatedAt": "2026-07-30T15:00:00Z",
  "goal": "Naprawić retry transmisji po timeout downlinku",
  "currentStatus": "Zidentyfikowano błąd w src/radio/retry.c",
  "modifiedFiles": [
    "src/radio/retry.c",
    "tests/test_retry.py"
  ],
  "decisions": [
    "Maksymalnie 3 retry",
    "Backoff wykładniczy z limitem 30 s"
  ],
  "commands": {
    "build": "idf.py build",
    "test": "pytest -q tests/test_retry.py"
  },
  "testStatus": {
    "lastCommand": "pytest -q tests/test_retry.py",
    "exitCode": 1,
    "summary": "1 failed, 14 passed"
  },
  "blockers": [
    "Brak testu integracyjnego dla symulowanego downlinku"
  ]
}
```

Nie zapisywać pełnych promptów, odpowiedzi modelu, sekretów, pełnego kodu ani kompletnych logów w tym pliku.

## Funkcje

### Inicjalizacja sesji

Przy `session.created` plugin ma:

1. Ustalić root repozytorium i bieżący worktree.
2. Odczytać `project-facts.md`.
3. Odczytać ostatni `active-session.json`, jeśli istnieje.
4. Pobierać minimalny stan Git:
    - branch,
    - krótki SHA `HEAD`,
    - listę zmodyfikowanych plików,
    - maksymalnie 20 ostatnich nazw plików z `git diff --name-only`.
5. Utworzyć zwięzły blok kontekstu dla agenta.

Przykładowy blok:

```text
PROJECT MEMORY
Architecture: ESP-IDF; FreeRTOS queues; no blocking in ISR.
Rules: no dynamic allocation in critical paths; public API requires tests.
Previous task: Retry after downlink timeout.
Changed files: src/radio/retry.c, tests/test_retry.py.
Last test: 1 failed, 14 passed; failure: retry timeout expectation.
```

Docelowy limit wstrzykniętego kontekstu: **maksymalnie 1 500 tokenów**.

### Handoff sesji

Przy `session.idle` i `session.compacted` plugin ma utworzyć lub zaktualizować `active-session.json`.

Należy zapisać:

- cel aktualnej pracy;
- pliki odczytane i edytowane w bieżącej sesji;
- decyzje implementacyjne wykryte na podstawie zmian;
- ostatni wynik builda/testów;
- aktualne błędy LSP;
- otwarte blokery;
- zalecany następny krok.

Handoff ma mieć limit około **800–1 200 tokenów** po serializacji do formatu tekstowego.

### Filtr wyników narzędzi

Plugin ma redukować dane zwracane przez narzędzia bez ukrywania informacji koniecznych do debugowania.

#### Reguły globalne

- Każdy wynik narzędzia powinien mieć limit rozmiaru, domyślnie 80–120 linii.
- Pełny wynik należy zachować lokalnie jako artefakt, jeśli jest większy od limitu.
- Skrót musi zawierać identyfikator artefaktu.
- Agent może odczytać pełny wynik fragmentami przez dedykowane narzędzie pluginu.
- Plugin musi zawsze zachować kod wyjścia procesu, pierwsze błędy i końcową sekcję podsumowania.


#### Build i testy

Dla `npm test`, `pytest`, `idf.py build`, `cmake --build`, `make`, `cargo test` i podobnych:

- zachowaj `exit code`;
- zachowaj listę testów błędnych;
- zachowaj pierwszy właściwy stack trace/błąd kompilatora;
- zachowaj 20–40 linii w pobliżu błędu;
- zachowaj końcowe podsumowanie testów/builda;
- usuń powtarzalne ostrzeżenia i sukcesy, jeśli nie są istotne.

Przykład skrótu:

```text
Command failed: pytest -q tests/test_retry.py (exit 1)
Result: 1 failed, 14 passed.
Failure: tests/test_retry.py:87
Expected retry delay: 4 s; actual: 2 s.
Relevant source: src/radio/retry.c:114.
Full output available: artifact://a71d8c
```


#### `git diff`

Dla `git diff`:

- pokaż listę zmienionych plików;
- dla każdego pliku pokaż statystykę `+/-`;
- pokaż maksymalnie 1–3 najistotniejsze hunki;
- maksymalnie 120 linii łącznie;
- jeśli diff jest większy, zapisz pełną wersję jako artefakt.

Nie wolno automatycznie usuwać hunka zawierającego błąd kompilacji, aktywną diagnostykę LSP albo plik aktualnie edytowany.

#### `grep`, `rg`, wyszukiwanie kodu

Dla `grep` i `rg`:

- maksymalnie 30–50 dopasowań;
- każde dopasowanie: ścieżka, numer linii i maksymalnie 2 linie kontekstu;
- grupowanie po pliku;
- usuwanie identycznych dopasowań;
- preferowanie plików aplikacyjnych nad katalogami typu `node_modules`, `build`, `.git`, `vendor`, `dist`, `coverage`.


#### Odczyt plików

Dla narzędzia `read`:

- rejestruj hash pliku i zakres odczytanych linii;
- jeśli identyczny zakres tego samego pliku był już dostarczony w aktywnej sesji, zwróć skrót zamiast pełnej treści;
- jeśli plik zmienił się od poprzedniego odczytu, nie używaj cache;
- dla dużych plików preferuj odczyt sekcji wokół funkcji, symbolu lub miejsca błędu.


### Deduplicacja

Należy prowadzić pamięć krótkotrwałą dla sesji:

```ts
type SeenContext = {
  filePath: string
  contentHash: string
  lineStart?: number
  lineEnd?: number
  deliveredAt: string
  source: "read" | "grep" | "diff" | "lsp" | "command"
}
```

Zasady:

- nie wysyłaj drugi raz identycznej zawartości;
- zamiast pełnej treści zwróć: „ten zakres był już dostępny w sesji; hash: …”;
- jeżeli model eksplicytnie poprosi o ponowny odczyt, pozwól na niego;
- w przypadku zmiany pliku unieważnij odpowiedni wpis cache;
- cache sesji nie może być używany między różnymi projektami/worktree.


### Budżet kontekstu

Plugin ma zarządzać kontekstem jako budżetem, nie tylko limitem pojedynczego wyniku.

Domyślna konfiguracja:

```json
{
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

Jeżeli limit jest przekroczony, priorytety danych są następujące:

1. Aktualny komunikat użytkownika.
2. Błędy builda/testów i diagnostyka LSP.
3. Kod aktualnie modyfikowany.
4. Projektowe fakty i konwencje.
5. Ostatni handoff.
6. Wyniki wyszukiwania kodu.
7. Stare logi, pełne diffy i powtarzalne dane.

Plugin powinien odrzucać dane od końca tej listy, nie dane krytyczne dla poprawności.

### Artefakty pełnych wyników

Dla skróconych wyników twórz artefakt:

```text
.opencode/memory/artifacts/<sha256>.log
```

Plugin ma udostępnić narzędzie:

```text
read_artifact
```

Parametry:

```json
{
  "artifactId": "a71d8c",
  "offset": 0,
  "limit": 100,
  "search": "error"
}
```

Wynik ma być stronicowany i ograniczony do skonfigurowanego limitu. Dzięki temu agent może pobrać dokładnie ten fragment logu, którego potrzebuje, zamiast ponownie otrzymywać pełny output.

### Komendy użytkownika

Dodać następujące komendy:

```text
/memory status
/memory show
/memory save
/memory clear-session
/memory clear-project
/memory compact
/context budget
/context artifacts
```

Znaczenie:

- `/memory status` — rozmiary pamięci, liczba artefaktów, ostatnia aktualizacja, aktywny worktree;
- `/memory show` — pokazuje obecny projektowy kontekst i handoff;
- `/memory save` — wymusza zapis handoffu;
- `/memory clear-session` — usuwa cache i stan bieżącej sesji, nie usuwa `project-facts.md`;
- `/memory clear-project` — wymaga potwierdzenia, usuwa całą pamięć lokalną projektu;
- `/memory compact` — ręcznie tworzy krótki handoff;
- `/context budget` — pokazuje wykorzystanie limitów;
- `/context artifacts` — pokazuje ostatnie pełne logi/diffy dostępne do selektywnego odczytu.


## Bezpieczeństwo

Plugin nie może automatycznie umieszczać w pamięci trwałej:

- `.env`, `.env.*`;
- kluczy prywatnych, certyfikatów, tokenów i haseł;
- plików `credentials`, `secrets`, `id_rsa`, `*.pem`, `*.p12`, `*.kdbx`;
- danych z katalogów skonfigurowanych jako prywatne;
- surowych treści plików binarnych.

W `tool.execute.before` należy blokować lub wymagać jawnej zgody na odczyt takich plików. OpenCode umożliwia przechwycenie wykonania narzędzia przed jego uruchomieniem, co pozwala wdrożyć tę politykę na poziomie pluginu.[^3][^4]

Należy stosować maskowanie wzorców sekretów także w logach i artefaktach, np.:

- `API_KEY=...`
- `Bearer ...`
- GitHub PAT;
- AWS Access Key;
- typowe nagłówki `Authorization`.


## Wymagania jakościowe

- Brak sieci i brak telemetrii w MVP.
- Brak wpływu na pliki źródłowe projektu.
- Operacje pluginu nie powinny zwiększać czasu odpowiedzi o więcej niż około 100 ms dla typowego wyniku narzędzia.
- Cache i artefakty muszą być ograniczane przez TTL oraz maksymalny rozmiar katalogu, np. 200 MB.
- Po przekroczeniu limitu należy usuwać najstarsze artefakty, z pominięciem aktywnej sesji.
- Błąd pluginu nie może zatrzymywać OpenCode; należy przejść w tryb fail-open i zapisać diagnostykę lokalnie.
- Każdy skrót ma zachowywać odniesienie do źródła: komenda, plik, zakres linii, hash lub artifact ID.


## Kryteria akceptacji

Implementację uznajemy za gotową do MVP, jeżeli:

- Nowa sesja otrzymuje projektową pamięć i ostatni handoff, bez mieszania danych z innym repozytorium.
- Po `session.idle` powstaje aktualny `active-session.json`.
- Długi output testów/builda jest skracany, ale zawiera kod wyjścia, pierwszy właściwy błąd, lokalizację i podsumowanie.
- Pełny wynik można pobrać fragmentami przez `read_artifact`.
- Drugi identyczny odczyt nie powoduje ponownego przekazania pełnej treści do modelu.
- Modyfikacja pliku unieważnia cache jego odczytu.
- `git diff` większy niż limit jest streszczany i archiwizowany.
- Sekrety nie trafiają do `project-facts.md`, `active-session.json`, cache ani artefaktów.
- Plugin działa lokalnie dla dwóch różnych worktree tego samego repo bez krzyżowania stanu.
- `/memory status` pokazuje wykorzystanie pamięci i budżetu kontekstu.


## Etapy implementacji

### Etap 1: Fundament

- Szkielet pluginu TypeScript.
- Identyfikacja projektu/worktree.
- Odczyt i zapis `project-facts.md` oraz `active-session.json`.
- Hooki `session.created`, `session.idle`, `session.compacted`.
- Komendy `/memory status`, `/memory show`, `/memory save`.


### Etap 2: Redukcja danych

- Hooki `tool.execute.before` i `tool.execute.after`.
- Filtry dla testów, buildów, `git diff`, `grep` i `read`.
- Artefakty pełnych wyników.
- Narzędzie `read_artifact`.
- Cache/deduplicacja per sesja.


### Etap 3: Jakość selekcji

- Rejestr edytowanych plików.
- Integracja z Git i LSP.
- Priorytetyzacja kontekstu wokół aktywnych błędów.
- Statystyki rzeczywistej redukcji danych.


### Etap 4: Opcjonalnie

- Indeks symboli z LSP.
- Lekki SQLite zamiast JSON.
- Semantyczne wyszukiwanie lokalne.
- Opcjonalny lokalny model do generowania streszczeń, wyłączony domyślnie.

### Etap 5: Moduł AI (Opcja A — własny tani model)

Zaimplementowano jako rozszerzenie pluginu. Moduł woła tani model AI (niezależny od modelu kodującego) konfigurowany w sekcji `ai` plugin options, bezpośrednio przez HTTP `fetch` — bez użycia SDK OpenCode do sterowania modelem kodującym.

**Zakres:**

1. **Handoff sesji** (`session.idle`): LLM podsumowuje przebieg sesji do 1-2 zdań → `active-session.currentStatus`. Fallback: puste (deterministycznie).
2. **Fakty projektu** (`project-facts.ai.md`): LLM ekstrahuje konwencje i ryzyka z `README.md`/`CLAUDE.md`/`AGENTS.md`/`CONTRIBUTING.md`. Fallback: brak pliku (używane są tylko auto-fakty deterministyczne).
3. **Triage testów** (`/memory ai triage`): LLM analizuje ostatnie 3 nieudane testy i proponuje root cause. Fallback: deterministyczna lista testów.

**Konfiguracja:**

```jsonc
"ai": {
  "enabled": false,                  // domyślnie wyłączone
  "provider": "openai-compatible",   // | "ollama" | "anthropic"
  "baseUrl": "",                     // puste = domyślny per provider
  "apiKey": "",                       // ${ENV_VAR} interpolacja; ollama nie wymaga
  "model": "gpt-4o-mini",
  "maxTokens": 800,
  "temperature": 0,
  "timeoutMs": 30000,
  "fallbackChain": [],                 // kolejne modele do spróbowania
  "minIntervalMs": 600000              // min. odstęp między auto-wywołaniami (session.idle); 0 = bez throttle
}
```

**Fallbacki (warstwowo):** brak `enabled`/`apiKey` → moduł wyłączony; błąd sieci/HTTP/timeout → retry 1× + `fallbackChain`; zły JSON → retry `temp:0`. `aiComplete()` zawsze zwraca `null` przy błędzie — nigdy nie rzuca. Wywołujący używa ścieżki deterministycznej. **AI nigdy nie w ścieżce krytycznej.**

**Ograniczenie częstotliwości:** auto-wywołania na `session.idle`/`compacted` są pomijane gdy sesja nic nie zmieniła (czysty `git status` + brak testów) oraz throttle'owane co `minIntervalMs` (domyślnie 10 min). Komendy na żądanie (`/codemem ai triage`) i health check ignorują throttle.

**Dynamiczny timeout:** twardy cutoff = `timeoutMs × 1.5` (50% bufor). Plugin śledzi czas każdego promptu; gdy ≥80% limitu → ostrzeżenie „zbliża się", gdy >100% → info „przekroczył, wymaga wydłużenia" (w TUI). `/codemem ai auto-timeout` ustawia `timeoutMs` = `maxObservedMs × 1.3` (min. 30 s), zapisuje override w cache (przeżywa restarty).

**Pliki:** `project-facts.ai.md` (regenerowane, gitignored), `plugin-ai.log` (log błędów, gitignored), `ai-max-observed.json` (najdłuższy prompt, gitignored), `ai-timeout-override.json` (override z auto-timeout, gitignored).

**Komendy diagnostyczne:** `/memory ai status`, `/memory ai auto-timeout`, `/memory ai triage`.


## Metryki

Plugin powinien zapisywać lokalne statystyki w JSON:

```json
{
  "sessionId": "ses_abc123",
  "toolCalls": 42,
  "rawChars": 485000,
  "deliveredChars": 112000,
  "estimatedReductionPercent": 76.9,
  "deduplicatedReads": 11,
  "artifactsCreated": 7,
  "artifactBytes": 84000,
  "ai": {
    "enabled": true,
    "provider": "openai-compatible",
    "model": "gpt-4o-mini",
    "calls": 3,
    "successes": 3,
    "failures": 0,
    "lastCallMs": 1240,
    "lastError": ""
  }
}
```

W MVP wystarczy estymacja na podstawie liczby znaków podzielonej przez 4; nie należy przedstawiać tego jako dokładnego licznika tokenów, bo tokenizacja zależy od konkretnego modelu.
<span style="display:none">[^10][^11][^12][^13][^14][^15][^5][^6][^7][^8][^9]</span>

<div align="center">⁂</div>

[^1]: https://opencode.ai/docs/plugins/

[^2]: https://dev.opencode.ai/docs/th/plugins/

[^3]: https://gist.github.com/johnlindquist/0adf1032b4e84942f3e1050aba3c5e4a

[^4]: https://opencode.io.vn/docs/plugins/

[^5]: https://opencode.ai/docs/ja/plugins/

[^6]: https://gist.github.com/rstacruz/946d02757525c9a0f49b25e316fbe715

[^7]: https://opencode.ai/docs/zh-cn/plugins/

[^8]: https://open-code.ai/ru/docs/plugins

[^9]: https://symposium.dev/design/agent-details/opencode.html

[^10]: https://opencode.ai/docs/de/plugins/

[^11]: https://www.youtube.com/watch?v=Wu3G1QwM81M

[^12]: https://github.com/Steffen025/pai-opencode/blob/main/docs/PLUGIN-SYSTEM.md

[^13]: https://learnopencode.com/en/5-advanced/12c-hooks

[^14]: https://smithery.ai/skills/pr-pm/creating-opencode-plugins

[^15]: https://gist.github.com/zeke/1e0ba44eaddb16afa6edc91fec778935

