---
subject: Format first-party skill code
packages:
  "@monke-together-strong/oxc-config": patch
---

## Format first-party skill code

The shared formatter now checks first-party code and metadata under `skills/`. Imported skills, imported references, and skill Markdown remain excluded so upstream assets and authored instructions retain their formatting.
