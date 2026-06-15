import { Address, AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils';
import { BoxReference } from '@algorandfoundation/algokit-utils/types/app-manager';
import {
  Transaction,
  decodeTransaction,
  encodeTransaction,
  groupTransactions,
} from '@algorandfoundation/algokit-utils/transact';
import { APP_SPEC, DidAlgoStorageClient, Metadata } from './contracts/DidAlgoStorageClient';
import { APP_ACCOUNT_BASE_MBR_MICROALGOS } from './algorand';
import { encodeUint64 } from './util';
import {
  BYTES_PER_CALL,
  MAX_BOX_SIZE,
  MAX_TXNS_PER_GROUP,
  calculateUploadCost,
  splitBoxIntoChunks,
  splitDataIntoBoxes,
} from './uploadDIDDocument';
import { DID_STATUS_DELETING, DID_STATUS_READY } from './deleteDIDDocument';
import { tryReadMetadata } from './tryReadMetadata';

/**
 * Extra fee (in µAlgo, sized at exactly one suggested `minFee`) that
 * the on-chain `deleteData` call needs to issue its inner refund
 * `pay` back to the user. We add one of these to the group-level
 * fee funder for every `deleteData` op in the group, so the manager
 * — not the (zero-balance) user — pays for it via fee pooling.
 */
const INNER_REFUND_FEE_UNITS_PER_DELETE = 1;

/** Role that must sign a specific unsigned transaction. */
export type DidTxnSigner = 'manager' | 'user';

/**
 * A single atomic group of unsigned transactions, shaped to match
 * the standard wallet-connect `signTransactions(txnGroup,
 * indexesToSign)` contract:
 *
 * ```ts
 * async signTransactions(
 *   txnGroup: algosdk.Transaction[] | Uint8Array[],
 *   indexesToSign?: number[],
 * ): Promise<(Uint8Array | null)[]>
 * ```
 *
 * - `txnGroup` is the full ordered set of canonical unsigned bytes
 *   for the group (one per position).
 * - `indexesToSign` enumerates the positions the wallet is expected
 *   to sign; any position not listed must be returned as `null` by
 *   the wallet (the host fills those positions itself with the
 *   `signed` array below).
 * - `signers` parallels `txnGroup` and labels each position with
 *   the role expected to sign it; provided for display/audit.
 * - `kinds` parallels `txnGroup` and labels each transaction type
 *   (e.g. `pay`, `appl`) — for client-side display only.
 */
export interface DidUnsignedGroup {
  /** Group ID (base64-encoded 32-byte digest), shared across all txns in this group. */
  groupIdB64: string;
  /** Canonical encoded transaction bytes (base64), one per position in the atomic group. */
  txnGroup: string[];
  /** Positions in {@link txnGroup} the wallet must sign; others must be returned as `null`. */
  indexesToSign: number[];
  /** Role labels parallel to {@link txnGroup}. */
  signers: DidTxnSigner[];
  /** Transaction-type labels parallel to {@link txnGroup} (`pay`, `appl`, …). */
  kinds: string[];
}

/** Outcome of {@link buildReplaceDIDDocumentGroups}. */
export interface DidReplacePlan {
  /** All atomic groups required to complete the replace, in execution order. */
  groups: DidUnsignedGroup[];
  /** µAlgo MBR locked by the prior box (0 when no prior document). */
  oldMbrMicroAlgos: bigint;
  /** µAlgo MBR required by the new payload. */
  newMbrMicroAlgos: bigint;
}

/**
 * Encode every unsigned txn the composer produced and tag it with the
 * role that must sign it. The composer pre-assigns the group ID; we
 * surface it base64-encoded so the broadcast step can verify shape
 * before submitting.
 */
function encodeGroup(transactions: Transaction[], roleFor: (i: number) => DidTxnSigner): DidUnsignedGroup {
  const first = transactions[0];
  const groupIdB64 = first?.group ? Buffer.from(first.group).toString('base64') : '';
  const txnGroup = transactions.map((txn) => Buffer.from(encodeTransaction(txn)).toString('base64'));
  const signers = transactions.map((_, i) => roleFor(i));
  const kinds = transactions.map((txn) => txn.type as string);
  const indexesToSign = signers.map((role, i) => (role === 'user' ? i : -1)).filter((i) => i >= 0);
  return { groupIdB64, txnGroup, indexesToSign, signers, kinds };
}

/**
 * Assign a shared group id to every txn in {@link txns} (in place),
 * matching what `composer.build()` does at the end of its happy path.
 * Single-txn "groups" are left ungrouped, mirroring composer behaviour.
 */
function assignGroupIdInPlace(txns: Transaction[]): void {
  if (txns.length <= 1) return;
  const grouped = groupTransactions(txns);
  txns.forEach((t, i) => {
    t.group = grouped[i].group;
  });
}

/**
 * A single planned operation in the linear delete-then-upload
 * sequence. `size` is the number of transactions the operation
 * contributes to its enclosing atomic group (1 for every op except
 * `startUpload`, which inlines its `mbrPayment` argument and thus
 * materialises as `[pay, appl]` — 2 txns).
 *
 * `roles` parallels those materialised positions in order, so the
 * packer can stamp the correct signer role on every encoded txn.
 *
 * `apply` registers the operation on the supplied composer. It is
 * intentionally side-effecting so each operation can hold its own
 * box references / chunk bytes without re-deriving them.
 */
type PlannedOp = {
  kind:
    | 'startDelete'
    | 'deleteData'
    | 'startUpload'
    | 'upload'
    | 'finishUpload'
    | 'appAccountBaseFund'
    | 'repayManagerMbr';
  size: 1 | 2;
  roles: DidTxnSigner[];
  /**
   * Materialise the op on the supplied composer. When `pooledFee`
   * is non-zero the op is acting as the group's fee carrier and
   * MUST set its (manager-signed) leg's `staticFee` to `pooledFee`
   * instead of `0`. Non-carrier ops ignore the argument.
   */
  apply: (composer: ReturnType<AlgorandClient['newGroup']>, pooledFee?: bigint) => void;
  /**
   * If `true`, this op contains a manager-signed pay leg that can
   * absorb the group's pooled fee, letting the packer drop the
   * separate manager fee-funder `pay → self (amount=0)` it would
   * otherwise prepend. The packer picks the first carrier in the
   * group (currently `appAccountBaseFund` or `startUpload`'s
   * inline `mbrPayment`).
   */
  feeCarrier?: true;
  /**
   * Set only on `repayManagerMbr` ops. When the packer places this
   * op into a group it drops the usual manager fee-funder pay and
   * instead pools the group's full fee onto this user→manager pay
   * itself: `staticFee = pooledFee`, `amount = refund − pooledFee`.
   * Net effect for the manager is identical (`refund − fee`), but
   * the group is one txn smaller and we avoid round-tripping fees
   * through a separate funder. `apply` is ignored for these ops.
   */
  repayment?: {
    sender: Address;
    receiver: Address;
    /** Full µAlgo amount the contract inner-refunds back to the user. */
    refundMicroAlgos: bigint;
  };
};

/**
 * Build (but do not send) the atomic transaction groups required to
 * upload {@link data} as a fresh on-chain DID document under
 * {@link pubKey}.
 *
 * Mirrors {@link uploadDIDDocument} byte-for-byte in group layout, but
 * returns *unsigned* transactions:
 *
 *   - Group 0: `[mbrPayment(manager → app), startUpload(user), ...upload(user), finishUpload(user)?]`
 *   - Subsequent groups: `[...upload(user), finishUpload(user)?]`
 *
 * The MBR `pay` transaction has the manager as its sender (so the
 * manager pays out-of-pocket); every app-call has the user's
 * ed25519-derived address as its sender (so the user signs every
 * on-chain mutation of their own DID document).
 */
export async function buildUploadDIDDocumentGroups(
  appClient: DidAlgoStorageClient,
  algorand: AlgorandClient,
  data: Buffer,
  appId: bigint,
  pubKey: Uint8Array,
  opts: { appCallSender: Address; mbrPaymentSender: Address },
): Promise<DidUnsignedGroup[]> {
  const ops = planUploadOps(appClient, algorand, data, appId, pubKey, opts, await currentBoxIndex(appClient), {
    includeAppAccountBaseFund: true,
  });
  return await packOpsIntoGroups(algorand, ops, opts.mbrPaymentSender);
}
/**
 * Build (but do not send) the atomic transaction groups required to
 * delete the on-chain DID document for {@link pubKey}. Mirrors
 * {@link import('./deleteDIDDocument').deleteDIDDocument}; the user
 * signs every app-call.
 *
 * The plan *always* ends with a user-signed `pay` for the full sum
 * of box-MBR being refunded back to {@link opts.repaymentReceiver}
 * (the manager). The on-chain contract's `deleteData` issues its
 * MBR refund as an inner `pay` to `Txn.sender` — i.e. the user —
 * so without this trailing repayment the manager's original
 * sponsorship would be silently pocketed by the user. We refuse to
 * emit any delete plan that doesn't include the repayment, and a
 * post-pack guard re-asserts the invariant against the produced
 * groups.
 *
 * Returns `null` when no on-chain document exists for the supplied
 * key — callers should treat this as "nothing to delete".
 */
export async function buildDeleteDIDDocumentGroups(
  appClient: DidAlgoStorageClient,
  algorand: AlgorandClient,
  appId: bigint,
  pubKey: Uint8Array,
  opts: { appCallSender: Address; feeFunderSender: Address; repaymentReceiver: Address },
): Promise<DidUnsignedGroup[] | null> {
  const metadata = await appClient.state.box.metadata.value(new Address(pubKey).toString());
  if (!metadata) return null;
  const boxCount = Number(BigInt(metadata.end) - BigInt(metadata.start)) + 1;
  const endBoxSize = Number(metadata.endSize);
  const refundMicroAlgos = BigInt(calculateUploadCost(boxCount, endBoxSize));
  const ops = planDeleteOps(appClient, appId, pubKey, opts, metadata, {
    repaymentReceiver: opts.repaymentReceiver,
    repaymentMicroAlgos: refundMicroAlgos,
  });
  const groups = await packOpsIntoGroups(algorand, ops, opts.feeFunderSender);
  assertDeleteGroupsRepayManager(groups, opts.repaymentReceiver);
  return groups;
}

/**
 * Build the full "replace the on-chain DID document" plan as a flat
 * list of atomic groups, without sending any transaction.
 *
 * Unlike the (now-removed) "phased" predecessor, every operation
 * required to swap the on-chain payload — `startDelete`,
 * `deleteData×N`, `mbrPay + startUpload`, `upload×K`, `finishUpload`
 * — is laid out in a single linear sequence and greedily packed into
 * atomic groups of at most {@link MAX_TXNS_PER_GROUP} transactions.
 *
 * The wallet/manager therefore signs as many on-chain steps
 * atomically as Algorand permits (16 txns/group); any overflow
 * naturally spills into the next group, which the on-chain
 * state-machine resumes from (e.g. continuing a partial delete or
 * finishing a partial upload). The app itself reclaims the prior
 * box MBR via `deleteData`'s inner refunds and locks in the new MBR
 * via the `startUpload` `mbrPayment`, so callers only pay the
 * **net** delta out-of-pocket.
 *
 * The manager signs only the MBR `pay` transaction in front of
 * `startUpload`; every other transaction is signed by
 * {@link opts.appCallSender} — i.e. the user's `did:key` Ed25519
 * key.
 */
export async function buildReplaceDIDDocumentGroups(
  appClient: DidAlgoStorageClient,
  algorand: AlgorandClient,
  data: Buffer,
  appId: bigint,
  pubKey: Uint8Array,
  opts: {
    appCallSender: Address;
    mbrPaymentSender: Address;
    /**
     * Manager address that receives the user→manager `pay`
     * appended to the delete phase, reclaiming every µAlgo of
     * box-MBR the contract inner-refunds back to the user. See
     * {@link buildDeleteDIDDocumentGroups} for details.
     */
    repaymentReceiver: Address;
  },
): Promise<DidReplacePlan> {
  const newBoxCount = Math.ceil(data.byteLength / MAX_BOX_SIZE) || 1;
  const newEndBoxSize = data.byteLength % MAX_BOX_SIZE;
  const newMbrMicroAlgos = BigInt(calculateUploadCost(newBoxCount, newEndBoxSize));

  const existing = await tryReadMetadata(appClient, pubKey);

  // No prior document → upload only. Old MBR is zero.
  if (!existing) {
    // First-time upload on a freshly-created user contract: the app
    // account currently holds 0 µAlgo, so we must also pay its base
    // account MBR (100,000 µAlgo) before the contract can hold any
    // boxes. Subsequent updates skip this — the base MBR persists
    // for the lifetime of the contract.
    const ops = planUploadOps(appClient, algorand, data, appId, pubKey, opts, await currentBoxIndex(appClient), {
      includeAppAccountBaseFund: true,
    });
    return {
      groups: await packOpsIntoGroups(algorand, ops, opts.mbrPaymentSender),
      oldMbrMicroAlgos: 0n,
      newMbrMicroAlgos,
    };
  }

  const oldBoxCount = Number(BigInt(existing.end) - BigInt(existing.start)) + 1;
  const oldEndBoxSize = Number(existing.endSize);
  const oldMbrMicroAlgos = BigInt(calculateUploadCost(oldBoxCount, oldEndBoxSize));

  // Delete and upload share a single op stream and are packed
  // together by the greedy 16-txn packer. When the combined
  // sequence fits, the wallet sees ONE atomic group covering the
  // full delete → repay → startUpload → upload(s) → finishUpload
  // flow; when it overflows, the packer spills naturally into
  // follow-up groups and the on-chain state machine resumes
  // mid-flow (DELETING → READY → UPLOADING). Op order is
  // preserved end-to-end:
  //   1. startDelete (if status==READY)
  //   2. deleteData × N           (inner refunds → user)
  //   3. repayManagerMbr          (user → manager, amount=oldMbr−pooledFee)
  //   4. startUpload + mbrPayment (manager → app, new MBR)
  //   5. upload × M
  //   6. finishUpload
  // Per-txn AVM min-balance is satisfied throughout:
  //   - User: holds the strict creator MBR before, during (after
  //     deleteData credits, before repay) and after the group;
  //     repay only sends `oldMbr−pooledFee`, leaving exactly MBR
  //     + pooledFee, which the next outer txn's fee consumes.
  //   - App account: each `deleteData` destroys a box (lowering
  //     its MBR) and inner-refunds the freed µAlgo to the user
  //     atomically in the same txn, so its balance never dips
  //     below MBR. `startUpload`'s inline `mbrPayment` then tops
  //     the app account back up for the new boxes before any
  //     `upload` txn allocates them.
  // The packer's fee-carrier preference (`repayment` > `feeCarrier`)
  // ensures the user-signed repay absorbs the entire group's
  // pooled fee, so the inline `mbrPayment` and every other leg
  // stays at `staticFee: 0`.
  const startBox = await currentBoxIndex(appClient);
  const deleteOps = planDeleteOps(appClient, appId, pubKey, opts, existing, {
    repaymentReceiver: opts.repaymentReceiver,
    repaymentMicroAlgos: oldMbrMicroAlgos,
  });
  // No `includeAppAccountBaseFund` here: a prior document existed,
  // so the app account already holds at least its base MBR.
  const uploadOps = planUploadOps(appClient, algorand, data, appId, pubKey, opts, startBox);
  const groups = await packOpsIntoGroups(algorand, [...deleteOps, ...uploadOps], opts.mbrPaymentSender);
  assertDeleteGroupsRepayManager(groups, opts.repaymentReceiver);
  return {
    groups,
    oldMbrMicroAlgos,
    newMbrMicroAlgos,
  };
}

async function currentBoxIndex(appClient: DidAlgoStorageClient): Promise<bigint> {
  return (await appClient.state.global.currentIndex()) ?? 0n;
}

/**
 * Compute the ordered list of operations required to materialise
 * {@link data} as a fresh on-chain DID document. The first op is
 * `startUpload` (size 2, since it inlines the manager-signed
 * `mbrPayment` `pay` txn as an ABI arg); the last is `finishUpload`.
 */
function planUploadOps(
  appClient: DidAlgoStorageClient,
  algorand: AlgorandClient,
  data: Buffer,
  appId: bigint,
  pubKey: Uint8Array,
  opts: { appCallSender: Address; mbrPaymentSender: Address },
  startBox: bigint,
  flags: { includeAppAccountBaseFund?: boolean } = {},
): PlannedOp[] {
  const { appCallSender, mbrPaymentSender } = opts;
  const boxCount = Math.ceil(data.byteLength / MAX_BOX_SIZE);
  const endBoxSize = data.byteLength % MAX_BOX_SIZE;
  const totalCost = calculateUploadCost(boxCount, endBoxSize);
  const pubKeyAddress = new Address(pubKey).toString();

  const startUploadMethod = appClient.appClient.getABIMethod('startUpload')!;
  const uploadMethod = appClient.appClient.getABIMethod('upload')!;
  const finishUploadMethod = appClient.appClient.getABIMethod('finishUpload')!;

  // The composer needs a *fresh* mbrPayment object on every call to
  // `composer.addAppCallMethodCall({args: [..., mbrPayment]})` so it
  // can re-materialise the inline `pay` txn within the new group's
  // suggested-params view. We therefore wrap it in a factory.
  // When `startUpload` is the group's fee carrier (i.e. no separate
  // manager fee-funder pay was emitted), the `mbrPayment` leg's
  // `staticFee` carries the entire pooled fee for the group;
  // otherwise it stays at 0 and the funder absorbs the fees.
  const buildMbrPayment = (pooledFee: bigint) =>
    appClient.algorand.createTransaction.payment({
      sender: mbrPaymentSender.toString(),
      receiver: appClient.appAddress,
      amount: microAlgos(totalCost),
      staticFee: microAlgos(pooledFee),
    });

  const ops: PlannedOp[] = [];
  if (flags.includeAppAccountBaseFund) {
    // Manager-signed `pay → appAddress` for the app account's base
    // MBR. Without this, the upload's `mbrPayment` (sized to box
    // MBR only) leaves the app account below its minimum balance
    // and algod rejects the group with `balance N below min M`.
    ops.push({
      kind: 'appAccountBaseFund',
      size: 1,
      roles: ['manager'],
      // Eligible to carry the group's pooled fee on its own
      // staticFee, eliminating the separate manager fee-funder pay
      // (no 0-algo manager→manager pay needed in this group).
      feeCarrier: true,
      apply: (composer, pooledFee = 0n) =>
        composer.addPayment({
          sender: mbrPaymentSender.toString(),
          receiver: appClient.appAddress,
          amount: microAlgos(APP_ACCOUNT_BASE_MBR_MICROALGOS),
          staticFee: microAlgos(pooledFee),
        }),
    });
  }
  ops.push({
    kind: 'startUpload',
    size: 2,
    // The composer materialises `[mbrPayment, startUpload]` in that
    // order when an inline `pay` arg is supplied to a method-call.
    roles: ['manager', 'user'],
    // The inline `mbrPayment` leg is manager-signed and can absorb
    // the group's pooled fee. When the packer picks this op as the
    // group's fee carrier it drops the separate 0-algo
    // manager→manager funder pay entirely; the `mbrPayment`'s
    // `staticFee` covers every txn (and inner refund) in the group
    // via Algorand fee pooling.
    feeCarrier: true,
    apply: (composer, pooledFee = 0n) =>
      composer.addAppCallMethodCall({
        method: startUploadMethod,
        args: [pubKeyAddress, BigInt(boxCount), BigInt(endBoxSize), buildMbrPayment(pooledFee)],
        boxReferences: [pubKey],
        sender: appCallSender.toString(),
        appId,
        // User has 0 µAlgo balance; if `mbrPayment` carries the
        // pooled fee, this leg stays at 0; otherwise the manager
        // fee-funder pay covers it.
        staticFee: microAlgos(0n),
      }),
  });

  const boxData = splitDataIntoBoxes(data);
  boxData.forEach((box, boxIndexOffset) => {
    const boxIndex = startBox + BigInt(boxIndexOffset);
    const boxes: BoxReference[] = new Array(7)
      .fill({ appId: 0n, name: encodeUint64(boxIndex) })
      .concat({ appId: 0n, name: pubKey });
    const chunks = splitBoxIntoChunks(box);
    chunks.forEach((chunk, i) => {
      ops.push({
        kind: 'upload',
        size: 1,
        roles: ['user'],
        apply: (composer) =>
          composer.addAppCallMethodCall({
            method: uploadMethod,
            args: [pubKeyAddress, boxIndex, BigInt(BYTES_PER_CALL * i), chunk],
            boxReferences: boxes,
            sender: appCallSender.toString(),
            appId,
            staticFee: microAlgos(0n),
          }),
      });
    });
    // The variables `algorand` is accepted for future use (e.g.
    // separate composer params), but the composer is shared per
    // group so we do not need it inside `apply`.
    void algorand;
  });

  ops.push({
    kind: 'finishUpload',
    size: 1,
    roles: ['user'],
    apply: (composer) =>
      composer.addAppCallMethodCall({
        method: finishUploadMethod,
        args: [pubKeyAddress],
        boxReferences: [pubKey],
        sender: appCallSender.toString(),
        appId,
        staticFee: microAlgos(0n),
      }),
  });

  return ops;
}

/**
 * Compute the ordered list of `startDelete?` + `deleteData×N`
 * operations needed to tear down the on-chain document described by
 * {@link metadata}. `startDelete` is omitted when the contract is
 * already in the `DELETING` status (resuming a partial delete).
 */
function planDeleteOps(
  appClient: DidAlgoStorageClient,
  appId: bigint,
  pubKey: Uint8Array,
  opts: { appCallSender: Address },
  metadata: Metadata,
  repayment: { repaymentReceiver: Address; repaymentMicroAlgos: bigint },
): PlannedOp[] {
  const { appCallSender } = opts;
  const pubKeyAddress = new Address(pubKey).toString();

  const status = Number(metadata.status);
  if (status !== DID_STATUS_READY && status !== DID_STATUS_DELETING) {
    throw new Error(
      `Cannot delete DID for pubKey ${pubKeyAddress}: contract status=${status} (expected READY or DELETING)`,
    );
  }
  const needsStartDelete = status === DID_STATUS_READY;
  const endBox = metadata.end;
  // Pick the first box index to delete in this plan.
  //
  // The contract stores `lastDeleted` initialised to 0 and only
  // updates it from `deleteData` when the box being deleted is NOT
  // the end box (see `deleteData` in the reference contract: the
  // metadata box is destroyed instead when `boxIndex === end`).
  // That means `lastDeleted === 0` is ambiguous: it can mean either
  // "no box deleted yet" OR "box index 0 was deleted as a non-end
  // box". The old heuristic `lastDeleted < start ? start : lastDeleted+1`
  // disambiguated only when `start > 0`; for a freshly-uploaded
  // single-box DID document — where `currentIndex` was 0 at upload
  // time, so `start === end === 0` — the heuristic incorrectly
  // resolved to `firstBox = 1`, the loop ran zero times, and the
  // plan emitted `[startDelete, repay]` with no `deleteData` at
  // all. The trailing user→manager repay then overspent because
  // the contract never inner-refunded anything.
  //
  // Disambiguate via `status`: when `status === READY` we are
  // about to call `startDelete` in this very group, so by
  // construction no `deleteData` has run yet and the first box to
  // delete is `metadata.start`. When `status === DELETING` we are
  // resuming a partial delete from a previous (failed) group, so
  // `lastDeleted` is authoritative.
  const firstBox =
    status === DID_STATUS_READY
      ? metadata.start
      : metadata.lastDeleted < metadata.start
        ? metadata.start
        : metadata.lastDeleted + 1n;

  const startDeleteMethod = appClient.appClient.getABIMethod('startDelete')!;
  const deleteDataMethod = appClient.appClient.getABIMethod('deleteData')!;

  const ops: PlannedOp[] = [];
  if (needsStartDelete) {
    ops.push({
      kind: 'startDelete',
      size: 1,
      roles: ['user'],
      apply: (composer) =>
        composer.addAppCallMethodCall({
          method: startDeleteMethod,
          args: [pubKeyAddress],
          boxReferences: [pubKey],
          sender: appCallSender.toString(),
          appId,
          staticFee: microAlgos(0n),
        }),
    });
  }

  for (let box = firstBox; box <= endBox; box += 1n) {
    const boxIndex = box;
    const boxes: BoxReference[] = [
      { appId: 0n, name: encodeUint64(boxIndex) },
      { appId: 0n, name: pubKey },
    ];
    ops.push({
      kind: 'deleteData',
      size: 1,
      roles: ['user'],
      apply: (composer) =>
        composer.addAppCallMethodCall({
          method: deleteDataMethod,
          args: [pubKeyAddress, boxIndex],
          boxReferences: boxes,
          sender: appCallSender.toString(),
          appId,
          // Fee + inner-refund extra are pooled via the group's
          // manager fee-funder pay (see packOpsIntoGroups).
          staticFee: microAlgos(0n),
        }),
    });
  }

  // Reclaim every µAlgo the contract just inner-refunded into the
  // user account by paying it forward to the manager that originally
  // sponsored the MBR. The contract's `deleteData` emits its refund
  // as an inner `pay` with `receiver: Txn.sender` (i.e. the user),
  // so without this trailing user→manager `pay` the sponsorship
  // money would silently accumulate on the user's `did:key`-derived
  // wallet across delete/replace cycles. Fee pooled via the group
  // funder so the user still pays zero fees out of pocket.
  const { repaymentReceiver, repaymentMicroAlgos } = repayment;
  if (repaymentMicroAlgos <= 0n) {
    throw new Error(`Refusing to plan delete without a positive manager repayment (got ${repaymentMicroAlgos} µAlgo)`);
  }
  ops.push({
    kind: 'repayManagerMbr',
    size: 1,
    roles: ['user'],
    // `apply` is intentionally a no-op: the packer materialises this
    // op directly from `repayment` so it can fold the group's pooled
    // fee onto it (eliminating the separate manager fee-funder pay
    // for groups containing the repayment).
    apply: () => {},
    repayment: {
      sender: appCallSender,
      receiver: repaymentReceiver,
      refundMicroAlgos: repaymentMicroAlgos,
    },
  });

  return ops;
}

/**
 * Defense-in-depth: every delete plan we emit MUST contain at least
 * one user→manager `pay` returning the freed MBR. This guard
 * inspects the *produced* groups (so any future packer/builder
 * change that accidentally drops the trailing repayment is caught
 * here before the plan reaches the wallet).
 */
function assertDeleteGroupsRepayManager(groups: DidUnsignedGroup[], repaymentReceiver: Address): void {
  const receiverAddress = repaymentReceiver.toString();
  for (const group of groups) {
    for (let i = 0; i < group.txnGroup.length; i += 1) {
      if (group.kinds[i] !== 'pay') continue;
      if (group.signers[i] !== 'user') continue;
      const txn = decodePayTxn(group.txnGroup[i]);
      if (txn && txn.receiver === receiverAddress && txn.amount > 0n) {
        return;
      }
    }
  }
  throw new Error(
    `Delete plan is missing the mandatory user→manager MBR repayment to ${receiverAddress}; refusing to emit groups`,
  );
}

/**
 * Best-effort decode of a base64-encoded canonical `pay` txn for the
 * {@link assertDeleteGroupsRepayManager} guard. Returns `null` when
 * the bytes don't decode cleanly as a `pay` — the guard treats that
 * as "not the repayment" and keeps scanning.
 */
function decodePayTxn(b64: string): { receiver: string; amount: bigint } | null {
  try {
    const decoded = decodeTransaction(Buffer.from(b64, 'base64'));
    if (decoded.type !== 'pay' || !decoded.payment) return null;
    return {
      receiver: new Address(decoded.payment.receiver.publicKey).toString(),
      amount: BigInt(decoded.payment.amount ?? 0n),
    };
  } catch {
    return null;
  }
}

/**
 * µAlgo the user's `did:key`-derived address must hold to remain
 * solvent after creating the `DIDAlgoStorage` contract:
 *
 *   - 100,000 µAlgo: base account MBR
 *   - 100,000 µAlgo: per app created (this account becomes creator)
 *   -  28,500 µAlgo: per global uint in app state schema (the contract
 *                    declares `globalInts: 1, globalByteSlices: 0`)
 *
 * Total = 228,500 µAlgo. Funded exactly — no cushion — so we never
 * dispurse more than is strictly required to satisfy MBR at create
 * time. If the on-chain MBR formula or the contract's state schema
 * ever changes such that this account needs more, the manager is
 * responsible for topping up the difference on the next operation.
 * (Fees for the create group are pooled onto the manager-signed
 * funder payment, so the user account does not need to cover fees
 * out of this amount.)
 */
export const USER_ACCOUNT_MIN_BALANCE_FOR_CREATE_MICROALGOS = 228_500n;

/**
 * Build (but do not sign or send) the single atomic transaction group
 * that lets a wallet `did:key` create its own per-user
 * `DIDAlgoStorage` contract, with the manager covering every fee and
 * the user's min-balance up-front:
 *
 *   - Index 0: manager-signed `pay` (self-pay, amount=0) carrying a
 *     `staticFee` large enough to pool fees for every other txn in
 *     the group via Algorand fee pooling.
 *   - Index 1: manager-signed `pay` → `userAddress` for
 *     {@link USER_ACCOUNT_MIN_BALANCE_FOR_CREATE_MICROALGOS} µAlgo —
 *     funds the user's address so that, post-create, the account
 *     still satisfies its (now higher) min balance.
 *   - Index 2: **user-signed** `appl` (app create), with the
 *     compiled approval/clear programs and state schema sourced from
 *     the on-chain `DidAlgoStorageClient` ARC-56 app spec. The
 *     `sender` is `userAddress` — and that's why the resulting
 *     `applicationId.creator` is the wallet's `did:key`-derived
 *     address (the contract enforces `Txn.sender == creator` on
 *     every subsequent write, so this single signing decision pins
 *     authority to the wallet for the life of the contract).
 *
 * Returns the canonical unsigned bytes (base64) for every position
 * plus the standard wallet-connect-style `indexesToSign` array (only
 * index 2). The caller is responsible for signing the manager
 * positions at *submit* time (the server only commits its signature
 * after validating the wallet's signed positions against the
 * canonical bytes we emit here).
 */
export async function buildCreateUserContractGroup(
  algorand: AlgorandClient,
  opts: { userAddress: Address; managerAddress: Address },
): Promise<DidUnsignedGroup> {
  const { userAddress, managerAddress } = opts;
  const suggestedParams = await algorand.getSuggestedParams();
  const minFee = BigInt(suggestedParams.minFee);
  // Three txns in the group; manager funder covers all of them.
  const funderStaticFee = 3n * minFee;

  const composer = algorand.newGroup();
  const managerStr = managerAddress.toString();
  composer.addPayment({
    sender: managerStr,
    receiver: managerStr,
    amount: microAlgos(0n),
    staticFee: microAlgos(funderStaticFee),
  });
  composer.addPayment({
    sender: managerStr,
    receiver: userAddress.toString(),
    amount: microAlgos(USER_ACCOUNT_MIN_BALANCE_FOR_CREATE_MICROALGOS),
    staticFee: microAlgos(0n),
  });
  if (!APP_SPEC.byteCode?.approval || !APP_SPEC.byteCode?.clear) {
    throw new Error('DIDAlgoStorage APP_SPEC is missing compiled approval/clear bytecode');
  }
  composer.addAppCreate({
    sender: userAddress.toString(),
    approvalProgram: Buffer.from(APP_SPEC.byteCode.approval, 'base64'),
    clearStateProgram: Buffer.from(APP_SPEC.byteCode.clear, 'base64'),
    schema: {
      globalInts: APP_SPEC.state.schema.global.ints,
      globalByteSlices: APP_SPEC.state.schema.global.bytes,
      localInts: APP_SPEC.state.schema.local.ints,
      localByteSlices: APP_SPEC.state.schema.local.bytes,
    },
    staticFee: microAlgos(0n),
  });

  const { transactions } = await composer.buildTransactions();
  assignGroupIdInPlace(transactions);
  const roles: DidTxnSigner[] = ['manager', 'manager', 'user'];
  return encodeGroup(transactions, (i) => roles[i] ?? 'user');
}

/**
 * Greedy 16-txn packer: walks {@link ops} left-to-right and opens a
 * new atomic group whenever the next op would overflow the group
 * cap. Every group is led by a manager-signed fee funder
 * (self-pay, amount 0) whose `staticFee` is sized to cover every
 * other txn in the group via Algorand fee pooling — plus one extra
 * `minFee` for each `deleteData` op (its inner-refund leg). This is
 * what lets the user's zero-balance `did:key` address sign app-calls
 * without holding any µAlgo: every user txn is pinned at
 * `staticFee: 0`. The per-txn minimum fee is sourced from algod's
 * suggested params, never hard-coded.
 */
async function packOpsIntoGroups(
  algorand: AlgorandClient,
  ops: PlannedOp[],
  feeFunderSender: Address,
): Promise<DidUnsignedGroup[]> {
  const suggestedParams = await algorand.getSuggestedParams();
  const minFee = BigInt(suggestedParams.minFee);
  // Total capacity for actual ops once the funder slot is reserved.
  const opsCapacity = MAX_TXNS_PER_GROUP - 1;

  const groups: DidUnsignedGroup[] = [];
  let i = 0;
  while (i < ops.length) {
    let remaining = opsCapacity;
    const opsForGroup: PlannedOp[] = [];

    while (i < ops.length) {
      const op = ops[i];
      if (op.size > opsCapacity) {
        throw new Error(`Op ${op.kind} has size=${op.size} which exceeds packer capacity=${opsCapacity}`);
      }
      if (op.size > remaining) break;
      opsForGroup.push(op);
      remaining -= op.size;
      i += 1;
    }

    // Fold the manager fee-funder pay into the group whenever an
    // op in the group can carry the pooled fee itself:
    //   - `repayManagerMbr` (delete groups): the user-signed
    //     trailing repay carries the fee — its `amount` is
    //     reduced by `pooledFee` so the manager nets the same
    //     `refund − fee` as under the old funder-separate flow.
    //   - `feeCarrier` ops (upload groups): a manager-signed pay
    //     leg already exists (`appAccountBaseFund` or
    //     `startUpload`'s inline `mbrPayment`); its `staticFee`
    //     absorbs the pooled fee, so no separate 0-algo
    //     manager→manager funder pay is needed.
    // Only the first carrier in the group receives the pooled fee.
    const repaymentOp = opsForGroup.find((op) => op.kind === 'repayManagerMbr');
    const feeCarrierOp = repaymentOp ?? opsForGroup.find((op) => op.feeCarrier);
    const includeFunder = !feeCarrierOp;

    // Fee math: every outer txn in the group costs `minFee` from
    // the pool, plus one extra `minFee` for the inner refund of
    // every `deleteData` op.
    const funderSize = includeFunder ? 1 : 0;
    const groupTxnCount = funderSize + opsForGroup.reduce((acc, op) => acc + op.size, 0);
    const innerRefundCount = opsForGroup.filter((op) => op.kind === 'deleteData').length;
    const pooledFee = BigInt(groupTxnCount + innerRefundCount * INNER_REFUND_FEE_UNITS_PER_DELETE) * minFee;

    const composer = algorand.newGroup();
    const roles: DidTxnSigner[] = [];
    if (includeFunder) {
      const feeFunderSenderStr = feeFunderSender.toString();
      composer.addPayment({
        sender: feeFunderSenderStr,
        receiver: feeFunderSenderStr,
        amount: microAlgos(0n),
        staticFee: microAlgos(pooledFee),
      });
      roles.push('manager');
    }
    for (const op of opsForGroup) {
      if (op.repayment) {
        // Combined fee-and-payment: user-signed pay that carries the
        // entire group's pooled fee. `amount = refund − pooledFee`
        // so the manager nets exactly what it would have received
        // under the old funder-separate flow.
        const { sender, receiver, refundMicroAlgos } = op.repayment;
        if (refundMicroAlgos <= pooledFee) {
          throw new Error(
            `repayManagerMbr: refund ${refundMicroAlgos} µAlgo does not cover pooled fee ${pooledFee} µAlgo`,
          );
        }
        composer.addPayment({
          sender: sender.toString(),
          receiver: receiver.toString(),
          amount: microAlgos(refundMicroAlgos - pooledFee),
          staticFee: microAlgos(pooledFee),
        });
      } else if (op === feeCarrierOp) {
        // This op's manager-signed leg carries the group's pooled
        // fee — no separate funder pay was emitted.
        op.apply(composer, pooledFee);
      } else {
        op.apply(composer);
      }
      roles.push(...op.roles);
    }

    const { transactions: built } = await composer.buildTransactions();
    // `buildTransactions()` is the simulate-free counterpart of
    // `build()` — we use it because the user's `did:key`-derived
    // address has a 0-µALGO balance, so `build()`'s
    // `analyzeGroupRequirements` simulate path would overspend when
    // attributing fees back to the (zero-balance) user. Group IDs
    // are not assigned by `buildTransactions()`, so we apply them
    // manually below.
    assignGroupIdInPlace(built);
    groups.push(encodeGroup(built, (idx) => roles[idx] ?? 'user'));
  }
  return groups;
}
