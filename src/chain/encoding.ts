import { AlgorandEncoder } from '@algorandfoundation/algo-models';

export const LENGTH_ENCODE_BYTE_SIZE = 2;
/**
 * Check whether the environment is Node.js (as opposed to the browser)
 * @returns True if Node.js environment, false otherwise
 */
export function isNode() {
  return (
    // @ts-ignore
    typeof process === 'object' &&
    // @ts-ignore
    typeof process.versions === 'object' &&
    // @ts-ignore
    typeof process.versions.node !== 'undefined'
  );
}

/**
 * Convert a base64 string to a Uint8Array for Node.js and browser environments.
 * @returns A Uint8Array
 */
export function base64ToBytes(base64String: string): Uint8Array {
  if (isNode()) {
    return new Uint8Array(Buffer.from(base64String, 'base64'));
  }
  /* eslint-env browser */
  const binString = atob(base64String);
  return Uint8Array.from(binString, (m) => m.codePointAt(0)!);
}

/**
 * Convert a Uint8Array to a base64 string for Node.js and browser environments.
 * @returns A base64 string
 */
export function bytesToBase64(byteArray: Uint8Array): string {
  if (isNode()) {
    return Buffer.from(byteArray).toString('base64');
  }
  /* eslint-env browser */
  const binString = Array.from(byteArray, (x) => String.fromCodePoint(x)).join('');
  return btoa(binString);
}

// NOTE: at the moment we specifically do not use Buffer.writeBigUInt64BE and
// Buffer.readBigUInt64BE. This is because projects using webpack v4
// automatically include an old version of the npm `buffer` package (v4.9.2 at
// the time of writing), and this old version does not have these methods.

/**
 * encodeUint64 converts an integer to its binary representation.
 * @param num - The number to convert. This must be an unsigned integer less than
 *   2^64.
 * @returns An 8-byte typed array containing the big-endian encoding of the input
 *   integer.
 */
export function encodeUint64(num: number | bigint) {
  const isInteger = typeof num === 'bigint' || Number.isInteger(num);

  if (!isInteger || num < 0 || num > BigInt('0xffffffffffffffff')) {
    throw new Error('Input is not a 64-bit unsigned integer');
  }

  const encoding = new Uint8Array(8);
  const view = new DataView(encoding.buffer);
  view.setBigUint64(0, BigInt(num));

  return encoding;
}

/**
 * decodeUint64 produces an integer from a binary representation.
 * @param data - An typed array containing the big-endian encoding of an unsigned integer
 *   less than 2^64. This array must be at most 8 bytes long.
 * @param decodingMode - Configure how the integer will be
 *   decoded.
 *
 *   The options are:
 *   * "safe": The integer will be decoded as a Number, but if it is greater than
 *     Number.MAX_SAFE_INTEGER an error will be thrown.
 *   * "mixed": The integer will be decoded as a Number if it is less than or equal to
 *     Number.MAX_SAFE_INTEGER, otherwise it will be decoded as a BigInt.
 *   * "bigint": The integer will always be decoded as a BigInt.
 *
 *   Defaults to "safe" if not included.
 * @returns The integer that was encoded in the input data. The return type will
 *   be determined by the parameter decodingMode.
 */
export function decodeUint64(data: Uint8Array, decodingMode: 'safe'): number;
export function decodeUint64(data: Uint8Array, decodingMode: 'mixed'): number | bigint;
export function decodeUint64(data: Uint8Array, decodingMode: 'bigint'): bigint;
export function decodeUint64(data: Uint8Array): number;
export function decodeUint64(data: any, decodingMode: any = 'safe') {
  if (decodingMode !== 'safe' && decodingMode !== 'mixed' && decodingMode !== 'bigint') {
    throw new Error(`Unknown decodingMode option: ${decodingMode}`);
  }

  if (data.byteLength === 0 || data.byteLength > 8) {
    throw new Error(`Data has unacceptable length. Expected length is between 1 and 8, got ${data.byteLength}`);
  }

  // insert 0s at the beginning if data is smaller than 8 bytes
  const padding = new Uint8Array(8 - data.byteLength);
  const encoding = AlgorandEncoder.ConcatArrays(padding, data);
  const view = new DataView(encoding.buffer);

  const num = view.getBigUint64(0);
  const isBig = num > BigInt(Number.MAX_SAFE_INTEGER);

  if (decodingMode === 'safe') {
    if (isBig) {
      throw new Error(
        `Integer exceeds maximum safe integer: ${num.toString()}. Try decoding with "mixed" or "safe" decodingMode.`,
      );
    }
    return Number(num);
  }

  if (decodingMode === 'mixed' && !isBig) {
    return Number(num);
  }

  return num;
}

export function encodeString(value: boolean | number | bigint | string | Uint8Array) {
  if (typeof value !== 'string' && !(value instanceof Uint8Array)) {
    throw new Error(`Cannot encode value as string: ${value}`);
  }
  let encodedBytes: Uint8Array;
  if (typeof value === 'string') {
    encodedBytes = new TextEncoder().encode(value);
  } else {
    encodedBytes = value;
  }
  const encodedLength = bigIntToBytes(encodedBytes.length, LENGTH_ENCODE_BYTE_SIZE);
  const mergedBytes = new Uint8Array(encodedBytes.length + LENGTH_ENCODE_BYTE_SIZE);
  mergedBytes.set(encodedLength);
  mergedBytes.set(encodedBytes, LENGTH_ENCODE_BYTE_SIZE);
  return mergedBytes;
}

export function decodeString(byteString: Uint8Array): string {
  if (byteString.length < LENGTH_ENCODE_BYTE_SIZE) {
    throw new Error(
      `byte string is too short to be decoded. Actual length is ${byteString.length}, but expected at least ${LENGTH_ENCODE_BYTE_SIZE}`,
    );
  }
  const view = new DataView(byteString.buffer, byteString.byteOffset, LENGTH_ENCODE_BYTE_SIZE);
  const byteLength = view.getUint16(0);
  const byteValue = byteString.slice(LENGTH_ENCODE_BYTE_SIZE, byteString.length);
  if (byteLength !== byteValue.length) {
    throw new Error(
      `string length bytes do not match the actual length of string. Expected ${byteLength}, got ${byteValue.length}`,
    );
  }
  return new TextDecoder('utf-8').decode(byteValue);
}

/**
 * bigIntToBytes converts a BigInt to a big-endian Uint8Array for encoding.
 * @param bi - The bigint to convert.
 * @param size - The size of the resulting byte array.
 * @returns A byte array containing the big-endian encoding of the input bigint
 */
export function bigIntToBytes(bi: bigint | number, size: number) {
  let hex = bi.toString(16);
  // Pad the hex with zeros so it matches the size in bytes
  if (hex.length !== size * 2) {
    hex = hex.padStart(size * 2, '0');
  }
  const byteArray = new Uint8Array(hex.length / 2);
  for (let i = 0, j = 0; i < hex.length / 2; i++, j += 2) {
    byteArray[i] = parseInt(hex.slice(j, j + 2), 16);
  }
  return byteArray;
}

/**
 * bytesToBigInt produces a bigint from a binary representation.
 *
 * @param bytes - The Uint8Array to convert.
 * @returns The bigint that was encoded in the input data.
 */
export function bytesToBigInt(bytes: Uint8Array) {
  let res = BigInt(0);
  const buf = new DataView(bytes.buffer, bytes.byteOffset);
  for (let i = 0; i < bytes.length; i++) {
    res = BigInt(Number(buf.getUint8(i))) + res * BigInt(256);
  }
  return res;
}
