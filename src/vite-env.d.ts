/// <reference types="vite/client" />

// Build-time constants injected by Vite `define` (see vite.config.ts). Surfaced
// on the About splash so the running build is identifiable from the phone.
declare const __APP_VERSION__: string
declare const __GIT_SHA__: string
declare const __BUILD_DATE__: string
