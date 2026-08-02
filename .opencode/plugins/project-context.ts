import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync, rmSync } from "node:fs"
import { join, relative, resolve, basename } from "node:path"
import { createHash } from "node:crypto"
import { execSync } from "node:child_process"
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Config = {
  enabled: boolean
  maxProjectMemoryTokens: number
  maxSessionHandoffTokens: number
  maxToolResultLines: number
  maxDiffLines: number
  maxSearchMatches: number
  maxArtifactPreviewLines: number
  deduplicateReadResults: boolean
  storeFullArtifacts: boolean
  // Additions
  persistentDedupCache: boolean
  maxDedupCacheEntries: number
  maxTestHistoryEntries: number
  // Regression detection
  regressionTrackHead: boolean
  regressionSafeRevertOnly: boolean
  // Auto-extracted facts
  autoExtractFacts: boolean
  autoExtractOnEvents: string[]   // e.g. ["session.idle","session.compacted"]
  factsAutoGlobDepth: number
}

const DEFAULT_CONFIG: Config = {
  enabled: true,
  maxProjectMemoryTokens: 1500,
  maxSessionHandoffTokens: 1000,
  maxToolResultLines: 100,
  maxDiffLines: 120,
  maxSearchMatches: 40,
  maxArtifactPreviewLines: 80,
  deduplicateReadResults: true,
  storeFullArtifacts: true,
  // Additions
  persistentDedupCache: true,
  maxDedupCacheEntries: 500,
  maxTestHistoryEntries: 50,
  regressionTrackHead: true,
  regressionSafeRevertOnly: true,
  // Auto-extracted facts
  autoExtractFacts: true,
  autoExtractOnEvents: ["session.idle", "session.compacted"],
  factsAutoGlobDepth: 3,
}

type SeenContext = {
  filePath: string
  contentHash: string
  lineStart?: number
  lineEnd?: number
  deliveredAt: string
  source: "read" | "grep" | "diff" | "lsp" | "command"
}

type ActiveSession = {
  schemaVersion: 1
  sessionId: string
  updatedAt: string
  goal: string
  currentStatus: string
  modifiedFiles: string[]
  decisions: string[]
  commands: Record<string, string>
  testStatus?: {
    lastCommand: string
    exitCode: number
    summary: string
  }
  blockers: string[]
  lspErrors?: string[]
}

type Metrics = {
  sessionId: string
  toolCalls: number
  rawChars: number
  deliveredChars: number
  estimatedReductionPercent: number
  deduplicatedReads: number
  artifactsCreated: number
  artifactBytes: number
}

type TestRun = {
  timestamp: string
  command: string
  exitCode: number
  summary: string
  failed: string[]
  sessionId: string
  head: string  // git SHA w momencie uruchomienia (do korelacji regresji)
}

type SessionTrace = {
  sessionId: string
  buildTestCommands: Record<string, number>   // command -> invocation count
  editedFiles: Record<string, number>          // file -> edit count across sessions
  blockers: string[]                          // repeated blockers seen
  startedAt: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /API_KEY\s*=\s*[^\s]+/gi,
  /SECRET\s*=\s*[^\s]+/gi,
  /PASSWORD\s*=\s*[^\s]+/gi,
  /TOKEN\s*=\s*[^\s]+/gi,
  /Bearer\s+[A-Za-z0-9\-\._~+\/=]+/g,
  /Authorization:\s*Bearer\s+[^\s]+/gi,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /ghp_[A-Za-z0-9]{36}/g, // GitHub PAT
  /gho_[A-Za-z0-9]{36}/g,
  /sk-[A-Za-z0-9]{20,}/g,
]

const SENSITIVE_PATH_PATTERNS = [
  /\.env(\.|$)/i,
  /id_rsa/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.kdbx$/i,
  /credentials/i,
  /secrets/i,
]

const MAX_ARTIFACT_DIR_MB = 200
const ARTIFACT_TTL_MS = 1000 * 60 * 60 * 24 * 7 // 7 days

// ---------------------------------------------------------------------------
// Plugin state (per plugin instance / per worktree)
// ---------------------------------------------------------------------------

let cfg: Config = { ...DEFAULT_CONFIG }
let memoryDir = ""
let worktreePath = ""
let projectRoot = ""
let seen: SeenContext[] = []
let metrics: Metrics = {
  sessionId: "",
  toolCalls: 0,
  rawChars: 0,
  deliveredChars: 0,
  estimatedReductionPercent: 0,
  deduplicatedReads: 0,
  artifactsCreated: 0,
  artifactBytes: 0,
}
let lastInjectedContext = ""
let lastSessionId = ""

// --- Additions: persistent dedup cache, test history, session trace ----------
let testHistory: TestRun[] = []
let sessionTrace: SessionTrace = {
  sessionId: "",
  buildTestCommands: {},
  editedFiles: {},
  blockers: [],
  startedAt: "",
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function failOpen(fn: () => void, label: string) {
  try {
    fn()
  } catch (e: any) {
    try {
      const logPath = join(memoryDir || process.cwd(), "plugin-errors.log")
      writeFileSync(logPath, `[${new Date().toISOString()}] ${label}: ${e?.message ?? e}\n`, { flag: "a" })
    } catch {
      // swallow
    }
  }
}

function failOpenReturn<T>(fn: () => T, fallback: T, label: string): T {
  try {
    return fn()
  } catch (e: any) {
    try {
      const logPath = join(memoryDir || process.cwd(), "plugin-errors.log")
      writeFileSync(logPath, `[${new Date().toISOString()}] ${label}: ${e?.message ?? e}\n`, { flag: "a" })
    } catch {
      // swallow
    }
    return fallback
  }
}

async function failOpenAsync(fn: () => Promise<void> | void, label: string) {
  try {
    await fn()
  } catch (e: any) {
    try {
      const logPath = join(memoryDir || process.cwd(), "plugin-errors.log")
      writeFileSync(logPath, `[${new Date().toISOString()}] ${label}: ${e?.message ?? e}\n`, { flag: "a" })
    } catch {
      // swallow
    }
  }
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

function writeJson(path: string, data: unknown) {
  ensureDir(join(path, ".."))
  writeFileSync(path, JSON.stringify(data, null, 2), "utf8")
}

function readText(path: string): string {
  if (!existsSync(path)) return ""
  return readFileSync(path, "utf8")
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split("\n")
  if (lines.length <= maxLines) return text
  return lines.slice(0, maxLines).join("\n") + `\n... [truncated ${lines.length - maxLines} lines]`
}

function maskSecrets(text: string): string {
  let out = text
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (m) => m.replace(/=.*$|:.+$/, "=...") )
  }
  // simpler approach: replace matched secret value with placeholder
  out = text
  for (const p of SECRET_PATTERNS) {
    out = out.replace(p, (match) => {
      // keep key name, mask value
      if (match.includes("=")) {
        const idx = match.indexOf("=")
        return match.slice(0, idx + 1) + "...[REDACTED]"
      }
      if (match.includes(":")) {
        const idx = match.indexOf(":")
        return match.slice(0, idx + 1) + " ...[REDACTED]"
      }
      if (match.startsWith("Bearer ")) return "Bearer ...[REDACTED]"
      return "...[REDACTED]"
    })
  }
  return out
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

function shortHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 6)
}

function isSensitivePath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").toLowerCase()
  return SENSITIVE_PATH_PATTERNS.some((p) => p.test(norm))
}

// ---------------------------------------------------------------------------
// Memory layout
// ---------------------------------------------------------------------------

function initMemoryLayout(worktree: string) {
  worktreePath = worktree
  projectRoot = worktree
  memoryDir = join(worktree, ".opencode", "memory")
  ensureDir(memoryDir)
  ensureDir(join(memoryDir, "session-history"))
  ensureDir(join(memoryDir, "artifacts"))
  ensureDir(join(memoryDir, "cache"))
  ensureDir(join(memoryDir, "index"))
  // Additions: load persistent dedup cache, test history, session trace
  loadDedupCache()
  loadTestHistory()
  loadSessionTrace()
}

function factsPath(): string {
  return join(memoryDir, "project-facts.md")
}

// --- Auto-extracted facts -----------------------------------------------------
// Deterministyczne ekstraktory czytają repozytorium i budują project-facts.auto.md.
// Plik .auto.md jest regenerowany; project-facts.md pozostaje dla faktów ręcznych.

function factsAutoPath(): string {
  return join(memoryDir, "project-facts.auto.md")
}

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".ijfw", ".opencode", "dist", "build", "out",
  ".next", ".nuxt", ".cache", ".turbo", "target", "bin", "obj",
  "__pycache__", ".venv", "venv", "vendor", ".idea", ".vscode",
])

function listTopDirs(root: string, depth: number): string[] {
  const out: string[] = []
  const walk = (dir: string, d: number) => {
    if (d > depth) return
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      const full = join(dir, e)
      let st
      try { st = statSync(full) } catch { continue }
      if (!st.isDirectory()) continue
      if (IGNORED_DIRS.has(e)) continue
      const rel = relative(root, full).replace(/\\/g, "/")
      out.push(rel)
      walk(full, d + 1)
    }
  }
  walk(root, 1)
  return out.sort()
}

