// Automated verification of every plugin command.
// Run after ANY change to .opencode/plugins/project-context.ts with:
//   npx vitest run tests/commands.test.ts
//
// Each test boots a fresh harness (fresh module state + tmp worktree + tiny git
// repo + package.json), invokes the command through the same
// `command.execute.before` hook opencode uses, then asserts on the returned
// deterministic string AND on side effects in .opencode/memory/.

import { describe, it, expect, afterEach } from "vitest"
import { createHarness, type Harness } from "./harness"

let h: Harness
afterEach(() => { try { h?.dispose() } catch {} })

describe("plugin commands — /memory", () => {
  it("status: returns multi-line summary and does not throw", async () => {
    h = await createHarness()
    const out = await h.runCommand("/memory status")
    expect(out).toMatch(/Worktree:/)
    expect(out).toMatch(/Project facts:/)
    expect(out).toMatch(/Active session:/)
    expect(out).toMatch(/Dedup cache:/)
    expect(out).toMatch(/Artifacts:/)
  })

  it("show: prints facts + active session + injected context sections", async () => {
    h = await createHarness()
    const out = await h.runCommand("/memory show")
    expect(out).toContain("=== PROJECT FACTS ===")
    expect(out).toContain("=== ACTIVE SESSION ===")
    expect(out).toContain("=== INJECTED CONTEXT")
    expect(out).toContain("=== TEST HISTORY")
  })

  it("save: writes handoff and refreshes updatedAt; no commit/stage", async () => {
    h = await createHarness()
    const before = h.readMemoryJson("active-session.json")
    const out = await h.runCommand("/memory save")
    expect(out).toBe("Handoff saved.")
    const after = h.readMemoryJson("active-session.json")
    expect(after).not.toBeNull()
    if (before) {
      expect(Date.parse(after!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(before.updatedAt))
    }
  })

  it("lesson <text>: appends lesson to project-facts.md (## Lekcje section)", async () => {
    h = await createHarness()
    const out = await h.runCommand("/memory lesson Always run vitest before commit")
    expect(out).toMatch(/Lekcja dopisan|lesson|saved/i)
    // NOTE: implementation writes to project-facts.md under "## Lekcje", NOT
    // to a separate lessons.md file. The command template's description says
    // "append to lessons.md" — this is a doc/impl mismatch worth flagging.
    const facts = h.readMemoryFile("project-facts.md")
    expect(facts).toContain("Always run vitest before commit")
    expect(facts).toMatch(/## Lekcje/)
  })

  it("test-history: reports empty when no runs", async () => {
    h = await createHarness()
    const out = await h.runCommand("/memory test-history")
    expect(out).toMatch(/Brak|brak|empty/i)
  })

  it("test-history: shows recorded runs after seeding", async () => {
    h = await createHarness()
    h.writeMemoryFile("cache/test-history.json", JSON.stringify([
      { timestamp: "2026-08-01T00:00:00Z", command: "vitest", exitCode: 0, summary: "ok", failed: [], sessionId: "s1", head: "aaa" },
      { timestamp: "2026-08-02T00:00:00Z", command: "vitest", exitCode: 1, summary: "boom", failed: ["tests/x.test.ts"], sessionId: "s1", head: "bbb" },
    ]))
    // reload plugin in the SAME worktree so it reads the seeded file from disk
    h = await h.reload()
    const out = await h.runCommand("/memory test-history")
    expect(out).toContain("vitest")
    expect(out).toMatch(/FAIL|OK/)
  })

  it("init: writes project-facts.md when missing", async () => {
    h = await createHarness()
    expect(h.memoryExists("project-facts.md")).toBe(false)
    const out = await h.runCommand("/memory init")
    expect(h.memoryExists("project-facts.md")).toBe(true)
    expect(out).toMatch(/Zapisano|NIE zapisano/)
    const facts = h.readMemoryFile("project-facts.md")
    expect(facts).toMatch(/# project-facts\.md|# Architektura/)
  })

  it("init: does NOT overwrite a non-trivial project-facts.md without --force", async () => {
    h = await createHarness()
    h.writeMemoryFile("project-facts.md", "# project-facts.md\n\n# Architektura\n- My real stack\n")
    const before = h.readMemoryFile("project-facts.md")
    await h.runCommand("/memory init")
    const after = h.readMemoryFile("project-facts.md")
    expect(after).toBe(before)
  })

  // KNOWN BUG: /\b--force\b/ never matches "--force" because "-" is a non-word
  // char, so \b before "--" doesn't exist. /memory init --force ALWAYS refuses
  // to overwrite a non-trivial project-facts.md. Fix: use /(^|\s)--force\b/ or
  // /--force/. After the fix, flip it.fails -> it.
  it.fails("init --force: overwrites existing non-trivial facts (KNOWN BUG: \\b before --)", async () => {
    h = await createHarness()
    h.writeMemoryFile("project-facts.md", "# project-facts.md\n\n# Architektura\n- old custom stack\n")
    const out = await h.runCommand("/memory init --force")
    expect(out).toMatch(/Zapisano:/)
    const after = h.readMemoryFile("project-facts.md")
    expect(after).not.toContain("- old custom stack")
    expect(after).toMatch(/# Architektura/)
  })

  it("auto / auto-refresh: regenerates project-facts.auto.md", async () => {
    h = await createHarness()
    const out = await h.runCommand("/memory auto-refresh")
    expect(h.memoryExists("project-facts.auto.md")).toBe(true)
    expect(out).toMatch(/Zregenerowano|auto/i)
  })

  it("auto (show): prints auto facts", async () => {
    h = await createHarness()
    await h.runCommand("/memory auto-refresh")
    const out = await h.runCommand("/memory auto")
    expect(out.trim().length).toBeGreaterThan(0)
  })

  it("propose: writes proposed-facts.md and returns it with commit hint", async () => {
    h = await createHarness()
    const out = await h.runCommand("/memory propose")
    expect(out).toMatch(/Proponowane fakty|propozycje|brak danych/i)
    expect(out).toMatch(/\/memory commit/)
  })

  it("commit: appends proposed facts to project-facts.md and clears buffer", async () => {
    h = await createHarness()
    h.writeMemoryFile("project-facts.md", "# project-facts.md\n\n# Architektura\n- existing\n")
    await h.runCommand("/memory commit")
    const facts = h.readMemoryFile("project-facts.md")
    expect(facts).toContain("existing")
    expect(facts).toMatch(/propozycje pluginu|Proponowane fakty/)
  })

  it("clear-session: removes per-session caches, keeps project-facts.md", async () => {
    h = await createHarness()
    h.writeMemoryFile("project-facts.md", "# keep me\n")
    h.writeMemoryFile("cache/dedup-seen.json", "[]")
    h.writeMemoryFile("cache/test-history.json", "[]")
    h.writeMemoryFile("cache/metrics.json", "{}")
    const out = await h.runCommand("/memory clear-session")
    expect(out).toMatch(/cleared|wyczyszczon/i)
    expect(h.readMemoryFile("project-facts.md")).toContain("keep me")
    // per-session caches removed
    expect(h.memoryExists("cache/dedup-seen.json")).toBe(false)
    expect(h.memoryExists("cache/test-history.json")).toBe(false)
    expect(h.memoryExists("cache/metrics.json")).toBe(false)
  })

  it("clear-project: wipes entire memory dir then recreates layout", async () => {
    h = await createHarness()
    h.writeMemoryFile("project-facts.md", "# bye\n")
    const out = await h.runCommand("/memory clear-project")
    expect(out).toMatch(/cleared|wyczyszczon/i)
    expect(h.readMemoryFile("project-facts.md")).toBe("")
    // layout recreated
    expect(h.listMemory()).toEqual(expect.arrayContaining(["cache", "artifacts", "index", "session-history"]))
  })

  // KNOWN BUG: dispatchCommand checks `cmd.startsWith("/memory compact")`
  // BEFORE "/memory compact-status" and "/memory compact-reset", so both
  // subcommands are shadowed and instead create a handoff returning
  // "Compact handoff created." Fix: move compact-status/compact-reset checks
  // before the generic "/memory compact" branch (or use a stricter match).
  it.fails("compact-status: prints compaction status block (KNOWN BUG: shadowed by /memory compact)", async () => {
    h = await createHarness()
    const out = await h.runCommand("/memory compact-status")
    expect(out).toContain("=== Context compaction ===")
    expect(out).toMatch(/Tryb:/)
    expect(out).toMatch(/Limit:/)
  })

  it.fails("compact-reset: resets suggestion flag (KNOWN BUG: shadowed by /memory compact)", async () => {
    h = await createHarness()
    const out = await h.runCommand("/memory compact-reset")
    expect(out).toMatch(/reset|zresetow/i)
  })

  it("tui: returns memory one-line status (text equivalent of TUI)", async () => {
    h = await createHarness()
    const out = await h.runCommand("/memory tui")
    expect(out).toMatch(/memory:|tools:|tok/)
  })

  it("dashboard: returns deterministic TUI-route hint (not a render)", async () => {
    h = await createHarness()
    const out = await h.runCommand("/memory dashboard")
    expect(out).toMatch(/Dashboard TUI|route: memory-dashboard|interaktywn/i)
  })

  it("ai status: reports AI disabled by default", async () => {
    h = await createHarness()
    const out = await h.runCommand("/memory ai status")
    expect(out).toMatch(/AI:/)
    expect(out).toMatch(/wyłączon|wylaczon|disabled/i)
  })

  it("ai (bare): alias of ai status", async () => {
    h = await createHarness()
    const out = await h.runCommand("/memory ai")
    expect(out).toMatch(/AI:/)
  })
})

describe("plugin commands — /context", () => {
  it("budget: prints budget breakdown", async () => {
    h = await createHarness()
    const out = await h.runCommand("/context budget")
    expect(out).toMatch(/Project facts:/)
    expect(out).toMatch(/Handoff:/)
    expect(out).toMatch(/Context size:/)
  })

  it("artifacts: reports no artifacts when empty", async () => {
    h = await createHarness()
    const out = await h.runCommand("/context artifacts")
    expect(out).toMatch(/No artifacts|brak/i)
  })
})

describe("plugin commands — /regression", () => {
  it("last-good: reports no data when history empty", async () => {
    h = await createHarness()
    const out = await h.runCommand("/regression last-good")
    expect(out).toMatch(/Brak danych|brak|no data/i)
  })

  it("last-good: detects last good / first red from seeded history", async () => {
    h = await createHarness()
    h.writeMemoryFile("cache/test-history.json", JSON.stringify([
      { timestamp: "2026-08-01T00:00:00Z", command: "vitest", exitCode: 0, summary: "ok", failed: [], sessionId: "s", head: "aaa" },
      { timestamp: "2026-08-02T00:00:00Z", command: "vitest", exitCode: 0, summary: "ok", failed: [], sessionId: "s", head: "bbb" },
      { timestamp: "2026-08-03T00:00:00Z", command: "vitest", exitCode: 1, summary: "boom", failed: ["tests/x.test.ts"], sessionId: "s", head: "ccc" },
    ]))
    h = await h.reload()
    const out = await h.runCommand("/regression last-good")
    expect(out).toContain("=== Regression window ===")
    expect(out).toMatch(/Last good:/)
    expect(out).toMatch(/First red:/)
    expect(out).toContain("tests/x.test.ts")
  })

  it("suspect: returns list (possibly empty) without throwing", async () => {
    h = await createHarness()
    const out = await h.runCommand("/regression suspect")
    // no throw = pass; output is either suspects or a no-data message
    expect(typeof out).toBe("string")
  })

  it("revert: rejects unsafe revert by default (safeRevertOnly)", async () => {
    h = await createHarness()
    const out = await h.runCommand("/regression revert aaa")
    expect(out).toMatch(/safe|odmow|nie można|abort|brak|refus/i)
  })
})

describe("plugin hooks — event lifecycle", () => {
  it("session.created does not throw and sets up memory layout", async () => {
    h = await createHarness()
    await h.emitEvent("session.created", { info: { sessionID: "sess-1" } })
    expect(h.listMemory()).toEqual(expect.arrayContaining(["cache", "artifacts", "index", "session-history"]))
  })

  it("session.idle writes active-session.json handoff", async () => {
    h = await createHarness()
    await h.emitEvent("session.created", { info: { sessionID: "sess-1" } })
    await h.emitEvent("session.idle", { info: { sessionID: "sess-1" } })
    const sess = h.readMemoryJson("active-session.json")
    expect(sess).not.toBeNull()
    expect(sess!.updatedAt).toBeTruthy()
  })

  it("session.idle survives when `$` is unavailable (execSync fallback)", async () => {
    h = await createHarness()
    // $ is undefined in fake api — this exercises the crash that produced
    // "session.idle: $ is not a function" in plugin-errors.log
    await expect(h.emitEvent("session.idle", { info: { sessionID: "sess-1" } })).resolves.toBeUndefined()
    expect(h.memoryExists("active-session.json")).toBe(true)
  })
})

describe("plugin hooks — command_result.txt contract", () => {
  it("every /memory command writes command_result.txt with matching header", async () => {
    const cmds = [
      "/memory status", "/memory show", "/memory save", "/memory test-history",
      "/memory init", "/memory auto-refresh", "/memory auto", "/memory propose",
      "/memory commit", "/memory clear-session", "/memory compact-status",
      "/memory compact-reset", "/memory tui", "/memory dashboard", "/memory ai status",
    ]
    for (const c of cmds) {
      h = await createHarness()
      await h.runCommand(c)
      const raw = h.readMemoryFile("command_result.txt")
      const header = raw.split("\n")[0]
      expect(header, `header for ${c}`).toBe(`# ${c}`)
      h.dispose()
    }
  })
})