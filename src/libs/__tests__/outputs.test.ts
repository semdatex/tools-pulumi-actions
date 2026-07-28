import { jest } from '@jest/globals';

// publishStackOutputs talks to @actions/core; ESM namespaces can't be spied
// on, so mock the module and record every call in one shared list — the
// relative order of setOutput and setSecret is part of the contract.
const calls: Array<{ fn: string; args: unknown[] }> = [];
const setOutput = jest.fn((...args: unknown[]) => {
  calls.push({ fn: 'setOutput', args });
});
const setSecret = jest.fn((...args: unknown[]) => {
  calls.push({ fn: 'setSecret', args });
});
const debug = jest.fn();
jest.unstable_mockModule('@actions/core', () => ({
  setOutput,
  setSecret,
  debug,
}));

// fetchOutputsWithoutDecrypting shells out through pulumi-cli; mock it so the
// exact argv — most importantly the absence of --show-secrets — is assertable.
const run = jest.fn<() => Promise<{ success: boolean; stdout: string; stderr: string }>>();
jest.unstable_mockModule('../pulumi-cli', () => ({ run }));

const { publishStackOutputs, buildStackOutputsJson, fetchOutputsWithoutDecrypting } =
  await import('../outputs');

beforeEach(() => {
  calls.length = 0;
  setOutput.mockClear();
  setSecret.mockClear();
  debug.mockClear();
  run.mockReset();
});

