# Decision: dashboard access gate (#100, SPEC §21 "Dashboard access", DSH-3)

**Status:** Decided for the hackathon demo. The code implements it.

## Options considered

| | A. Shared access key | B. Clerk sign-in (SPEC §10.6 proposal) | C. Gate in Next.js only |
|---|---|---|---|
| Protects data | Yes. Every Convex query and mutation checks the key server-side | Yes. Every function checks the identity | **No.** The browser calls Convex directly |
| Demo friction | None. The big screen opens a `#key=` link once and the key is remembered | Needs a sign-in on the demo machine, plus a Clerk app, JWT template and env vars | None |
| Identity for audit logs | Self-declared: the user picks a family contact on the device | Real: the Clerk subject matches `familyContacts[].authSubject` | None |
| Setup | One Convex env var | Clerk project, `CLERK_JWT_ISSUER_DOMAIN`, a client provider | — |

## Decision

**Use A, the shared access key, and keep B's Clerk path wired as the upgrade.** Both are checked inside every Convex function. C is rejected because it protects nothing.

- `DASHBOARD_ACCESS_KEY` is a Convex env var of 32 or more characters. It unlocks only the demo household (`DASHBOARD_HOUSEHOLD_PHONE`, else `DEMO_CALLER_PHONE`).
  - Every public dashboard query takes `accessKey`.
  - Every family mutation takes `accessKey` and `actor`: approve, decline, acknowledge, override, forget and the settings edits.
  - A wrong key, a missing key, another household's ID or a non-contact `actor` is refused. Tests cover each case in `convex/dashboard.test.ts` and `convex/family_actions.test.ts`.
- The key reaches the dashboard in a URL fragment (`/live#key=…`), so it never hits server logs or a Referer header. The app strips it from the address bar at once and keeps it in this device's localStorage. "Lock" forgets it.
- **Who acted.** With the key, the person picks which family contact they are, once per device. Approvals, overrides, acknowledgements and forgets are recorded as `"<Name> (dashboard)"`. With the shared key this identity is self-declared, which is acceptable for one seeded household and a demo. A Clerk identity is recorded as the matching contact's name.
- Transcripts, memory and mood notes also follow the §14.2 sharing rules server-side (#99).
- The legacy public queries in `calls.ts`, `orders.ts`, `alerts.ts`, `memory.ts` and `households.ts` accept only a Clerk family identity.

## Residual risk

- Anyone holding the key sees the household. Treat the link like a password and rotate the key with `npx convex env set DASHBOARD_ACCESS_KEY …` after the event.
- To move to real identities, switch `ConvexProvider` to `ConvexProviderWithClerk` and stop sending `accessKey`. The server path already exists (`requireFamily`, `resolveActor`).
