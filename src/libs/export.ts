import * as fs from 'fs';
import { dirname } from 'path';
import * as pulumiCli from './pulumi-cli';

/**
 * Writes `pulumi stack export` JSON to a file with secrets kept encrypted.
 *
 * Deliberately NOT the Automation API's exportStack(), which hardcodes
 * `--show-secrets` and would put plaintext secrets on disk. The raw CLI
 * without the flag preserves the ciphertext envelopes, so the file is safe
 * to persist (e.g. as a pre-deploy snapshot artifact) — only someone with
 * the stack's secrets provider can decrypt it.
 */
export async function exportStackState(
  workDir: string,
  stackName: string,
  path: string,
): Promise<void> {
  const result = await pulumiCli.run(
    '--non-interactive',
    '--cwd',
    workDir,
    'stack',
    'export',
    '--stack',
    stackName,
  );
  if (!result.success) {
    throw new Error(
      `Failed to export the state of stack ${stackName}: ${result.stderr}`,
    );
  }
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, result.stdout, { encoding: 'utf-8' });
}
