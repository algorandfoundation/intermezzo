# Credential status and revocation — implementation plan

**Integration branch:** `feat/credentials-status-and-revoke`
**Status:** Phases 0-3 complete. Next: Phase 4 (in-process resolution), on
PR 3's branch.
**Scope:** per-credential revocation for SD-JWT VCs issued by this service, published as an IETF Token Status List.

This document is the working plan. It is written to be resumable: a session
picking this up mid-flight should be able to read only this file plus the
code it points at and know what is done, what is left, and why each choice
was made. Update the checkboxes as phases land.

---

## Branch and PR structure

The work ships as a stack of three pull requests. The bottom branch is the
**integration branch**: the other two merge into it, and only once the feature
is whole does it merge to `master`.

```
feat/credentials-status-local-resolve   PR 3 — Phase 4, Phase 6
        │ merges into
        ▼
feat/credentials-status-endpoint        PR 2 — Phase 3, 5b, 5e
        │ merges into
        ▼
feat/credentials-status-and-revoke      PR 1 — Phases 0-2  (integration branch)
        │ merges into
        ▼
master
```

| PR | Branch | Owns | Base |
| --- | --- | --- | --- |
| 1 | `feat/credentials-status-and-revoke` | Phases 0-2, and this document | `master` |
| 2 | `feat/credentials-status-endpoint` | Phase 3, 5b, 5e | PR 1 |
| 3 | `feat/credentials-status-local-resolve` | Phase 4, Phase 6 | PR 2 |

**Why this direction matters.** Phase 2 makes issued credentials carry a
`status_list.uri`, and Phase 3 is what serves it — between them, issuance
produces credentials that fail verification permanently (§8). Merging the
stack downward into the integration branch, rather than each PR into `master`
in turn, means `master` never sees that intermediate state. The hazard is
confined to a feature branch nothing deploys from.

Two consequences worth knowing:

- **Do not merge PR 1 to `master` early**, however green it looks on its own.
  It is complete as a unit of review, not as a unit of deployment.
- The repo merges with real merge commits rather than squashing (`git log
  --merges`), so the usual stacked-PR hazard — a squashed base rewriting its
  commits and making the child PR show duplicated changes — does not apply
  here. Rebasing the integration branch while the stack is open would
  reintroduce it; merge into it instead.

Phase 5a, 5c and 5d already landed in PR 1 alongside the code they cover.

## 1. Problem

Credentials issued today are bearer-forever. Nothing in the codebase emits a
`credentialStatus` or `status` claim, there is no status-list endpoint, and
neither verification path checks revocation:

- [`CredentialAuthGuard`](../auth/credential-auth.guard.ts) — the real gate on
  wallet routes. Checks issuer signature, `iss` equals the manager
  `did:algo`, `vct` equals `device-attestation-credential`, and that
  `cnf.kid` is a `did:key`. Nothing else.
- [`Oid4vcVerifierService.findSession`](verifier/oid4vc-verifier.service.ts) —
  reads Credo's verified OID4VP response, same underlying verify.

Steal a credential, replay the header, you are in. Withdrawing one holder's
access is impossible short of rotating the issuer key, which invalidates
every credential ever issued for every user at once.

## 2. Goal / non-goals

**Goal.** Revoke an individual issued credential, immediately, and have both
this service and an unrelated third-party verifier reject it afterwards.

**Non-goals.** Suspension (as distinct from revocation). Multi-tenant issuer
support. Wallet-initiated self-revoke. Revocation of W3C JWT VCs (see §4).

## 3. Why a status claim rather than a local revocation table

A local table would be simpler and would cover every verifier that exists in
this repo today — both verification paths above are *us* verifying our own
credentials, in our own process.

It was rejected because third-party verification is not hypothetical here —
it is already cryptographically available, whether or not we intend it.

`did:algo` is **self-describing**: `did:algo:<network>:app:<appId>:<hex-pubkey>`
(see `../../libs/credo-did-algo/identifier.ts`). The issuer's Ed25519 public
key is embedded in the `iss` claim of every credential we sign. Anyone who has
ever held one of our credentials can verify its signature with a regex and an
Ed25519 verify — no chain access, no library, no network call, and no
permission from us. Combined with the fact that the device-attestation
credential is presented as a bare bearer token (`X-Credential-Presentation`,
no key-binding JWT, no `exp`), a leaked credential is independently checkable
by a stranger, forever.