function readJsonManifest(root: string, file: string): any | null {
  const p = join(root, file)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, "utf8")) } catch { return null }
}

function extractBuildAndTestCommands(root: string): { build: string[]; test: string[]; format: string[]; lint: string[] } {
  const build: string[] = []
  const test: string[] = []
  const format: string[] = []
  const lint: string[] = []
  // package.json (npm/bun/yarn/pnpm)
  const pkg = readJsonManifest(root, "package.json")
  if (pkg && pkg.scripts) {
    const s = pkg.scripts as Record<string, string>
    const push = (arr: string[], k: string, label: string) => {
      if (s[k]) arr.push(`npm run ${k}  (package.json: ${s[k]})`)
    }
    for (const k of ["build", "build:debug", "compile", "tsc"]) push(build, k, "build")
    for (const k of ["test", "test:unit", "test:ci", "vitest", "jest"]) push(test, k, "test")
    for (const k of ["format", "prettier", "lint:fix"]) push(format, k, "format")
    for (const k of ["lint", "eslint", "biome", "tsc --noEmit"]) push(lint, k, "lint")
    // packageManager hint
    if (pkg.packageManager) build.push(`# packageManager: ${pkg.packageManager}`)
  }
  // pyproject.toml / setup.py
  const pyproject = join(root, "pyproject.toml")
  if (existsSync(pyproject)) {
    const raw = readText(pyproject)
    if (/\[tool\.pytest\]/.test(raw) || /pytest/.test(raw)) test.push("pytest  (pyproject.toml)")
    if (/\[tool\.black\]/.test(raw) || /\[tool\.ruff\]/.test(raw)) {
      if (/\[tool\.ruff\]/.test(raw)) { format.push("ruff format  (pyproject.toml)"); lint.push("ruff check  (pyproject.toml)") }
      if (/\[tool\.black\]/.test(raw)) format.push("black  (pyproject.toml)")
    }
    if (/\[tool\.mypy\]/.test(raw)) lint.push("mypy  (pyproject.toml)")
    if (/\[project\.scripts\]/.test(raw) || /\[tool\.poetry\]/.test(raw)) {
      const m = raw.match(/build-system[\s\S]*?requires\s*=\s*\[([^\]]+)\]/)
      if (m) build.push(`# build-backend: ${m[1].replace(/[\n"']/g, " ").trim()}`)
    }
  }
  // Makefile
  const makefile = join(root, "Makefile")
  if (existsSync(makefile)) {
    const raw = readText(makefile)
    const targets = new Set<string>()
    for (const line of raw.split("\n")) {
      const m = line.match(/^([a-zA-Z0-9_\-]+):\s*/)
      if (m) targets.add(m[1])
    }
    for (const t of ["build", "all", "compile", "debug"]) if (targets.has(t)) build.push(`make ${t}  (Makefile)`)
    for (const t of ["test", "check", "test-unit"]) if (targets.has(t)) test.push(`make ${t}  (Makefile)`)
    for (const t of ["lint", "format", "fmt"]) if (targets.has(t)) (t === "lint" ? lint : format).push(`make ${t}  (Makefile)`)
  }
  // CMake
  const cmake = join(root, "CMakeLists.txt")
  if (existsSync(cmake)) {
    build.push("cmake --build build  (CMakeLists.txt)")
    const raw = readText(cmake)
    if (/enable_testing|add_test|gtest|Catch2|catch2/i.test(raw)) test.push("ctest --test-dir build  (CMakeLists.txt)")
  }
  // Cargo
  const cargo = join(root, "Cargo.toml")
  if (existsSync(cargo)) {
    build.push("cargo build  (Cargo.toml)")
    test.push("cargo test  (Cargo.toml)")
    format.push("cargo fmt  (Cargo.toml)")
    lint.push("cargo clippy  (Cargo.toml)")
  }
  // Go
  if (existsSync(join(root, "go.mod"))) {
    build.push("go build ./...  (go.mod)")
    test.push("go test ./...  (go.mod)")
    format.push("gofmt -w .  (go.mod)")
  }
  // dotnet: *.csproj/*.sln
  try {
    const hasCs = readdirSync(root).some((f) => /\.(csproj|sln|fsproj|vbproj)$/i.test(f))
    if (hasCs) {
      build.push("dotnet build  (*.csproj)")
      test.push("dotnet test  (*.csproj)")
      format.push("dotnet format  (*.csproj)")
    }
  } catch { /* ignore */ }
  // Dedup preserving order
  const uniq = (a: string[]) => Array.from(new Set(a))
  return { build: uniq(build), test: uniq(test), format: uniq(format), lint: uniq(lint) }
}

function extractEnvironment(root: string): string[] {
  const out: string[] = []
  const readLine = (file: string): string | null => {
    const p = join(root, file)
    if (!existsSync(p)) return null
    const raw = readText(p).split("\n")[0]?.trim()
    return raw || null
  }
  const node = readLine(".nvmrc") ?? readLine(".node-version")
  if (node) out.push(`Node: ${node}  (.nvmrc)`)
  const py = readLine(".python-version")
  if (py) out.push(`Python: ${py}  (.python-version)`)
  const ruby = readLine(".ruby-version")
  if (ruby) out.push(`Ruby: ${ruby}  (.ruby-version)`)
  // mise / asdf / tool-versions
  const tv = join(root, ".tool-versions")
  if (existsSync(tv)) {
    for (const l of readText(tv).split("\n")) {
      const m = l.match(/^(\w+)\s+(\S+)/)
      if (m) out.push(`${m[1]}: ${m[2]}  (.tool-versions)`)
    }
  }
  const mise = join(root, "mise.toml")
  if (existsSync(mise)) {
    for (const l of readText(mise).split("\n")) {
      const m = l.match(/^\s*(\w+)\s*=\s*["']?([^"'\s]+)["']?/)
      if (m && !["env", "tasks"].includes(m[1])) out.push(`${m[1]}: ${m[2]}  (mise.toml)`)
    }
  }
  // Dockerfile
  if (existsSync(join(root, "Dockerfile"))) {
    const raw = readText(join(root, "Dockerfile"))
    const fm = raw.match(/FROM\s+([^\s]+)/i)
    if (fm) out.push(`Container base: ${fm[1]}  (Dockerfile)`)
  }
  return out
}

function extractArchitecture(root: string): { stack: string[]; dirs: string[] } {
  const stack: string[] = []
  const dirs = listTopDirs(root, cfg.factsAutoGlobDepth)
  // wykrywanie stacku po plikach manifestu i dominujących rozszerzeniach
  const extCounts: Record<string, number> = {}
  const walk = (dir: string, d: number) => {
    if (d > cfg.factsAutoGlobDepth) return
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { return }
    for (const e of entries) {
      const full = join(dir, e)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (IGNORED_DIRS.has(e)) continue
        walk(full, d + 1)
      } else {
        const ext = e.includes(".") ? e.slice(e.lastIndexOf(".")) : ""
        if (ext) extCounts[ext] = (extCounts[ext] ?? 0) + 1
      }
    }
  }
  walk(root, 1)
  if (existsSync(join(root, "package.json"))) stack.push("TypeScript/JavaScript (Node)")
  if (existsSync(join(root, "tsconfig.json"))) stack.push("TypeScript (tsc)")
  if (existsSync(join(root, "Cargo.toml"))) stack.push("Rust (Cargo)")
  if (existsSync(join(root, "go.mod"))) stack.push("Go")
  if (existsSync(join(root, "pom.xml")) || existsSync(join(root, "build.gradle")) || existsSync(join(root, "build.gradle.kts"))) stack.push("Java/Kotlin (JVM)")
  if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "setup.py")) || existsSync(join(root, "requirements.txt"))) stack.push("Python")
  if (existsSync(join(root, "CMakeLists.txt")) || existsSync(join(root, "Makefile"))) stack.push("C/C++ (native)")
  // dominujące rozszerzenia jako hint
  const top = Object.entries(extCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)
  for (const [ext, n] of top) {
    if (n < 3) continue
    if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") continue
    stack.push(`${ext} (${n} plików)`)
  }
  return { stack: Array.from(new Set(stack)), dirs }
}

