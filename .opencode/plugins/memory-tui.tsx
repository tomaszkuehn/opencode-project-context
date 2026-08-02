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

      const saved = m.estimatedSavedTokens ?? 0
      const reduction = m.estimatedReductionPercent ?? 0
      const dedup = m.deduplicatedReads ?? 0
      const calls = m.toolCalls
      const arts = m.artifactsCreated ?? 0
      const artBytes = m.artifactBytes ?? 0

      const sep = " · "
      const parts: string[] = []
      parts.push(`tools: ${calls}`)
      parts.push(`saved: ~${fmtTokens(saved)} tok`)
      parts.push(`${reduction.toFixed(0)}% reduc.`)
      if (dedup > 0) parts.push(`dedup: ${dedup}`)
      if (arts > 0) parts.push(`art: ${arts} (${fmtBytes(artBytes)})`)

      const line = `memory: ` + parts.join(sep)

      return (
        <Text color={t.textMuted}>
          {line}
        </Text>
      )
    },
  })
}

export default MemoryTuiPlugin
export const tui = MemoryTuiPlugin