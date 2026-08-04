// Stub of @opencode-ai/plugin for tests.
// The real SDK is only available inside the opencode runtime; tests run in
// plain Node/tsx, so we provide a minimal surface that the plugin imports.
// Keep the API shape stable with what project-context.ts uses.

type ToolHandler<A, R> = (args: A) => Promise<R> | R

export const tool = Object.assign(
  <A extends Record<string, unknown>, R>(def: {
    description: string
    params: Record<string, unknown>
    execute: ToolHandler<A, R>
  }) => def,
  {
    schema: {
      string: () => ({ type: "string" }),
      number: () => ({ type: "number" }),
      boolean: () => ({ type: "boolean" }),
      object: (_shape?: Record<string, unknown>) => ({ type: "object" }),
      array: (_item?: unknown) => ({ type: "array" }),
      optional: <T>(s: T) => ({ type: "optional", inner: s }),
    },
  },
) as any

export type Plugin = (api: any, options?: any) => Promise<any> | any