function buildAutoFacts(): string {
  const root = worktreePath || projectRoot || process.cwd()
  const cmds = extractBuildAndTestCommands(root)
  const env = extractEnvironment(root)
  const arch = extractArchitecture(root)
  const out: string[] = []
  out.push("# project-facts.auto.md — generowane automatycznie przez plugin")
  out.push("# Nie edytuj ręcznie; plik jest regenerowany na session.idle/compacted.")
  out.push(`# Ostatnia aktualizacja: ${new Date().toISOString()}`)
  out.push("")
  if (arch.stack.length) {
    out.push("## Architektura")
    for (const s of arch.stack) out.push(`- ${s}`)
    if (arch.dirs.length) out.push(`- Główne katalogi: ${arch.dirs.slice(0, 15).join(", ")}`)
    out.push("")
  }
  if (cmds.build.length || cmds.test.length || cmds.format.length || cmds.lint.length) {
    out.push("## Komendy")
    for (const c of cmds.build) out.push(`- Build: ${c}`)
    for (const c of cmds.test) out.push(`- Testy: ${c}`)
    for (const c of cmds.format) out.push(`- Formatowanie: ${c}`)
    for (const c of cmds.lint) out.push(`- Lint: ${c}`)
    out.push("")
  }
  if (env.length) {
    out.push("## Środowisko")
    for (const e of env) out.push(`- ${e}`)
    out.push("")
  }
  return out.join("\n")
}

function refreshAutoFacts(): void {
  const body = buildAutoFacts()
  writeFileSync(factsAutoPath(), body, "utf8")
}

function readAutoFacts(): string {
  const raw = readText(factsAutoPath())
  if (!raw) return ""
  const tokens = estimateTokens(raw)
  if (tokens > cfg.maxProjectMemoryTokens) {
    return raw.slice(0, cfg.maxProjectMemoryTokens * 4) + "\n\n[WARN: project-facts.auto.md exceeds memory budget; truncated]"
  }
  return raw
}

function activeSessionPath(): string {
  return join(memoryDir, "active-session.json")
}

function artifactsDir(): string {
  return join(memoryDir, "artifacts")
}

function cachePath(): string {
  return join(memoryDir, "cache", "tool-results.json")
}

function indexFilesPath(): string {
  return join(memoryDir, "index", "files.json")
}

function metricsPath(): string {
  return join(memoryDir, "cache", "metrics.json")
}

// --- Additions: paths for new persistent data ---------------------------------
function dedupCachePath(): string {
  return join(memoryDir, "cache", "dedup-seen.json")
}

function testHistoryPath(): string {
  return join(memoryDir, "cache", "test-history.json")
}

function sessionTracePath(): string {
  return join(memoryDir, "cache", "session-trace.json")
}

function proposedFactsPath(): string {
  return join(memoryDir, "cache", "proposed-facts.md")
}

// --- Additions: load / save persistent dedup cache ---------------------------
function loadDedupCache() {
  if (!cfg.persistentDedupCache) return
  const data = readJson<SeenContext[]>(dedupCachePath())
  if (Array.isArray(data)) {
    seen = data
  }
}

function saveDedupCache() {
  if (!cfg.persistentDedupCache) return
  // LRU eviction by deliveredAt (oldest first) when over capacity
  if (seen.length > cfg.maxDedupCacheEntries) {
    seen.sort((a, b) => (a.deliveredAt < b.deliveredAt ? -1 : 1))
    seen = seen.slice(seen.length - cfg.maxDedupCacheEntries)
  }
  writeJson(dedupCachePath(), seen)
}

// --- Additions: load / save test history --------------------------------------
function loadTestHistory() {
  const data = readJson<TestRun[]>(testHistoryPath())
  if (Array.isArray(data)) testHistory = data
}

function recordTestRun(run: TestRun) {
  testHistory.push(run)
  // keep most recent N
  if (testHistory.length > cfg.maxTestHistoryEntries) {
    testHistory = testHistory.slice(testHistory.length - cfg.maxTestHistoryEntries)
  }
  writeJson(testHistoryPath(), testHistory)
}

// --- Additions: load / save session trace (aggregated across sessions) --------
function loadSessionTrace() {
  const data = readJson<SessionTrace>(sessionTracePath())
  if (data && typeof data === "object") {
    sessionTrace = data
  }
}

function saveSessionTrace() {
  writeJson(sessionTracePath(), sessionTrace)
}

function mergeTraceIntoGlobal() {
  // On session.idle, fold the per-session trace into the persistent trace,
  // then persist. buildTestCommands & editedFiles accumulate counts across sessions.
  const globalRaw = readJson<SessionTrace>(sessionTracePath())
  const g: SessionTrace = globalRaw && typeof globalRaw === "object" ? globalRaw : {
    sessionId: "", buildTestCommands: {}, editedFiles: {}, blockers: [], startedAt: "",
  }
  for (const [cmd, n] of Object.entries(sessionTrace.buildTestCommands)) {
    g.buildTestCommands[cmd] = (g.buildTestCommands[cmd] ?? 0) + n
  }
  for (const [f, n] of Object.entries(sessionTrace.editedFiles)) {
    g.editedFiles[f] = (g.editedFiles[f] ?? 0) + n
  }
  for (const b of sessionTrace.blockers) {
    if (!g.blockers.includes(b)) g.blockers.push(b)
  }
  g.buildTestCommands = trimObject(g.buildTestCommands, 20)
  g.editedFiles = trimObject(g.editedFiles, 40)
  g.blockers = g.blockers.slice(-20)
  writeJson(sessionTracePath(), g)
}

function trimObject(obj: Record<string, number>, max: number): Record<string, number> {
  const entries = Object.entries(obj)
  if (entries.length <= max) return obj
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, max))
}

// --- Additions: detect build/test commands from a bash command string ---------
const BUILD_TEST_RE = /\b(pytest|npm test|idf\.py build|idf\.py test|cmake --build|make|cargo test|jest|vitest|go test|mvn test|gradle test)\b/

function isBuildTestCommand(command: string): boolean {
  return BUILD_TEST_RE.test(command)
}

function normalizeBuildTestCommand(command: string): string {
  // strip arguments after the tool name for stable aggregation
  const m = command.match(/\b(pytest|npm test|idf\.py build|idf\.py test|cmake --build|make|cargo test|jest|vitest|go test|mvn test|gradle test)\b/)
  return m ? m[1] : command.split(/\s+/).slice(0, 2).join(" ")
}

// --- Additions: parse failed test names from build/test output ----------------
function parseFailedTests(result: string, command: string): string[] {
  const failed: string[] = []
  // pytest: "FAILED tests/test_retry.py::test_name"
  if (/pytest/.test(command)) {
    const re = /FAILED\s+(\S+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(result)) && failed.length < 30) failed.push(m[1])
  }
  // jest/vitest: "✕ test name (X ms)" or "FAIL  path/test.js"
  if (/jest|vitest/.test(command)) {
    const re = /FAIL\s+(\S+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(result)) && failed.length < 30) failed.push(m[1])
  }
  // cargo: "test result: FAILED. ...", or "failures: name"
  if (/cargo test/.test(command)) {
    const re = /failures:\n([\s\S]*?)\n\n/
    const block = re.exec(result)?.[1] ?? ""
    for (const l of block.split("\n").filter(Boolean)) failed.push(l.trim())
  }
  // generic fallback: lines with FAIL/error
  if (failed.length === 0) {
    for (const l of result.split("\n")) {
      if (/^FAIL\b|^FAILED\b|: error:/i.test(l) && failed.length < 20) failed.push(l.trim().slice(0, 200))
    }
  }
  return failed
}

function parseTestSummary(result: string): string {
  for (const l of result.split("\n")) {
    if (/passed|failed|PASS|tests?\s+\d/i.test(l)) return l.trim()
  }
  return ""
}

// --- Additions: propose facts from session trace -----------------------------
function buildProposedFacts(): string {
  const gRaw = readJson<SessionTrace>(sessionTracePath())
  const g: SessionTrace | null = gRaw && typeof gRaw === "object" ? gRaw : null
  const out: string[] = ["# Proponowane fakty projektu (wygenerowane przez plugin)", ""]
  let added = false

  if (g && Object.keys(g.buildTestCommands).length) {
    added = true
    out.push("## Komendy")
    const cmds = Object.entries(g.buildTestCommands).sort((a, b) => b[1] - a[1])
    for (const [cmd, n] of cmds) {
      out.push(`- ${cmd}  (uruchamiano ${n}× w sesjach)`)
    }
    out.push("")
  }

  if (g && Object.keys(g.editedFiles).length) {
    added = true
    out.push("## Hotspoty (często edytowane pliki)")
    const files = Object.entries(g.editedFiles).sort((a, b) => b[1] - a[1]).slice(0, 10)
    for (const [f, n] of files) {
      out.push(`- ${f}  (${n}× edytowany)`)
    }
    out.push("")
  }

  // recent test failures from test history
  const recentFails = testHistory
    .filter((t) => t.exitCode !== 0)
    .slice(-5)
  if (recentFails.length) {
    added = true
    out.push("## Ostatnie nieudane testy")
    for (const t of recentFails) {
      out.push(`- [${t.timestamp}] ${t.command} (exit ${t.exitCode}): ${t.failed.slice(0, 3).join(", ") || t.summary}`)
    }
    out.push("")
  }

  if (g && g.blockers.length) {
    added = true
    out.push("## Ryzyka / powtarzające się blokery")
    for (const b of g.blockers.slice(-10)) out.push(`- ${b}`)
    out.push("")
  }

  if (!added) {
    out.push("(brak danych — uruchom kilka sesji z buildem/testami i edycją plików, aby plugin zebrał statystyki)")
  }
  return out.join("\n")
}

