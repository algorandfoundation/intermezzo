/**
 * Public surface of the `did-algo` library.
 *
 * This module bundles the on-chain DIDAlgoStorage smart-contract client
 * (generated from the ARC-56 spec) together with the helpers needed to
 * interact with it: data upload orchestration, MBR cost calculation,
 * box-name encoding, and `did:algo` identifier construction.
 *
 * Consumers (the API in `src/did`, the development init script, and the
 * standalone deploy script) should import from this barrel rather than
 * reaching into individual files, so the internal layout can evolve
 * without churning every call site.
 */

export { DidAlgoStorageClient, DidAlgoStorageFactory, MetadataFromTuple } from './contracts/DidAlgoStorageClient';
export type { Metadata } from './contracts/DidAlgoStorageClient';

export {
  uploadDIDDocument,
  calculateUploadCost,
  splitDataIntoBoxes,
  splitBoxIntoChunks,
  COST_PER_BYTE,
  COST_PER_BOX,
  MAX_BOX_SIZE,
  BYTES_PER_CALL,
  MAX_TXNS_PER_GROUP,
} from './uploadDIDDocument';

export { deleteDIDDocument, DID_STATUS_UPLOADING, DID_STATUS_READY, DID_STATUS_DELETING } from './deleteDIDDocument';

export { resolveDIDDocument } from './resolveDIDDocument';

export { tryReadMetadata } from './tryReadMetadata';

export { replaceDIDDocument } from './replaceDIDDocument';
export type { ReplaceDIDDocumentResult } from './replaceDIDDocument';

export {
  buildUploadDIDDocumentGroups,
  buildDeleteDIDDocumentGroups,
  buildReplaceDIDDocumentGroups,
  buildCreateUserContractGroup,
  USER_ACCOUNT_MIN_BALANCE_FOR_CREATE_MICROALGOS,
} from './buildDIDDocumentTransactions';
export type { DidTxnSigner, DidUnsignedGroup, DidReplacePlan } from './buildDIDDocumentTransactions';

export { encodeUint64, genesisIdToNetwork, buildDidIdentifier } from './util';
