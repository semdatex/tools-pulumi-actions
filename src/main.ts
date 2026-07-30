import { resolve } from 'path';
import * as core from '@actions/core';
import { context } from '@actions/github';
import {
  EngineEvent,
  LocalProgramArgs,
  LocalWorkspace,
  LocalWorkspaceOptions,
  OutputMap,
  Stack,
} from '@pulumi/pulumi/automation';
import { invariant } from 'ts-invariant';
import {
  Commands,
  Config,
  InstallationConfig,
  makeConfig,
  makeInstallationConfig,
} from './config';
import { createChangeCollector } from './libs/changes';
import { environmentVariables } from './libs/envs';
import { createErrorLogCollector } from './libs/error-log';
import {
  buildStackOutputsJson,
  fetchOutputsWithoutDecrypting,
  publishStackOutputs,
  registerSecretMasks,
} from './libs/outputs';
import { handlePullRequestMessage } from './libs/pr';
import * as pulumiCli from './libs/pulumi-cli';
import { writeRunSummary } from './libs/run-summary';
import { handleSummaryMessage } from './libs/summary';
import { login } from './login';

const main = async () => {
  const downloadConfig = makeInstallationConfig();
  if (downloadConfig.success) {
    await installOnly(downloadConfig.value);
    core.info('Pulumi has been successfully installed. Exiting.');
    return;
  }

  // If we get here, we're not in install-only mode.
  // Attempt to parse the full configuration and run the action.
  const config = makeConfig();
  core.debug('Configuration is loaded');
  runAction(config);
};

// installOnly is the main entrypoint of the program when the user
// intends to install the Pulumi CLI without running additional commands.
const installOnly = async (config: InstallationConfig): Promise<void> => {
  await pulumiCli.downloadCli(config.pulumiVersion);
};

