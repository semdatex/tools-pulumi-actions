import * as fs from 'fs';
import { dirname } from 'path';
import { EngineEvent } from '@pulumi/pulumi/automation';

export interface EventLogWriter {
  readonly onEvent: (event: EngineEvent) => void;
  readonly close: () => Promise<void>;
}

/**
 * Streams engine events to a file as JSON lines — one `EngineEvent` per
 * line. The contract is "EngineEvent JSON per line", not the CLI's own
 * `--event-log` byte format (field presence can differ subtly between the
 * gRPC and file-tail delivery paths of the Automation API).
 *
 * Events are written incrementally, so everything emitted before a command
 * failure survives on disk; close() flushes and resolves once the file is
 * complete.
 */
export function createEventLogWriter(path: string): EventLogWriter {
  fs.mkdirSync(dirname(path), { recursive: true });
  const stream = fs.createWriteStream(path, { flags: 'w', encoding: 'utf-8' });
  return {
    onEvent: (event) => {
      stream.write(`${JSON.stringify(event)}\n`);
    },
    close: () =>
      new Promise((resolvePromise, rejectPromise) => {
        stream.on('error', rejectPromise);
        stream.end(() => resolvePromise());
      }),
  };
}
