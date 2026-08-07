// Regression tests for AI config bugs fixed 2026-08-07:
//   1. interpolateEnv: lowercase/dashed literals like "${sk-lm-xxx:yyy}" were
//      not interpolated (regex only matched A-Z_) → apiKey stayed literal
//      "${sk-lm-xxx:yyy}" → HTTP 401.
//   2. aiUrl: baseUrl "http://127.0.0.1:1234" (LM Studio) produced
//      ".../chat/completions" missing "/v1" → wrong endpoint.
//   3. safeErrorString: objects without .message serialized as "[object Object]"
//      → useless "SDK call failed (...): [object Object]" logs.
//   4. parseModelKey: split("/") on "openrouter/cohere/model:free" (2 slashes)
//      gave modelID="cohere" (truncated) → OpenRouter 500 "Unexpected server error"
//      on every call (0 successes / 608 calls).

import { describe, it, expect } from "vitest"
import { __testState } from "../.opencode/plugins/project-context.ts"

const { interpolateEnv, aiUrl, safeErrorString, parseModelKey } = __testState()

describe("interpolateEnv", () => {
  it("interpolates uppercase env vars", () => {
    process.env.FOO_BAR = "abc"
    expect(interpolateEnv("${FOO_BAR}")).toBe("abc")
    delete process.env.FOO_BAR
  })

  it("returns literal value for non-env ${...} placeholders (bug fix)", () => {
    // Was: "${sk-lm-7zNcsVKV:t1B9PYo63258cbU5jCex}" stayed literal → bad apiKey.
    expect(interpolateEnv("${sk-lm-7zNcsVKV:t1B9PYo63258cbU5jCex}")).toBe(
      "sk-lm-7zNcsVKV:t1B9PYo63258cbU5jCex",
    )
  })

  it("returns empty for unset env vars", () => {
    expect(interpolateEnv("${DEFINITELY_UNSET_X9Y2}")).toBe("")
  })

  it("handles mixed strings with multiple placeholders", () => {
    process.env.ENV1 = "v1"
    expect(interpolateEnv("a${ENV1}b${sk-lm-key}c")).toBe("av1bsk-lm-keyc")
    delete process.env.ENV1
  })

  it("passes through strings without placeholders", () => {
    expect(interpolateEnv("plain-key-123")).toBe("plain-key-123")
  })
})

describe("aiUrl", () => {
  const stub = (provider: any, baseUrl: string): any => ({ provider, baseUrl })

  it("appends /v1 for openai-compatible when missing (LM Studio, bug fix)", () => {
    expect(aiUrl(stub("openai-compatible", "http://127.0.0.1:1234"))).toBe(
      "http://127.0.0.1:1234/v1/chat/completions",
    )
  })

  it("preserves /v1 for openai-compatible when present", () => {
    expect(aiUrl(stub("openai-compatible", "http://127.0.0.1:1234/v1"))).toBe(
      "http://127.0.0.1:1234/v1/chat/completions",
    )
  })

  it("strips trailing slash before appending /v1", () => {
    expect(aiUrl(stub("openai-compatible", "http://127.0.0.1:1234/"))).toBe(
      "http://127.0.0.1:1234/v1/chat/completions",
    )
  })

  it("appends /messages for anthropic", () => {
    expect(aiUrl(stub("anthropic", "https://api.anthropic.com/v1"))).toBe(
      "https://api.anthropic.com/v1/messages",
    )
  })

  it("does not double-append /v1 for OpenAI itself (has /v1)", () => {
    expect(aiUrl(stub("openai-compatible", "https://api.openai.com/v1"))).toBe(
      "https://api.openai.com/v1/chat/completions",
    )
  })
})

describe("safeErrorString", () => {
  it("returns message property if present", () => {
    expect(safeErrorString(new Error("boom"))).toBe("boom")
  })

  it("returns string input as-is", () => {
    expect(safeErrorString("plain string")).toBe("plain string")
  })

  it("serializes objects without message (bug fix: was '[object Object]')", () => {
    const obj = { code: 500, detail: "internal" }
    const out = safeErrorString(obj)
    expect(out).not.toBe("[object Object]")
    expect(out).toContain("500")
    expect(out).toContain("internal")
  })

  it("handles null gracefully", () => {
    expect(safeErrorString(null)).toBe("null")
  })
})

describe("parseModelKey", () => {
  it("parses simple providerID/modelID", () => {
    expect(parseModelKey("openai/gpt-4o-mini")).toEqual(["openai", "gpt-4o-mini"])
  })

  it("parses modelID with multiple slashes (bug fix: was truncated)", () => {
    // Was: "openrouter/cohere/north-mini-code:free".split("/") gave
    //   providerID="openrouter", modelID="cohere" (TRUNCATED)
    //   → OpenRouter 500 "Unexpected server error" on every call.
    expect(parseModelKey("openrouter/cohere/north-mini-code:free")).toEqual([
      "openrouter",
      "cohere/north-mini-code:free",
    ])
  })

  it("parses modelID with two extra slashes", () => {
    expect(parseModelKey("openrouter/nvidia/nemotron-3-nano-30b-a3b:free")).toEqual([
      "openrouter",
      "nvidia/nemotron-3-nano-30b-a3b:free",
    ])
  })

  it("returns empty for missing slash", () => {
    expect(parseModelKey("noprovider")).toEqual(["", ""])
  })

  it("returns empty for leading slash", () => {
    expect(parseModelKey("/modelID")).toEqual(["", ""])
  })

  it("returns empty for trailing slash", () => {
    expect(parseModelKey("providerID/")).toEqual(["", ""])
  })

  it("returns empty for empty string", () => {
    expect(parseModelKey("")).toEqual(["", ""])
  })

  it("returns empty for null", () => {
    expect(parseModelKey(null as any)).toEqual(["", ""])
  })
})