# Plugin command tests

Automatyczne testy weryfikujące wszystkie komendy pluginu
`.opencode/plugins/project-context.ts`. Uruchamiaj po KAŻDEJ modyfikacji pluginu:

```bash
npm test                # = vitest run  (cały zestaw)
npm run test:plugin     # tylko tests/commands.test.ts
npx vitest run tests/commands.test.ts   # bezpośrednio
```

## Co testują

Każdy test bootuje świeżą instancję pluginu w izolowanym tmpdir (z mini-repo
git + package.json), wywołuje komendę przez ten sam hook `command.execute.before`,
którego używa opencode, i weryfikuje:

- zwracany deterministyczny string,
- efekty uboczne w `.opencode/memory/` (pliki, JSON, handoff),
- kontrakt `command_result.txt` (nagłówek `# /<command>`),
- cykl życia sesji (`session.created` / `session.idle` bez `$`).

## Struktura

- `tests/harness.ts` — stub `@opencode-ai/plugin`, fake API, tmp worktree,
  `createHarness()` / `h.reload()` / `h.runCommand()`.
- `tests/stubs/@opencode-ai/plugin.ts` — minimalny stub SDK (Node nie ma
  runtime'u opencode).
- `tests/commands.test.ts` — testy komend `/memory`, `/context`, `/regression`
  i hooków zdarzeń.
- `vitest.config.ts` — konfiguracja (forks pool, isolate=true dla świeżego
  stanu modułu).
- `tests/tsconfig.json` — mapowanie `@opencode-ai/plugin` → stub.

## Wykryte bugi (oznaczone `it.fails` — test dokumentuje błąd)

Po naprawie zamień `it.fails(...)` → `it(...)`; test powinien przejść.

### BUG-1: `/memory compact-status` i `/memory compact-reset` nigdy nie docierają do handlerów

**Plik:** `.opencode/plugins/project-context.ts:3054`
**Przyczyna:** `dispatchCommand` sprawdza `cmd.startsWith("/memory compact")`
(przed) `cmd.startsWith("/memory compact-status")` i `"/memory compact-reset"`
(po). Ponieważ `startsWith` jest prefiksowe, `/memory compact-status` pasuje do
`/memory compact` → tworzy handoff i zwraca `"Compact handoff created."` zamiast
wywołać `memoryCompactStatus()` / `memoryCompactReset()`.
**Skutek:** obie komendy są niedziałające; `compact-status` nigdy nie pokaże
stanu kompaktacji, `compact-reset` nigdy nie resetuje flagi.
**Fix:** przenieść sprawdzenia `compact-status` / `compact-reset` PRZED
ogólnym `/memory compact`, albo użyć dokładniejszego warunku
(np. `cmd === "/memory compact" || cmd.startsWith("/memory compact ")`).

### BUG-2: `/memory init --force` nigdy nie nadpisuje nietrywialnego pliku

**Plik:** `.opencode/plugins/project-context.ts:2757`
**Przyczyna:** `force = /\b--force\b/.test(args)`. `\b` (word boundary) wymaga
znaku word po jednej stronie granicy. `-` jest znakiem non-word, więc przed
`--force` nie ma `\b` → regex NIGDY nie pasuje (`/\b--force\b/.test("--force")
=== false`).
**Skutek:** `/memory init --force` zawsze odmawia nadpisania nietrywialnego
`project-facts.md` komunikatem "NIE zapisano: istniejący project-facts.md
nietrywialny". Flaga `--force` jest martwa.
**Fix:** `force = /--force\b/.test(args)` (bez wiodącego `\b`) lub
`/(^|\s)--force\b/`.

### BUG-3 (dokumentacja/impl rozbieżność): `/memory lesson` zapisuje do `project-facts.md`, nie `lessons.md`

**Plik:** `.opencode/plugins/project-context.ts:1318`
**Przyczyna:** szablon komendy `.opencode/command/memory.md` opisuje `lesson` jako
"append the text to `.opencode/memory/lessons.md`", ale implementacja dopisuje
lekcję do `project-facts.md` pod sekcją `## Lekcje`. Osobny plik `lessons.md`
nigdy nie istnieje.
**Skutek:** niespójność między dokumentacją komendy a działaniem; użytkownik
spodziewa się osobnego pliku lekcji.
**Fix (do wyboru):** (a) zaktualizować opis w `memory.md` aby mówił
"append to project-facts.md (## Lekcje)"; lub (b) zmienić implementację aby
zapisywała do `lessons.md`. Test zakłada (a) — weryfikuje sekcję w
`project-facts.md`.

## Inne obserwacje (nie-bug, ale warte uwagi)

- `dashboard` zwraca tylko hint tekstowy (`"Dashboard TUI: użyj w trybie
  interaktywnym (route: memory-dashboard)"`) — pełny dashboard jest widokiem
  TUI (`route: memory-dashboard` w `memory-tui.tsx`), nie renderuje się w
  odpowiedzi czatu. To celowe, nie błąd.
- `session.idle` ma poprawny fallback na `execSync` gdy `$` (Bun shell) jest
  niedostępny — test potwierdza, że hook nie rzuca `"$ is not a function"`
  (błąd widoczny w `plugin-errors.log` pochodzi ze starszej wersji lub innego
  hooka; obecny kod jest odporny).
- `commitProposedFacts()` regeneruje propozycje przez `buildProposedFacts()`
  zamiast czytać `cache/proposed-facts.md` zapisany przez `memoryPropose()` —
  plik propose jest nadmiarowy, ale commit działa poprawnie.

## Dodawanie testów po naprawie bugów

1. Zmień `it.fails(...)` → `it(...)` w `tests/commands.test.ts`.
2. Uruchom `npm run test:plugin`.
3. Jeśli zielony — bug naprawiony; jeśli czerwony — poprawka niewystarczająca.