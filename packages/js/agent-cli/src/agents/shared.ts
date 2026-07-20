import type {
  AgentInvocationRequest,
  InvocationResult,
  ModelUsage,
  PreparedAgentInvocation,
  StreamEvent,
} from "./types.ts";

interface BuildCliInvocationOptions {
  command: string;
  flags: string[];
  effectiveModel: string;
  stdinSupport: boolean;
  supportsResume: boolean;
  expectPromptLast?: boolean;
}

export function createMissingEnvResult(agentName: string, envKey: string): InvocationResult {
  return {
    success: false,
    stdout: `${envKey} is required for ${agentName} agent tasks. Set it in your .env file.`,
    stderr: `Missing ${envKey}`,
    exitCode: 1,
  };
}

export function resolveEnvValue(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key];
  return value && value.length > 0 ? value : undefined;
}

export function buildCliInvocation(
  request: AgentInvocationRequest,
  options: BuildCliInvocationOptions,
): PreparedAgentInvocation {
  const args = [...options.flags];
  const isResume = Boolean(request.resumeSessionId && options.supportsResume);

  args.push("--model", options.effectiveModel);

  if (isResume) {
    args.push("--resume", request.resumeSessionId!, "-p", request.taskPrompt);
  } else {
    const effectiveTaskPrompt = options.stdinSupport
      ? request.taskPrompt
      : buildCombinedPrompt(request.systemPrompt, request.taskPrompt);

    if (options.expectPromptLast) {
      args.push(effectiveTaskPrompt);
    } else {
      args.push("-p", effectiveTaskPrompt);
    }
  }

  return {
    command: options.command,
    args,
    stdinInput: options.stdinSupport && !isResume ? request.systemPrompt : undefined,
  };
}

export function buildCombinedPrompt(systemPrompt: string, taskPrompt: string): string {
  return systemPrompt ? `${systemPrompt}\n\n---\n\n${taskPrompt}` : taskPrompt;
}

export function extractStandardSessionId(events: StreamEvent[]): string | undefined {
  const resultEvent = events.find((event) => event.type === "result");
  return resultEvent?.session_id ?? events.find((event) => event.session_id)?.session_id;
}

export function buildModelUsage(
  model: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUsd?: number;
  },
): Record<string, ModelUsage> {
  return {
    [model]: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
      costUsd: usage.costUsd ?? 0,
    },
  };
}
