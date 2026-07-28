import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { EngineEvent } from '@pulumi/pulumi/automation';
import { createEventLogWriter } from '../events';

function tempDir(): string {
  return fs.mkdtempSync(join(os.tmpdir(), 'events-test-'));
}

function readLines(path: string): string[] {
  return fs.readFileSync(path, 'utf-8').split('\n').filter(Boolean);
}

describe('createEventLogWriter', () => {
  it('writes one parseable JSON line per event', async () => {
    const path = join(tempDir(), 'events.jsonl');
    const writer = createEventLogWriter(path);
    writer.onEvent({ sequence: 1, timestamp: 100 } as EngineEvent);
    writer.onEvent({
      sequence: 2,
      timestamp: 101,
      summaryEvent: { maybeCorrupt: false, durationSeconds: 1, resourceChanges: { same: 1 } },
    } as EngineEvent);
    await writer.close();

    const lines = readLines(path).map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].sequence).toBe(1);
    expect(lines[1].summaryEvent.resourceChanges).toEqual({ same: 1 });
  });

  it('creates missing parent directories', async () => {
    const path = join(tempDir(), 'deeply', 'nested', 'events.jsonl');
    const writer = createEventLogWriter(path);
    writer.onEvent({ sequence: 1, timestamp: 100 } as EngineEvent);
    await writer.close();
    expect(fs.existsSync(path)).toBe(true);
  });

  it('keeps events written before a failure on disk', async () => {
    // Simulates the command throwing after some events were delivered: the
    // writer is closed from a finally block and everything already written
    // must be parseable.
    const path = join(tempDir(), 'events.jsonl');
    const writer = createEventLogWriter(path);
    writer.onEvent({ sequence: 1, timestamp: 100 } as EngineEvent);
    writer.onEvent({ sequence: 2, timestamp: 101 } as EngineEvent);
    try {
      throw new Error('command failed');
    } catch {
      await writer.close();
    }
    expect(readLines(path).map((line) => JSON.parse(line))).toHaveLength(2);
  });

  it('produces an empty file when no events arrive', async () => {
    const path = join(tempDir(), 'events.jsonl');
    const writer = createEventLogWriter(path);
    await writer.close();
    expect(fs.existsSync(path)).toBe(true);
    expect(readLines(path)).toHaveLength(0);
  });
});
