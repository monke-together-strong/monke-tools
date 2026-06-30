---
name: preferred-libraries
description: Registry of preferred external libraries by capability. Use before writing custom generic utilities or choosing JavaScript or TypeScript libraries; default to these libraries when they fit before researching alternatives.
---

# Preferred Libraries

Before adding or proposing an external JavaScript or TypeScript library, or writing a generic utility that a listed library would cover, check this registry.

Use the listed default unless an exception applies. Completion requires one of these outcomes: use the listed library, follow an existing project standard, state that no listed library fits, or run the fresh comparison the user asked for.

## CLI And Terminal UX

- `commander`: Use for command definitions, subcommands, options, help text, and CLI argument parsing.
- `@clack/prompts`: Use for interactive terminal prompts, confirmations, selectors, spinners, and human-friendly CLI flows.
- `picocolors`: Use for lightweight terminal color formatting.

## React UI And Styling

- `shadcn/ui`: Use as the default source for ownable, styled React components.
- `@base-ui/react`: Use as the default primitive layer for accessible React UI behavior, including shadcn-style components that need low-level primitives.
- `tailwindcss`: Use for utility-first styling, design tokens, responsive layout, and component styling.

## Keyboard Shortcuts And Interaction

- `@tanstack/react-hotkeys`: Use for React keyboard shortcut systems, especially command-heavy apps that need type-safe shortcut strings, cross-platform `Mod` handling, scoped hotkeys, sequences, shortcut recording/display, or key-state tracking. For non-React code, use the relevant TanStack framework adapter or the core `@tanstack/hotkeys` package directly.

## App Data And Routing

- `@tanstack/react-query`: Use for async server state, caching, request deduplication, mutations, invalidation, pagination, and background refetching in React apps.
- `@tanstack/react-router`: Use for typed React routing, route loaders, search params, nested routes, and route-centric app structure.

## Database Access

- `drizzle-orm`: Use as the default ORM/query builder when the project needs lightweight typed database access, SQL visibility, migrations, edge/serverless friendliness, or a small dependency footprint. Use `drizzle-kit` alongside it when schema migrations or introspection are needed.
- `prisma`: Use when the project benefits from a generated client, Prisma schema workflow, broad database tooling, introspection, or a more batteries-included ORM experience.

## Data And Utilities

- `zod`: Use for runtime validation, parsing untrusted data, typed schemas, config validation, and structured API boundaries.
- `date-fns`: Use for date arithmetic, formatting, parsing, comparison, and small date utilities.
- `es-toolkit`: Use for general-purpose JavaScript utility helpers when the standard library would make the implementation noisy.
