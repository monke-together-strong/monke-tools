---
name: preferred-libraries
description: Preferred JavaScript and TypeScript project tooling and external libraries by capability. Use when setting up a new project or choosing or replacing libraries, CLI parsing, runtime validation, or generic utilities; default to listed tools when they fit.
---

# Preferred Libraries

Before adding or proposing an external JavaScript or TypeScript library, or writing a custom implementation that a listed library would cover, check this registry.

Use the listed default unless an exception applies. Completion requires one of these outcomes: use the listed library, follow an existing project standard, state that no listed library fits, or run the fresh comparison the user asked for.

## Project Tooling

- `vite-plus`: Use Vite+ as the default toolchain for new JavaScript and TypeScript projects. Scaffold with `vp create`, keep formatter and linter settings in `vite.config.ts`, and use `vp check` for formatting, linting, and type checking.
- `@monke-together-strong/oxc-config`: Use as the default Oxfmt and Oxlint config for new team-owned JavaScript and TypeScript projects.

## CLI And Terminal UX

- `commander`: Use for command definitions, subcommands, options, help text, and CLI argument parsing. Follow the [WIP Commander, extra-typings, and Zod boundary reference](references/commander-extra-typings-zod-boundary.md).
- `@commander-js/extra-typings`: Use with Commander in TypeScript to infer action arguments and options instead of maintaining duplicate types; keep its major and minor version aligned with Commander.
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

## APIs

- [`oRPC`](https://orpc.dev/): Use as the default for end-to-end type-safe TypeScript APIs, including RPC, contract-first development, and OpenAPI-compatible endpoints.

## Database Access

- `drizzle-orm`: Use as the default ORM/query builder when the project needs lightweight typed database access, SQL visibility, migrations, edge/serverless friendliness, or a small dependency footprint. Use `drizzle-kit` alongside it when schema migrations or introspection are needed.
- `prisma`: Use when the project benefits from a generated client, Prisma schema workflow, broad database tooling, introspection, or a more batteries-included ORM experience.

## File Storage

- [`files-sdk`](https://files-sdk.dev/): Use as the default interface when storing files in an external object or blob store and the application benefits from one API across providers.

## Data And Utilities

- `zod`: Use for runtime validation and typed parsing of untrusted config, persisted state, manifests, subprocess output, requests, and API data instead of casts or custom structural validators.
- `@sindresorhus/is`: Use for reusable runtime type guards and assertions over unknown values, especially shallow checks at data boundaries. Keep full payload validation in `zod` and domain-specific predicates local.
- `type-fest`: Use for reusable type-only utilities instead of maintaining custom mapped or conditional type aliases. Import its types directly and prefer built-in TypeScript utility types when they already express the intent.
- `ts-extras`: Use for strongly typed standard-library helpers, nullish guards, and exhaustive assertions when they improve inference or remove casts, such as `objectKeys`, `objectEntries`, `arrayIncludes`, and `assertNever`.
- `date-fns`: Use for date arithmetic, formatting, parsing, comparison, and small date utilities.
- `es-toolkit`: Use for general-purpose JavaScript utility helpers when the standard library would make the implementation noisy.
