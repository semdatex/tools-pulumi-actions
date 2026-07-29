import { EngineEvent } from '@pulumi/pulumi/automation';

export interface ResourceChange {
  readonly op: string;
  readonly urn: string;
  readonly type: string;
}

export interface ChangeCollector {
  readonly onEvent: (event: EngineEvent) => void;
  readonly toJson: () => string;
}

/**
 * Collects resource-level changes from engine events, in memory. A change is
 * any step whose operation is not `same` (unchanged) or `read` (data-source
 * read): creates, updates, deletes, replacements, imports, refreshes.
 *
 * During an update both resourcePreEvent (step scheduled) and
 * resOutputsEvent (step done) fire for the same step; during a preview only
 * the pre event does. Steps are keyed by urn+op so each change is reported
 * once, in event order. resOpFailedEvent metadata is collected too, so a
 * failed command still reports the step it died on.
 */
export function createChangeCollector(): ChangeCollector {
  const changes = new Map<string, ResourceChange>();

  const onEvent = (event: EngineEvent): void => {
    const metadata =
      event.resourcePreEvent?.metadata ??
      event.resOutputsEvent?.metadata ??
      event.resOpFailedEvent?.metadata;
    if (!metadata || metadata.op === 'same' || metadata.op === 'read') {
      return;
    }
    changes.set(`${metadata.urn}|${metadata.op}`, {
      op: metadata.op,
      urn: metadata.urn,
      type: metadata.type,
    });
  };

  return { onEvent, toJson: () => JSON.stringify([...changes.values()]) };
}