function commitProposedFacts(): string {
  const proposed = buildProposedFacts()
  const existing = readText(factsPath())
  const sep = existing.endsWith("\n") ? "\n" : existing ? "\n\n" : ""
  const merged = existing + sep + "\n<!-- === propozycje pluginu (dodane /memory commit) === -->\n" + proposed
  writeFileSync(factsPath(), merged, "utf8")
  // clear the proposed buffer by resetting trace (keep history though)
  rmSync(proposedFactsPath(), { force: true })
  return "Propozycje dopisane do project-facts.md. Przejrzyj i edytuj ręcznie, aby zachować zwięzłość."
}

// ---------------------------------------------------------------------------
// project-facts.md
// ---------------------------------------------------------------------------

function readProjectFacts(): string {
  const raw = readText(factsPath())
  const auto = cfg.autoExtractFacts ? readAutoFacts() : ""
  const merged = [auto, raw].filter(Boolean).join("\n\n---\n\n")
  if (!merged) return ""
  const tokens = estimateTokens(merged)
  if (tokens > cfg.maxProjectMemoryTokens) {
    const maxChars = cfg.maxProjectMemoryTokens * 4
    const truncated = merged.slice(0, maxChars)
    return truncated + "\n\n[WARN: project-facts exceeds memory budget; truncated]"
  }
  return merged
}

// ---------------------------------------------------------------------------
// active-session.json
// ---------------------------------------------------------------------------

function readActiveSession(): ActiveSession | null {
  return readJson<ActiveSession>(activeSessionPath())
}

function writeActiveSession(s: ActiveSession) {
  s.updatedAt = new Date().toISOString()
  // token-budget guard: if serialized too large, trim fields
  let serialized = JSON.stringify(s)
  if (estimateTokens(serialized) > cfg.maxSessionHandoffTokens) {
    s.decisions = s.decisions.slice(0, 3)
    s.modifiedFiles = s.modifiedFiles.slice(0, 10)
    s.blockers = s.blockers.slice(0, 3)
    s.lspErrors = s.lspErrors?.slice(0, 5)
    serialized = JSON.stringify(s)
  }
  writeJson(activeSessionPath(), s)
  // also persist per-session history
  if (s.sessionId) {
    writeJson(join(memoryDir, "session-history", `${s.sessionId}.json`), s)
  }
}

// ---------------------------------------------------------------------------
// Git helpers (via Bun shell $)
// ---------------------------------------------------------------------------

async function gitInfo($: any): Promise<{ branch: string; head: string; modified: string[]; recentDiff: string[] }> {
  const empty = { branch: "", head: "", modified: [], recentDiff: [] }
  try {
    const branch = (await $`git -C ${worktreePath} rev-parse --abbrev-ref HEAD`.text()).trim() || "(detached)"
    const head = (await $`git -C ${worktreePath} rev-parse --short HEAD`.text()).trim()
    const modifiedRaw = (await $`git -C ${worktreePath} status --porcelain`.text()).trim()
    const modified = modifiedRaw
      .split("\n")
      .filter(Boolean)
      .map((l: string) => l.slice(3).trim())
    const diffRaw = (await $`git -C ${worktreePath} diff --name-only HEAD~20 2>/dev/null || git -C ${worktreePath} diff --name-only`.text()).trim()
    const recentDiff = diffRaw.split("\n").filter(Boolean).slice(0, 20)
    return { branch, head, modified, recentDiff }
  } catch {
    return empty
  }
}

// ---------------------------------------------------------------------------
// Regression detection helpers (sync, via execSync)
// ---------------------------------------------------------------------------

function getHeadSha(): string {
  try {
    return execSync(`git -C ${JSON.stringify(worktreePath)} rev-parse HEAD`, { encoding: "utf8" }).trim()
  } catch {
    return ""
  }
}

function gitFilesChangedBetween(fromSha: string, toSha: string): string[] {
  try {
    const range = fromSha && toSha ? `${fromSha}..${toSha}` : toSha || "HEAD"
    const out = execSync(`git -C ${JSON.stringify(worktreePath)} diff --name-only ${range}`, { encoding: "utf8" })
    return out.split("\n").filter(Boolean)
  } catch {
    return []
  }
}

function gitCommitsBetween(fromSha: string, toSha: string): string[] {
  try {
    const range = fromSha && toSha ? `${fromSha}..${toSha}` : toSha || "HEAD"
    const out = execSync(`git -C ${JSON.stringify(worktreePath)} log --oneline ${range}`, { encoding: "utf8" })
    return out.split("\n").filter(Boolean)
  } catch {
    return []
  }
}

function gitStatusPorcelain(): string[] {
  try {
    const out = execSync(`git -C ${JSON.stringify(worktreePath)} status --porcelain`, { encoding: "utf8" })
    return out.split("\n").filter(Boolean).map((l) => l.slice(3).trim())
  } catch {
    return []
  }
}

function gitStash(args: string): string {
  try {
    return execSync(`git -C ${JSON.stringify(worktreePath)} stash ${args}`, { encoding: "utf8" }).trim()
  } catch (e: any) {
    return `git stash ${args} failed: ${e?.message ?? e}`
  }
}

function gitCheckoutFileFromSha(sha: string, file: string): string {
  try {
    execSync(`git -C ${JSON.stringify(worktreePath)} checkout ${sha} -- ${JSON.stringify(file)}`, { encoding: "utf8" })
    return `Przywrócono ${file} do wersji ${sha.slice(0, 7)}.`
  } catch (e: any) {
    return `Nie udało się przywrócić ${file}: ${e?.message ?? e}`
  }
}

// Znajdź „last good run" i „first red run" po pierwszym niepustymfailed test name.
// lastGood: ostatni uruchomienie z exit=0 (lub failed puste) przed pierwszym red.
// firstRed: pierwsze uruchomienie z exit!=0 z failed testem, którego wcześniej nie było.
function findRegressionWindow(): {
  lastGood: TestRun | null
  firstRed: TestRun | null
  failingTest: string
} {
  if (testHistory.length < 2) return { lastGood: null, firstRed: null, failingTest: "" }
  // iteruj od najnowszego wstecz, znajdź ostatni zielony
  const reversed = [...testHistory].reverse()
  let lastGreenIdx = -1
  for (let i = 0; i < reversed.length; i++) {
    if (reversed[i].exitCode === 0) { lastGreenIdx = i; break }
  }
  if (lastGreenIdx === -1) {
    // brak zielonego — użyj najstarszego wpisu jako „początek"
    return { lastGood: reversed[reversed.length - 1], firstRed: reversed[0], failingTest: reversed[0]?.failed?.[0] ?? "" }
  }
  const lastGood = reversed[lastGreenIdx]
  // szukaj pierwszego red PO lastGood (czyli w indeksie mniejszym niż lastGreenIdx w reversed)
  let firstRed: TestRun | null = null
  for (let i = lastGreenIdx - 1; i >= 0; i--) {
    if (reversed[i].exitCode !== 0 && reversed[i].failed.length) {
      firstRed = reversed[i]
      break
    }
  }
  return {
    lastGood,
    firstRed,
    failingTest: firstRed?.failed?.[0] ?? "",
  }
}

// Pliki podejrzane = edytowane między lastGood a firstRed, sortowane po liczbie edycji w trace
function suspectFiles(): string[] {
  const { lastGood, firstRed } = findRegressionWindow()
  if (!lastGood && !firstRed) return []
  // 1. pliki zmienione między SHA (jeśli mamy head'y)
  const filesFromGit: string[] = []
  if (lastGood?.head && firstRed?.head && lastGood.head !== firstRed.head) {
    filesFromGit.push(...gitFilesChangedBetween(lastGood.head, firstRed.head))
  } else if (firstRed?.head) {
    // brak lastGood.head — użyj stanu roboczego vs firstRed.head
    filesFromGit.push(...gitFilesChangedBetween("", firstRed.head))
  }
  // 2. pliki z trace.editedFiles, edytowane w oknie czasowym lastGood→firstRed
  const tStart = lastGood ? Date.parse(lastGood.timestamp) : 0
  const tEnd = firstRed ? Date.parse(firstRed.timestamp) : Date.now()
  const traceFiles: string[] = []
  const g = readJson<SessionTrace>(sessionTracePath())
  // trace nie ma timestampów per edycja, więc użyjemy wszystkich edytowanych plików
  // jako priorytetu sortowania, a okno czasowe bierzemy z git/active-session
  if (g?.editedFiles) {
    traceFiles.push(...Object.keys(g.editedFiles))
  }
  // 3. pliki zmodyfikowane obecnie (stan roboczy)
  const dirty = gitStatusPorcelain()
  // scalanie z priorytetem: dirty > git diff range > trace, sortowane po liczbie edycji
  const score: Record<string, number> = {}
  const add = (f: string, w: number) => { score[f] = (score[f] ?? 0) + w }
  for (const f of dirty) add(f, 100)
  for (const f of filesFromGit) add(f, 50)
  for (const f of traceFiles) add(f, (g?.editedFiles[f] ?? 1))
  return Object.entries(score)
    .sort((a, b) => b[1] - a[1])
    .map(([f]) => f)
    .slice(0, 20)
}

