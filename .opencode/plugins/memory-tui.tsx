import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { createSignal, createMemo, Text, Box } from "@opentui/solid"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"

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
            <Box flexDirection="column" padding={1} borderColor={theme.current.warning}>
              <Text color={theme.current.warning}>Kontekst {ctxPct}% — powyżej progu {threshold}%</Text>
              <Text color={theme.current.textMuted}>Skompaktować sesję? Zaoszczędzi tokeny.</Text>
              <Text color={theme.current.textMuted}>  Y = skompaktuj teraz   N = odłóż</Text>
            </Box>
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

  const m = createMemo(() => metrics())
  const s = createMemo(() => sess())
  const th = createMemo(() => tests())
  const ar = createMemo(() => arts())

  const sectionTitle = (label: string) => (
    <Text color={t.accent} style={{ bold: true }}>{label}</Text>
  )

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box flexDirection="row">
        <Text color={t.primary} style={{ bold: true }}>memory dashboard</Text>
        <Text color={t.textMuted}>  /memory dashboard  ·  refresh 3s</Text>
      </Box>

      {/* --- Section 1: Token savings --- */}
      <Box flexDirection="column" marginTop={1}>
        {sectionTitle("Oszczędność tokenów")}
        {(() => {
          const mm = m()
          if (!mm || !mm.toolCalls) return <Text color={t.textMuted}>  idle (brak danych)</Text>
          return (
            <Box flexDirection="column">
              <Text color={t.text}>  tools: {mm.toolCalls} · saved: ~{fmtTokens(mm.estimatedSavedTokens ?? 0)} tok · {mm.estimatedReductionPercent ?? 0}% reduc.</Text>
              <Text color={t.textMuted}>  dedup: {mm.deduplicatedReads ?? 0} reads · artifacts: {mm.artifactsCreated ?? 0} ({fmtBytes(mm.artifactsBytes ?? 0)})</Text>
            </Box>
          )
        })()}
      </Box>

      {/* --- Section 2: Disk --- */}
      <Box flexDirection="column" marginTop={1}>
        {sectionTitle("Dysk")}
        {(() => {
          const mm = m()
          const disk = mm?.diskBytes ?? 0
          const limit = mm?.diskLimitBytes ?? 200 * 1024 * 1024
          const dp = pct(disk, limit)
          const color = dp >= 90 ? t.error : dp >= 70 ? t.warning : t.text
          return (
            <Text color={color}>  {fmtBytes(disk)} / {fmtBytes(limit)} ({dp}%) · art {fmtBytes(mm?.artifactsBytes ?? 0)} · cache {fmtBytes(mm?.cacheBytes ?? 0)}</Text>
          )
        })()}
      </Box>

      {/* --- Section 3: Context budget --- */}
      <Box flexDirection="column" marginTop={1}>
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
            <Box flexDirection="column">
              <Text color={color}>  ctx: {fmtTokens(ct)}/{fmtTokens(cl)} tok ({cp}%, compact@{thr}%) [{mm?.compactMode ?? "?"}]</Text>
              <Text color={t.textMuted}>  facts: {fmtTokens(ft)}/{fmtTokens(fm)} ({fp}%)</Text>
            </Box>
          )
        })()}
      </Box>

      {/* --- Section 4: Session --- */}
      <Box flexDirection="column" marginTop={1}>
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
            <Box flexDirection="column">
              <Text color={t.text}>  handoff: {handoff} · mod:{mm?.modifiedCount ?? 0} · dec:{mm?.decisionsCount ?? 0} · blk:{mm?.blockersCount ?? 0}</Text>
              <Text color={t.textMuted}>  HEAD:{mm?.headSha || "-"}{dirtyLabel}{lspLabel}{lastGood}</Text>
              {ss?.goal ? <Text color={t.text}>  goal: {ss.goal}</Text> : null}
              {ss?.currentStatus ? <Text color={t.textMuted}>  status: {ss.currentStatus}</Text> : null}
              {ss?.blockers && ss.blockers.length > 0 ? (
                <Box flexDirection="column">
                  <Text color={t.warning}>  blokery:</Text>
                  {ss.blockers.map((b, i) => <Text key={i} color={t.warning}>    - {b}</Text>)}
                </Box>
              ) : null}
              {ss?.lspErrors && ss.lspErrors.length > 0 ? (
                <Box flexDirection="column">
                  <Text color={t.error}>  błędy LSP:</Text>
                  {ss.lspErrors.slice(0, 5).map((e, i) => <Text key={i} color={t.error}>    - {e}</Text>)}
                </Box>
              ) : null}
            </Box>
          )
        })()}
      </Box>

      {/* --- Section 5: Cache limits --- */}
      <Box flexDirection="column" marginTop={1}>
        {sectionTitle("Cache")}
        {(() => {
          const mm = m()
          return (
            <Text color={t.text}>  dedup: {mm?.dedupCacheCount ?? 0}/{mm?.dedupCacheMax ?? 500} · tests: {mm?.testHistoryCount ?? 0}/{mm?.testHistoryMax ?? 50}</Text>
          )
        })()}
      </Box>

      {/* --- Section 6: Test history --- */}
      <Box flexDirection="column" marginTop={1}>
        {sectionTitle("Historia testów (10 ostatnich)")}
        {(() => {
          const ts = th()
          if (ts.length === 0) return <Text color={t.textMuted}>  (brak)</Text>
          return (
            <Box flexDirection="column">
              {ts.map((run, i) => {
                const status = run.exitCode === 0 ? "OK" : `FAIL(${run.exitCode})`
                const color = run.exitCode === 0 ? t.success : t.error
                return (
                  <Box key={i} flexDirection="column">
                    <Text color={color}>  [{run.timestamp}] {status}  {run.command}</Text>
                    {run.summary ? <Text color={t.textMuted}>    {run.summary}</Text> : null}
                    {run.failed.length > 0 ? (
                      <Text color={t.error}>    failed: {run.failed.slice(0, 3).join(", ")}</Text>
                    ) : null}
                  </Box>
                )
              })}
            </Box>
          )
        })()}
      </Box>

      {/* --- Section 7: Artifacts --- */}
      <Box flexDirection="column" marginTop={1}>
        {sectionTitle("Artefakty (10 największych)")}
        {(() => {
          const as = ar()
          if (as.length === 0) return <Text color={t.textMuted}>  (brak)</Text>
          return (
            <Box flexDirection="column">
              {as.map((a, i) => (
                <Text key={i} color={t.textMuted}>  {a.id}  {fmtBytes(a.bytes)}</Text>
              ))}
            </Box>
          )
        })()}
      </Box>

      {/* Footer */}
      <Box flexDirection="row" marginTop={1}>
        <Text color={t.textMuted}>Esc = zamknij · /memory status = tekstowy odpowiednik</Text>
      </Box>
    </Box>
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

  slots.register({
    name: "sidebar_content",
    render: () => {
      const s = sess()
      const t = theme.current
      const blockers = s?.blockers ?? []
      const lsp = s?.lspErrors ?? []
      if (blockers.length === 0 && lsp.length === 0) return null

      return (
        <Box flexDirection="column" padding={0}>
          {blockers.length > 0 ? (
            <Box flexDirection="column">
              <Text color={t.warning} style={{ bold: true }}>blokery ({blockers.length})</Text>
              {blockers.slice(0, 3).map((b, i) => (
                <Text key={i} color={t.warning}>  - {b.length > 60 ? b.slice(0, 57) + "..." : b}</Text>
              ))}
            </Box>
          ) : null}
          {lsp.length > 0 ? (
            <Box flexDirection="column" marginTop={blockers.length > 0 ? 1 : 0}>
              <Text color={t.error} style={{ bold: true }}>LSP err ({lsp.length})</Text>
              {lsp.slice(0, 3).map((e, i) => (
                <Text key={i} color={t.error}>  - {e.length > 60 ? e.slice(0, 57) + "..." : e}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
      )
    },
  })
}

// ============================================================================
// Main plugin — app_bottom status bar (existing) + all new features
// ============================================================================

const MemoryTuiPlugin: TuiPlugin = async (api: TuiPluginApi) => {
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

  // 5: Sidebar enrichment (blokery + LSP)
  setupSidebar(api, worktree)

  // Existing: app_bottom status bar
  slots.register({
    name: "app_bottom",
    render: () => {
      const m = metrics()
      const t = theme.current

      if (!m || !m.toolCalls) {
        return (
          <Text color={t.textMuted}>
            memory: idle
          </Text>
        )
      }

      const calls = m.toolCalls ?? 0
      const saved = m.estimatedSavedTokens ?? 0
      const reduction = m.estimatedReductionPercent ?? 0
      const dedup = m.deduplicatedReads ?? 0
      const arts = m.artifactsCreated ?? 0
      const artBytes = m.artifactsBytes ?? 0

      // --- Line 1: token savings (existing) ---
      const parts1: string[] = []
      parts1.push(`tools: ${calls}`)
      parts1.push(`saved: ~${fmtTokens(saved)} tok`)
      parts1.push(`${reduction.toFixed(0)}% reduc.`)
      if (dedup > 0) parts1.push(`dedup: ${dedup}`)
      if (arts > 0) parts1.push(`art: ${arts} (${fmtBytes(artBytes)})`)
      const line1 = `memory: ` + parts1.join(" · ")

      // --- Line 2: disk usage ---
      const disk = m.diskBytes ?? 0
      const diskLimit = m.diskLimitBytes ?? (200 * 1024 * 1024)
      const diskPct = pct(disk, diskLimit)
      const cacheBytes = m.cacheBytes ?? 0
      const artifactsBytes = m.artifactsBytes ?? 0
      const diskColor = diskPct >= 90 ? t.error : diskPct >= 70 ? t.warning : t.textMuted
      const line2 = `disk: ${fmtBytes(disk)} / ${fmtBytes(diskLimit)} (${diskPct}%) · art ${fmtBytes(artifactsBytes)} · cache ${fmtBytes(cacheBytes)}`

      // --- Line 3: context budget + compaction ---
      const ctxTok = m.contextTokens ?? 0
      const ctxLimit = m.contextLimit ?? 0
      const ctxPct = pct(ctxTok, ctxLimit)
      const threshold = m.compactThresholdPct ?? 80
      const ctxColor = ctxPct >= threshold ? t.error : ctxPct >= threshold - 15 ? t.warning : t.textMuted
      const factsTok = m.factsTokens ?? 0
      const factsMax = m.factsMaxTokens ?? 1500
      const factsPct = pct(factsTok, factsMax)
      const line3 = `ctx: ${fmtTokens(ctxTok)}/${fmtTokens(ctxLimit)} tok (${ctxPct}%, compact@${threshold}%) · facts: ${fmtTokens(factsTok)}/${fmtTokens(factsMax)} (${factsPct}%) [${m.compactMode ?? "?"}]`

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
      const line4 = `handoff: ${handoff} · mod:${mod} · dec:${dec} · blk:${blk} · HEAD:${head}${dirtyLabel}${lspLabel}${lastGood}${revertsLabel}`

      // --- Line 5: cache limits ---
      const dedupC = m.dedupCacheCount ?? 0
      const dedupM = m.dedupCacheMax ?? 500
      const testC = m.testHistoryCount ?? 0
      const testM = m.testHistoryMax ?? 50
      const line5 = `dedup cache: ${dedupC}/${dedupM} · tests: ${testC}/${testM}`

      return (
        <Text color={t.textMuted}>
          <Text color={t.textMuted}>{line1}</Text>
          {"\n"}
          <Text color={diskColor}>{line2}</Text>
          {"\n"}
          <Text color={ctxColor}>{line3}</Text>
          {"\n"}
          <Text color={t.textMuted}>{line4}</Text>
          {"\n"}
          <Text color={t.textMuted}>{line5}</Text>
        </Text>
      )
    },
  })
}

export default MemoryTuiPlugin
export const tui = MemoryTuiPlugin