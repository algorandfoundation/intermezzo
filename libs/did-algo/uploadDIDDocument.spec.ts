import { Address } from '@algorandfoundation/algokit-utils';
import {
  BYTES_PER_CALL,
  COST_PER_BOX,
  COST_PER_BYTE,
  MAX_BOX_SIZE,
  MAX_TXNS_PER_GROUP,
  calculateUploadCost,
  splitBoxIntoChunks,
  splitDataIntoBoxes,
  uploadDIDDocument,
} from './uploadDIDDocument';

type RecordedCall = {
  method: string;
  args: any[];
  boxReferences?: any[];
  sender?: string;
  appId?: bigint;
};

type RecordedGroup = {
  calls: RecordedCall[];
  paymentTxn?: any;
  txIds: string[];
};

/**
 * Build a minimal `algorand` + `appClient` pair that records every group
 * the orchestrator composes, so we can assert on the shape and ordering
 * of the produced atomic groups without ever touching a real algod node.
 */
function buildHarness({ currentIndex = 0n }: { currentIndex?: bigint } = {}) {
  const groups: RecordedGroup[] = [];
  let txCounter = 0;

  const newGroup = () => {
    const recorded: RecordedGroup = { calls: [], txIds: [] };
    groups.push(recorded);

    const composer = {
      addAppCallMethodCall: (call: any) => {
        recorded.calls.push({
          method: call.method.name,
          args: call.args,
          boxReferences: call.boxReferences,
          sender: call.sender,
          appId: call.appId,
        });
        return composer;
      },
      send: async () => {
        // 1 txId per call we recorded, plus 1 if a payment was attached.
        const total = recorded.calls.length + (recorded.paymentTxn ? 1 : 0);
        for (let i = 0; i < total; i++) {
          recorded.txIds.push(`tx-${++txCounter}`);
        }
        return { txIds: recorded.txIds };
      },
    };
    return composer;
  };

  let recordedPaymentTxn: any;
  const algorand = {
    newGroup,
    createTransaction: {
      payment: (params: any) => {
        recordedPaymentTxn = { type: 'pay', ...params };
        // Tag whatever group the next addAppCallMethodCall lands in (the first group).
        return recordedPaymentTxn;
      },
    },
  } as any;

  // The orchestrator passes the payment txn to startUpload as an arg, so we
  // associate it with the first group after the fact in the assertions.
  const getGroups = () => {
    if (groups[0] && recordedPaymentTxn) {
      groups[0].paymentTxn = recordedPaymentTxn;
    }
    return groups;
  };

  const abiMethod = (name: string) => ({ name, getSelector: () => Buffer.alloc(4) });

  const appClient = {
    appAddress: 'APP_ADDRESS_PLACEHOLDER',
    algorand: {
      createTransaction: algorand.createTransaction,
    },
    appClient: {
      getABIMethod: (name: string) => abiMethod(name),
    },
    state: {
      global: {
        currentIndex: async () => currentIndex,
      },
    },
  } as any;

  return { algorand, appClient, getGroups };
}