// ---------------------------------------------------------------------------
// Regression commands
// ---------------------------------------------------------------------------

function regressionLastGood(): string {
  const { lastGood, firstRed, failingTest } = findRegressionWindow()
  if (!lastGood && !firstRed) {
    return "Brak danych w test-history. Uruchom testy/build, aby plugin zebrał statystyki."
  }
  const lines: string[] = ["=== Regression window ==="]
  if (lastGood) {
    lines.push(`Last good:  ${lastGood.timestamp}  exit=${lastGood.exitCode}  ${lastGood.command}`)
    lines.push(`            HEAD: ${lastGood.head || "(brak SHA)"}`)
    lines.push(`            ${lastGood.summary}`)
  } else {
    lines.push("Last good:  (brak udanego uruchomienia w historii)")
  }
  if (firstRed) {
    lines.push(`First red:  ${firstRed.timestamp}  exit=${firstRed.exitCode}  ${firstRed.command}`)
    lines.push(`            HEAD: ${firstRed.head || "(brak SHA)"}`)
    lines.push(`            ${firstRed.summary}`)
    lines.push(`            failed: ${firstRed.failed.slice(0, 5).join(", ")}`)
  } else {
    lines.push("First red:  (brak nieudanego uruchomienia — brak regresji?)")
  }
  if (failingTest) lines.push(`Failing test: ${failingTest}`)
  return lines.join("\n")
}

function regressionSuspect(): string {
  const { lastGood, firstRed, failingTest } = findRegressionWindow()
  const files = suspectFiles()
  const out: string[] = ["=== Regression suspects ==="]
  if (failingTest) out.push(`Failing test: ${failingTest}`)
  if (lastGood && firstRed) {
    out.push(`Okno: ${lastGood.timestamp} → ${firstRed.timestamp}`)
    if (lastGood.head && firstRed.head && lastGood.head !== firstRed.head) {
      out.push(`Commity w oknie:`)
      for (const c of gitCommitsBetween(lastGood.head, firstRed.head).slice(0, 15)) out.push(`  ${c}`)
    }
  }
  if (!files.length) {
    out.push("Brak podejrzanych plików (brak zmian w oknie lub brak danych).")
  } else {
    out.push(`Pliki zmienione w oknie (posortowane wg prawdopodobieństwa):`)
    for (const f of files) out.push(`  ${f}`)
    out.push("")
    out.push("Podpowiedź: przywróć podejrzany plik do wersji last-good:")
    if (lastGood?.head) out.push(`  /regression revert <plik>      (wymaga /regression revert confirm)`)
    out.push(`  /regression revert stash       (zachowaj wszystkie zmiany w stash)`)
  }
  return out.join("\n")
}

function regressionRevert(args: string): string {
  const safe = cfg.regressionSafeRevertOnly
  const { lastGood } = findRegressionWindow()
  if (!lastGood) return "Brak last-good w historii — nie ma do czego wracać."
  const sha = lastGood.head
  if (!sha) return "Last-good nie ma zapisanego HEAD SHA. Włącz regressionTrackHead, by zbierać SHA."

  const parts = args.trim().split(/\s+/)
  const action = parts[0] ?? ""

  if (action === "stash") {
    const msg = gitStash(`push -m "opencode regression revert @ ${new Date().toISOString()}"`)
    return `Stash: ${msg}\nZmiany zachowane w stash. Sprawdź: git stash list, git stash pop.`
  }

  if (action === "all") {
    if (safe) {
      return [
        "OSTRZEŻENIE: 'all' wykonuje git checkout <sha> -- . (przywraca WSZYSTKIE pliki do last-good).",
        "Tryb bezpieczny (regressionSafeRevertOnly) wymaga potwierdzenia. Aby wykonać, wpisz:",
        `  /regression revert all confirm`,
      ].join("\n")
    }
    for (const f of suspectFiles()) gitCheckoutFileFromSha(sha, f)
    return `Przywrócono wszystkie podejrzane pliki do wersji ${sha.slice(0, 7)}.`
  }

  if (action === "confirm") {
    // drugi człon to nazwa pliku lub 'all'
    const target = parts[1] ?? ""
    if (target === "all") {
      for (const f of suspectFiles()) gitCheckoutFileFromSha(sha, f)
      return `Przywrócono wszystkie podejrzane pliki do wersji ${sha.slice(0, 7)}.`
    }
    if (target) {
      return gitCheckoutFileFromSha(sha, target)
    }
    return "Użycie: /regression revert confirm <plik|all>"
  }

  // brak akcji — podpowiedź
  if (!action) {
    return [
      "Użycie /regression revert:",
      "  /regression revert <plik>            — przywróć pojedynczy plik do last-good",
      "  /regression revert all               — przywróć wszystkie podejrzane pliki (wymaga confirm w trybie bezpiecznym)",
      "  /regression revert all confirm        — wykonaj przywrócenie wszystkich",
      "  /regression revert stash              — zstashuj wszystkie niezatwierdzone zmiany",
      "",
      `Last-good HEAD: ${sha.slice(0, 7)}`,
      `Podejrzane pliki: ${suspectFiles().slice(0, 5).join(", ") || "(brak)"}`,
    ].join("\n")
  }

  // domyślnie: pojedynczy plik
  if (safe) {
    return [
      `Przywrócenie ${action} do ${sha.slice(0, 7)} wymaga potwierdzenia (tryb bezpieczny).`,
      `Wpisz: /regression revert confirm ${action}`,
    ].join("\n")
  }
  return gitCheckoutFileFromSha(sha, action)
}

// ---------------------------------------------------------------------------
// Context injection on session.created
// ---------------------------------------------------------------------------

function buildInjectedContext(facts: string, session: ActiveSession | null, git: { branch: string; head: string; modified: string[]; recentDiff: string[] }): string {
  const lines: string[] = ["PROJECT MEMORY"]
  if (facts) {
    // extract first meaningful lines (Architecture, Rules, Commands) - keep concise
    const compact = facts
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(0, 25)
      .join("\n")
    lines.push(compact)
  }
  if (git.branch) lines.push(`Git: ${git.branch} @ ${git.head}`)
  if (git.modified.length) lines.push(`Modified files: ${git.modified.slice(0, 10).join(", ")}`)
  if (git.recentDiff.length) lines.push(`Recent changes: ${git.recentDiff.slice(0, 10).join(", ")}`)
  if (session) {
    if (session.goal) lines.push(`Previous task: ${session.goal}`)
    if (session.currentStatus) lines.push(`Status: ${session.currentStatus}`)
    if (session.modifiedFiles?.length) lines.push(`Previously edited: ${session.modifiedFiles.slice(0, 10).join(", ")}`)
    if (session.testStatus) lines.push(`Last test (${session.testStatus.exitCode}): ${session.testStatus.summary}`)
    if (session.blockers?.length) lines.push(`Blockers: ${session.blockers.join("; ")}`)
  }
  let block = lines.join("\n")
  const budget = cfg.maxProjectMemoryTokens
  if (estimateTokens(block) > budget) {
    block = block.slice(0, budget * 4)
    block += "\n[truncated to memory budget]"
  }
  return block
}

// ---------------------------------------------------------------------------
// Handoff building on session.idle / session.compacted
// ---------------------------------------------------------------------------

function buildHandoff(sessionId: string, edits: string[]): ActiveSession {
  const prev = readActiveSession()
  const s: ActiveSession = {
    schemaVersion: 1,
    sessionId,
    updatedAt: new Date().toISOString(),
    goal: prev?.goal ?? "",
    currentStatus: prev?.currentStatus ?? "",
    modifiedFiles: Array.from(new Set([...(prev?.modifiedFiles ?? []), ...edits])).slice(0, 20),
    decisions: prev?.decisions ?? [],
    commands: prev?.commands ?? {},
    testStatus: prev?.testStatus,
    blockers: prev?.blockers ?? [],
    lspErrors: prev?.lspErrors,
  }
  return s
}

// ---------------------------------------------------------------------------
// Tool result filtering
// ---------------------------------------------------------------------------

function saveArtifact(content: string): string {
  const id = shortHash(content)
  const path = join(artifactsDir(), `${id}.log`)
  ensureDir(artifactsDir())
  writeFileSync(path, content, "utf8")
  metrics.artifactsCreated += 1
  metrics.artifactBytes += Buffer.byteLength(content)
  enforceArtifactLimits()
  return id
}

function enforceArtifactLimits() {
  try {
    const dir = artifactsDir()
    const files = readdirSync(dir)
      .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs, size: statSync(join(dir, f)).size }))
      .sort((a, b) => a.mtime - b.mtime)
    const totalMB = files.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024)
    if (totalMB <= MAX_ARTIFACT_DIR_MB) {
      // also prune by TTL
      const now = Date.now()
      for (const f of files) {
        if (now - f.mtime > ARTIFACT_TTL_MS) {
          unlinkSync(join(dir, f.f))
        }
      }
      return
    }
    // remove oldest until under limit
    let removed = 0
    for (const f of files) {
      if (totalMB - removed <= MAX_ARTIFACT_DIR_MB) break
      unlinkSync(join(dir, f.f))
      removed += f.size / (1024 * 1024)
    }
  } catch {
    // ignore
  }
}

