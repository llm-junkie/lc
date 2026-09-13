import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'src-tauri/**']),
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
      // Allow `_`-prefixed names — common pattern for "destructured but unused"
      // (e.g. `const { id: _drop, ...rest } = obj`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // We deliberately use `Date.now()` / `performance.now()` inside event
      // handlers for timing measurements — these are not rendering-side
      // computations and the React Compiler's purity rule flags them
      // incorrectly. We're not using the React Compiler in this project.
      'react-hooks/purity': 'off',
      // Same story for "setState in effect" — we use effects to bridge
      // zustand/prop changes into local UI state (hydrating attachments,
      // resetting draft params, etc.). The pattern is intentional and the
      // alternative is more boilerplate with no real win.
      'react-hooks/set-state-in-effect': 'off',
      // We deliberately co-locate `useAutoScroll` with `MessageBubble` for
      // convenience; the HMR-friendliness hit is acceptable here.
      'react-refresh/only-export-components': 'off',
    },
  },
])
