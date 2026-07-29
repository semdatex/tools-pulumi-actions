import * as core from '@actions/core';
import { OutputMap } from '@pulumi/pulumi/automation';
import * as pulumiCli from './pulumi-cli';

/**
 * How secret stack outputs are masked in logs.
 *
 * - `nested`: in addition to the exact serialized value, every string and
 *   number leaf inside a structured (object/array) secret output is masked.
 *   Without this, `fromJSON(steps.x.outputs.key).password` or a re-encoded
 *   `toJSON(steps.x.outputs)` prints nested leaves unmasked, because the
 *   runner replaces exact literals only.
 * - `exact`: upstream behavior — mask only the exact serialized value.
 */
export type SecretMasking = 'nested' | 'exact';

export interface PublishOptions {
  readonly secretMasking?: SecretMasking;
}

// Leaves whose string form is shorter than this are not masked: a registered
// mask replaces every occurrence of the literal in all subsequent log lines,
// and very short fragments ("us", "1") occur everywhere. GitHub applies the
// same reasoning to repository secrets, which it wants 8+ characters long.
const MIN_MASKED_LEAF_LENGTH = 4;

function maskLiteral(literal: string): void {
  if (literal === '') {
    return;
  }
  if (literal.length < MIN_MASKED_LEAF_LENGTH) {
    core.debug(
      `not masking a secret leaf shorter than ${MIN_MASKED_LEAF_LENGTH} characters; ` +
        'masking it would corrupt unrelated log lines',
    );
    return;
  }
  core.setSecret(literal);
}

// Masks every maskable leaf of a structured secret value. `root` marks the
// top-level value, whose exact serialization is already registered by the
// caller — only the parts that serialization does not protect (nested leaves,
// individual lines of multiline strings) need extra masks there.
function maskLeaves(value: unknown, root: boolean): void {
  if (typeof value === 'string') {
    if (!root) {
      maskLiteral(value);
    }
    if (value.includes('\n')) {
      // The runner masks whole literals; a multiline secret that later
      // appears line-by-line would otherwise escape.
      for (const line of value.split('\n')) {
        maskLiteral(line);
      }
    }
    return;
  }
  if (typeof value === 'number') {
    if (!root) {
      maskLiteral(String(value));
    }
    return;
  }
  if (typeof value === 'boolean') {
    // Masking "true"/"false" would corrupt all subsequent logs.
    core.debug('not masking a boolean secret leaf');
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      maskLeaves(element, false);
    }
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const element of Object.values(value)) {
      maskLeaves(element, false);
    }
  }
}

/**
 * Registers log masks for every value Pulumi marks as secret, without
 * writing anything to GITHUB_OUTPUT. Masks only affect log rendering (and
 * GitHub's stripping of job outputs that contain masked values).
 */
export function registerSecretMasks(
  outputs: OutputMap,
  masking: SecretMasking = 'nested',
): void {
  for (const outExport of Object.values(outputs)) {
    if (!outExport.secret || outExport.value === undefined) {
      continue;
    }
    // The exact serialized value, as upstream has always masked it.
    core.setSecret(outExport.value);
    if (masking === 'nested') {
      maskLeaves(outExport.value, true);
    }
  }
}

/**
 * Publishes every stack output as a step output of the action, registering
 * log masks for the values Pulumi marks as secret.
 *
 * All masks are registered before the first value is written, so nothing
 * emitted afterwards can leak a value that was about to be masked. What lands
 * in GITHUB_OUTPUT is identical in both masking modes.
 */
export function publishStackOutputs(
  outputs: OutputMap,
  options?: PublishOptions,
): void {
  registerSecretMasks(outputs, options?.secretMasking ?? 'nested');

  for (const [outKey, outExport] of Object.entries(outputs)) {
    core.setOutput(outKey, outExport.value);
  }
}

/**
 * Serializes an OutputMap into the aggregate `stack-outputs` JSON:
 * `{name: {value, secret: false} | {secret: true}}`. Unless `includeSecrets`
 * is set, secret entries are listed without their value, so consumers can
 * detect presence without the aggregate ever containing secret material.
 * With `includeSecrets`, secret entries carry their decrypted value — the
 * caller must have registered log masks first.
 */
export function buildStackOutputsJson(
  outputs: OutputMap,
  includeSecrets = false,
): string {
  const aggregate: Record<string, { value?: unknown; secret: boolean }> = {};
  for (const [key, outExport] of Object.entries(outputs)) {
    if (outExport.secret && !includeSecrets) {
      aggregate[key] = { secret: true };
    } else {
      aggregate[key] = { value: outExport.value, secret: outExport.secret };
    }
  }
  return JSON.stringify(aggregate);
}

// What the CLI prints in place of a secret value when --show-secrets is not
// passed. Also the Automation API's own secret-detection marker.
const SECRET_PLACEHOLDER = '[secret]';

/**
 * Reads stack outputs without ever decrypting secrets.
 *
 * The Automation API's `stack.outputs()`/`stackOutputs()` always run
 * `pulumi stack output --json --show-secrets`, so decrypted secret values
 * enter the process even when nothing will publish them. Running the CLI
 * without `--show-secrets` yields non-secret values plus `"[secret]"`
 * markers; secret entries are returned with `value: undefined`.
 *
 * Inherits the Automation API's quirk that a non-secret output whose literal
 * value is `"[secret]"` is misclassified as secret.
 */
export async function fetchOutputsWithoutDecrypting(
  workDir: string,
  stackName: string,
): Promise<OutputMap> {
  const result = await pulumiCli.run(
    '--non-interactive',
    '--cwd',
    workDir,
    'stack',
    'output',
    '--json',
    '--stack',
    stackName,
  );
  if (!result.success) {
    throw new Error(
      `Failed to read outputs of stack ${stackName}: ${result.stderr}`,
    );
  }
  const parsed = JSON.parse(result.stdout || '{}') as Record<string, unknown>;
  const outputs: OutputMap = {};
  for (const [key, value] of Object.entries(parsed)) {
    outputs[key] =
      value === SECRET_PLACEHOLDER
        ? { value: undefined, secret: true }
        : { value, secret: false };
  }
  return outputs;
}
