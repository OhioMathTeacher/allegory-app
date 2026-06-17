/// <reference types="vite/client" />

// Build stamp injected into index.html by the `allegory-build-info` Vite plugin
// (see vite.config.ts). Read by the About splash so the running build is
// identifiable from the phone, through any cache. Works in dev and build alike.
interface Window {
  __ALLEGORY_BUILD__?: { version: string; sha: string; date: string }
}
