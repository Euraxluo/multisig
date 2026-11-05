import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { FlatCompat } from "@eslint/eslintrc"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// `eslint-config-next` still ships eslintrc-style presets, so they are bridged
// into flat config rather than imported directly. Keep this in sync with the
// installed `next` version: a mismatched config would lint against different
// rules than the framework expects.
const compat = new FlatCompat({ baseDirectory: __dirname })

const config = [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // A leading underscore is the conventional marker for "kept for the
      // signature, deliberately unused". Rest-destructuring (`const { gone: _x,
      // ...rest }`) is how a field is omitted without mutating the source.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Tests load the module under test with `require` on purpose: the environment
    // variables and module mocks must be installed before the module is evaluated,
    // which a hoisted ESM import cannot express. Same for the Tailwind plugin entry.
    //
    // `any` is a warning here, not an error: these files build partial doubles of
    // the gRPC client, and a structurally-exact fake would couple every test to the
    // SDK's full type surface. Production files keep the error.
    files: ["**/*.test.ts", "**/*.test.tsx", "tailwind.config.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
]

export default config