const runAction = async (config: Config): Promise<void> => {
  await pulumiCli.downloadCli(config.pulumiVersion);

  const workDir = resolve(
    environmentVariables.GITHUB_WORKSPACE,
    config.workDir,
  );
  core.debug(`Working directory resolved at ${workDir}`);

  const result = await login(workDir, config.cloudUrl);
  if (!result.success) {
    core.warning(`Failed to login to Pulumi service: ${result.stderr}`);
  }

  const wsOpts: LocalWorkspaceOptions = {};
  if (config.secretsProvider != '') {
    wsOpts.secretsProvider = config.secretsProvider;
  }

  // Only initialize `stack` when the command is not `output`.
  // When the command is `output` we want to avoid the underlying call to `pulumi stack select`,
  // which requires a Pulumi.yaml file to be present.
  let stack: Stack | undefined;
  if (config.command !== "output") {
    const stackArgs: LocalProgramArgs = {
      stackName: config.stackName,
      workDir: workDir,
    };

    stack = await (config.upsert
      ? LocalWorkspace.createOrSelectStack(stackArgs, wsOpts)
      : LocalWorkspace.selectStack(stackArgs, wsOpts));
  }

  // Only initialize `projectName` when we have an instance of `stack` to operate on,
  // for commands other than `output`.
  let projectName: string | undefined;
  if (stack) {
    const projectSettings = await stack.workspace.projectSettings();
    projectName = projectSettings.name;
  }

  const onOutput = (msg: string) => {
    core.debug(msg);
    core.info(msg);
  };

  // If we have an instance of `stack` and `configMap` is set, set all the config values.
  // `stack` is only initialized when the command is not `output`.
  if (stack && config.configMap) {
    await stack.setAllConfig(config.configMap);
  }


  core.startGroup(`pulumi ${config.command} on ${config.stackName}`);

  // Collects {op, urn, type} per resource step for the opt-in
  // resource-changes output ('changed' steps only, or 'all' steps including
  // same/read), and the engine's error records for the opt-in error-log
  // output. Only wired up when a flag is set, so default runs skip the
  // Automation API's event-log plumbing entirely.
  const changeCollector = config.resourceChanges
    ? createChangeCollector({
        includeUnchanged: config.resourceChanges === 'all',
      })
    : undefined;
  const errorLogCollector = config.errorLog
    ? createErrorLogCollector()
    : undefined;
  const collectors = [changeCollector, errorLogCollector].filter(
    (collector) => collector !== undefined,
  );
  const onEvent =
    collectors.length > 0
      ? (event: EngineEvent) =>
          collectors.forEach((collector) => collector.onEvent(event))
      : undefined;

  const actions: Record<Commands, () => Promise<[string, string]>> = {
    up: () =>
      stack
        .up({ onOutput, onEvent, ...config.options })
        .then((r) => [r.stdout, r.stderr]),
    update: () =>
      stack
        .up({ onOutput, onEvent, ...config.options })
        .then((r) => [r.stdout, r.stderr]),
    refresh: () =>
      stack
        .refresh({ onOutput, onEvent, ...config.options })
        .then((r) => [r.stdout, r.stderr]),
    destroy: () =>
      stack
        .destroy({ onOutput, onEvent, ...config.options })
        .then((r) => [r.stdout, r.stderr]),
    preview: async () => {
      const { stdout, stderr } = await stack.preview({
        onOutput,
        onEvent,
        ...config.options
      });
      return [stdout, stderr];
    },
    output: () => Promise.resolve(['', '']) //do nothing, outputs are fetched anyway afterwards
  };

  core.debug(`Running action ${config.command}`);
  let stdout: string;
  let stderr: string;
  try {
    [stdout, stderr] = await actions[config.command]();
  } catch (err) {
    // Failure keeps upstream semantics (the rethrow lands in the top-level
    // handler: setFailed, no stack outputs, no PR comment) — but opted-in
    // resource-changes and error-log outputs are still published, best-effort
    // from the events received before the error, so a step carrying the
    // GitHub Actions step property `continue-on-error: true` (unrelated to
    // this action's same-named input, which is pulumi's --continue-on-error)
    // can see what the command changed or planned to change — and what the
    // engine reported as failing, for its own interpretation.
    if (changeCollector) {
      core.setOutput('resource-changes', changeCollector.toJson());
    }
    if (errorLogCollector) {
      core.setOutput('error-log', errorLogCollector.toJson());
    }
    // Render what was collected into the job summary too — never throws, so
    // it cannot mask the command's real error being rethrown below.
    if (config.command !== 'output') {
      await writeRunSummary({
        changes: changeCollector
          ? { json: changeCollector.toJson(), command: config.command }
          : undefined,
        errorLog: errorLogCollector
          ? { json: errorLogCollector.toJson() }
          : undefined,
      });
    }
    throw err;
  }
  core.debug(`Done running action ${config.command}`);
  if (stderr !== '') {
    if (config.options.logToStdErr) {
      core.info(stderr);
    } else {
      core.warning(stderr);
    }
  }

  core.setOutput('output', stdout);

  const fetchDecryptedOutputs = async (): Promise<OutputMap> => {
    if (config.command === "output") {
      // When the command is `output` we didn't initialize `stack`, because we
      // wanted to avoid the underlying call to `pulumi stack select`, which
      // requires a Pulumi.yaml file to be present. Instead, we can use the
      // `LocalWorkspace.stackOutputs()` to get the stack's outputs.
      const ws = await LocalWorkspace.create({ ...wsOpts, workDir });
      return ws.stackOutputs(config.stackName);
    }
    // When the command is not `output`, we already have a `stack` instance
    // initialized, so `stack.outputs()` can be used to get the stack's outputs.
    return stack.outputs();
  };

  if (config.outputFormat === 'per-key') {
    const outputs = await fetchDecryptedOutputs();
    if (
      changeCollector &&
      Object.prototype.hasOwnProperty.call(outputs, 'resource-changes')
    ) {
      throw new Error(
        "The stack output 'resource-changes' collides with the action's resource-changes output in per-key format. Rename the stack output or use output-format: json.",
      );
    }
    if (
      errorLogCollector &&
      Object.prototype.hasOwnProperty.call(outputs, 'error-log')
    ) {
      throw new Error(
        "The stack output 'error-log' collides with the action's error-log output in per-key format. Rename the stack output or use output-format: json.",
      );
    }
    publishStackOutputs(outputs, {
      secretMasking: config.secretMasking,
    });
  } else {
    // The json formats publish no per-key outputs.
    let outputs: OutputMap;
    if (config.outputFormat === 'json') {
      // The aggregate never carries a secret value, so no secret is ever
      // decrypted: the Automation API's outputs()/stackOutputs() always run
      // `--show-secrets`, while the raw CLI without it never lets plaintext
      // secrets enter the process.
      outputs = await fetchOutputsWithoutDecrypting(workDir, config.stackName);
    } else {
      // json-with-secrets carries decrypted values, so masks must be
      // registered before the aggregate is written anywhere.
      outputs = await fetchDecryptedOutputs();
      registerSecretMasks(outputs, config.secretMasking);
    }
    core.setOutput(
      'stack-outputs',
      buildStackOutputsJson(outputs, config.outputFormat === 'json-with-secrets'),
    );
  }

  if (changeCollector) {
    // Empty for command: output, which performs no engine operation.
    core.setOutput('resource-changes', changeCollector.toJson());
  }
  if (errorLogCollector) {
    // Usually empty on success; non-empty when pulumi's --continue-on-error
    // let the command succeed past failed steps.
    core.setOutput('error-log', errorLogCollector.toJson());
  }
  // Render the collected data into the job summary. Skipped entirely for
  // command: output, which performs no engine operation — an always-empty
  // "No resource changes." section would be noise.
  if (config.command !== 'output') {
    await writeRunSummary({
      changes: changeCollector
        ? { json: changeCollector.toJson(), command: config.command }
        : undefined,
      errorLog: errorLogCollector
        ? { json: errorLogCollector.toJson() }
        : undefined,
    });
  }

  // Only comment on the pull request if the command is not `output`.
  if (config.command !== "output") {
    const isPullRequest = context.payload.pull_request !== undefined;
    if (config.commentOnPrNumber ||
      (config.commentOnPr && isPullRequest)) {
      core.debug(`Commenting on pull request`);
      invariant(config.githubToken, 'github-token is missing.');
      handlePullRequestMessage(config, projectName, stdout);
    }

    if (config.commentOnSummary) {
      handleSummaryMessage(config, projectName, stdout)
    }
  }

  if (config.remove && config.command === 'destroy') {
    stack.workspace.removeStack(stack.name);
  }

  core.endGroup();
};

(async () => {
  try {
    await main();
  } catch (err) {
    if (err.message.stderr) {
      core.setFailed(err.message.stderr);
    } else {
      core.setFailed(err.message);
    }
  }
})();
