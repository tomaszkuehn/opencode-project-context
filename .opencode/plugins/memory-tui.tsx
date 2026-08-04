/** @jsxImportSource @opentui/solid */
import { readFileSync, existsSync, readdirSync, statSync, appendFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createSignal, createMemo } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule, TuiSlotPlugin, TuiCommand } from "@opencode-ai/plugin/tui"

// --- TRACE (tymczasowe, do usunięcia po diagnozie) ---
const TRACE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "memory")
const TRACE_FILE = join(TRACE_DIR, "tui-trace.log")
function trace(msg: string, data?: unknown): void {
  try {
    mkdirSync(TRACE_DIR, { recursive: true })
    const extra = data !== undefined ? " " + JSON.stringify(data) : ""
    appendFileSync(TRACE_FILE, `${new Date().toISOString()} ${msg}${extra}\n`)
  } catch {}
}
trace("module-eval")
// --- KONIEC TRACE ---

type Metrics = {
  sessionId?: string
  toolCalls?: number
  rawChars?: number
  deliveredChars?: number
  deduplicatedReads?: number
  dedupSavedChars?: number
  estimatedReductionPercent?: number
  estimatedSavedChars?: number
  estimatedSavedTokens?: number
  artifactsCreated?: number
  artifactBytes?: number
  contextTokens?: number
  contextLimit?: number
  compactThresholdPct?: number
  compactMode?: string
  headSha?: string
  dirtyFiles?: number
  diskBytes?: number
  diskLimitBytes?: number
  artifactsBytes?: number
  cacheBytes?: number
  handoffAgeMin?: number
  modifiedCount?: number
  decisionsCount?: number
  blockersCount?: number
  dedupCacheCount?: number
  dedupCacheMax?: number
  testHistoryCount?: number
  testHistoryMax?: number
  lspErrorsCount?: number
  lastGoodHead?: string
  revertsCount?: number
  factsTokens?: number
  factsMaxTokens?: number
  // --- AI (Opcja A) ---
  aiEnabled?: boolean
  aiProvider?: string
  aiModel?: string
  aiCalls?: number
  aiSuccesses?: number
  aiFailures?: number
  aiLastCallMs?: number
  aiLastError?: string
}

type ActiveSession = {
  sessionId?: string
  updatedAt?: string
  goal?: string
  currentStatus?: string
  modifiedFiles?: string[]
  decisions?: string[]
  blockers?: string[]
  lspErrors?: string[]
}

type TestRun = {
  timestamp: string
  command: string
  exitCode: number
  summary: string
  failed: string[]
  head: string
}

function readJson<T>(p: string): T | null {
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, "utf8")) as T } catch { return null }
}

function readMetrics(worktree: string): Metrics | null {
  return readJson<Metrics>(join(worktree, ".opencode", "memory", "cache", "metrics.json"))
}

function readActiveSession(worktree: string): ActiveSession | null {
  return readJson<ActiveSession>(join(worktree, ".opencode", "memory", "active-session.json"))
}

function readTestHistory(worktree: string): TestRun[] {
  return readJson<TestRun[]>(join(worktree, ".opencode", "memory", "cache", "test-history.json")) ?? []
}

function listArtifacts(worktree: string): { id: string; bytes: number }[] {
  const dir = join(worktree, ".opencode", "memory", "artifacts")
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        let bytes = 0
        try { bytes = statSync(join(dir, f)).size } catch {}
        return { id: f.replace(/\.log$/, ""), bytes }
      })
      .sort((a, b) => b.bytes - a.bytes)
  } catch { return [] }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return `${n}`
}

function fmtBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

function pct(num: number, den: number): number {
  return den > 0 ? Math.round((num / den) * 100) : 0
}

function ageLabel(min: number): string {
  if (min <= 0) return "now"
  if (min < 60) return `${min}m`
  if (min < 1440) return `${Math.floor(min / 60)}h ${min % 60}m`
  return `${Math.floor(min / 1440)}d`
}

