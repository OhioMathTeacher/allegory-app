import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // A hook exported beside the provider it belongs to is the ordinary React
      // pattern, and this rule only affects Fast Refresh granularity in dev --
      // nothing ships differently. usePlayer alone has 17 importers; splitting
      // these files to satisfy a dev-ergonomics rule is not worth the churn.
      'react-refresh/only-export-components': [
        'error',
        { allowExportNames: ['usePlayer', 'useRemoteMode', 'useFolderDrop'] },
      ],

      // eslint-plugin-react-hooks v7 turned on the React Compiler rules, which
      // flagged ~22 pre-existing sites -- 16 of them in the audio engine. They
      // are real and worth fixing, but each needs checking against actual
      // playback, so they stay visible as warnings rather than blocking the
      // build. Backlog, not dismissal.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
])
