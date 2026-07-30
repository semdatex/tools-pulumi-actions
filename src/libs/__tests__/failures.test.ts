import { EngineEvent } from '@pulumi/pulumi/automation';
import { createFailureCollector } from '../failures';

function diagEvent(
  severity: string,
  message: string,
  urn?: string,
): EngineEvent {
  return {
    sequence: 0,
    timestamp: 0,
    diagnosticEvent: { severity, message, urn, color: '' },
  } as unknown as EngineEvent;
}

function opFailedEvent(op: string, urn: string, type: string): EngineEvent {
  return {
    sequence: 0,
    timestamp: 0,
    resOpFailedEvent: {
      metadata: { op, urn, type, keys: [], diffs: [] },
      status: 0,
      steps: 1,
    },
  } as unknown as EngineEvent;
}

const guardedUrn = 'urn:pulumi:dev::proj::pulumi-nodejs:dynamic:Resource::guarded';

describe('createFailureCollector', () => {
  it('records an error diagnostic verbatim with its structured urn', () => {
    const collector = createFailureCollector();
    // Shape observed from a real engine run: a protection refusal carrying
    // the urn both structured and inside the message. The collector must
    // transport it, not interpret it.
    const message = `Preview failed: resource "${guardedUrn}" cannot be deleted\nbecause it is protected.`;
    collector.onEvent(diagEvent('error', message, guardedUrn));
    expect(JSON.parse(collector.toJson())).toEqual([
      { kind: 'diagnostic', urn: guardedUrn, message },
    ]);
  });

  it('does not parse a urn out of the message text', () => {
    const collector = createFailureCollector();
    const message = `error: resource "${guardedUrn}" is protected and can't be deleted`;
    collector.onEvent(diagEvent('error', message));
    const failures = JSON.parse(collector.toJson());
    expect(failures).toEqual([{ kind: 'diagnostic', message }]);
    expect(failures[0].urn).toBeUndefined();
  });

  it('keeps urn-less diagnostics, including the engine closing summary', () => {
    const collector = createFailureCollector();
    // Shapes observed from real engine runs: the bare trailer restating that
    // the command failed. Filtering it would be message interpretation, which
    // is the consumer's job — the collector keeps it.
    collector.onEvent(diagEvent('error', 'preview failed\n'));
    collector.onEvent(
      diagEvent(
        'error',
        "Running program '/work/index.js' failed with an unhandled exception:\nError: kaboom",
      ),
    );
    expect(JSON.parse(collector.toJson())).toEqual([
      { kind: 'diagnostic', message: 'preview failed\n' },
      {
        kind: 'diagnostic',
        message:
          "Running program '/work/index.js' failed with an unhandled exception:\nError: kaboom",
      },
    ]);
  });

  it('ignores non-error severities', () => {
    const collector = createFailureCollector();
    collector.onEvent(diagEvent('info', 'hello'));
    collector.onEvent(diagEvent('info#err', 'stderr chatter'));
    collector.onEvent(diagEvent('warning', 'something worrying'));
    expect(collector.toJson()).toEqual('[]');
  });

  it('records failed steps with their runtime metadata', () => {
    const collector = createFailureCollector();
    collector.onEvent(
      opFailedEvent(
        'create',
        'urn:pulumi:dev::proj::aws:s3/bucket:Bucket::b',
        'aws:s3/bucket:Bucket',
      ),
    );
    expect(JSON.parse(collector.toJson())).toEqual([
      {
        kind: 'op-failed',
        op: 'create',
        urn: 'urn:pulumi:dev::proj::aws:s3/bucket:Bucket::b',
        type: 'aws:s3/bucket:Bucket',
      },
    ]);
  });

  it('preserves event order across mixed failure kinds', () => {
    const collector = createFailureCollector();
    collector.onEvent(
      opFailedEvent('update', 'urn:pulumi:dev::proj::t::x', 't'),
    );
    collector.onEvent(diagEvent('error', 'boom', guardedUrn));
    expect(
      JSON.parse(collector.toJson()).map((f: { kind: string }) => f.kind),
    ).toEqual(['op-failed', 'diagnostic']);
  });

  it('truncates oversized messages', () => {
    const collector = createFailureCollector();
    collector.onEvent(diagEvent('error', 'x'.repeat(5000)));
    const failures = JSON.parse(collector.toJson());
    expect(failures[0].message).toHaveLength(2001);
    expect(failures[0].message.endsWith('…')).toBe(true);
  });

  it('reports an empty array when nothing failed', () => {
    const collector = createFailureCollector();
    expect(collector.toJson()).toEqual('[]');
  });
});