// ============================================================================
// 1. Toast przy przekroczeniach (context >= threshold, disk >= 90%)
// 3. Dialog compact-confirm (compactMode === "confirm")
// ============================================================================

function setupToastsAndDialogs(
  api: TuiPluginApi,
  metrics: () => Metrics | null,
): void {
  const { ui, theme } = api
  let lastCtxWarn = false
  let lastDiskWarn = false
  let compactDialogShown = false

  const checkAndNotify = () => {
    const m = metrics()
    if (!m) return

    // --- Context threshold toast ---
    const ctxPct = pct(m.contextTokens ?? 0, m.contextLimit ?? 0)
    const threshold = m.compactThresholdPct ?? 80
    const ctxWarn = ctxPct >= threshold
    if (ctxWarn && !lastCtxWarn) {
      const mode = m.compactMode ?? "suggest"
      if (mode === "confirm" && !compactDialogShown && ui?.dialog) {
        // --- 3. Dialog compact-confirm ---
        compactDialogShown = true
        ui.dialog.replace(
          () => (
            <box flexDirection="column" padding={1} borderColor={theme.current.warning}>
              <text fg={theme.current.warning}>Kontekst {ctxPct}% — powyżej progu {threshold}%</text>
              <text fg={theme.current.textMuted}>Skompaktować sesję? Zaoszczędzi tokeny.</text>
              <text fg={theme.current.textMuted}>  Y = skompaktuj teraz   N = odłóż</text>
            </box>
          ),
          () => { compactDialogShown = false },
        )
      } else if (mode === "suggest") {
        ui?.toast?.({
          variant: "warning",
          title: "Kontekst",
          message: `${ctxPct}% (compact@${threshold}%) — /memory compact-now`,
          duration: 5000,
        })
      }
    }
    lastCtxWarn = ctxWarn

    // --- Disk threshold toast ---
    const diskPct = pct(m.diskBytes ?? 0, m.diskLimitBytes ?? 200 * 1024 * 1024)
    const diskWarn = diskPct >= 90
    if (diskWarn && !lastDiskWarn) {
      ui?.toast?.({
        variant: "error",
        title: "Dysk",
        message: `Pamięć pluginu ${fmtBytes(m.diskBytes ?? 0)} (${diskPct}% limitu) — /memory clear-session`,
        duration: 7000,
      })
    }
    lastDiskWarn = diskWarn
  }

  // Check every 5s (less aggressive than 3s status refresh)
  const notifyTimer = setInterval(checkAndNotify, 5000)
  api.lifecycle.onDispose(() => clearInterval(notifyTimer))
}

// ============================================================================
// 2. Własny ekran /memory dashboard (route)
// ============================================================================