function summarizeBuildTest(result: string, exitCode: number, command: string): string {
  const lines = result.split("\n")
  const failed: string[] = []
  const errors: string[] = []
  let summary = ""
  for (const l of lines) {
    if (/FAIL|failed|error|Error|ERROR/.test(l)) {
      if (/FAILED|failed:/i.test(l) || /\berror\b/i.test(l)) {
        if (errors.length < 5) errors.push(l.trim())
        else if (!summary) summary = l.trim()
      }
      failed.push(l.trim())
    }
    if (/passed|PASS|tests? \d|summary|Result:|BUILD/i.test(l)) {
      summary = l.trim()
    }
  }
  const head = lines.slice(0, 5).join("\n")
  const tail = lines.slice(-15).join("\n")
  const parts = [
    `Command: ${command} (exit ${exitCode})`,
    summary ? `Summary: ${summary}` : "",
    errors.length ? `Errors:\n${errors.join("\n")}` : "",
    head ? `Head:\n${head}` : "",
    tail ? `Tail:\n${tail}` : "",
  ].filter(Boolean)
  return parts.join("\n")
}

function summarizeDiff(result: string): string {
  const lines = result.split("\n")
  if (lines.length <= cfg.maxDiffLines) return result
  // files list
  const files = lines
    .filter((l) => l.startsWith("diff --git") || l.startsWith("+++") || l.startsWith("---"))
    .map((l) => l.replace(/^diff --git a\//, "").replace(/^.{0,8}/, ""))
    .slice(0, 20)
  // first hunk(s)
  const hunks: string[] = []
  let cur: string[] = []
  let inHunk = false
  for (const l of lines) {
    if (l.startsWith("@@")) {
      if (cur.length) hunks.push(cur.join("\n"))
      cur = [l]
      inHunk = true
    } else if (inHunk) {
      cur.push(l)
    }
  }
  if (cur.length) hunks.push(cur.join("\n"))
  const selected = hunks.slice(0, 3).join("\n")
  const id = saveArtifact(result)
  const summary = `Changed files:\n${files.join("\n")}\n\nTop hunk(s):\n${truncateLines(selected, cfg.maxDiffLines - files.length - 5)}\n\nFull diff available: artifact://${id}`
  return summary
}

function summarizeSearch(result: string): string {
  const lines = result.split("\n")
  const matches: { file: string; line: string; ctx: string }[] = []
  let currentFile = ""
  for (const l of lines) {
    const m = l.match(/^(.+?):(\d+):\s*(.*)$/)
    if (m) {
      currentFile = m[1]
      matches.push({ file: m[1], line: m[2], ctx: m[3] })
    }
  }
  // dedupe identical
  const seen = new Set<string>()
  const unique = matches.filter((m) => {
    const k = `${m.file}:${m.ctx}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  // group by file
  const grouped: Record<string, string[]> = {}
  for (const m of unique) {
    if (!grouped[m.file]) grouped[m.file] = []
    grouped[m.file].push(`${m.line}: ${m.ctx}`)
  }
  const files = Object.keys(grouped).slice(0, 30)
  let out = ""
  let count = 0
  for (const f of files) {
    if (count >= cfg.maxSearchMatches) break
    out += `${f}\n`
    for (const l of grouped[f]) {
      if (count >= cfg.maxSearchMatches) break
      out += `  ${l}\n`
      count++
    }
  }
  if (unique.length > count) {
    const id = saveArtifact(result)
    out += `\n... ${unique.length - count} more matches. Full output: artifact://${id}`
  }
  return out || result
}

function dedupeRead(filePath: string, content: string, lineStart?: number, lineEnd?: number): string | null {
  if (!cfg.deduplicateReadResults) return content
  const h = hashContent(content)
  const rangeKey = `${filePath}:${lineStart ?? 0}-${lineEnd ?? "end"}`
  const existing = seen.find((s) => s.filePath === filePath && s.contentHash === h && `${s.filePath}:${s.lineStart ?? 0}-${s.lineEnd ?? "end"}` === rangeKey)
  if (existing) {
    metrics.deduplicatedReads += 1
    return `Already delivered in this session (hash: ${h.slice(0, 8)}, source: ${existing.source}, at ${existing.deliveredAt}). Use read_artifact or read again explicitly if needed.`
  }
  seen.push({ filePath, contentHash: h, lineStart, lineEnd, deliveredAt: new Date().toISOString(), source: "read" })
  return content
}

function filterToolResult(tool: string, args: any, result: string, exitCode = 0): string {
  if (typeof result !== "string") return result
  let filtered = result
  metrics.rawChars += result.length

  if (tool === "bash") {
    const cmd: string = args?.command ?? ""
    if (/git diff/.test(cmd)) {
      filtered = summarizeDiff(result)
    } else if (isBuildTestCommand(cmd)) {
      filtered = summarizeBuildTest(result, exitCode, cmd)
      // --- Addition 3: record test run in history ---
      failOpen(() => {
        const normalized = normalizeBuildTestCommand(cmd)
        const run: TestRun = {
          timestamp: new Date().toISOString(),
          command: cmd.slice(0, 200),
          exitCode,
          summary: parseTestSummary(result),
          failed: parseFailedTests(result, cmd),
          sessionId: lastSessionId,
          head: cfg.regressionTrackHead ? getHeadSha() : "",
        }
        recordTestRun(run)
        // --- Addition 2: track in session trace ---
        sessionTrace.buildTestCommands[normalized] = (sessionTrace.buildTestCommands[normalized] ?? 0) + 1
        if (exitCode !== 0 && run.failed.length) {
          for (const f of run.failed.slice(0, 5)) {
            if (!sessionTrace.blockers.includes(f)) sessionTrace.blockers.push(f)
          }
        }
        saveSessionTrace()
      }, "recordTestRun")
    } else if (/grep|rg /.test(cmd)) {
      filtered = summarizeSearch(result)
    }
  } else if (tool === "grep") {
    filtered = summarizeSearch(result)
  } else if (tool === "read") {
    const fp: string = args?.filePath ?? ""
    const ls = args?.offset
    const le = args?.limit ? (args.offset ?? 0) + args.limit : undefined
    const deduped = dedupeRead(fp, result, ls, le)
    if (deduped !== result) filtered = deduped ?? result
  }

  // mask secrets
  filtered = maskSecrets(filtered)

  // global line limit
  if (filtered.split("\n").length > cfg.maxToolResultLines) {
    if (cfg.storeFullArtifacts && filtered === result) {
      const id = saveArtifact(result)
      filtered = truncateLines(filtered, cfg.maxToolResultLines) + `\n\nFull output available: artifact://${id}`
    } else {
      filtered = truncateLines(filtered, cfg.maxToolResultLines)
    }
  }

  metrics.deliveredChars += filtered.length
  metrics.toolCalls += 1
  return filtered
}

// ---------------------------------------------------------------------------
// Custom tool: read_artifact
// ---------------------------------------------------------------------------

function readArtifact(artifactId: string, offset = 0, limit = cfg.maxArtifactPreviewLines, search?: string): string {
  const path = join(artifactsDir(), `${artifactId}.log`)
  if (!existsSync(path)) return `Artifact ${artifactId} not found.`
  let content = readText(path)
  if (search) {
    const lines = content.split("\n")
    const matched = lines.filter((l) => l.includes(search))
    content = matched.join("\n")
  }
  const lines = content.split("\n")
  const slice = lines.slice(offset, offset + limit)
  return slice.join("\n") + `\n\n[artifact ${artifactId}: lines ${offset}-${offset + slice.length} of ${lines.length}]`
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

function flushMetrics() {
  metrics.estimatedReductionPercent = metrics.rawChars > 0
    ? +(((metrics.rawChars - metrics.deliveredChars) / metrics.rawChars) * 100).toFixed(1)
    : 0
  writeJson(metricsPath(), metrics)
  // Addition 1: persist dedup cache to disk
  failOpen(() => saveDedupCache(), "saveDedupCache")
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function memoryStatus(): string {
  const facts = readText(factsPath())
  const sess = readActiveSession()
  let artifacts = 0
  let artifactBytes = 0
  try {
    const dir = artifactsDir()
    for (const f of readdirSync(dir)) {
      const st = statSync(join(dir, f))
      artifacts += 1
      artifactBytes += st.size
    }
  } catch {
    // ignore
  }
  return [
    `Worktree: ${worktreePath}`,
    `Project facts: ${estimateTokens(facts)} tokens (${facts.length} chars)`,
    `Active session: ${sess?.sessionId ?? "none"} (updated ${sess?.updatedAt ?? "-"})`,
    `Dedup cache: ${seen.length} wpisów${cfg.persistentDedupCache ? " (trwały na dysku)" : " (tylko RAM)"}`,
    `Artifacts: ${artifacts} (${(artifactBytes / 1024).toFixed(1)} KB)`,
    `Test history: ${testHistory.length} uruchomień`,
    `Metrics: ${metrics.toolCalls} tool calls, ${metrics.estimatedReductionPercent}% reduction, ${metrics.deduplicatedReads} dedup reads`,
  ].join("\n")
}

function memoryShow(): string {
  const facts = readProjectFacts()
  const sess = readActiveSession()
  return [
    "=== PROJECT FACTS ===",
    facts || "(empty)",
    "",
    "=== ACTIVE SESSION ===",
    sess ? JSON.stringify(sess, null, 2) : "(none)",
    "",
    "=== INJECTED CONTEXT (last session) ===",
    lastInjectedContext || "(none)",
    "",
    "=== TEST HISTORY (ostatnie 5) ===",
    testHistory.length ? testHistory.slice(-5).map((t) => `[${t.timestamp}] exit=${t.exitCode} ${t.command}\n    ${t.summary}`).join("\n") : "(brak)",
    "",
    "=== SESSION TRACE (aggregated) ===",
    (() => {
      const g = readJson<SessionTrace>(sessionTracePath())
      if (!g) return "(brak)"
      return JSON.stringify(g, null, 2)
    })(),
  ].join("\n")
}

function memoryClearSession(): string {
  seen = []
  metrics = { ...metrics, toolCalls: 0, rawChars: 0, deliveredChars: 0, deduplicatedReads: 0 }
  testHistory = []
  sessionTrace = { sessionId: lastSessionId, buildTestCommands: {}, editedFiles: {}, blockers: [], startedAt: new Date().toISOString() }
  try {
    rmSync(activeSessionPath(), { force: true })
    rmSync(join(memoryDir, "cache"), { recursive: true, force: true })
    ensureDir(join(memoryDir, "cache"))
  } catch {
    // ignore
  }
  return "Session memory cleared (project-facts.md i aggregated trace zachowane)."
}

function memoryClearProject(): string {
  try {
    rmSync(memoryDir, { recursive: true, force: true })
    initMemoryLayout(worktreePath)
  } catch {
    // ignore
  }
  return "All project memory cleared."
}

function contextBudget(): string {
  const facts = readProjectFacts()
  const sess = readActiveSession()
  const handoffTokens = sess ? estimateTokens(JSON.stringify(sess)) : 0
  return [
    `Project facts:  ${estimateTokens(facts)} / ${cfg.maxProjectMemoryTokens} tokens`,
    `Handoff:        ${handoffTokens} / ${cfg.maxSessionHandoffTokens} tokens`,
    `Tool result limit: ${cfg.maxToolResultLines} lines`,
    `Diff limit:     ${cfg.maxDiffLines} lines`,
    `Search matches: ${cfg.maxSearchMatches}`,
    `Artifact preview: ${cfg.maxArtifactPreviewLines} lines`,
  ].join("\n")
}

function contextArtifacts(): string {
  try {
    const dir = artifactsDir()
    const files = readdirSync(dir).map((f) => ({ f, st: statSync(join(dir, f)) }))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
      .slice(0, 20)
    if (!files.length) return "No artifacts stored."
    return files.map((f) => `${f.f}  ${(f.st.size / 1024).toFixed(1)} KB  ${new Date(f.st.mtimeMs).toISOString()}`).join("\n")
  } catch {
    return "No artifacts stored."
  }
}

// --- Additions: /memory propose | commit | test-history ----------------------

function memoryPropose(): string {
  const proposed = buildProposedFacts()
  writeFileSync(proposedFactsPath(), proposed, "utf8")
  return proposed + "\n\n---\nAby dopisać te propozycje do project-facts.md, uruchom:  /memory commit"
}

function memoryAutoRefresh(): string {
  refreshAutoFacts()
  const auto = readAutoFacts()
  return auto + `\n\n---\nZregenerowano ${factsAutoPath()}. Wstrzykiwane razem z project-facts.md.`
}

function memoryAutoShow(): string {
  const auto = readAutoFacts()
  if (!auto) return "Auto-fakty wyłączone lub puste. (autoExtractFacts=" + cfg.autoExtractFacts + ")"
  return auto
}

// --- /memory init ------------------------------------------------------------
// Wykrywa dane z repo (ekstraktory auto-fakts) i wstępnie wypełnia project-facts.md
// podpowiedziami. Idempotentny: nie nadpisuje nietrywialnego pliku; --force nadpisuje.

function isDefaultFactsTemplate(text: string): boolean {
  if (!text) return true
  const head = text.split("\n").slice(0, 6).join("\n")
  return /# Architektura/.test(head) && /\(uzupełnij/.test(head)
}

function buildInitFactsTemplate(force: boolean): { wrote: boolean; path: string; body: string; skipped: string } {
  const root = worktreePath || projectRoot || process.cwd()
  const cmds = extractBuildAndTestCommands(root)
  const env = extractEnvironment(root)
  const arch = extractArchitecture(root)
  const out: string[] = []
  out.push("# project-facts.md")
  out.push("# Fakty ręczne o projekcie. Inicjalizowane przez /memory init.")
  out.push("# Auto-wykryte wartości to podpowiedzi — edytuj swobodnie. Regenerowane auto-fakty: project-facts.auto.md")
  out.push("")

  // Architektura
  out.push("# Architektura")
  if (arch.stack.length) {
    for (const s of arch.stack) out.push(`- ${s}`)
  } else {
    out.push("- (uzupełnij: stack, główne katalogi, warstwy)")
  }
  if (arch.dirs.length) {
    out.push(`- Główne katalogi: ${arch.dirs.slice(0, 15).join(", ")}`)
  } else {
    out.push("- (uzupełnij: główne katalogi)")
  }
  out.push("")

  // Konwencje (puste — do ręcznego wypełnienia)
  out.push("# Konwencje")
  out.push("- (uzupełnij: reguły kodowania, styl, nazewnictwo)")
  out.push("- (uzupełnij: struktura modułów, warstwy)")
  out.push("")

  // Komendy
  out.push("# Komendy")
  const haveCmd = cmds.build.length || cmds.test.length || cmds.format.length || cmds.lint.length
  if (cmds.build.length) {
    out.push("- Build:")
    for (const c of cmds.build) out.push(`  - ${c}`)
  } else {
    out.push("- Build: (uzupełnij)")
  }
  if (cmds.test.length) {
    out.push("- Testy:")
    for (const c of cmds.test) out.push(`  - ${c}`)
  } else {
    out.push("- Testy: (uzupełnij)")
  }
  if (cmds.format.length) {
    out.push("- Formatowanie:")
    for (const c of cmds.format) out.push(`  - ${c}`)
  }
  if (cmds.lint.length) {
    out.push("- Lint:")
    for (const c of cmds.lint) out.push(`  - ${c}`)
  }
  if (!haveCmd) out.push("- (brak wykrytych manifestów — uzupełnij ręcznie)")
  out.push("")

  // Środowisko
  if (env.length) {
    out.push("# Środowisko")
    for (const e of env) out.push(`- ${e}`)
    out.push("")
  } else {
    out.push("# Środowisko")
    out.push("- (uzupełnij: wersje runtime, kontener, zależności systemowe)")
    out.push("")
  }

  // Ryzyka (puste — do ręcznego wypełnienia)
  out.push("# Ryzyka i znane problemy")
  out.push("- (uzupełnij)")

  const body = out.join("\n") + "\n"
  const path = factsPath()
  const existing = readText(path)

  // Idempotencja: nie nadpisuj, chyba że force lub domyślny szablon
  if (existing && !force && !isDefaultFactsTemplate(existing)) {
    return { wrote: false, path, body, skipped: "istniejący project-facts.md nietrywialny — użyj /memory init --force, aby nadpisać" }
  }
  if (existing && !force && isDefaultFactsTemplate(existing)) {
    // backup domyślnego szablonu
    try { writeFileSync(path + ".tpl.bak", existing, "utf8") } catch { /* ignore */ }
  }
  writeFileSync(path, body, "utf8")
  return { wrote: true, path, body, skipped: "" }
}

function memoryInit(args: string): string {
  const force = /\b--force\b/.test(args)
  const res = buildInitFactsTemplate(force)
  const lines: string[] = []
  if (res.wrote) {
    lines.push(`Zapisano: ${res.path}`)
    lines.push("")
    lines.push(res.body)
    lines.push("---")
    lines.push("Wykryte podpowiedzi wstawione do sekcji: Architektura, Komendy, Środowisko.")
    lines.push("Sekcje Konwencje i Ryzyka pozostawiono puste — uzupełnij ręcznie.")
    lines.push("Auto-fakty (.auto.md) są regenerowane oddzielnie na session.idle lub /memory auto-refresh.")
  } else {
    lines.push(`NIE zapisano: ${res.skipped}`)
    lines.push("Aby zobaczyć proponowany szablon bez zapisu, edytuj ręcznie lub użyj /memory init --force.")
  }
  return lines.join("\n")
}

function memoryTestHistory(): string {
  if (!testHistory.length) return "Brak zarejestrowanych uruchomień testów/buildów."
  const rows = testHistory.slice(-15).reverse().map((t) => {
    const status = t.exitCode === 0 ? "OK" : `FAIL(${t.exitCode})`
    const failed = t.failed.length ? `\n    failed: ${t.failed.slice(0, 5).join("; ")}` : ""
    return `[${t.timestamp}] ${status}  ${t.command}\n    ${t.summary}${failed}`
  })
  return ["=== Test history (najnowsze na górze) ===", ...rows].join("\n")
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const ProjectContextPlugin: Plugin = async ({ project, client, $, directory, worktree }, options) => {
  initMemoryLayout(worktree || directory || process.cwd())

  const userConfig = (options ?? {}) as Partial<Config>
  cfg = { ...DEFAULT_CONFIG, ...userConfig }

  return {
    // ------------------------------------------------------ session lifecycle
    event: async ({ event }: { event: any }) => {
      await failOpenAsync(async () => {
        const type = event?.properties?.type ?? event?.type
        if (type === "session.created") {
          const sessionId = event?.properties?.info?.sessionID ?? event?.properties?.sessionId ?? ""
          lastSessionId = sessionId
          metrics.sessionId = sessionId
          // Addition 2: start fresh per-session trace
          sessionTrace = {
            sessionId,
            buildTestCommands: {},
            editedFiles: {},
            blockers: [],
            startedAt: new Date().toISOString(),
          }
          // Auto-extract facts at session start so context is fresh even on first run
          if (cfg.autoExtractFacts) failOpen(() => refreshAutoFacts(), "refreshAutoFacts on session.created")
          const facts = readProjectFacts()
          const sess = readActiveSession()
          const git = await gitInfo($)
          const block = buildInjectedContext(facts, sess, git)
          lastInjectedContext = block
          // Try to append to the session prompt via TUI
          try {
            await client?.session?.prompt?.append?.({ body: { content: block } })
          } catch {
            // append not available; context stored for /memory show
          }
        } else if (type === "session.idle" || type === "session.compacted") {
          const sessionId = event?.properties?.info?.sessionID ?? lastSessionId ?? ""
          const edits = (await $`git -C ${worktreePath} status --porcelain`.text().catch(() => ""))
            .split("\n").filter(Boolean).map((l: string) => l.slice(3).trim())
          const handoff = buildHandoff(sessionId, edits)
          writeActiveSession(handoff)
          // Addition 2: fold per-session trace into persistent aggregated trace
          failOpen(() => mergeTraceIntoGlobal(), "mergeTraceIntoGlobal")
          // Auto-extract deterministic facts (build/test/architecture/environment)
          if (cfg.autoExtractFacts && cfg.autoExtractOnEvents.includes(type)) {
            failOpen(() => refreshAutoFacts(), `refreshAutoFacts on ${type}`)
          }
          flushMetrics()
        } else if (type === "session.deleted") {
          // optional: remove non-persistent session data
          failOpen(() => {
            const sid = event?.properties?.info?.sessionID
            if (sid) rmSync(join(memoryDir, "session-history", `${sid}.json`), { force: true })
          }, "session.deleted cleanup")
        } else if (type === "lsp.client.diagnostics") {
          const sess = readActiveSession()
          if (sess) {
            const diags = event?.properties?.diagnostics ?? event?.properties?.info?.diagnostics ?? []
            const errs = (Array.isArray(diags) ? diags : [])
              .filter((d: any) => d.severity === "error" || d.severity === 1)
              .map((d: any) => `${d.file ?? d.uri ?? ""}:${d.range?.start?.line ?? "?"} ${d.message ?? ""}`)
              .slice(0, 20)
            sess.lspErrors = errs
            writeActiveSession(sess)
          }
        } else if (type === "file.edited") {
          const fp: string = event?.properties?.path ?? event?.properties?.info?.path ?? ""
          if (fp) {
            // invalidate read cache for that file (Addition 1: persistent cache)
            seen = seen.filter((s) => s.filePath !== fp)
            failOpen(() => saveDedupCache(), "saveDedupCache on file.edited")
            // Addition 2: track edit count in session trace
            const rel = failOpenReturn(() => relative(worktreePath, fp) || fp, fp, "relative path")
            sessionTrace.editedFiles[rel] = (sessionTrace.editedFiles[rel] ?? 0) + 1
            failOpen(() => saveSessionTrace(), "saveSessionTrace on file.edited")
            const sess = readActiveSession()
            if (sess) {
              if (!sess.modifiedFiles.includes(fp)) sess.modifiedFiles.push(fp)
              writeActiveSession(sess)
            }
          }
        } else if (type === "command.executed") {
          const cmd: string = event?.properties?.command ?? ""
          if (cmd.startsWith("/memory ") || cmd.startsWith("/context ")) {
            // handled below via tui.command.execute; nothing here
          }
        }
      }, `event:${event?.type ?? "?"}`)
    },

    // ----------------------------------------------------- tool.execute hooks
    "tool.execute.before": async (input: any, output: any) => {
      await failOpenAsync(async () => {
        const t = input?.tool
        // security: block sensitive reads
        if (t === "read") {
          const fp: string = output?.args?.filePath ?? ""
          if (isSensitivePath(fp)) {
            throw new Error(`Blocked read of sensitive file: ${fp}. Use /memory to allow explicitly.`)
          }
        }
        // security: block bash reading secrets
        if (t === "bash") {
          const c: string = output?.args?.command ?? ""
          if (/\b(cat|type|Get-Content)\s+.*(\.env|id_rsa|\.pem|credentials|secrets)\b/i.test(c)) {
            throw new Error("Blocked command that reads secrets.")
          }
        }
      }, "tool.execute.before")
    },

    "tool.execute.after": async (input: any, output: any) => {
      await failOpenAsync(async () => {
        const t = input?.tool
        const args = output?.args ?? input?.args ?? {}
        const result = output?.result ?? output?.output ?? output?.content ?? ""
        if (typeof result !== "string" || !result) return
        const exitCode = output?.exitCode ?? output?.code ?? 0
        const filtered = filterToolResult(t, args, result, exitCode)
        if (filtered !== result) {
          output.result = filtered
          output.content = filtered
          output.output = filtered
        }
      }, "tool.execute.after")
      flushMetrics()
    },

    // ----------------------------------------------------------- custom tool
    tool: {
      read_artifact: tool({
        description: "Read a previously stored full tool result artifact by its short id, with pagination and optional search.",
        args: {
          artifactId: tool.schema.string(),
          offset: tool.schema.number().optional(),
          limit: tool.schema.number().optional(),
          search: tool.schema.string().optional(),
        },
        async execute(args: any, _ctx: any) {
          return readArtifact(args.artifactId, args.offset ?? 0, args.limit ?? cfg.maxArtifactPreviewLines, args.search)
        },
      }),
    },

    // ----------------------------------------------------------- TUI commands
    "tui.command.execute": async (input: any, output: any) => {
      await failOpenAsync(async () => {
        const cmd: string = input?.command ?? ""
        if (cmd.startsWith("/memory status")) output.result = memoryStatus()
        else if (cmd.startsWith("/memory show")) output.result = memoryShow()
        else if (cmd.startsWith("/memory save")) {
          const handoff = buildHandoff(lastSessionId, [])
          writeActiveSession(handoff)
          output.result = "Handoff saved."
        }
        else if (cmd.startsWith("/memory clear-session")) output.result = memoryClearSession()
        else if (cmd.startsWith("/memory clear-project")) output.result = memoryClearProject()
        else if (cmd.startsWith("/memory compact")) {
          const handoff = buildHandoff(lastSessionId, [])
          writeActiveSession(handoff)
          output.result = "Compact handoff created."
        }
        else if (cmd.startsWith("/memory propose")) output.result = memoryPropose()
        else if (cmd.startsWith("/memory commit")) output.result = commitProposedFacts()
        else if (cmd.startsWith("/memory auto-refresh")) output.result = memoryAutoRefresh()
        else if (cmd.startsWith("/memory auto")) output.result = memoryAutoShow()
        else if (cmd.startsWith("/memory init")) output.result = memoryInit(cmd.replace(/^\/memory init\s*/, ""))
        else if (cmd.startsWith("/memory test-history")) output.result = memoryTestHistory()
        else if (cmd.startsWith("/context budget")) output.result = contextBudget()
        else if (cmd.startsWith("/context artifacts")) output.result = contextArtifacts()
        else if (cmd.startsWith("/regression last-good")) output.result = regressionLastGood()
        else if (cmd.startsWith("/regression suspect")) output.result = regressionSuspect()
        else if (cmd.startsWith("/regression revert")) output.result = regressionRevert(cmd.replace(/^\/regression revert\s*/, ""))
      }, "tui.command.execute")
    },
  }
}

export default ProjectContextPlugin