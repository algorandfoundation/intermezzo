import { Logger as NestLogger } from '@nestjs/common';
import { LogLevel } from '@credo-ts/core';
import { CredoNestLogger, resolveCredoLogLevel } from './credo-nest-logger';

describe('resolveCredoLogLevel', () => {
  it.each([
    ['test', LogLevel.test],
    ['TRACE', LogLevel.trace],
    ['debug', LogLevel.debug],
    ['Info', LogLevel.info],
    ['warn', LogLevel.warn],
    ['error', LogLevel.error],
    ['fatal', LogLevel.fatal],
    ['off', LogLevel.off],
  ])('parses %p as %p', (value, expected) => {
    expect(resolveCredoLogLevel(value)).toBe(expected);
  });

  it('defaults to debug when unset', () => {
    expect(resolveCredoLogLevel(undefined)).toBe(LogLevel.debug);
  });

  it('defaults to info on unknown values', () => {
    expect(resolveCredoLogLevel('shout')).toBe(LogLevel.info);
  });
});

describe('CredoNestLogger', () => {
  let verbose: jest.SpyInstance;
  let debug: jest.SpyInstance;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    verbose = jest.spyOn(NestLogger.prototype, 'verbose').mockImplementation(() => undefined);
    debug = jest.spyOn(NestLogger.prototype, 'debug').mockImplementation(() => undefined);
    log = jest.spyOn(NestLogger.prototype, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(NestLogger.prototype, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(NestLogger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('routes Credo levels to the matching Nest methods at the lowest level', () => {
    const l = new CredoNestLogger(LogLevel.test);
    l.test('t');
    l.trace('r');
    l.debug('d');
    l.info('i');
    l.warn('w');
    l.error('e');
    l.fatal('f');
    expect(verbose).toHaveBeenCalledWith('t');
    expect(verbose).toHaveBeenCalledWith('r');
    expect(debug).toHaveBeenCalledWith('d');
    expect(log).toHaveBeenCalledWith('i');
    expect(warn).toHaveBeenCalledWith('w');
    expect(error).toHaveBeenCalledWith('e');
    expect(error).toHaveBeenCalledWith('f');
  });

  it('drops messages below the configured level', () => {
    const l = new CredoNestLogger(LogLevel.warn);
    l.debug('skip');
    l.info('skip');
    l.warn('keep');
    expect(debug).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('keep');
  });

  it('serialises structured data and tolerates circular references', () => {
    const l = new CredoNestLogger(LogLevel.debug);
    const data: Record<string, unknown> = { a: 1 };
    (data as { self?: unknown }).self = data;
    l.debug('msg', data);
    expect(debug).toHaveBeenCalledTimes(1);
    const arg = debug.mock.calls[0][0] as string;
    expect(arg.startsWith('msg ')).toBe(true);
    expect(arg).toContain('"a":1');
    expect(arg).toContain('"self":"[Circular]"');
  });
});
