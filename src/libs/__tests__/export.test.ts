import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { jest } from '@jest/globals';

const run = jest.fn<() => Promise<{ success: boolean; stdout: string; stderr: string }>>();
jest.unstable_mockModule('../pulumi-cli', () => ({ run }));

const { exportStackState } = await import('../export');

function tempDir(): string {
  return fs.mkdtempSync(join(os.tmpdir(), 'export-test-'));
}

beforeEach(() => {
  run.mockReset();
});

describe('exportStackState', () => {
  it('never passes --show-secrets and writes the export verbatim', async () => {
    const state =
      '{"version":3,"deployment":{"resources":[{"type":"pulumi:pulumi:Stack","outputs":{"secretValue":{"4dabf18193072939515e22adb298388d":"1b47061264138c4ac30d75fd1eb44270","ciphertext":"v1:abc"}}}]}}';
    run.mockResolvedValue({ success: true, stdout: state, stderr: '' });
    const path = join(tempDir(), 'state.json');

    await exportStackState('/work', 'org/proj/stack', path);

    // The load-bearing assertion: the argv must keep secrets encrypted.
    expect(run).toHaveBeenCalledWith(
      '--non-interactive',
      '--cwd',
      '/work',
      'stack',
      'export',
      '--stack',
      'org/proj/stack',
    );
    expect(run.mock.calls[0]).not.toContain('--show-secrets');
    expect(fs.readFileSync(path, 'utf-8')).toEqual(state);
  });

  it('creates missing parent directories', async () => {
    run.mockResolvedValue({ success: true, stdout: '{}', stderr: '' });
    const path = join(tempDir(), 'deeply', 'nested', 'state.json');
    await exportStackState('/work', 'org/proj/stack', path);
    expect(fs.existsSync(path)).toBe(true);
  });

  it('throws with the CLI error and writes nothing when the export fails', async () => {
    run.mockResolvedValue({
      success: false,
      stdout: '',
      stderr: 'error: no stack named bogus found',
    });
    const path = join(tempDir(), 'state.json');
    await expect(
      exportStackState('/work', 'org/proj/bogus', path),
    ).rejects.toThrow(/no stack named bogus found/);
    expect(fs.existsSync(path)).toBe(false);
  });
});
