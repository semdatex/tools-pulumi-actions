import { resolve } from 'path';
import * as core from '@actions/core';
import { context } from '@actions/github';
import {
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
import { environmentVariables } from './libs/envs';
import { createEventLogWriter } from './libs/events';
import { exportStackState } from './libs/export';
import {
  buildStackOutputsJson,
  fetchOutputsWithoutDecrypting,
  publishStackOutputs,
} from './libs/outputs';
import { handlePullRequestMessage } from './libs/pr';
import * as pulumiCli from './libs/pulumi-cli';
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

  // Streams engine events to disk while the command runs, so the file exists
  // even when the command fails (config rejects event-log-file for `output`,
  // where no engine operation runs).
  const eventLogWriter = config.eventLogFile
    ? createEventLogWriter(resolve(workDir, config.eventLogFile))
    : undefined;
  const engineEventHooks = eventLogWriter
    ? { onEvent: eventLogWriter.onEvent }
    : {};

  const actions: Record<Commands, () => Promise<[string, string]>> = {
    up: () =>
      stack
        .up({ onOutput, ...engineEventHooks, ...config.options })
        .then((r) => [r.stdout, r.stderr]),
    update: () =>
      stack
        .up({ onOutput, ...engineEventHooks, ...config.options })
        .then((r) => [r.stdout, r.stderr]),
    refresh: () =>
      stack
        .refresh({ onOutput, ...engineEventHooks, ...config.options })
        .then((r) => [r.stdout, r.stderr]),
    destroy: () =>
      stack
        .destroy({ onOutput, ...engineEventHooks, ...config.options })
        .then((r) => [r.stdout, r.stderr]),
    preview: async () => {
      const { stdout, stderr } = await stack.preview({
        onOutput,
        ...engineEventHooks,
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
    // handler: setFailed, no per-key outputs, no PR comment) — but when
    // opted in, the disposition is published so a workflow-level
    // `continue-on-error: true` step can distinguish a failed command from
    // an infrastructure error, and the event log above is already on disk.
    if (config.publishCommandResult) {
      core.setOutput('command-result', 'failed');
    }
    throw err;
  } finally {
    await eventLogWriter?.close();
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

  let outputs: OutputMap;
  if (
    config.suppressSecretOutputs &&
    config.stackOutputs !== 'plaintext-secrets'
  ) {
    // Nothing the action publishes will contain a secret value, so don't
    // decrypt any: the Automation API's outputs()/stackOutputs() always run
    // `--show-secrets`, while the raw CLI without it never lets plaintext
    // secrets enter the process.
    outputs = await fetchOutputsWithoutDecrypting(workDir, config.stackName);
  } else if (config.command === "output") {
    // When the command is `output` we didn't initialize `stack`, because we
    // wanted to avoid the underlying call to `pulumi stack select`, which
    // requires a Pulumi.yaml file to be present. Instead, we can use the
    // `LocalWorkspace.stackOutputs()` to get the stack's outputs.
    const ws = await LocalWorkspace.create({ ...wsOpts, workDir });
    outputs = await ws.stackOutputs(config.stackName);
  } else {
    // When the command is not `output`, we already have a `stack` instance
    // initialized, so `stack.outputs()` can be used to get the stack's outputs.
    outputs = await stack.outputs();
  }

  publishStackOutputs(outputs, {
    secretMasking: config.secretMasking,
    suppressSecretOutputs: config.suppressSecretOutputs,
  });

  // Both declared outputs are off by default so the action's outputs are
  // byte-identical to upstream unless explicitly requested. When enabled
  // they are set after the per-key loop so they win a collision with a stack
  // output of the same name (unlike `output`, which a stack output can
  // shadow because it is set before the loop).
  const declaredOutputs: [string, boolean][] = [
    ['stack-outputs', config.stackOutputs !== 'off'],
    ['command-result', config.publishCommandResult],
  ];
  for (const [declared, enabled] of declaredOutputs) {
    if (enabled && Object.prototype.hasOwnProperty.call(outputs, declared)) {
      core.warning(
        `The stack output named '${declared}' is shadowed by the action's declared ${declared} output.`,
      );
    }
  }
  if (config.stackOutputs !== 'off') {
    core.setOutput(
      'stack-outputs',
      buildStackOutputsJson(outputs, config.stackOutputs),
    );
  }
  if (config.publishCommandResult) {
    core.setOutput('command-result', 'succeeded');
  }

  if (config.exportFile) {
    await exportStackState(
      workDir,
      config.stackName,
      resolve(workDir, config.exportFile),
    );
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
