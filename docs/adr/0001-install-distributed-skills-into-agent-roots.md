# Install distributed skills into agent roots

monke-tools remains a Bun CLI whose local executable is rebuilt by `bun run install:local`, and the same local install also makes shared team skills available by symlinking the monke-tools `skills/` source tree into selected agent skill roots. The selected targets are stored in global monke config so each later install can refresh the same Codex, Claude, Cursor, or custom skill roots without requiring per-repo loading instructions.