What such a verifier cannot do is discover that we consider the credential
dead. A VC is verified by signature arithmetic against a pinned issuer DID,
with no call back to the issuer; a verifier has no reason to believe there is
anything to check unless the credential itself says so. `status.status_list`
is that instruction, and it is the only lever we retain over what an outside
verifier concludes.

The decisive asymmetry: infrastructure can be added later, **the claim
cannot**. `@sd-jwt`'s `verify()` skips the status check entirely when the
claim is absent, so any credential issued without it is permanently
unrevocable no matter what is built afterwards. The choice is therefore not
"do third parties verify today" but "are credentials issued from now on ever
revocable in their eyes".

**There is no cheap middle option.** Emitting the claim while deferring the
endpoint does not work: a fetch failure throws, so a credential whose
`status_list.uri` is not served fails verification for everyone who
dereferences it. Emitting the claim commits us to serving the list from that
moment (see §8).

What today's practical situation *does* buy us is time on polish, not on the
claim. `libs/credo-did-algo` has no `package.json`, is not built, and neither
`@algorandfoundation/credo-did-algo` nor `@algorandfoundation/credo-vault-wallet`
resolves on npm — despite the README instructing `yarn add`. So a third party
today means "someone who vendored this repo's `libs/`". That is a packaging
gap, not an architectural one, and the library is already written to close it
(host-agnostic, port-based, *"Intermezzo today, CREDEBL tomorrow"*).

Note that Phase 4 makes this service resolve its own status lists in-process.
Since the manager is the only party checking status initially, that is the
**primary enforcement path**, not an optimisation — the HTTP endpoint exists
for the third parties who come later.

## 4. Verified constraints

Established by reading the installed dependencies, not from memory. Verified
against `@credo-ts/core@0.5.19` and `@sd-jwt/*@0.7.2`; re-verify the line
references if either is upgraded.

| Fact | Evidence |
| --- | --- |
| `verify()` auto-checks `status.status_list`: fetch list, verify its signature, check `exp` if present, `getStatus(idx)`, throw unless `0` | `@sd-jwt/sd-jwt-vc/dist/index.js:133-148` |
| The status list JWT is verified with **the same key** as the credential's `iss` — Credo configures a single `verifier` for both | `@credo-ts/core/build/modules/sd-jwt-vc/SdJwtVcService.js:154` |
| No `alg` / `typ` / `kid` checks on the list JWT; signature only | `@sd-jwt/core` `Jwt.verify` |
| `exp` is checked only when present — omit it and there is no expiry cliff | same |
| Credo's fetcher is a plain `fetch` with no content-type check; `@sd-jwt`'s *default* fetcher compares Content-Type for **strict equality** with `application/statuslist+jwt` — a `; charset=utf-8` suffix is rejected as "Invalid content type" | `SdJwtVcService.js:458` and `@sd-jwt/sd-jwt-vc/dist/index.js:98` |
| Express appends `; charset=utf-8` to the Content-Type of any **string** body, and Nest sends any **object** (a Buffer included) via `response.json()` — so neither ordinary return path can serve an exact media type | `express/lib/response.js` `send()`, `@nestjs/platform-express/adapters/express-adapter.js:68` |
| `status` is a **reserved** field: listing it in `_sd` throws `"Cannot disclose protected field"` | `@sd-jwt/sd-jwt-vc/dist/index.js:72` |
| Credo hardcodes `'Verifying credential status is not supported for JWT VCs'` — adding `credentialStatus` to a W3C JwtVc makes verification **fail**, not check | `@credo-ts/core/.../W3cJwtCredentialService.js:169` |
| `@sd-jwt/jwt-status-list@0.7.2` is already installed as a transitive dependency, and `yarn.lock:2050` already resolves the exact spec `0.7.2` | `node_modules/@sd-jwt/jwt-status-list`, `yarn.lock` |
| `VaultService.sign` is typed `Promise<Buffer>` but returns the `vault:v1:…` **string**; existing callers cast via `as unknown as string` | `src/vault/vault.service.ts:112`, `oid4vc-agent.provider.ts:154-159` |
| `SdJwtVcService.getStatusListFetcher` is `private` in the type declarations | `SdJwtVcService.d.ts:79` |
| Nest global prefix is `v1`; `Oid4vcConfig.baseUrl` already includes it | `src/main.ts:31` |
| `credoIssuanceSessionId` is persisted at offer-creation time, before redemption, so the mapper can find the local session | `issuer/oid4vc-issuer.service.ts:220` |
| `did:algo` embeds the issuer's Ed25519 public key in the identifier, so signature verification needs no chain access and no library | `libs/credo-did-algo/identifier.ts` |
| `AlgoDidResolver` always reads the on-chain box (no self-describe fallback, caching disabled), so *proper* resolution does need algod plus the method implementation | `libs/credo-did-algo/algo-did.resolver.ts:15-33` |
| Neither `did:algo` library is published: no `package.json` in `libs/`, and both npm names 404 | `npm view @algorandfoundation/credo-did-algo` |

