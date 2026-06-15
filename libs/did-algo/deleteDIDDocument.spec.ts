import { Address } from '@algorandfoundation/algokit-utils';
import { DID_STATUS_DELETING, DID_STATUS_READY, DID_STATUS_UPLOADING, deleteDIDDocument } from './deleteDIDDocument';
import { MAX_TXNS_PER_GROUP } from './uploadDIDDocument';

type RecordedCall = {
  method: string;
  args: any[];
  boxReferences?: any[];
  extraFee?: any;
};

type RecordedGroup = { calls: RecordedCall[]; txIds: string[] };

function buildHarness(metadata: any) {
  const groups: RecordedGroup[] = [];
  let counter = 0;

  const algorand = {
    newGroup: () => {
      const g: RecordedGroup = { calls: [], txIds: [] };
      groups.push(g);
      const composer = {
        addAppCallMethodCall: (call: any) => {
          g.calls.push({
            method: call.method.name,
            args: call.args,
            boxReferences: call.boxReferences,
            extraFee: call.extraFee,
          });
          return composer;
        },
        send: async () => {
          for (let i = 0; i < g.calls.length; i++) g.txIds.push(`tx-${++counter}`);
          return { txIds: g.txIds };
        },
      };
      return composer;
    },
  } as any;

  const appClient = {
    appClient: { getABIMethod: (name: string) => ({ name }) },
    state: {
      box: {
        metadata: { value: async () => metadata },
      },
    },
  } as any;

  return { algorand, appClient, groups };
}

const PUB_KEY = new Uint8Array(32).fill(0x33);
const SENDER = new Address(new Uint8Array(32).fill(0x44));

describe('did-algo/deleteDIDDocument', () => {
  it('throws when no metadata exists for the user', async () => {
    const { algorand, appClient } = buildHarness(undefined);
    await expect(deleteDIDDocument(appClient, algorand, 1n, PUB_KEY, SENDER)).rejects.toThrow(
      /No on-chain DID metadata/,
    );
  });

  it('refuses to delete when the contract status is UPLOADING', async () => {
    const { algorand, appClient } = buildHarness({
      start: 0n,
      end: 0n,
      status: DID_STATUS_UPLOADING,
      lastDeleted: 0n,
      endSize: 0n,
    });
    await expect(deleteDIDDocument(appClient, algorand, 1n, PUB_KEY, SENDER)).rejects.toThrow(/Cannot delete DID/);
  });

  it('READY: prepends startDelete then sequential deleteData over [start, end]', async () => {
    const { algorand, appClient, groups } = buildHarness({
      start: 3n,
      end: 5n,
      status: DID_STATUS_READY,
      lastDeleted: 0n,
      endSize: 100n,
    });

    const txIds = await deleteDIDDocument(appClient, algorand, 9n, PUB_KEY, SENDER);

    expect(groups).toHaveLength(1);
    const methods = groups[0].calls.map((c) => c.method);
    expect(methods).toEqual(['startDelete', 'deleteData', 'deleteData', 'deleteData']);

    const indices = groups[0].calls.filter((c) => c.method === 'deleteData').map((c) => c.args[1]);
    expect(indices).toEqual([3n, 4n, 5n]);

    // Each deleteData carries the data-box ref + metadata box ref + an extraFee bump.
    groups[0].calls
      .filter((c) => c.method === 'deleteData')
      .forEach((c) => {
        expect(c.boxReferences).toHaveLength(2);
        expect(c.extraFee).toBeDefined();
      });

    expect(txIds).toEqual(groups[0].txIds);
  });

  it('DELETING: skips startDelete and resumes from lastDeleted+1', async () => {
    const { algorand, appClient, groups } = buildHarness({
      start: 0n,
      end: 4n,
      status: DID_STATUS_DELETING,
      lastDeleted: 2n,
      endSize: 0n,
    });

    await deleteDIDDocument(appClient, algorand, 1n, PUB_KEY, SENDER);

    const methods = groups[0].calls.map((c) => c.method);
    expect(methods).not.toContain('startDelete');
    const indices = groups[0].calls.filter((c) => c.method === 'deleteData').map((c) => c.args[1]);
    expect(indices).toEqual([3n, 4n]);
  });

  it('DELETING with lastDeleted < start: resumes from start (sentinel handling)', async () => {
    const { algorand, appClient, groups } = buildHarness({
      start: 7n,
      end: 8n,
      status: DID_STATUS_DELETING,
      lastDeleted: 0n,
      endSize: 0n,
    });

    await deleteDIDDocument(appClient, algorand, 1n, PUB_KEY, SENDER);

    const indices = groups[0].calls.filter((c) => c.method === 'deleteData').map((c) => c.args[1]);
    expect(indices).toEqual([7n, 8n]);
  });

  it('splits across multiple groups when [start..end] does not fit in a single group', async () => {
    // 1 startDelete + N deleteData. With MAX_TXNS_PER_GROUP=16 we can fit at
    // most 15 deleteData in the first group and the rest in subsequent groups.
    const startBox = 1n; // start>0 so the lastDeleted=0 sentinel resolves to "no progress"
    const endBox = startBox + BigInt(MAX_TXNS_PER_GROUP * 2); // 33 deleteData calls total
    const { algorand, appClient, groups } = buildHarness({
      start: startBox,
      end: endBox,
      status: DID_STATUS_READY,
      lastDeleted: 0n,
      endSize: 0n,
    });

    await deleteDIDDocument(appClient, algorand, 1n, PUB_KEY, SENDER);

    expect(groups.length).toBeGreaterThan(1);
    groups.forEach((g) => expect(g.calls.length).toBeLessThanOrEqual(MAX_TXNS_PER_GROUP));

    const allDeletes = groups.flatMap((g) => g.calls.filter((c) => c.method === 'deleteData'));
    const expected = Number(endBox - startBox) + 1;
    expect(allDeletes).toHaveLength(expected);
    // Indices form the contiguous range start..end in order.
    allDeletes.forEach((c, i) => expect(c.args[1]).toBe(startBox + BigInt(i)));

    // Only the first group contains startDelete.
    expect(groups[0].calls[0].method).toBe('startDelete');
    groups.slice(1).forEach((g) => g.calls.forEach((c) => expect(c.method).toBe('deleteData')));
  });
});
