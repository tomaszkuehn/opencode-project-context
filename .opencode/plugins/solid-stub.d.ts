declare module "@opentui/solid" {
  export function createSignal<T>(
    initial: T,
  ): [() => T, (v: T | ((prev: T) => T)) => void]
  export function createEffect(fn: () => void): void
  export function onMount(fn: () => void): void
  export function untrack<T>(fn: () => T): T
  export const JSX: {
    Element: unknown
    IntrinsicElements: {
      Text: {
        children?: unknown
        color?: unknown
        backgroundColor?: unknown
        style?: unknown
      }
      Box: {
        children?: unknown
        flexDirection?: "row" | "column"
        padding?: number
        borderColor?: unknown
      }
    }
  }
  export function Text(props: {
    children?: unknown
    color?: unknown
    backgroundColor?: unknown
    style?: unknown
  }): unknown
  export function Box(props: {
    children?: unknown
    flexDirection?: "row" | "column"
    padding?: number
    borderColor?: unknown
  }): unknown
}

declare module "@opentui/solid/jsx-runtime" {
  export const jsx: (type: unknown, props: unknown, key?: unknown) => unknown
  export const jsxs: (type: unknown, props: unknown, key?: unknown) => unknown
  export const Fragment: unknown
}