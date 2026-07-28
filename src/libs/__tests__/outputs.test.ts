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
jest.unstable_mockModule('@actions/core', () => ({ setOutput, setSecret }));

const { publishStackOutputs } = await import('../outputs');

describe('publishStackOutputs', () => {
  beforeEach(() => {
    calls.length = 0;
    setOutput.mockClear();
    setSecret.mockClear();
  });

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
    publishStackOutputs({ password: { value: 'hunter2', secret: true } });
    expect(setOutput).toHaveBeenCalledWith('password', 'hunter2');
    expect(setSecret).toHaveBeenCalledWith('hunter2');
  });

  it('registers the mask only after the output is set', () => {
    // Baseline of the current behavior: per entry, the value is written to
    // GITHUB_OUTPUT first and the mask is registered second.
    publishStackOutputs({ password: { value: 'hunter2', secret: true } });
    expect(calls.map((c) => c.fn)).toEqual(['setOutput', 'setSecret']);
  });

  it('passes structured values through without serializing them', () => {
    const connection = { host: 'db.example.com', port: 5432 };
    publishStackOutputs({ connection: { value: connection, secret: false } });
    expect(setOutput).toHaveBeenCalledWith('connection', connection);
    expect(setSecret).not.toHaveBeenCalled();
  });

  it('masks a structured secret with the raw value, not per leaf', () => {
    // Baseline: a single setSecret with the object itself; the nested leaf
    // values are not registered individually.
    const credentials = { user: 'admin', password: 'hunter2' };
    publishStackOutputs({ credentials: { value: credentials, secret: true } });
    expect(setOutput).toHaveBeenCalledWith('credentials', credentials);
    expect(setSecret).toHaveBeenCalledTimes(1);
    expect(setSecret).toHaveBeenCalledWith(credentials);
  });

  it('masks a numeric secret with the raw value', () => {
    publishStackOutputs({ pin: { value: 2468, secret: true } });
    expect(setOutput).toHaveBeenCalledWith('pin', 2468);
    expect(setSecret).toHaveBeenCalledWith(2468);
  });

  it('publishes every entry of the map in order', () => {
    publishStackOutputs({
      first: { value: 'one', secret: false },
      second: { value: 'two', secret: true },
      third: { value: 'three', secret: false },
    });
    expect(calls).toEqual([
      { fn: 'setOutput', args: ['first', 'one'] },
      { fn: 'setOutput', args: ['second', 'two'] },
      { fn: 'setSecret', args: ['two'] },
      { fn: 'setOutput', args: ['third', 'three'] },
    ]);
  });
});
