// Test harness: boots ProjectContextPlugin against an isolated tmp worktree
// with a tiny git repo, and exposes helpers to invoke command hooks and read
// the resulting memory state.
//
// Each test gets a FRESH tmp dir + fresh module load (so module-level state
// like memoryDir/cfg/seen/metrics is reset). We achieve fresh module load by
// using a unique query-string import path per harness instance.

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { vi } from "vitest"

export type Api = ReturnType<typeof setupFakeApi>

export interface Harness {
  worktree: string
  memoryDir: string
  plugin: any
  api: Api
  /** Run a `/memory ...` (or /context, /regression) command through the same
   * hook opencode uses (command.execute.before). Returns the deterministic
   * string the plugin produced, and also writes command_result.txt. */
  runCommand(command: string): string
  /** Read the deterministic result file the plugin writes. */
  readCommandResult(): string | null
  readMemoryFile(name: string): string
  readMemoryJson<T = any>(name: string): T | null
  writeMemoryFile(name: string, body: string): void
  memoryExists(name: string): boolean
  listMemory(): string[]
  /** Emit a session lifecycle event into the plugin's `event` hook. */
  emitEvent(type: string, extra?: any): Promise<void>
  /** Read a value from the plugin module's exported/internal state via accessor. */
  getState(): any
  /** Reload the plugin module in-place (same worktree) so it picks up files
   * written to .opencode/memory after the harness was created (e.g. seeded
   * test-history.json). Returns a new harness sharing the same worktree. */
  reload(): Promise<Harness>
  dispose(): void
}

function setupFakeApi(worktree: string) {
  return {
    project: { path: worktree },
    directory: worktree,
    worktree,
    // `$` (Bun shell) is unavailable in Node — plugin must fall back to execSync.
    $: undefined,
    client: {
      tui: {
        appendPrompt: async (_args: any) => {},
        executeCommand: async (_args: any) => {},
      },
      session: { messages: async () => ({ messages: [] }) },
      lsp: { list: async () => ({ servers: [] }) },
    },
  }
}

export async function createHarness(opts: { git?: boolean; seedPackage?: boolean; worktree?: string } = {}): Promise<Harness> {
  let worktree = opts.worktree ?? ""
  let ownsWorktree = false
  if (!worktree) {
    worktree = mkdtempSync(join(tmpdir(), "ocm-test-"))
    ownsWorktree = true
    mkdirSync(join(worktree, ".opencode"), { recursive: true })

    if (opts.git !== false) {
      execSync("git init -q", { cwd: worktree })
      execSync('git config user.email "t@t"', { cwd: worktree })
      execSync('git config user.name "t"', { cwd: worktree })
    }
    if (opts.seedPackage !== false) {
      writeFileSync(
        join(worktree, "package.json"),
        JSON.stringify({
          name: "test-repo",
          scripts: { build: "tsc", test: "vitest", lint: "eslint .", format: "prettier --write ." },
        }),
      )
    }
    if (opts.git !== false) {
      execSync("git add -A && git commit -q -m init", { cwd: worktree })
    }
  }

  return makeHarness(worktree, ownsWorktree)
}

async function makeHarness(worktree: string, ownsWorktree: boolean): Promise<Harness> {
  // Fresh module load: reset the module registry so module-level state
  // (memoryDir, cfg, seen, metrics, testHistory, sessionTrace) is re-initialized.
  vi.resetModules()
  const mod: any = await import("../.opencode/plugins/project-context.ts")
  const ProjectContextPlugin = mod.ProjectContextPlugin ?? mod.default

  const api = setupFakeApi(worktree)
  // Plugin is async; it returns an object with hooks.
  const hooks: any = await Promise.resolve(ProjectContextPlugin(api, {}))

  const memoryDir = join(worktree, ".opencode", "memory")

  function ensureHooks(): any {
    if (!hooks) throw new Error("plugin hooks not ready")
    return hooks
  }

  const h: Harness = {
    worktree,
    memoryDir,
    plugin: ProjectContextPlugin,
    api,
    async runCommand(command) {
      const hk = ensureHooks()
      const slash = command.startsWith("/") ? command : "/" + command
      const input = { command: slash, input: { command: slash } }
      const output: any = {}
      const p = hk["command.execute.before"]?.(input, output)
      if (p && typeof p.then === "function") await p
      return h.readCommandResult() ?? ""
    },
    readCommandResult() {
      const p = join(memoryDir, "command_result.txt")
      if (!existsSync(p)) return null
      const raw = readFileSync(p, "utf8")
      // strip the `# /command` header line
      const nl = raw.indexOf("\n")
      return nl >= 0 ? raw.slice(nl + 1) : ""
    },
    readMemoryFile(name) {
      const p = join(memoryDir, name)
      return existsSync(p) ? readFileSync(p, "utf8") : ""
    },
    readMemoryJson(name) {
      const p = join(memoryDir, name)
      if (!existsSync(p)) return null
      try { return JSON.parse(readFileSync(p, "utf8")) } catch { return null }
    },
    writeMemoryFile(name, body) {
      const p = join(memoryDir, name)
      mkdirSync(join(p, ".."), { recursive: true })
      writeFileSync(p, body, "utf8")
    },
    memoryExists(name) {
      return existsSync(join(memoryDir, name))
    },
    listMemory() {
      try { return readdirSync(memoryDir) } catch { return [] }
    },
    async emitEvent(type, extra) {
      const hk = ensureHooks()
      const event = { properties: { type, ...(extra ?? {}) } }
      await hk.event?.({ event })
    },
    getState() {
      return mod.__testState?.() ?? null
    },
    async reload() {
      // Same worktree, fresh module + plugin instance so it reads seeded files.
      return makeHarness(worktree, ownsWorktree)
    },
    dispose() {
      if (ownsWorktree) {
        try { rmSync(worktree, { recursive: true, force: true }) } catch {}
      }
    },
  }

  return h
}