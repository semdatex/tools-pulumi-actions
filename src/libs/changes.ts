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

export interface ChangeCollectorOptions {
  /**
   * Also collect `same` (unchanged) and `read` (data-source read) steps —
   * the full op-by-URN account of the run, not just its changes. Consumers
   * proving what a run did NOT touch (e.g. migration validation, where a
   * still-declared resource's `same` op is the proof it isn't leaving the
   * stack) need these; the default keeps the changes-only semantics.
   */
  readonly includeUnchanged?: boolean;
}

/**
 * Collects resource-level steps from engine events, in memory. By default a
 * step is reported when its operation is not `same` (unchanged) or `read`
 * (data-source read): creates, updates, deletes, replacements, imports,
 * refreshes. With `includeUnchanged`, every step is reported.
 *
 * During an update both resourcePreEvent (step scheduled) and
 * resOutputsEvent (step done) fire for the same step; during a preview only
 * the pre event does. Steps are keyed by urn+op so each change is reported
 * once, in event order. resOpFailedEvent metadata is collected too, so a
 * failed command still reports the step it died on.
 */
export function createChangeCollector(
  options: ChangeCollectorOptions = {},
): ChangeCollector {
  const changes = new Map<string, ResourceChange>();

  const onEvent = (event: EngineEvent): void => {
    const metadata =
      event.resourcePreEvent?.metadata ??
      event.resOutputsEvent?.metadata ??
      event.resOpFailedEvent?.metadata;
    if (!metadata) {
      return;
    }
    if (
      !options.includeUnchanged &&
      (metadata.op === 'same' || metadata.op === 'read')
    ) {
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