Consequence of rows 2 and 8: the status list is signed with the manager
`did:algo` key through Vault transit, reusing the existing
`vault.sign` + `parseVaultSignature` pair.

## 5. Recorded decisions

These were taken as working defaults. Revisit only with a reason; changing
one mid-implementation invalidates parts of the plan below.

1. **Pre-existing credentials are left alone.** Credentials already issued
   carry no `status` claim, so they remain valid forever and cannot be
   revoked. Accepted because nothing meaningful is in the wild. The
   alternative — making `CredentialAuthGuard` reject credentials that lack a
   `status` claim — is a real behaviour change and would need its own flag
   and rollout. Document the gap in `TRUST_MODEL.md`.

   Sharpened by §3: those credentials are not merely unrevocable by us, they
   are permanently and unilaterally verifiable by anyone who holds one, since
   the issuer key travels inside the DID. If any device-attestation
   credential currently in circulation matters, reissue at cutover rather
   than accepting this.
2. **Granularity is per-credential**, keyed on the local issuance session id.
   A sweep over all sessions for a given `did:key` would give a device-level
   semantic on top, but it is **deferred** (§9) — `sessionId` covers v1 and
   the data model does not foreclose adding it.
3. **Audit fields are in scope**: `revokedAt` and `revokedReason` on the
   issuance session record. Two fields, no new storage, and flipping a bit
   otherwise records nothing about who did what.
4. **`Cache-Control: no-store`, no `ttl` claim.** Revocation freshness beats
   cache economy, and our own guard bypasses HTTP entirely (Phase 4).
5. **`bits: 1`.** `0` = valid, `1` = revoked. The draft's `SUSPENDED` needs 2
   bits, and `@sd-jwt`'s default validator rejects every non-zero status
   identically, so suspension would be indistinguishable from revocation
   until a verifier opts into a custom validator.

## 6. Data model

```
StatusListRecord                    Oid4vcIssuanceSession  (+4 fields)
  id: 'default'                       statusListId?:    'default'
  bits: 1                             statusListIndex?: 42
  size: 16384                         revokedAt?:       Date
  nextIndex: 43                       revokedReason?:   string
  encodedList: <deflate + base64url>
```

One Vault KV record holds the entire list. The list is pre-sized full-length
with all bits `0`, so issuing a credential only bumps a counter — the
compressed bitstring for 16k unused entries is a few dozen bytes.

---

## 7. Phases

### Phase 0 — dependency and config

- [x] `package.json`: add `"@sd-jwt/jwt-status-list": "0.7.2"` to
      `dependencies`. Pin exactly: `yarn.lock` already resolves that spec as a
      transitive of `@sd-jwt/sd-jwt-vc`, so an exact pin needs no lockfile
      change. A range like `^0.7.2` introduces a new spec string and forces
      lockfile churn. Confirmed: `yarn install --frozen-lockfile` succeeds and
      leaves `yarn.lock` byte-identical.