function MemoryDashboard(props: { worktree: string; theme: any; api: TuiPluginApi }): unknown {
  const { worktree, theme, api } = props
  const t = theme.current

  const [metrics, setMetrics] = createSignal<Metrics | null>(null)
  const [sess, setSess] = createSignal<ActiveSession | null>(null)
  const [tests, setTests] = createSignal<TestRun[]>([])
  const [arts, setArts] = createSignal<{ id: string; bytes: number }[]>([])

  const refresh = () => {
    setMetrics(readMetrics(worktree))
    setSess(readActiveSession(worktree))
    setTests(readTestHistory(worktree).slice(-10).reverse())
    setArts(listArtifacts(worktree).slice(0, 10))
  }

  refresh()
  const timer = setInterval(refresh, 3000)
  // Cleanup interval on plugin teardown — prevents timer leak when route unmounts.
  api.lifecycle.onDispose(() => clearInterval(timer))

  // Esc/q = zamknij dashboard i wróć na poprzedni route.
  // useKeyboard jest globalne (renderer.keyInput) — działa bez fokusu, włączając
  // przypadki gdy dashboard nie ma focusowalnych elementów.
  useKeyboard((key) => {
    if (key.name === "escape" || key.name === "q") {
      try {
        api.route.navigate("home")
        trace("dashboard-close-key", { key: key.name })
      } catch (err) {
        trace("dashboard-close-throw", { error: String(err) })
      }
    }
  })

  const m = createMemo(() => metrics())
  const s = createMemo(() => sess())
  const th = createMemo(() => tests())
  const ar = createMemo(() => arts())

  const sectionTitle = (label: string) => (
    <text fg={t.accent} attributes={1}>{label}</text>
  )

  return (
    <box flexDirection="column" border={true} borderStyle="rounded" borderColor={t.textMuted} padding={0} paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
      {/* Header */}
      <box flexDirection="row">
        <text fg={t.primary} attributes={1}>memory dashboard</text>
        <text fg={t.textMuted}>  /memory dashboard  ·  refresh 3s</text>
      </box>

      {/* --- Section 1: Token savings --- */}
      <box flexDirection="column" marginTop={1}>
        {sectionTitle("Oszczędność tokenów")}
        {(() => {
          const mm = m()
          if (!mm || !mm.toolCalls) return <text fg={t.textMuted}>  idle (brak danych)</text>
          return (
            <box flexDirection="column">
              <text fg={t.text}>  tools: {mm.toolCalls} · saved: ~{fmtTokens(mm.estimatedSavedTokens ?? 0)} tok · {mm.estimatedReductionPercent ?? 0}% reduc.</text>
              <text fg={t.textMuted}>  dedup: {mm.deduplicatedReads ?? 0} reads · artifacts: {mm.artifactsCreated ?? 0} ({fmtBytes(mm.artifactsBytes ?? 0)})</text>
            </box>
          )
        })()}
      </box>

      {/* --- Section 2: Disk --- */}
      <box flexDirection="column" marginTop={1}>
        {sectionTitle("Dysk")}
        {(() => {
          const mm = m()
          const disk = mm?.diskBytes ?? 0
          const limit = mm?.diskLimitBytes ?? 200 * 1024 * 1024
          const dp = pct(disk, limit)
          const color = dp >= 90 ? t.error : dp >= 70 ? t.warning : t.text
          return (
            <text fg={color}>  {fmtBytes(disk)} / {fmtBytes(limit)} ({dp}%) · art {fmtBytes(mm?.artifactsBytes ?? 0)} · cache {fmtBytes(mm?.cacheBytes ?? 0)}</text>
          )
        })()}
      </box>

      {/* --- Section 3: Context budget --- */}
      <box flexDirection="column" marginTop={1}>
        {sectionTitle("Budżet kontekstu")}
        {(() => {
          const mm = m()
          const ct = mm?.contextTokens ?? 0
          const cl = mm?.contextLimit ?? 0
          const cp = pct(ct, cl)
          const thr = mm?.compactThresholdPct ?? 80
          const ft = mm?.factsTokens ?? 0
          const fm = mm?.factsMaxTokens ?? 1500
          const fp = pct(ft, fm)
          const color = cp >= thr ? t.error : cp >= thr - 15 ? t.warning : t.text
          return (
            <box flexDirection="column">
              <text fg={color}>  ctx: {fmtTokens(ct)}/{fmtTokens(cl)} tok ({cp}%, compact@{thr}%) [{mm?.compactMode ?? "?"}]</text>
              <text fg={t.textMuted}>  facts: {fmtTokens(ft)}/{fmtTokens(fm)} ({fp}%)</text>
            </box>
          )
        })()}
      </box>

      {/* --- Section 4: Session --- */}
      <box flexDirection="column" marginTop={1}>
        {sectionTitle("Sesja")}
        {(() => {
          const mm = m()
          const ss = s()
          const handoff = ageLabel(mm?.handoffAgeMin ?? 0)
          const dirty = mm?.dirtyFiles ?? 0
          const dirtyLabel = dirty > 0 ? ` (dirty:${dirty})` : ""
          const lsp = mm?.lspErrorsCount ?? 0
          const lspLabel = lsp > 0 ? ` · lsp:${lsp}err` : ""
          const lastGood = mm?.lastGoodHead ? ` · last-good:${mm.lastGoodHead}` : ""
          return (
            <box flexDirection="column">
              <text fg={t.text}>  handoff: {handoff} · mod:{mm?.modifiedCount ?? 0} · dec:{mm?.decisionsCount ?? 0} · blk:{mm?.blockersCount ?? 0}</text>
              <text fg={t.textMuted}>  HEAD:{mm?.headSha || "-"}{dirtyLabel}{lspLabel}{lastGood}</text>
              {ss?.goal ? <text fg={t.text}>  goal: {ss.goal}</text> : null}
              {ss?.currentStatus ? <text fg={t.textMuted}>  status: {ss.currentStatus}</text> : null}
              {ss?.blockers && ss.blockers.length > 0 ? (
                <box flexDirection="column">
                  <text fg={t.warning}>  blokery:</text>
                  {ss.blockers.map((b, i) => <text fg={t.warning}>    - {b}</text>)}
                </box>
              ) : null}
              {ss?.lspErrors && ss.lspErrors.length > 0 ? (
                <box flexDirection="column">
                  <text fg={t.error}>  błędy LSP:</text>
                  {ss.lspErrors.slice(0, 5).map((e, i) => <text fg={t.error}>    - {e}</text>)}
                </box>
              ) : null}
            </box>
          )
        })()}
      </box>

      {/* --- Section 5: Cache limits --- */}
      <box flexDirection="column" marginTop={1}>
        {sectionTitle("Cache")}
        {(() => {
          const mm = m()
          return (
            <text fg={t.text}>  dedup: {mm?.dedupCacheCount ?? 0}/{mm?.dedupCacheMax ?? 500} · tests: {mm?.testHistoryCount ?? 0}/{mm?.testHistoryMax ?? 50}</text>
          )
        })()}
      </box>

      {/* --- Section 5b: AI module --- */}
      <box flexDirection="column" marginTop={1}>
        {sectionTitle("AI module (Opcja A)")}
        {(() => {
          const mm = m()
          const on = mm?.aiEnabled === true
          if (!on) return <text fg={t.textMuted}>  wyłączone (deterministyczne ekstraktory działają)</text>
          const prov = mm?.aiProvider ?? "?"
          const model = mm?.aiModel ?? "?"
          const calls = mm?.aiCalls ?? 0
          const ok = mm?.aiSuccesses ?? 0
          const fail = mm?.aiFailures ?? 0
          const ms = mm?.aiLastCallMs ?? 0
          const err = mm?.aiLastError ?? ""
          const statusColor = fail > 0 && ok === 0 ? t.error : fail > 0 ? t.warning : t.success
          return (
            <box flexDirection="column">
              <text fg={t.text}>  model: <text fg={t.accent}>{prov}/{model}</text></text>
              <text fg={t.text}>  wołania: <text fg={statusColor}>{ok}/{calls} ok</text>{fail > 0 ? <text fg={t.warning}> ({fail} porażek)</text> : null}{ms > 0 ? <text fg={t.textMuted}> · {ms}ms</text> : null}</text>
              {err && fail > 0 ? <text fg={t.error}>  błąd: {err.slice(0, 100)}</text> : null}
            </box>
          )
        })()}
      </box>

      {/* --- Section 6: Test history --- */}
      <box flexDirection="column" marginTop={1}>
        {sectionTitle("Historia testów (10 ostatnich)")}
        {(() => {
          const ts = th()
          if (ts.length === 0) return <text fg={t.textMuted}>  (brak)</text>
          return (
            <box flexDirection="column">
              {ts.map((run, i) => {
                const status = run.exitCode === 0 ? "OK" : `FAIL(${run.exitCode})`
                const color = run.exitCode === 0 ? t.success : t.error
                return (
                  <box flexDirection="column">
                    <text fg={color}>  [{run.timestamp}] {status}  {run.command}</text>
                    {run.summary ? <text fg={t.textMuted}>    {run.summary}</text> : null}
                    {run.failed.length > 0 ? (
                      <text fg={t.error}>    failed: {run.failed.slice(0, 3).join(", ")}</text>
                    ) : null}
                  </box>
                )
              })}
            </box>
          )
        })()}
      </box>

      {/* --- Section 7: Artifacts --- */}
      <box flexDirection="column" marginTop={1}>
        {sectionTitle("Artefakty (10 największych)")}
        {(() => {
          const as = ar()
          if (as.length === 0) return <text fg={t.textMuted}>  (brak)</text>
          return (
            <box flexDirection="column">
              {as.map((a, i) => (
                <text fg={t.textMuted}>  {a.id}  {fmtBytes(a.bytes)}</text>
              ))}
            </box>
          )
        })()}
      </box>

      {/* Footer */}
      <box flexDirection="row" marginTop={1}>
        <text fg={t.textMuted}>Esc = zamknij · /memory status = tekstowy odpowiednik</text>
      </box>
    </box>
  )
}