describe('publishStackOutputs', () => {
  it('does nothing for an empty output map', () => {
    publishStackOutputs({});
    expect(setOutput).not.toHaveBeenCalled();
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('sets a plain output without registering a mask', () => {
    publishStackOutputs({ name: { value: 'fluffy-mole', secret: false } });
    expect(setOutput).toHaveBeenCalledTimes(1);
    expect(setOutput).toHaveBeenCalledWith('name', 'fluffy-mole');
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('sets a secret output and masks the exact value', () => {
    publishStackOutputs({ password: { value: 'hunter22', secret: true } });
    expect(setOutput).toHaveBeenCalledWith('password', 'hunter22');
    expect(setSecret).toHaveBeenCalledWith('hunter22');
  });

  it('registers every mask before the first output is written', () => {
    publishStackOutputs({
      first: { value: 'one', secret: false },
      second: { value: 'password-two', secret: true },
      third: { value: 'password-three', secret: true },
    });
    const firstSetOutput = calls.findIndex((c) => c.fn === 'setOutput');
    const lastSetSecret = calls.map((c) => c.fn).lastIndexOf('setSecret');
    expect(lastSetSecret).toBeGreaterThanOrEqual(0);
    expect(lastSetSecret).toBeLessThan(firstSetOutput);
  });

  it('passes structured values through without serializing them', () => {
    const connection = { host: 'db.example.com', port: 5432 };
    publishStackOutputs({ connection: { value: connection, secret: false } });
    expect(setOutput).toHaveBeenCalledWith('connection', connection);
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('writes identical outputs regardless of masking mode', () => {
    const outputs = {
      credentials: {
        value: { user: 'admin', password: 'hunter22' },
        secret: true,
      },
      plain: { value: 'hello', secret: false },
    };
    publishStackOutputs(outputs, { secretMasking: 'nested' });
    const nestedOutputCalls = setOutput.mock.calls.slice();
    setOutput.mockClear();
    publishStackOutputs(outputs, { secretMasking: 'exact' });
    expect(setOutput.mock.calls).toEqual(nestedOutputCalls);
  });

  describe('nested masking (default)', () => {
    it('masks the raw value and every string leaf of a structured secret', () => {
      const credentials = { user: 'admin', password: 'hunter22' };
      publishStackOutputs({
        credentials: { value: credentials, secret: true },
      });
      expect(setSecret).toHaveBeenCalledWith(credentials);
      expect(setSecret).toHaveBeenCalledWith('admin');
      expect(setSecret).toHaveBeenCalledWith('hunter22');
      expect(setOutput).toHaveBeenCalledWith('credentials', credentials);
    });

    it('recurses into arrays and nested objects', () => {
      const value = {
        tokens: ['token-one', 'token-two'],
        nested: { inner: { key: 'deep-secret' } },
      };
      publishStackOutputs({ blob: { value, secret: true } });
      expect(setSecret).toHaveBeenCalledWith('token-one');
      expect(setSecret).toHaveBeenCalledWith('token-two');
      expect(setSecret).toHaveBeenCalledWith('deep-secret');
    });

    it('masks number leaves via their string form', () => {
      publishStackOutputs({
        creds: { value: { pin: 246824 }, secret: true },
      });
      expect(setSecret).toHaveBeenCalledWith({ pin: 246824 });
      expect(setSecret).toHaveBeenCalledWith('246824');
    });

    it('skips boolean leaves instead of masking "true"/"false"', () => {
      publishStackOutputs({
        creds: {
          value: { enabled: true, password: 'hunter22' },
          secret: true,
        },
      });
      expect(setSecret).not.toHaveBeenCalledWith(true);
      expect(setSecret).not.toHaveBeenCalledWith('true');
      expect(setSecret).toHaveBeenCalledWith('hunter22');
      expect(debug).toHaveBeenCalledWith('not masking a boolean secret leaf');
    });

    it('skips leaves shorter than four characters', () => {
      publishStackOutputs({
        creds: {
          value: { region: 'us', password: 'hunter22' },
          secret: true,
        },
      });
      expect(setSecret).not.toHaveBeenCalledWith('us');
      expect(setSecret).toHaveBeenCalledWith('hunter22');
    });

    it('masks each line of a multiline string secret individually', () => {
      const pem = 'first-line-of-key\nsecond-line-of-key';
      publishStackOutputs({ key: { value: pem, secret: true } });
      expect(setSecret).toHaveBeenCalledWith(pem);
      expect(setSecret).toHaveBeenCalledWith('first-line-of-key');
      expect(setSecret).toHaveBeenCalledWith('second-line-of-key');
    });

    it('does not duplicate the mask for a single-line string secret', () => {
      publishStackOutputs({ password: { value: 'hunter22', secret: true } });
      expect(setSecret).toHaveBeenCalledTimes(1);
    });
  });

  describe('exact masking (upstream behavior)', () => {
    it('masks only the raw value of a structured secret', () => {
      const credentials = { user: 'admin', password: 'hunter22' };
      publishStackOutputs(
        { credentials: { value: credentials, secret: true } },
        { secretMasking: 'exact' },
      );
      expect(setSecret).toHaveBeenCalledTimes(1);
      expect(setSecret).toHaveBeenCalledWith(credentials);
    });

    it('masks a numeric secret with the raw value', () => {
      publishStackOutputs(
        { pin: { value: 2468, secret: true } },
        { secretMasking: 'exact' },
      );
      expect(setOutput).toHaveBeenCalledWith('pin', 2468);
      expect(setSecret).toHaveBeenCalledWith(2468);
    });
  });

  describe('suppressSecretOutputs', () => {
    it('skips per-key outputs for secret entries only', () => {
      publishStackOutputs(
        {
          plain: { value: 'hello', secret: false },
          password: { value: 'hunter22', secret: true },
        },
        { suppressSecretOutputs: true },
      );
      expect(setOutput).toHaveBeenCalledTimes(1);
      expect(setOutput).toHaveBeenCalledWith('plain', 'hello');
    });

    it('still registers masks for suppressed secret values', () => {
      publishStackOutputs(
        { password: { value: 'hunter22', secret: true } },
        { suppressSecretOutputs: true },
      );
      expect(setSecret).toHaveBeenCalledWith('hunter22');
    });

    it('does not mask value-less secret entries from the no-decrypt path', () => {
      publishStackOutputs(
        { password: { value: undefined, secret: true } },
        { suppressSecretOutputs: true },
      );
      expect(setSecret).not.toHaveBeenCalled();
      expect(setOutput).not.toHaveBeenCalled();
    });
  });
});

describe('buildStackOutputsJson', () => {
  it('lists secret entries without their value in exclude mode', () => {
    const json = buildStackOutputsJson(
      {
        plain: { value: 'hello', secret: false },
        password: { value: 'hunter22', secret: true },
      },
      'exclude',
    );
    expect(JSON.parse(json)).toEqual({
      plain: { value: 'hello', secret: false },
      password: { secret: true },
    });
    expect(json).not.toContain('hunter22');
  });

  it('includes decrypted secret values in plaintext mode', () => {
    const json = buildStackOutputsJson(
      { password: { value: 'hunter22', secret: true } },
      'plaintext',
    );
    expect(JSON.parse(json)).toEqual({
      password: { value: 'hunter22', secret: true },
    });
  });

  it('keeps structured non-secret values intact', () => {
    const connection = { host: 'db.example.com', port: 5432 };
    const json = buildStackOutputsJson(
      { connection: { value: connection, secret: false } },
      'exclude',
    );
    expect(JSON.parse(json).connection.value).toEqual(connection);
  });

  it('serializes an empty map to an empty object', () => {
    expect(buildStackOutputsJson({}, 'exclude')).toEqual('{}');
  });
});

describe('fetchOutputsWithoutDecrypting', () => {
  it('never passes --show-secrets and maps [secret] markers to value-less entries', async () => {
    run.mockResolvedValue({
      success: true,
      stdout: '{"plain":"hello","password":"[secret]"}',
      stderr: '',
    });
    const outputs = await fetchOutputsWithoutDecrypting('/work', 'org/proj/stack');
    // The load-bearing assertion: the argv must not decrypt.
    expect(run).toHaveBeenCalledWith(
      '--non-interactive',
      '--cwd',
      '/work',
      'stack',
      'output',
      '--json',
      '--stack',
      'org/proj/stack',
    );
    expect(run.mock.calls[0]).not.toContain('--show-secrets');
    expect(outputs).toEqual({
      plain: { value: 'hello', secret: false },
      password: { value: undefined, secret: true },
    });
  });

  it('returns an empty map for a stack without outputs', async () => {
    run.mockResolvedValue({ success: true, stdout: '{}', stderr: '' });
    await expect(
      fetchOutputsWithoutDecrypting('/work', 'org/proj/stack'),
    ).resolves.toEqual({});
  });

  it('throws with the CLI error when the command fails', async () => {
    run.mockResolvedValue({
      success: false,
      stdout: '',
      stderr: 'error: no stack named bogus found',
    });
    await expect(
      fetchOutputsWithoutDecrypting('/work', 'org/proj/bogus'),
    ).rejects.toThrow(/no stack named bogus found/);
  });
});
