import * as core from '@actions/core';
import { OutputMap } from '@pulumi/pulumi/automation';

/**
 * Publishes every stack output as a step output of the action, registering a
 * log mask for the values Pulumi marks as secret.
 */
export function publishStackOutputs(outputs: OutputMap): void {
  for (const [outKey, outExport] of Object.entries(outputs)) {
    core.setOutput(outKey, outExport.value);
    if (outExport.secret) {
      core.setSecret(outExport.value);
    }
  }
}