- [x] [`oid4vc.config.ts`](oid4vc.config.ts): add `statusListBaseUrl`
      (`${baseUrl}/credential/status/list`) and `statusListUri(listId)`.

      List size is **not** configurable: a `STATUS_LIST_SIZE = 16384` const
      lives with the entity in Phase 1. Nobody tunes a bitstring length per
      deployment, and the answer at capacity is rollover, not a bigger number
      — so an env var here would be config for a value that never changes,
      plus a parse branch and its tests to maintain.

> **Deployment trap.** The status URI is baked into every credential at
> issuance. If `OID4VC_BASE_URL` is wrong or omits the `/v1` prefix, every
> credential issued under it points at a 404 and fails verification
> permanently — reissuance is the only fix.
>
> Implemented as a heuristic warning in `statusListBaseUrl`: the config layer
> does not know the prefix literal, only that `main.ts` always installs one,
> so it warns when the base URL has no path segment at all. That catches the
> realistic misconfiguration (`http://host:3000` instead of
> `http://host:3000/v1`) without hardcoding `v1` into the config.

### Phase 1 — storage and service

- [x] `entities/status-list.entity.ts` — `StatusListRecord` as in §6, plus
      `export const STATUS_LIST_SIZE = 16384` used when a list is first created.
      The `size` field stays on the record so an existing list keeps its own
      length if the const ever changes.
- [x] `status/status-list.repository.ts` — subclass the existing
      [`VaultRepository`](../vault/vault.repository.ts) over folder
      `intermezzo/oid4vc/status-lists`, no secondary index. About eight lines;
      do not introduce a new persistence layer.
- [x] `status/oid4vc-status.service.ts`:
  - `allocate()` → `{ listId, idx, uri }`; reads the record, hands out
    `nextIndex`, increments, saves.
  - `setStatus(listId, idx, 0 | 1)` → decompress, set, recompress, save,
    invalidate the JWT cache.
  - `getStatusListJwt(listId)` → build via `createHeaderAndPayload(list,
    { iss, sub: uri, iat }, { alg: 'EdDSA', typ: 'statuslist+jwt', kid })`,
    sign, memory-cache. **No `exp`.**
  - `revokeBySessionId` / `reactivateBySessionId`.
  - private `sign()` — `vault.sign(config.managerUserId,
    config.managerTransitPath, …)` then `parseVaultSignature`, mirroring the
    cast documented in §4.
  - `iss` comes from `agentProvider.ensureIssuerDid()`. Dependency direction
    is status service → agent provider, and issuer service → status service.
    No cycle; do not add one.

Allocation and status writes both go through a single in-process promise
chain so concurrent redemptions cannot collide on an index.

**Resequenced:** the four session fields listed under Phase 2 were added here
instead. `revokeBySessionId` resolves a session id to its `(listId, index)`
pair, so it cannot compile without them, and they are pure type declarations
with no behaviour attached.

**Token building runs inside the same queue as bit writes.** Not incidental:
building outside it allows a revocation to land between reading the record and
populating the cache, which would publish — and then keep serving — a token
saying a revoked credential is live. The cache is re-checked inside the queue
so concurrent misses sign once rather than once each.

### Phase 2 — allocation at issue time

- [x] Add the four fields from §6 to
      [`Oid4vcIssuanceSession`](entities/oid4vc-issuance-session.entity.ts).
      Done in Phase 1 — see the note there.
- [x] In [`buildCredentialMapper`](issuer/oid4vc-issuer.service.ts), **SD-JWT
      branch only**:
  - allocate an entry, and set `status: { status_list: { uri, idx } }`
    **after** the claims spread, so a stray `status` claim in
    `issuanceMetadata` cannot shadow the real one;
  - exclude `status` from `disclosureFrame._sd` — required, not defensive
    polish, per §4 row 6;
  - persist `statusListId` / `statusListIndex` to the local session **before
    returning**. If the write-back fails the mapper must throw, so no
    unrevocable credential escapes. Throw on `affected === 0` too.
- [x] Leave the W3C `JwtVc` branch **exactly as it is** (§4 row 7).
- [x] Register `Oid4vcStatusService` and `StatusListRepository` in
      [`oid4vc.module.ts`](oid4vc.module.ts) and export the service.

