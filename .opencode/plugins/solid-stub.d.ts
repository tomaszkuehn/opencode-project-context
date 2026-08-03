declare module "@opentui/solid" {
  export function createSignal<T>(
    initial: T,
  ): [() => T, (v: T | ((prev: T) => T)) => void]
  export function createMemo<T>(fn: () => T): () => T
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
        key?: unknown
      }
      Box: {
        children?: unknown
        flexDirection?: "row" | "column"
        padding?: number
        borderColor?: unknown
        borderStyle?: "single" | "double" | "round" | "bold" | "singleDouble" | "doubleSingle" | "dim"
        margin?: number
        marginTop?: number
        marginBottom?: number
        marginLeft?: number
        marginRight?: number
        width?: number | string
        height?: number | string
        key?: unknown
      }
      Slot: {
        name?: string
        children?: unknown
      }
    }
  }
  export function Text(props: {
    children?: unknown
    color?: unknown
    backgroundColor?: unknown
    style?: unknown
    key?: unknown
  }): unknown
  export function Box(props: {
    children?: unknown
    flexDirection?: "row" | "column"
    padding?: number
    borderColor?: unknown
    borderStyle?: "single" | "double" | "round" | "bold" | "singleDouble" | "doubleSingle" | "dim"
    margin?: number
    marginTop?: number
    marginBottom?: number
    marginLeft?: number
    marginRight?: number
    width?: number | string
    height?: number | string
    key?: unknown
  }): unknown
}

declare module "@opentui/solid/jsx-runtime" {
  export const jsx: (type: unknown, props: unknown, key?: unknown) => unknown
  export const jsxs: (type: unknown, props: unknown, key?: unknown) => unknown
  export const Fragment: unknown
}