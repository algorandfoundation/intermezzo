import { Logger as NestLogger } from '@nestjs/common';
import { BaseLogger, LogLevel } from '@credo-ts/core';

/**
 * Bridges Credo's internal logger to Nest's `Logger`, so OID4VC/Credo
 * diagnostics flow through the same stream (and log shipper, in production)
 * as the rest of the service.
 *
 * The OID4VCI/OID4VP HTTP routers are mounted as raw Express routers (see
 * `main.ts`), so Nest's global interceptor / exception filter never see
 * those requests — without this bridge a 500 inside Credo is silent on the
 * server side.
 *
 * Mapping (Credo → Nest):
 *   test, trace → verbose
 *   debug       → debug
 *   info        → log
 *   warn        → warn
 *   error       → error
 *   fatal       → error
 */
export class CredoNestLogger extends BaseLogger {
  private readonly nest: NestLogger;

  constructor(logLevel: LogLevel = LogLevel.info, context = 'CredoAgent') {
    super(logLevel);
    this.nest = new NestLogger(context);
  }

  test(message: string, data?: Record<string, unknown>): void {
    if (!this.isEnabled(LogLevel.test)) return;
    this.nest.verbose(this.format(message, data));
  }

  trace(message: string, data?: Record<string, unknown>): void {
    if (!this.isEnabled(LogLevel.trace)) return;
    this.nest.verbose(this.format(message, data));
  }

  debug(message: string, data?: Record<string, unknown>): void {
    if (!this.isEnabled(LogLevel.debug)) return;
    this.nest.debug(this.format(message, data));
  }

  info(message: string, data?: Record<string, unknown>): void {
    if (!this.isEnabled(LogLevel.info)) return;
    this.nest.log(this.format(message, data));
  }

  warn(message: string, data?: Record<string, unknown>): void {
    if (!this.isEnabled(LogLevel.warn)) return;
    this.nest.warn(this.format(message, data));
  }

  error(message: string, data?: Record<string, unknown>): void {
    if (!this.isEnabled(LogLevel.error)) return;
    this.nest.error(this.format(message, data));
  }

  fatal(message: string, data?: Record<string, unknown>): void {
    if (!this.isEnabled(LogLevel.fatal)) return;
    this.nest.error(this.format(message, data));
  }

  private format(message: string, data?: Record<string, unknown>): string {
    if (!data) return message;
    try {
      return `${message} ${JSON.stringify(data, replaceCircular())}`;
    } catch {
      return `${message} [unserialisable data]`;
    }
  }
}

/**
 * Resolve a {@link LogLevel} from the `CREDO_LOG_LEVEL` env var. Accepts
 * any of the Credo level names (case-insensitive); falls back to `info`
 * for unknown values and `debug` when unset (chatty enough to surface
 * the silent-500 cases without being trace-level noisy in normal runs).
 */
export function resolveCredoLogLevel(value: string | undefined): LogLevel {
  const v = (value ?? 'debug').trim().toLowerCase();
  switch (v) {
    case 'test':
      return LogLevel.test;
    case 'trace':
      return LogLevel.trace;
    case 'debug':
      return LogLevel.debug;
    case 'info':
      return LogLevel.info;
    case 'warn':
      return LogLevel.warn;
    case 'error':
      return LogLevel.error;
    case 'fatal':
      return LogLevel.fatal;
    case 'off':
      return LogLevel.off;
    default:
      return LogLevel.info;
  }
}

function replaceCircular() {
  const seen = new WeakSet<object>();
  return (_key: string, value: unknown) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value as object)) return '[Circular]';
      seen.add(value as object);
    }
    return value;
  };
}