function setupRoute(api: TuiPluginApi, worktree: string): void {
  const { route, theme } = api
  route.register([
    {
      name: "memory-dashboard",
      render: () => <MemoryDashboard worktree={worktree} theme={theme} api={api} />,
    },
  ])
}

// ============================================================================
// 5. Sidebar enrichment — blokery + błędy LSP w sidebar_content
// ============================================================================

function setupSidebar(api: TuiPluginApi, worktree: string): void {
  const { slots, theme } = api

  const [sess, setSess] = createSignal<ActiveSession | null>(null)
  const refresh = () => setSess(readActiveSession(worktree))
  refresh()
  const timer = setInterval(refresh, 5000)
  api.lifecycle.onDispose(() => clearInterval(timer))

  let tracedSidebar = false
  const sidebarSlot: TuiSlotPlugin = {
    slots: {
      sidebar_content: (_ctx, _props) => {
        try {
        if (!tracedSidebar) { tracedSidebar = true; trace("render-sidebar_content") }
        const s = sess()
        const t = theme.current
        const blockers = s?.blockers ?? []
        const lsp = s?.lspErrors ?? []
        if (blockers.length === 0 && lsp.length === 0) return null

        return (
          <box flexDirection="column" border={true} borderStyle="rounded" borderColor={t.textMuted} padding={0} paddingLeft={1} paddingRight={1}>
            {blockers.length > 0 ? (
              <box flexDirection="column">
                <text fg={t.warning} attributes={1}>blokery ({blockers.length})</text>
                {blockers.slice(0, 3).map((b, i) => (
                  <text fg={t.warning}>  - {b.length > 60 ? b.slice(0, 57) + "..." : b}</text>
                ))}
              </box>
            ) : null}
            {lsp.length > 0 ? (
              <box flexDirection="column" marginTop={blockers.length > 0 ? 1 : 0}>
                <text fg={t.error} attributes={1}>LSP err ({lsp.length})</text>
                {lsp.slice(0, 3).map((e, i) => (
                  <text fg={t.error}>  - {e.length > 60 ? e.slice(0, 57) + "..." : e}</text>
                ))}
              </box>
            ) : null}
          </box>
        )
        } catch (err) {
          trace("render-sidebar-throw", { error: String(err) })
          return null
        }
      },
    },
  }
  slots.register(sidebarSlot)
}

