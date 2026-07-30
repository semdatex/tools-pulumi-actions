import * as core from '@actions/core';
import { Commands } from '../config';
import { ResourceChange } from './changes';
import { ErrorLogEntry } from './error-log';

/**
 * Verbatim step-summary rendering of the action's own structured data — the
 * resource-changes and error-log outputs — so every consumer gets a legible
 * job summary without pasting the same rendering shell into its workflow.
 *
 * Presentation only, deliberately no interpretation: entries are rendered as
 * reported (the engine's bare closing record included), tables are capped
 * but never silently (a run past the cap says how many rows it left out),
 * and nothing here classifies a message. Consumers that want verdicts (e.g.
 * "is this run red only because of protections?") build them on the outputs.
 */

/** Rows rendered per section; past this the section says what it dropped. */
const MAX_ROWS = 100;

function firstLine(message: string): string {
  const line = message.split('\n', 1)[0].trim();
  // Keep table cells intact: the message is arbitrary text, the pipe is the
  // one character that would break out of the cell.
  return line.replace(/\|/g, '\\|');
}

export function renderResourceChangesSummary(
  changes: readonly ResourceChange[],
  command: Commands,
): string {
  const heading =
    command === 'preview' ? 'Planned resource changes' : 'Resource changes';
  const lines = [`### ${heading}`, ''];
  if (changes.length === 0) {
    lines.push('No resource changes.');
    return lines.join('\n');
  }

  const countsByOp = new Map<string, number>();
  for (const change of changes) {
    countsByOp.set(change.op, (countsByOp.get(change.op) ?? 0) + 1);
  }
  lines.push(
    [...countsByOp.entries()].map(([op, count]) => `${count} ${op}`).join(', '),
    '',
    `<details><summary>${changes.length} step(s)</summary>`,
    '',
    '| Op | Type | URN |',
    '| --- | --- | --- |',
  );
  for (const change of changes.slice(0, MAX_ROWS)) {
    lines.push(`| ${change.op} | \`${change.type}\` | \`${change.urn}\` |`);
  }
  if (changes.length > MAX_ROWS) {
    lines.push('', `_and ${changes.length - MAX_ROWS} more; see the log._`);
  }
  lines.push('', '</details>');
  return lines.join('\n');
}

export function renderErrorLogSummary(
  entries: readonly ErrorLogEntry[],
): string | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  const lines = ['### Errors', ''];
  for (const entry of entries.slice(0, MAX_ROWS)) {
    if (entry.kind === 'op-failed') {
      lines.push(`- ${entry.op} \`${entry.type}\` \`${entry.urn}\` failed`);
    } else {
      lines.push(
        entry.urn
          ? `- \`${entry.urn}\` — ${firstLine(entry.message)}`
          : `- ${firstLine(entry.message)}`,
      );
    }
  }
  if (entries.length > MAX_ROWS) {
    lines.push('', `_and ${entries.length - MAX_ROWS} more; see the log._`);
  }
  return lines.join('\n');
}

/**
 * Append the enabled sections to the job summary. Best-effort by contract:
 * callers on the failure path must not let a summary-write problem mask the
 * command's real error, so this never throws.
 */
export async function writeRunSummary(sections: {
  readonly changes?: { json: string; command: Commands };
  readonly errorLog?: { json: string };
}): Promise<void> {
  try {
    const parts: string[] = [];
    if (sections.changes) {
      parts.push(
        renderResourceChangesSummary(
          JSON.parse(sections.changes.json) as ResourceChange[],
          sections.changes.command,
        ),
      );
    }
    if (sections.errorLog) {
      const rendered = renderErrorLogSummary(
        JSON.parse(sections.errorLog.json) as ErrorLogEntry[],
      );
      if (rendered) {
        parts.push(rendered);
      }
    }
    if (parts.length === 0) {
      return;
    }
    await core.summary.addRaw(`${parts.join('\n\n')}\n`).write();
  } catch (err) {
    core.warning(`Failed to write the run summary: ${err}`);
  }
}
