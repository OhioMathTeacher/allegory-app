/**
 * The base path for all API requests.
 *
 * Allegory has no remote server: a Vite plugin (see server/plugin.ts) scans the
 * local music library and serves it under `/api` on the same origin, in both
 * dev and the production `vite preview`. So this is always a relative path.
 */
export const API_BASE = '/api'
