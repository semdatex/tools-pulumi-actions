import { EngineEvent } from '@pulumi/pulumi/automation';

export interface Failure {
  readonly urn?: string;
  readonly type?: string;
  readonly op?: string;
  readonly message?: string;
  readonly protected: boolean;
}

export interface FailureCollector {
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
 * The engine closes every failed command with a bare summary diagnostic —
 * observed as `preview failed\n` / `update failed\n`, with no URN — that
 * restates that the command failed without naming a cause. Left in, it would
 * register as a non-protection failure in every failed run and the
 * "all failures are protection refusals" check could never pass, so exactly
 * this shape is suppressed. Anything not matching (including any URN-bearing
 * diagnostic) is kept — unknown failure shapes surface rather than vanish.
 */
const COMMAND_TRAILER = /^(preview|update|refresh|destroy) failed$/;

/**
 * Loose protection-refusal match: a protection word AND a deletion verb, so
 * wording drift across Pulumi versions doesn't silently drop the signal,
 * while unrelated diagnostics that merely mention "protect" don't match.
 * Observed shapes:
 *   `resource "urn:..." cannot be deleted\nbecause it is protected. ...`
 *   `error: resource "urn:..." is protected and can't be deleted`
 */
function isProtectionRefusal(message: string): boolean {
  return /protect/i.test(message) && /delet/i.test(message);
}

/**
 * Collects the failures a command hit from engine events, in memory: failed
 * steps (resOpFailedEvent) and error diagnostics, each classified with
 * `protected: true` when it is a protection refusal — a `protect: true`
 * resource the program would delete. That lets a dry-run consumer answer
 * "is this run red only because protected resources are leaving the stack?"
 * with `jq 'length > 0 and all(.protected)'`.
 *
 * The `length > 0` half is load-bearing: some command failures emit no error
 * event at all (`--expect-no-changes` fails via CLI stderr only), so an
 * empty array on a failed command means the cause was not visible in engine
 * events and must not be treated as protection-only.
 */
export function createFailureCollector(): FailureCollector {
  const failures: Failure[] = [];

  const onEvent = (event: EngineEvent): void => {
    const failedStep = event.resOpFailedEvent?.metadata;
    if (failedStep) {
      // Step failures carry no message to classify; protection refusals are
      // refused at planning time and never become failed steps, so these are
      // always genuine (non-protection) failures.
      failures.push({
        op: failedStep.op,
        urn: failedStep.urn,
        type: failedStep.type,
        protected: false,
      });
      return;
    }

    const diag = event.diagnosticEvent;
    if (!diag || diag.severity !== 'error') {
      return;
    }
    const message = diag.message ?? '';
    // Prefer the structured URN; fall back to the first URN in the message.
    const urn = diag.urn || message.match(/urn:pulumi:[^\s"'`]+/)?.[0];
    if (!urn && COMMAND_TRAILER.test(message.trim())) {
      return;
    }
    failures.push({
      ...(urn ? { urn } : {}),
      message:
        message.length > MESSAGE_LIMIT
          ? `${message.slice(0, MESSAGE_LIMIT)}…`
          : message,
      protected: isProtectionRefusal(message),
    });
  };

  return { onEvent, toJson: () => JSON.stringify(failures) };
}
