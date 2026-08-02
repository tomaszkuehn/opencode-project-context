import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createSignal, Text } from "@opentui/solid"
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
  // --- TUI live stats ---
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

function readMetrics(worktree: string): Metrics | null {
  const p = join(worktree, ".opencode", "memory", "cache", "metrics.json")
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
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

  slots.register({
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