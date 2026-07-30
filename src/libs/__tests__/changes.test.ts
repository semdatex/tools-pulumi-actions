import { EngineEvent } from '@pulumi/pulumi/automation';
import { createChangeCollector } from '../changes';

function preEvent(op: string, urn: string, type: string): EngineEvent {
  return {
    sequence: 0,
    timestamp: 0,
    resourcePreEvent: {
      metadata: { op, urn, type, keys: [], diffs: [] },
    },
  } as unknown as EngineEvent;
}

function outputsEvent(op: string, urn: string, type: string): EngineEvent {
  return {
    sequence: 0,
    timestamp: 0,
    resOutputsEvent: {
      metadata: { op, urn, type, keys: [], diffs: [] },
    },
  } as unknown as EngineEvent;
}

describe('createChangeCollector', () => {
  it('records changed resources from pre events in order', () => {
    const collector = createChangeCollector();
    collector.onEvent(preEvent('create', 'urn:pulumi:dev::p::t::a', 't'));
    collector.onEvent(preEvent('update', 'urn:pulumi:dev::p::t::b', 't'));
    expect(JSON.parse(collector.toJson())).toEqual([
      { op: 'create', urn: 'urn:pulumi:dev::p::t::a', type: 't' },
      { op: 'update', urn: 'urn:pulumi:dev::p::t::b', type: 't' },
    ]);
  });

  it('filters unchanged and read steps', () => {
    const collector = createChangeCollector();
    collector.onEvent(preEvent('same', 'urn:pulumi:dev::p::t::a', 't'));
    collector.onEvent(preEvent('read', 'urn:pulumi:dev::p::t::b', 't'));
    expect(collector.toJson()).toEqual('[]');
  });

  it('reports a step once when both pre and outputs events fire', () => {
    const collector = createChangeCollector();
    collector.onEvent(preEvent('create', 'urn:pulumi:dev::p::t::a', 't'));
    collector.onEvent(outputsEvent('create', 'urn:pulumi:dev::p::t::a', 't'));
    expect(JSON.parse(collector.toJson())).toHaveLength(1);
  });

  it('records the failed step from a resOpFailedEvent', () => {
    const collector = createChangeCollector();
    collector.onEvent({
      sequence: 0,
      timestamp: 0,
      resOpFailedEvent: {
        metadata: {
          op: 'delete',
          urn: 'urn:pulumi:dev::p::t::a',
          type: 't',
          keys: [],
          diffs: [],
        },
      },
    } as unknown as EngineEvent);
    expect(JSON.parse(collector.toJson())).toEqual([
      { op: 'delete', urn: 'urn:pulumi:dev::p::t::a', type: 't' },
    ]);
  });

  it('ignores events without step metadata', () => {
    const collector = createChangeCollector();
    collector.onEvent({
      sequence: 0,
      timestamp: 0,
      summaryEvent: {},
    } as unknown as EngineEvent);
    expect(collector.toJson()).toEqual('[]');
  });

  it('includes unchanged and read steps when asked for the full account', () => {
    const collector = createChangeCollector({ includeUnchanged: true });
    collector.onEvent(preEvent('same', 'urn:pulumi:dev::p::t::a', 't'));
    collector.onEvent(preEvent('read', 'urn:pulumi:dev::p::t::b', 't'));
    collector.onEvent(preEvent('delete', 'urn:pulumi:dev::p::t::c', 't'));
    expect(JSON.parse(collector.toJson())).toEqual([
      { op: 'same', urn: 'urn:pulumi:dev::p::t::a', type: 't' },
      { op: 'read', urn: 'urn:pulumi:dev::p::t::b', type: 't' },
      { op: 'delete', urn: 'urn:pulumi:dev::p::t::c', type: 't' },
    ]);
  });

  it('still ignores metadata-less events in full-account mode', () => {
    const collector = createChangeCollector({ includeUnchanged: true });
    collector.onEvent({
      sequence: 0,
      timestamp: 0,
      summaryEvent: {},
    } as unknown as EngineEvent);
    expect(collector.toJson()).toEqual('[]');
  });
});