// ============================================================================
// Main plugin — app_bottom status bar (existing) + all new features
// ============================================================================

const MemoryTuiPlugin: TuiPlugin = async (api: TuiPluginApi) => {
  try {
    trace("tui-enter", { worktree: api.state?.path?.worktree, directory: api.state?.path?.directory })
  const { state, theme, slots, lifecycle } = api
  const worktree = state.path.worktree

  const [metrics, setMetrics] = createSignal<Metrics | null>(null)

  const refresh = () => {
    setMetrics(readMetrics(worktree))
  }

  refresh()

  const timer = setInterval(refresh, 3000)
  lifecycle.onDispose(() => clearInterval(timer))

  // 1 + 3: Toasts przy przekroczeniach + dialog compact-confirm
  setupToastsAndDialogs(api, metrics)

  // 2: Własny ekran dashboard (route)
  setupRoute(api, worktree)
  trace("route-registered")

  // 2b: Keybind + slash command -> przejdź na route memory-dashboard
  if (api.command?.register) {
    const unregisterCommands = api.command.register(() => [
      {
        title: "Memory dashboard",
        value: "memory.dashboard",
        description: "Otwórz pełnoekranowy dashboard pamięci projektu (route: memory-dashboard)",
        category: "Memory",
        keybind: "ctrl+d",
        slash: { name: "memory dashboard", aliases: ["md"] },
        onSelect: () => {
          try {
            api.route.navigate("memory-dashboard")
            trace("command-navigate-memory-dashboard")
          } catch (err) {
            trace("command-navigate-throw", { error: String(err) })
          }
        },
      } satisfies TuiCommand,
    ])
    lifecycle.onDispose(() => unregisterCommands?.())
    trace("command-registered")
  } else {
    trace("command-api-unavailable")
  }

  // 5: Sidebar enrichment (blokery + LSP)
  setupSidebar(api, worktree)
  trace("sidebar-registered")

  // Existing: app_bottom status bar
  let tracedAppBottom = false
  const appBottomSlot: TuiSlotPlugin = {
    slots: {
      app_bottom: (_ctx, _props) => {
        try {
        const m = metrics()
        if (!tracedAppBottom) { tracedAppBottom = true; trace("render-app_bottom", { hasMetrics: !!m, toolCalls: m?.toolCalls }) }
        const t = theme.current

        if (!m || !m.toolCalls) {
          return (
            <box flexDirection="column" flexShrink={0} border={true} borderStyle="rounded" borderColor={t.textMuted} padding={0} paddingLeft={1} paddingRight={1}>
              <text fg={t.primary}>memory: </text><text fg={t.textMuted}>idle</text>
            </box>
          )
        }

        const calls = m.toolCalls ?? 0
        const saved = m.estimatedSavedTokens ?? 0
        const reduction = m.estimatedReductionPercent ?? 0
        const dedup = m.deduplicatedReads ?? 0
        const arts = m.artifactsCreated ?? 0
        const artBytes = m.artifactsBytes ?? 0

        // --- Line 1: token savings (existing) ---
        // Kolorowane fragmenty: etykiety textMuted, wartości istotne success/accent
        const line1Parts: unknown[] = []
        line1Parts.push(<text fg={t.primary}>memory:</text>)
        line1Parts.push(<text fg={t.textMuted}> tools: </text>)
        line1Parts.push(<text fg={t.accent}>{calls}</text>)
        line1Parts.push(<text fg={t.textMuted}> · saved: ~</text>)
        line1Parts.push(<text fg={t.success}>{fmtTokens(saved)} tok</text>)
        line1Parts.push(<text fg={t.textMuted}> · </text>)
        line1Parts.push(<text fg={reduction >= 50 ? t.success : reduction >= 20 ? t.warning : t.textMuted}>{reduction.toFixed(0)}% reduc.</text>)
        if (dedup > 0) {
          line1Parts.push(<text fg={t.textMuted}> · dedup: </text>)
          line1Parts.push(<text fg={t.accent}>{dedup}</text>)
        }
        if (arts > 0) {
          line1Parts.push(<text fg={t.textMuted}> · art: </text>)
          line1Parts.push(<text fg={t.accent}>{arts}</text>)
          line1Parts.push(<text fg={t.textMuted}> ({fmtBytes(artBytes)})</text>)
        }

        // --- Line 2: disk usage ---
        const disk = m.diskBytes ?? 0
        const diskLimit = m.diskLimitBytes ?? (200 * 1024 * 1024)
        const diskPct = pct(disk, diskLimit)
        const cacheBytes = m.cacheBytes ?? 0
        const artifactsBytes = m.artifactsBytes ?? 0
        const diskColor = diskPct >= 90 ? t.error : diskPct >= 70 ? t.warning : t.textMuted
        const line2Parts: unknown[] = []
        line2Parts.push(<text fg={t.textMuted}>disk: </text>)
        line2Parts.push(<text fg={diskColor}>{fmtBytes(disk)} / {fmtBytes(diskLimit)} ({diskPct}%)</text>)
        line2Parts.push(<text fg={t.textMuted}> · art </text>)
        line2Parts.push(<text fg={artifactsBytes > 10 * 1024 * 1024 ? t.warning : t.textMuted}>{fmtBytes(artifactsBytes)}</text>)
        line2Parts.push(<text fg={t.textMuted}> · cache </text>)
        line2Parts.push(<text fg={cacheBytes > 50 * 1024 * 1024 ? t.warning : t.textMuted}>{fmtBytes(cacheBytes)}</text>)

        // --- Line 3: context budget + compaction ---
        const ctxTok = m.contextTokens ?? 0
        const ctxLimit = m.contextLimit ?? 0
        const ctxPct = pct(ctxTok, ctxLimit)
        const threshold = m.compactThresholdPct ?? 80
        const ctxColor = ctxPct >= threshold ? t.error : ctxPct >= threshold - 15 ? t.warning : t.textMuted
        const factsTok = m.factsTokens ?? 0
        const factsMax = m.factsMaxTokens ?? 1500
        const factsPct = pct(factsTok, factsMax)
        const factsColor = factsPct >= 90 ? t.error : factsPct >= 70 ? t.warning : t.textMuted
        const line3Parts: unknown[] = []
        line3Parts.push(<text fg={t.textMuted}>ctx: </text>)
        line3Parts.push(<text fg={ctxColor}>{fmtTokens(ctxTok)}/{fmtTokens(ctxLimit)} tok ({ctxPct}%, compact@{threshold}%)</text>)
        line3Parts.push(<text fg={t.textMuted}> · facts: </text>)
        line3Parts.push(<text fg={factsColor}>{fmtTokens(factsTok)}/{fmtTokens(factsMax)} ({factsPct}%)</text>)
        line3Parts.push(<text fg={t.textMuted}> [</text>)
        line3Parts.push(<text fg={m.compactMode === "confirm" ? t.warning : t.textMuted}>{m.compactMode ?? "?"}</text>)
        line3Parts.push(<text fg={t.textMuted}>]</text>)

        // --- Line 4: session + git + regression ---
        const handoff = ageLabel(m.handoffAgeMin ?? 0)
        const mod = m.modifiedCount ?? 0
        const dec = m.decisionsCount ?? 0
        const blk = m.blockersCount ?? 0
        const head = m.headSha || "-"
        const dirty = m.dirtyFiles ?? 0
        const dirtyLabel = dirty > 0 ? ` (dirty:${dirty})` : ""
        const lsp = m.lspErrorsCount ?? 0
        const lspLabel = lsp > 0 ? ` · lsp:${lsp}err` : ""
        const lastGood = m.lastGoodHead ? ` · last-good:${m.lastGoodHead}` : ""
        const reverts = m.revertsCount ?? 0
        const revertsLabel = reverts > 0 ? ` · reverts:${reverts}` : ""
        const line4Parts: unknown[] = []
        line4Parts.push(<text fg={t.textMuted}>handoff: </text>)
        line4Parts.push(<text fg={(m.handoffAgeMin ?? 0) > 1440 ? t.warning : t.text}>{handoff}</text>)
        line4Parts.push(<text fg={t.textMuted}> · mod:</text>)
        line4Parts.push(<text fg={mod > 0 ? t.accent : t.textMuted}>{mod}</text>)
        line4Parts.push(<text fg={t.textMuted}> · dec:</text>)
        line4Parts.push(<text fg={dec > 0 ? t.accent : t.textMuted}>{dec}</text>)
        line4Parts.push(<text fg={t.textMuted}> · blk:</text>)
        line4Parts.push(<text fg={blk > 0 ? t.error : t.textMuted}>{blk}</text>)
        line4Parts.push(<text fg={t.textMuted}> · HEAD:</text>)
        line4Parts.push(<text fg={t.text}>{head}</text>)
        if (dirty > 0) line4Parts.push(<text fg={t.warning}>{dirtyLabel}</text>)
        if (lsp > 0) line4Parts.push(<text fg={t.error}> · lsp:{lsp}err</text>)
        if (m.lastGoodHead) line4Parts.push(<text fg={t.textMuted}> · last-good:</text>, <text fg={t.text}>{m.lastGoodHead}</text>)
        if (reverts > 0) line4Parts.push(<text fg={t.warning}> · reverts:{reverts}</text>)

        // --- Line 5: cache limits ---
        const dedupC = m.dedupCacheCount ?? 0
        const dedupM = m.dedupCacheMax ?? 500
        const testC = m.testHistoryCount ?? 0
        const testM = m.testHistoryMax ?? 50
        const dedupColor = dedupC >= dedupM ? t.warning : t.textMuted
        const testColor = testC >= testM ? t.warning : t.textMuted
        const line5Parts: unknown[] = []
        line5Parts.push(<text fg={t.textMuted}>dedup cache: </text>)
        line5Parts.push(<text fg={dedupColor}>{dedupC}/{dedupM}</text>)
        line5Parts.push(<text fg={t.textMuted}> · tests: </text>)
        line5Parts.push(<text fg={testColor}>{testC}/{testM}</text>)

        // --- AI (Opcja A): nazwa modelu + status ---
        const aiOn = m.aiEnabled === true
        const aiModel = m.aiModel ?? "?"
        const aiProv = m.aiProvider ?? "?"
        const aiCalls = m.aiCalls ?? 0
        const aiOk = m.aiSuccesses ?? 0
        const aiFail = m.aiFailures ?? 0
        const aiMs = m.aiLastCallMs ?? 0
        const aiErr = m.aiLastError ?? ""
        const line6Parts: unknown[] = []
        line6Parts.push(<text fg={t.textMuted}>ai: </text>)
        if (!aiOn) {
          line6Parts.push(<text fg={t.textMuted}>off</text>)
        } else {
          line6Parts.push(<text fg={t.accent}>{aiProv}/{aiModel}</text>)
          const statusColor = aiFail > 0 && aiOk === 0 ? t.error : aiFail > 0 ? t.warning : t.success
          line6Parts.push(<text fg={t.textMuted}> · </text>)
          line6Parts.push(<text fg={statusColor}>{aiOk}/{aiCalls} ok</text>)
          if (aiMs > 0) {
            line6Parts.push(<text fg={t.textMuted}> · </text>)
            line6Parts.push(<text fg={t.textMuted}>{aiMs}ms</text>)
          }
          if (aiErr && aiFail > 0) {
            line6Parts.push(<text fg={t.textMuted}> · </text>)
            line6Parts.push(<text fg={t.error}>err: {aiErr.slice(0, 60)}</text>)
          }
        }

        return (
          <box flexDirection="column" flexShrink={0} border={true} borderStyle="rounded" borderColor={t.textMuted} padding={0} paddingLeft={1} paddingRight={1}>
            <box flexDirection="row">{line1Parts}</box>
            <box flexDirection="row">{line2Parts}</box>
            <box flexDirection="row">{line3Parts}</box>
            <box flexDirection="row">{line4Parts}</box>
            <box flexDirection="row">{line5Parts}</box>
            {aiOn ? <box flexDirection="row">{line6Parts}</box> : null}
          </box>
        )
        } catch (err) {
          trace("render-app_bottom-throw", { error: String(err) })
          return null
        }
      },
    },
  }
  const appBottomId = slots.register(appBottomSlot)
  trace("app-bottom-registered", { id: appBottomId })
  trace("tui-done")
  } catch (err) {
    trace("tui-throw", { error: String(err), stack: err instanceof Error ? err.stack : undefined })
    throw err
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: "memory-tui",
  tui: MemoryTuiPlugin,
}

export default plugin