# Use global package links for local Intent discovery

monke-tools remains a Bun CLI whose local executable is rebuilt by `bun run install:local`, but the same command also exposes the source checkout through package-manager global roots so TanStack Intent can discover `skills/`. We chose this hybrid local setup because Intent's global scanner uses the consumer repo's package manager to choose a global package root, while the existing `~/.local/bin/mt` compiled executable stays the stable runtime command for consumer repos.

The consequence is that CLI source changes reach consumer repos after `bun run install:local`, while skill changes are visible through the global package link as soon as Intent loads `monke-tools#core --global`. npm remains the baseline link, and pnpm gets an explicit symlink when pnpm is available so pnpm repos can discover monke-tools without an `INTENT_GLOBAL_NODE_MODULES` override.