**Resequenced:** provider registration was listed under Phase 3. It has to
happen here — the mapper injects `Oid4vcStatusService`, so without it Nest
fails to resolve `Oid4vcIssuerService` at boot. Only the controller is left
for Phase 3.

### Phase 3 — endpoints  *(PR 2)*

- [x] `status/oid4vc-status.controller.ts`, `@Controller('credential/status')`,
      `@ApiTags('OID4VC')`:

| Route | Auth | Notes |
| --- | --- | --- |
| `GET list/:listId` | `@Public()` | `application/statuslist+jwt`, `Cache-Control: no-store` |
| `POST revoke` | manager JWT | body `{ sessionId }`, optional `reason` |
| `POST reactivate` | manager JWT | same body |

The public list sits under its own `list/` path segment, leaving the bare
`credential/status` namespace free for later sibling routes without route-order
hazards. Everything else inherits the global manager `AuthGuard`; only the list
route opts out via `@Public()`.

An ops listing (`GET entries`) was considered and cut: the issuance session
records already carry `statusListId` / `statusListIndex`, and the existing
`GET credential/issuer/sessions` route already exposes them.

- [x] Request DTOs with `class-validator` — the app installs a global
      `ValidationPipe` with `transform: true`.
- [x] Register the controller in [`oid4vc.module.ts`](oid4vc.module.ts).
      The service and repository were registered in Phase 2.

**The list route writes its own response.** It takes `@Res()` and calls
`response.end(token)` instead of returning the string, purely to keep the
media type exact — see the two Express/Nest rows in §4. Returning the token
any ordinary way yields either `application/statuslist+jwt; charset=utf-8`
(string) or a JSON-encoded Buffer (object), and the first of those is rejected
by `@sd-jwt`'s default fetcher, which is precisely the third-party verifier
this endpoint exists for. Credo's own fetcher does not check the media type,
so this would have passed every internal test and failed only for outside
verifiers. Nothing is written before the `await`, so a thrown
`NotFoundException` still renders through the exception filter.

### Phase 4 — keep the wallet auth path off the network  *(PR 3)*

**This is the primary enforcement path, not an optimisation.** The manager is
the only party checking status initially, so in practice every status check
that happens is this one.

`CredentialAuthGuard` runs on **every** wallet request. Without this phase,
each one makes a loopback HTTP call, and all wallet authentication becomes
dependent on the process being able to reach itself at its own advertised
hostname — in a container whose `OID4VC_BASE_URL` is an external name, every
request would 401.

- [ ] In the status service's `onModuleInit` (guarded by `config.autoInit`,
      matching `Oid4vcIssuerService`), resolve `SdJwtVcService` from
      `agent.context.dependencyManager` and wrap `getStatusListFetcher` so a
      URI under `statusListBaseUrl` resolves in-process and anything else
      falls through to the original. The method is `private` in the type
      declarations, so the patch needs a cast — comment why.

If this ever breaks on a Credo upgrade, deleting it leaves a correct but
slower system that depends on self-reachability. That is the fallback, not a
silent failure mode: it should be caught by the Phase 5a URI-matching tests.

### Phase 5 — tests

**Regression gate.** Baseline on `master` before any change:
**24 suites, 190 tests, all passing, ~7s** (`yarn test`). No existing test may
change behaviour or be edited to accommodate this work.

Running total: after Phase 3, **27 suites, 216 tests** (`yarn test`) plus
**2 e2e tests** (`yarn test:e2e status-list`), with `yarn lint`, `yarn format`
and `yarn build` clean. (Baseline 24/190; Phase 0 added 3, Phase 1 added 10,
Phase 2 added 6, Phase 3 added 7 unit + 2 e2e.)