describe('did-algo/uploadDIDDocument', () => {
  describe('splitDataIntoBoxes', () => {
    it('returns one (possibly empty) trailing box for sub-MAX_BOX_SIZE inputs', () => {
      const data = Buffer.alloc(100, 0xab);
      const boxes = splitDataIntoBoxes(data);
      expect(boxes).toHaveLength(1);
      expect(boxes[0].byteLength).toBe(100);
    });

    it('splits exactly at MAX_BOX_SIZE boundaries with an empty trailing box', () => {
      const data = Buffer.alloc(MAX_BOX_SIZE * 2, 0xcd);
      const boxes = splitDataIntoBoxes(data);
      // numBoxes = floor(2 * MAX / MAX) = 2, plus the empty trailing slice.
      expect(boxes).toHaveLength(3);
      expect(boxes[0].byteLength).toBe(MAX_BOX_SIZE);
      expect(boxes[1].byteLength).toBe(MAX_BOX_SIZE);
      expect(boxes[2].byteLength).toBe(0);
    });

    it('splits data spanning multiple boxes with a partial trailing box', () => {
      const data = Buffer.alloc(MAX_BOX_SIZE + 7, 0xef);
      const boxes = splitDataIntoBoxes(data);
      expect(boxes).toHaveLength(2);
      expect(boxes[0].byteLength).toBe(MAX_BOX_SIZE);
      expect(boxes[1].byteLength).toBe(7);
    });
  });

  describe('splitBoxIntoChunks', () => {
    it('produces ceil(box / BYTES_PER_CALL) chunks', () => {
      const box = new Uint8Array(BYTES_PER_CALL * 2 + 5);
      const chunks = splitBoxIntoChunks(box);
      expect(chunks).toHaveLength(3);
      expect(chunks[0].byteLength).toBe(BYTES_PER_CALL);
      expect(chunks[1].byteLength).toBe(BYTES_PER_CALL);
      expect(chunks[2].byteLength).toBe(5);
    });

    it('returns no chunks for an empty box', () => {
      expect(splitBoxIntoChunks(new Uint8Array(0))).toEqual([]);
    });
  });

  describe('calculateUploadCost', () => {
    it('matches the reference contract formula', () => {
      // For boxCount=1, endBoxSize=10:
      //   1*COST_PER_BOX + 0*MAX_BOX_SIZE*COST_PER_BYTE
      //   + 1*8*COST_PER_BYTE + 10*COST_PER_BYTE
      //   + COST_PER_BOX + (8+8+1+8+32+8)*COST_PER_BYTE
      const expected =
        COST_PER_BOX +
        0 +
        8 * COST_PER_BYTE +
        10 * COST_PER_BYTE +
        COST_PER_BOX +
        (8 + 8 + 1 + 8 + 32 + 8) * COST_PER_BYTE;
      expect(calculateUploadCost(1, 10)).toBe(expected);
    });
  });

  describe('uploadDIDDocument orchestration', () => {
    const PUB_KEY = new Uint8Array(32).fill(0x11);
    const SENDER = new Address(new Uint8Array(32).fill(0x22));

    it('emits a single group [mbrPayment, startUpload, ...uploads, finishUpload] for small docs', async () => {
      const { algorand, appClient, getGroups } = buildHarness({ currentIndex: 5n });
      const data = Buffer.alloc(100, 1);

      const txIds = await uploadDIDDocument(appClient, algorand, data, 42n, PUB_KEY, SENDER);

      const groups = getGroups();
      expect(groups).toHaveLength(1);

      // 1 startUpload + 1 upload (100 bytes < BYTES_PER_CALL) + 1 finishUpload = 3 calls.
      expect(groups[0].calls.map((c) => c.method)).toEqual(['startUpload', 'upload', 'finishUpload']);
      expect(groups[0].paymentTxn).toBeDefined();

      // mbr payment was sent to the app address with calculateUploadCost(1, 100) µALGO.
      const expectedCost = calculateUploadCost(1, 100);
      expect(groups[0].paymentTxn.receiver).toBe(appClient.appAddress);
      expect(Number(groups[0].paymentTxn.amount.microAlgos)).toBe(expectedCost);

      // startUpload args: [pubKeyAddress, boxCount=1, endBoxSize=100, mbrPayment].
      const startCall = groups[0].calls[0];
      expect(startCall.args[1]).toBe(1n);
      expect(startCall.args[2]).toBe(100n);
      expect(startCall.args[3]).toBe(groups[0].paymentTxn);

      // upload uses the box index seeded from currentIndex (5).
      const upload = groups[0].calls[1];
      expect(upload.args[1]).toBe(5n);
      expect(upload.args[2]).toBe(0n);

      // The composer reports one txId per recorded app call (the mbr payment
      // is attached to startUpload as an arg, not a separately-tracked call
      // in our harness).
      expect(txIds.length).toBeGreaterThan(0);
      expect(txIds).toEqual(groups[0].txIds);
    });

    it('caps each group at MAX_TXNS_PER_GROUP and appends finishUpload only in the last group', async () => {
      const { algorand, appClient, getGroups } = buildHarness();
      // Force enough chunks that we need a second group: a single box with
      // 16 chunks worth of data => 16 upload calls + start + mbr + finish = 18 txns.
      const chunkCount = 16;
      const data = Buffer.alloc(BYTES_PER_CALL * chunkCount, 0xa5);

      await uploadDIDDocument(appClient, algorand, data, 7n, PUB_KEY, SENDER);

      const groups = getGroups();
      expect(groups.length).toBeGreaterThan(1);

      // First group: startUpload + as many uploads as fit alongside the payment (16 - 2 = 14 uploads).
      const firstMethods = groups[0].calls.map((c) => c.method);
      expect(firstMethods[0]).toBe('startUpload');
      expect(firstMethods).not.toContain('finishUpload');
      // Composer-recorded calls should be ≤ MAX_TXNS_PER_GROUP - 1 (the payment is a separate txn in the group).
      expect(groups[0].calls.length).toBeLessThanOrEqual(MAX_TXNS_PER_GROUP - 1);

      // Last group: ends with finishUpload.
      const last = groups[groups.length - 1];
      expect(last.calls[last.calls.length - 1].method).toBe('finishUpload');

      // Total upload calls across groups equals the chunk count.
      const uploads = groups.flatMap((g) => g.calls.filter((c) => c.method === 'upload'));
      expect(uploads).toHaveLength(chunkCount);

      // Box index for every upload is `startBox + 0n` (single box).
      uploads.forEach((u) => expect(u.args[1]).toBe(0n));
      // bytesOffset increments by BYTES_PER_CALL per chunk.
      uploads.forEach((u, i) => expect(u.args[2]).toBe(BigInt(BYTES_PER_CALL * i)));
    });

    it('attaches a metadata box reference (pubKey-keyed) to startUpload and finishUpload', async () => {
      const { algorand, appClient, getGroups } = buildHarness();
      await uploadDIDDocument(appClient, algorand, Buffer.alloc(10), 1n, PUB_KEY, SENDER);

      const [group] = getGroups();
      const start = group.calls[0];
      const finish = group.calls[group.calls.length - 1];
      expect(start.method).toBe('startUpload');
      expect(finish.method).toBe('finishUpload');
      expect(start.boxReferences).toEqual([PUB_KEY]);
      expect(finish.boxReferences).toEqual([PUB_KEY]);
    });
  });
});
