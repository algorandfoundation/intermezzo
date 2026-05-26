import { AlgorandClient, Address, microAlgo } from '@algorandfoundation/algokit-utils';

/**
 * Default base MBR funding for a freshly-deployed application's
 * escrow account: 0.1 ALGO — the protocol-minimum account balance.
 * The DIDAlgoStorage contract pays per-box MBR inline via a payment
 * transaction grouped with each `upload`, so the app account itself
 * only needs to satisfy the account base MBR.
 */
export const APP_ACCOUNT_BASE_MBR_MICROALGOS = 100_000n;

export async function topUpFromSender(
  algorand: AlgorandClient,
  sender: string | Address,
  receiver: string | Address,
  targetMicroAlgos: bigint,
): Promise<void> {
  let currentMicroAlgos = 0n;
  try {
    const info = await algorand.account.getInformation(receiver);
    currentMicroAlgos = BigInt(info.balance.microAlgo);
  } catch (err: unknown) {
    const e = err as { status?: number; response?: { status?: number } };
    const status = e?.status ?? e?.response?.status;
    if (status !== 404) throw err;
  }

  if (currentMicroAlgos >= targetMicroAlgos) return;

  const shortfall = targetMicroAlgos - currentMicroAlgos;
  console.log(
    `Funding ${receiver.toString()} with ${shortfall} µALGO from ${sender.toString()} ` +
      `(current=${currentMicroAlgos}, target=${targetMicroAlgos})`,
  );
  await algorand.send.payment({
    sender: sender.toString(),
    receiver,
    amount: microAlgo(shortfall),
  });
}