- [x] **5a** `status/oid4vc-status.service.spec.ts` — Vault KV faked as an
      in-memory map; `vault.sign` backed by a **real** Ed25519 key from node's
      `crypto`, so the published token is verified the way a verifier would
      rather than merely inspected:
  - `allocate()` yields 0, 1, 2… and persists `nextIndex`
  - `Promise.all` of N concurrent allocations yields N **distinct** indices
    (this is the test that proves the serialization actually serializes)
  - `setStatus(idx, 1)` flips only that bit; neighbours stay `0`
  - JWT round trip via `getListFromStatusListJWT`; header `typ` is
    `statuslist+jwt`; payload carries `iss` / `sub` / `iat` and **no `exp`**
  - the JWT cache is invalidated by a write, but *not* by an allocation
  - concurrent cache misses sign once
  - allocating past `size` throws a named error
  - revoking an unknown session, or one that was never redeemed, is a 404
  - deferred to Phase 4: own-base URIs short-circuit locally, foreign URIs
    fall through
- [x] **5b** *(PR 2)* `status/oid4vc-status.controller.spec.ts` — delegation,
      DTO validation, a 404 for an unknown list, `Cache-Control: no-store`, and
      an **exact-match** assertion on the content type (the charset suffix is a
      real regression risk, not a style point). Also asserts the `@Public()`
      metadata is on the list route and on neither mutating route.
- [x] **5c** `issuer/oid4vc-issuer.service.spec.ts` — **new file**; the issuer
      service had no spec at all, so the mapper was entirely untested:
  - the SD-JWT branch emits `status.status_list` and writes the mapping back
  - `status` is kept out of the disclosure frame
  - an `issuanceMetadata` claim named `status` cannot shadow the real pointer
  - a failed write-back, and a failed allocation, each issue nothing
  - the W3C `JwtVc` branch stays status-free and never allocates — the
    regression guard for the one path where adding status would *break*
    verification
- [x] **5d** extend [`oid4vc.config.spec.ts`](oid4vc.config.spec.ts) —
      `statusListUri` under the default and a prefix-less base URL, and the
      no-path-segment warning. Pulled forward into Phase 0 so that phase lands
      green rather than deferring its own coverage.
- [x] **5e** *(PR 2)* `test/status-list.e2e-spec.ts` — self-contained.

  The existing [`test/app.e2e-spec.ts`](../../test/app.e2e-spec.ts) drives a
  live stack (Vault on `:8200`, the app on `:3000`, a real chain, secrets read
  off disk) and cannot be extended without that infrastructure. Instead: a
  real Nest app over `supertest`, Vault mocked, and **real Ed25519 from node's
  `crypto`** (`generateKeyPairSync('ed25519')` — stdlib, no new dependency)
  standing in for Vault transit signing.

  Full loop through real HTTP:
  1. `GET /v1/credential/status/list/default` → 200, correct content type,
     signature verifies against the public key
  2. allocate two entries, simulating issuance
  3. issue a genuine SD-JWT VC with `SDJwtVcInstance` whose
     `status.status_list.uri` points at the supertest server → `verify()`
     **passes**
  4. `POST /v1/credential/status/revoke` → 200
  5. the same credential now **throws** `"Status is not valid"`; the other
     credential still verifies
  6. `POST /v1/credential/status/reactivate` → verifies again

  Step 5 is the only test that proves the feature works. It runs the exact
  library code Credo delegates to (§4 row 1), so it is a real end-to-end of
  the enforcement path rather than a mock of it.

  **No extra jest config.** An earlier revision added a `test:e2e:offline`
  script and a second config that excluded `app.e2e-spec.ts`; both were
  deleted. `yarn test:e2e` already runs this suite in CI, where
  [`tests.yml`](../../.github/workflows/tests.yml) has LocalNet, Vault and the
  compose stack up, and locally a path filter selects it with nothing to
  maintain:

  ```sh
  yarn test:e2e status-list
  ```

  E2E specs stay in `test/` alongside `app.e2e-spec.ts` regardless of whether
  they need the live stack — placement follows the kind of test, not its
  dependencies.

  Implementation notes: the app really listens (`app.listen(0)`) and the base
  URL is read lazily, because the status URI baked into a credential has to
  match the port the test server ended up on. Vault KV is a `Map` whose writes
  are JSON round-tripped, so `undefined` fields genuinely disappear the way
  they would through Vault. The real `StatusListRepository` and
  `Oid4vcIssuanceSessionRepository` are used rather than fakes, so
  `VaultRepository` is exercised too.

### Phase 6 — documentation  *(PR 3)*

