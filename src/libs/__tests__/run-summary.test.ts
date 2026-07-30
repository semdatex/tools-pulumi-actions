import { ResourceChange } from '../changes';
import { ErrorLogEntry } from '../error-log';
import {
  renderErrorLogSummary,
  renderResourceChangesSummary,
  writeRunSummary,
} from '../run-summary';

function change(op: string, name: string): ResourceChange {
  return {
    op,
    urn: `urn:pulumi:dev::proj::pkg:m:T::${name}`,
    type: 'pkg:m:T',
  };
}

describe('renderResourceChangesSummary', () => {
  it('renders the empty case', () => {
    expect(renderResourceChangesSummary([], 'up')).toEqual(
      '### Resource changes\n\nNo resource changes.',
    );
  });

  it('uses the planned heading for previews', () => {
    expect(renderResourceChangesSummary([], 'preview')).toContain(
      '### Planned resource changes',
    );
  });

  it('renders per-op counts and a table row per step', () => {
    const rendered = renderResourceChangesSummary(
      [change('create', 'a'), change('create', 'b'), change('update', 'c')],
      'up',
    );
    expect(rendered).toContain('2 create, 1 update');
    expect(rendered).toContain('<details><summary>3 step(s)</summary>');
    expect(rendered).toContain(
      '| create | `pkg:m:T` | `urn:pulumi:dev::proj::pkg:m:T::a` |',
    );
    expect(rendered).not.toContain('more; see the log');
  });

  it('caps the table and says how many rows it dropped', () => {
    const many = Array.from({ length: 137 }, (_, i) =>
      change('create', `r${i}`),
    );
    const rendered = renderResourceChangesSummary(many, 'up');
    expect(rendered).toContain('137 create');
    expect(rendered).toContain('_and 37 more; see the log._');
    expect(rendered.match(/^\| create /gm)).toHaveLength(100);
  });
});

describe('renderErrorLogSummary', () => {
  it('returns nothing for an empty log', () => {
    expect(renderErrorLogSummary([])).toBeUndefined();
  });

  it('renders diagnostics with and without a urn, first line only, markdown escaped', () => {
    const entries: ErrorLogEntry[] = [
      {
        kind: 'diagnostic',
        urn: 'urn:pulumi:dev::proj::t::guarded',
        message: 'cannot be deleted\nbecause it is protected.',
      },
      { kind: 'diagnostic', message: 'a | b\nsecond line' },
      { kind: 'diagnostic', message: 'path C:\\temp\\x failed' },
    ];
    const rendered = renderErrorLogSummary(entries);
    expect(rendered).toContain('### Errors');
    expect(rendered).toContain(
      '- `urn:pulumi:dev::proj::t::guarded` — cannot be deleted',
    );
    expect(rendered).not.toContain('because it is protected');
    expect(rendered).toContain('- a \\| b');
    // Backslashes are escaped before pipes, so pre-existing ones render
    // literally instead of combining with the escaping.
    expect(rendered).toContain('- path C:\\\\temp\\\\x failed');
  });

  it('renders failed steps', () => {
    const rendered = renderErrorLogSummary([
      {
        kind: 'op-failed',
        op: 'create',
        urn: 'urn:pulumi:dev::proj::t::x',
        type: 't',
      },
    ]);
    expect(rendered).toContain('- create `t` `urn:pulumi:dev::proj::t::x` failed');
  });

  it('caps the list and says how many entries it dropped', () => {
    const entries: ErrorLogEntry[] = Array.from({ length: 105 }, (_, i) => ({
      kind: 'diagnostic',
      message: `error ${i}`,
    }));
    expect(renderErrorLogSummary(entries)).toContain(
      '_and 5 more; see the log._',
    );
  });
});

describe('writeRunSummary', () => {
  it('never throws, even on malformed payloads', async () => {
    await expect(
      writeRunSummary({ changes: { json: 'not json', command: 'up' } }),
    ).resolves.toBeUndefined();
  });
});
