---
name: speak
description: Speak text aloud. Use when the user asks to speak or say something aloud.
---

# Speak

Use `sag` when available, otherwise use macOS `say`, and wait for playback to
finish:

```sh
if command -v sag >/dev/null 2>&1; then sag "text"; else say "text"; fi
```

Add flags only when the user requests a change.
