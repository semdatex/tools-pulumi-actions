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
  it('classifies a protection refusal with a structured urn', () => {
    const collector = createFailureCollector();
    // Shape observed from a real engine run: the refusal diagnostic carries
    // the urn both structured and inside the message.
    collector.onEvent(
      diagEvent(
        'error',
        `Preview failed: resource "${guardedUrn}" cannot be deleted\nbecause it is protected. To unprotect the resource, either remove the protect flag from the resource in your Pulumi program and run \`pulumi up\`, or use the command:\n\`pulumi state unprotect '${guardedUrn}'\``,
        guardedUrn,
      ),
    );
    const failures = JSON.parse(collector.toJson());
    expect(failures).toHaveLength(1);
    expect(failures[0].urn).toBe(guardedUrn);
    expect(failures[0].protected).toBe(true);
  });

  it('derives the urn from the message when not structured', () => {
    const collector = createFailureCollector();
    collector.onEvent(
      diagEvent(
        'error',
        `error: resource "${guardedUrn}" is protected and can't be deleted`,
      ),
    );
    const failures = JSON.parse(collector.toJson());
    expect(failures).toEqual([
      {
        urn: guardedUrn,
        message: `error: resource "${guardedUrn}" is protected and can't be deleted`,
        protected: true,
      },
    ]);
  });

  it('keeps unrelated error diagnostics as non-protection failures', () => {
    const collector = createFailureCollector();
    collector.onEvent(
      diagEvent(
        'error',
        'error: failed to fetch bucket: timeout',
        'urn:pulumi:dev::proj::aws:s3/bucket:Bucket::b',
      ),
    );
    const failures = JSON.parse(collector.toJson());
    expect(failures).toHaveLength(1);
    expect(failures[0].protected).toBe(false);
  });

  it('keeps urn-less program errors as non-protection failures', () => {
    const collector = createFailureCollector();
    // Shape observed from a real engine run of a throwing program.
    collector.onEvent(
      diagEvent(
        'error',
        "Running program '/work/index.js' failed with an unhandled exception:\nError: kaboom from program",
      ),
    );
    const failures = JSON.parse(collector.toJson());
    expect(failures).toHaveLength(1);
    expect(failures[0].urn).toBeUndefined();
    expect(failures[0].protected).toBe(false);
  });

  it('suppresses the bare command trailer the engine emits on every failure', () => {
    const collector = createFailureCollector();
    // Shapes observed from real engine runs: a final urn-less summary
    // diagnostic restating that the command failed.
    collector.onEvent(diagEvent('error', 'preview failed\n'));
    collector.onEvent(diagEvent('error', 'update failed\n'));
    expect(collector.toJson()).toEqual('[]');
  });

  it('keeps a trailer-looking diagnostic when it carries a urn', () => {
    const collector = createFailureCollector();
    collector.onEvent(diagEvent('error', 'preview failed\n', guardedUrn));
    expect(JSON.parse(collector.toJson())).toHaveLength(1);
  });

  it('ignores non-error severities', () => {
    const collector = createFailureCollector();
    collector.onEvent(diagEvent('info', 'hello'));
    collector.onEvent(diagEvent('info#err', 'stderr chatter'));
    collector.onEvent(diagEvent('warning', 'something protected got deleted'));
    expect(collector.toJson()).toEqual('[]');
  });

  it('records failed steps as non-protection failures', () => {
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
        op: 'create',
        urn: 'urn:pulumi:dev::proj::aws:s3/bucket:Bucket::b',
        type: 'aws:s3/bucket:Bucket',
        protected: false,
      },
    ]);
  });

  it('preserves event order across mixed failure kinds', () => {
    const collector = createFailureCollector();
    collector.onEvent(
      opFailedEvent('update', 'urn:pulumi:dev::proj::t::x', 't'),
    );
    collector.onEvent(
      diagEvent('error', `${guardedUrn} cannot be deleted because it is protected.`),
    );
    const failures = JSON.parse(collector.toJson());
    expect(failures.map((f: { protected: boolean }) => f.protected)).toEqual([
      false,
      true,
    ]);
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
