# Agent login

`agent:login` prints a short-lived, single-use URL that signs a browser into the
local app as a test user, so an agent can screenshot login-gated pages.

## Safety

- Build it on Clerk, whose admin API mints one-time sign-in tokens; the route
  only redeems those tokens. For any other provider, ask the owner first,
  including how to recognize its development instance.
- Run only against a development auth instance. For Clerk, refuse secret keys
  that do not start with `sk_test_`. The localhost origin check is a
  convenience, not the boundary.
- Sign in as the test user named by a required local env var such as
  `AGENT_LOGIN_EMAIL`, and fail when it is unset.
- The printed link is a credential: open it directly, and keep it out of
  screenshots, reports, and links you hand over.

## Command

- Root package script: `bun run agent:login [-- --target <path>]`.
- `--target` is the page to land on; `--web-url` overrides the dev server
  origin; `--ttl` defaults to 30 seconds, at most 120.
- Prints `<origin>/agent-login?token=<token>&redirect=<target>`.
- Accepts only localhost origins, reads the auth secret from the repo's local
  env files, and names the missing user when the test user does not exist.
- Document usage in the repo's `AGENTS.md`: open the link in the tab you will
  hand over. Sessions are per origin, so `localhost` and `127.0.0.1` each need
  their own link.

## `/agent-login` route

1. Snapshot `token` and `redirect` once, then strip them with
   `history.replaceState`.
2. Parse `redirect` with `new URL(redirect, location.origin)`. When it is
   present and the origin matches, navigate to its absolute `href`; otherwise
   use the default page. A relative `pathname` can start with `//` and leave
   the origin.
3. When already signed in, go straight to the redirect. Otherwise redeem the
   token once, holding the pending promise in a ref so a Strict Mode effect
   rerun reuses it.
4. Navigate with `window.location.assign` so the new session loads everywhere.
5. On failure, show a state that says to generate a fresh link.

Exempt `/agent-login` from the app's signed-out redirect.

## Clerk

Script, against the Backend API with `Authorization: Bearer $CLERK_SECRET_KEY`:

1. `GET https://api.clerk.com/v1/users?email_address=<email>` for the user ID.
2. `POST https://api.clerk.com/v1/sign_in_tokens` with
   `{ user_id, expires_in_seconds }` for the token.

Route: with `@clerk/react` v6, redeem via `useSignIn()`'s
`signIn.ticket({ ticket })`, then `signIn.finalize({ navigate })`. Older SDKs
use `signIn.create({ strategy: "ticket", ticket })`, then
`setActive({ session: createdSessionId })`.
