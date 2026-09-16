# Algorand PQ accounts: merge-readiness plan

## Scope and decision

Ship opt-in Falcon-1024 user accounts in PR #40, reviewed against `master`.
Keep one account type per user ID. Reuse the immutable Vault KV-v2 CAS claim
implemented on `fix/pq-account-creation-conflicts`; do not introduce a lock
service or a provisioning state machine.

Falcon generalization is a future nice-to-have, outside this PR.

## Current state

- `feat/pq-accounts` implements the Vault plugin, account creation,
  discovery/listing, transaction signing, PQ fees, and legacy compatibility.
- PR #40 is still a draft targeting `master`.
- The creation-race fix is integrated as `e6d5b8f` and `56bd16b`.
- CI passed for `4f16327`. That result does not validate the combined changes.
- Stage 1 checks on 2026-09-16: lint, format, and Go plugin race tests pass.
  Full TypeScript and live E2E validation remains in stage 4.

## Merge gates, in order

1. **Integrate the existing fix.** Done. The validation, authorization, CAS,
   retry, and concurrent-creation tests are present on this branch.
2. **Add a read-only rollout audit.** Verify both Vault mounts exist and are
   accessible before treating a key-list miss as empty. Detect cross-mount
   duplicate IDs and case aliases incompatible with the claim normalization.
   Exit unsuccessfully on collisions, unavailable mounts, or unreadable data;
   never repair or delete keys automatically. Include a runnable check of the
   audit's failure cases.
3. **Document deployment and compatibility.** Add a short PQ setup/API section
   to the README and a cutover procedure. Explain the required account_type
   response field, new-ID validation, permissions, and same-type retry behavior.
   Move durable details out of this working plan before removing it.
4. **Validate the combined branch.** Refresh dependencies from the frozen
   lockfile; run build, lint, format, unit tests, Go tests with the race detector,
   and the full live E2E suite. Verify concurrent mixed-type creation, same-type
   retries after provisioning failure, caller authorization, unchanged Ed25519
   behavior, PQ fees, and mixed transaction groups. Require successful CI on
   the final PR head and report current results rather than historical counts.
5. **Review and prepare PR #40.** Review the complete diff against current
   `master`, address actionable review comments, and remove unrelated changes
   and obsolete planning prose. Keep commits organized around plugin/lifecycle,
   account handling/safety, and transaction support, with their relevant tests.
   Update the PR description to the final behavior, validation, and rollout
   requirements; mark ready for review when these gates are satisfied.

## Creation invariant

Claims live in Vault KV v2 at
`intermezzo/account-types/<sha256(lowercase(user_id))>` and contain only
`{ schemaVersion, userId, accountType }`.

After authorization and existing-account checks, CAS 0 chooses one account
type before key provisioning. An exact same-user/same-type retry may resume;
competing types or case aliases receive 409. Malformed or tombstoned claims
fail closed. A provisioning failure leaves the claim for a same-type retry;
there is no ready state, expiry, or automatic claim deletion.

The claim coordinates creation only. Vault key mounts remain the source of
truth for resolution and signing. Actual key creation and signing retain caller
credentials; service credentials manage claims. Review authorization before
claim creation as well as authorization of the eventual key operation.

## Deployment gate (after merge)

Pause or drain account-creation writers, run the audit, deploy claim-aware
instances everywhere, and then resume creation. Reads and signing may continue.
Existing accounts need no claim backfill while cross-mount checks remain in
the create path. Old instances and direct Vault writers can bypass claims;
creation must use the coordinated application path for the invariant to hold.

## Deferred

- General-purpose Falcon key/signing API and non-Algorand adapters (nice-to-have).
- PQ manager accounts and DID/OID4VC changes.
- Mnemonic export, rotation, deletion, and rekeying support.
- Stored PQ key schema versioning and consistency validation, before a future
  storage-format change.
- Runtime distinction between missing PQ keys and missing/misconfigured mounts;
  the rollout audit must explicitly verify mounts in this release.
