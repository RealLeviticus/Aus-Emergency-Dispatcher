// ESLint 9 flat config. Replaces .eslintrc.js, which ESLint 9 no longer reads —
// the project had no working lint at all until this file existed.
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');
const prettier = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');
const globalsPkg = require('globals');

// globals@11 (hoisted here as a transitive dep) ships the key
// "AudioWorkletGlobalScope " with a trailing space, which ESLint 9 rejects
// outright with "Global ... has leading or trailing whitespace". Trim the keys
// so the config works whatever version npm resolves.
const clean = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.trim(), v]));
const globals = {
  // globals@11 predates fetch/URL being node globals; add what the scripts use.
  node: { ...clean(globalsPkg.node), fetch: 'readonly', URL: 'readonly', AbortController: 'readonly' },
  browser: clean(globalsPkg.browser),
};

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'app/**',
      'dist/**',
      '**/.next/**',
      'renderer/out/**',
      '**/*.tsbuildinfo',
      'resources/msfs-packages/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks, prettier },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      // main/ is node, renderer/ is browser; one shared set keeps the config flat.
      globals: { ...globals.node, ...globals.browser },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // Next injects React; JSX doesn't need it in scope.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      // Empty catch blocks are a deliberate pattern here (best-effort IO).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // TypeScript already resolves identifiers, and does it better than eslint
      // can without type info — leaving both on just produces false positives.
      'no-undef': 'off',
      // eslint-plugin-react-hooks v7 ships the React Compiler rules. They are
      // useful signal but fire on idioms used deliberately throughout this
      // codebase — the "latest ref" pattern, `.then(setState)` after an IPC
      // call, and a Date.now() read in a component that re-renders on a timer.
      // Kept as warnings so real regressions still surface without blocking.
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/refs': 'warn',
    },
  },
  // Build scripts are CommonJS/node ESM, not browser code.
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  prettierConfig,
];
