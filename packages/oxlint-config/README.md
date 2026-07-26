# `@monke-together-strong/oxlint-config`

Shared lint preset for Vite+ repositories, maintained by Monke Together Strong.

```sh
bun add -D @monke-together-strong/oxlint-config
```

```ts
import mtsLint from "@monke-together-strong/oxlint-config";
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

The Shared lint preset is published on public npm under the MIT license.
