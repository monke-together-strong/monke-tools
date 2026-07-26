# `@mts/oxlint-config`

Shared MTS Oxlint policy for Vite+ repositories.

```ts
import mtsLint from "@mts/oxlint-config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: mtsLint,
});
```

Run checks through Vite+:

```sh
vp check
vp check --fix
```

The config composes Ultracite's native core preset, carries its generic ignore
patterns, and leaves environment globals and repository-specific ignores to the
consumer. Append local ignores when composing the config:

```ts
lint: {
  ...mtsLint,
  ignorePatterns: [...mtsLint.ignorePatterns, ".repo-specific-output"],
},
```

This package is private and build-ready. Registry publishing and packed-tarball
verification are intentionally deferred.
