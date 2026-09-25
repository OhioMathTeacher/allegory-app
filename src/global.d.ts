/// <reference types="vite/client" />

// Compile-time build flag injected by Vite's `define` (see vite.config.ts).
// `true` in the local-only distributable build, which strips the
// iPhone/Tailscale remote-control feature; `false` in the full dev build.
declare const __LOCAL_ONLY__: boolean