- [ ] [`README.md`](README.md) — status list section, revoke `curl` examples.
- [ ] [`TRUST_MODEL.md`](TRUST_MODEL.md) line 71 — currently calls the mutable
      on-chain `did:algo` document the "revocation surface". That becomes
      wrong once this lands: key rotation is a blunt all-users instrument, not
      revocation. Replace with the per-credential mechanism, and record the
      §5.1 gap for credentials issued before this change.

---

## 8. Properties to keep in mind

**Fail-closed.** If Vault is down or the list endpoint 500s, verification
*fails* and credentials are rejected. That is the correct direction for
revocation, but it makes the status list a new availability dependency of
wallet authentication. Phase 4 removes that dependency for our own guard; it
remains real for third-party verifiers.

**The claim commits us to the endpoint.** Once a credential is issued with
`status.status_list`, the list must stay served for the life of that
credential. A fetch failure throws inside `verify()`, so taking the endpoint
away — or moving it, via a changed `OID4VC_BASE_URL` — bricks every credential
that points at it. There is no partial rollout and no clean rollback after
Phase 2 ships.

The window between Phase 2 and Phase 3 is contained by the branch structure
above: PR 1 does not reach `master` until PR 2 has merged into it, so no
deployable branch ever issues credentials pointing at a URL nothing serves.
The commit message on `cbd5ed0` carries the same warning for anyone who finds
that commit on its own.

**No new key coupling.** The list is signed by the manager key, which already
signs every credential. A manager key rotation already invalidated
everything, so this adds no new failure mode.

**Additive only.** Nothing existing is "fixed" along the way. In particular,
the `VaultService.sign` return-type inaccuracy (§4 row 8) is mirrored, not
corrected — that is a separate change with its own blast radius.

## 9. Deliberate shortcuts

Each gets a `ponytail:` comment at its site naming the ceiling and the
upgrade path, so they show up in a debt sweep rather than rotting silently.

| Shortcut | Ceiling | Upgrade |
| --- | --- | --- |
| In-process promise chain around allocation | Two Nest instances can hand out the same index; `VaultService.kvWrite` has no CAS parameter | Add `cas` to `kvWrite` and retry on conflict |
| Single list, throw at capacity | 16384 credentials | Auto-rollover — nearly free, since `statusListId` is already stored per credential |
| `bits: 1` | No suspension | `bits: 2` plus a custom `statusValidator` on the verifier side |
| Device-level revocation (all credentials for one `did:key`) not built | Revoking a device means revoking its sessions one at a time | Add `revokeByHolderDidKey`; needs a secondary index on `holderDidKey` to avoid an O(n) scan |
| Signed-token cache is per-process with no expiry | A revocation on another instance does not evict this one's entry, so it keeps serving a token saying the credential is live | Short TTL on the entry, or cross-instance invalidation |

## 10. Pre-existing defects found, and left alone

Noticed while building. Neither is caused by this work and neither is fixed
here — recorded so the next person does not rediscover them.

- **The W3C `JwtVc` branch silently drops every custom claim.** The mapper
  builds `new W3cCredential({ credentialSubject: { id, ...claims } })`, but
  Credo's `W3cCredentialSubject` only maps `id` and `claims`, so anything
  passed through `issuanceMetadata` never reaches the issued credential.
  Verified directly: a `tier` claim serialises away, leaving `{ id }`.
  `oid4vc-issuer.service.spec.ts` pins the current behaviour so the branch is
  guarded, with a comment making clear the assertion is not an endorsement.
  Anyone relying on `jwt_vc_json` issuance today is getting empty credentials.
- **`VaultService.sign` is typed `Promise<Buffer>` but returns a string**
  (§4). Mirrored with a cast rather than corrected, since fixing the type
  touches every caller.

## 11. Open questions

- **Decision 1 is the only one still worth challenging.** If any credential
  currently in circulation matters, reissue at cutover instead of accepting
  the gap (§5.1).
- Everything else is settled. Note that Phase 2 is the point of no return:
  once credentials ship with a `status_list.uri`, the endpoint and its URL are
  load-bearing forever (§8) — which is why PR 1 waits for PR 2 before it sees
  `master`.
