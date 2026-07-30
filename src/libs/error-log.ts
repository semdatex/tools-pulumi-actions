import { EngineEvent } from '@pulumi/pulumi/automation';

/**
 * One error record, exactly as the engine reported it. `kind` mirrors which
 * engine event carried it — the only categorisation the runtime provides:
 *
 * - `diagnostic`: an error-severity diagnosticEvent. `urn` is set only when
 *   the engine provided it structurally; no value is ever parsed out of the
 *   message text.
 * - `op-failed`: a resOpFailedEvent — a scheduled resource step that failed.
 *
 * The action deliberately does NOT interpret messages. The engine attaches
 * no structured cause to a diagnostic (no error code, no category), so any
 * classification — "is this a protection refusal?", "is this the engine's
 * closing `preview failed` summary line?" — would be wording-dependent
 * heuristics baked into the action. That interpretation belongs to the
 * consumer, which knows what it is looking for and can evolve its patterns
 * without a new action release.
 */
export type ErrorLogEntry =
  | {
      readonly kind: 'diagnostic';
      readonly urn?: string;
      readonly message: string;
    }
  | {
      readonly kind: 'op-failed';
      readonly op: string;
      readonly urn: string;
      readonly type: string;
    };

export interface ErrorLogCollector {
  readonly onEvent: (event: EngineEvent) => void;
  readonly toJson: () => string;
}

/**
 * Diagnostic messages are kept verbatim up to this length — long enough for
 * any engine or provider error observed in practice, short enough that a
 * pathological provider error cannot balloon the step output.
 */
const MESSAGE_LIMIT = 2000;

/**
 * Collects the command's error log from engine events, in memory, as a
 * faithful structured transport: every error-severity diagnostic and every
 * failed step, in event order, shaped as {@link ErrorLogEntry}. Nothing is
 * classified and nothing is filtered beyond the error-severity selection —
 * including the engine's bare closing summary diagnostic (`preview failed` /
 * `update failed`, no URN), which consumers should filter out before cause
 * analysis.
 *
 * Note that some command failures emit no engine event at all
 * (`--expect-no-changes` fails via CLI stderr only), so an empty log on a
 * failed command means the cause was not visible in engine events.
 */
export function createErrorLogCollector(): ErrorLogCollector {
  const entries: ErrorLogEntry[] = [];

  const onEvent = (event: EngineEvent): void => {
    const failedStep = event.resOpFailedEvent?.metadata;
    if (failedStep) {
      entries.push({
        kind: 'op-failed',
        op: failedStep.op,
        urn: failedStep.urn,
        type: failedStep.type,
      });
      return;
    }

    const diag = event.diagnosticEvent;
    if (!diag || diag.severity !== 'error') {
      return;
    }
    const message = diag.message ?? '';
    entries.push({
      kind: 'diagnostic',
      ...(diag.urn ? { urn: diag.urn } : {}),
      message:
        message.length > MESSAGE_LIMIT
          ? `${message.slice(0, MESSAGE_LIMIT)}…`
          : message,
    });
  };

  return { onEvent, toJson: () => JSON.stringify(entries) };
}
