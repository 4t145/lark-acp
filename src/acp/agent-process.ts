import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";

const STDIO_PIPED: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
const WIN32_PLATFORM = "win32";

export interface AgentProcess {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
  capabilities: Record<string, unknown>;
}

export interface SpawnAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: acp.Client;
  logger: LarkLogger;
}

interface SpawnInternal {
  proc: ChildProcess;
  connection: acp.ClientSideConnection;
  initResult: Awaited<ReturnType<acp.ClientSideConnection["initialize"]>>;
}

/**
 * Spawn an agent subprocess, run the ACP handshake, and create a fresh
 * session.
 *
 * @throws when the agent process cannot be initialized (binary missing,
 *         protocol mismatch, etc.) or when `newSession` rejects.
 */
export async function spawnAgent(opts: SpawnAgentOptions): Promise<AgentProcess> {
  const { proc, connection, initResult } = await spawnAndInit(opts);

  let sessionResult: Awaited<ReturnType<typeof connection.newSession>>;
  try {
    sessionResult = await connection.newSession({ cwd: opts.cwd, mcpServers: [] });
  } catch (err) {
    throw new Error("Failed to create agent session", { cause: err });
  }
  opts.logger.info({ sessionId: sessionResult.sessionId }, "agent session created");

  return {
    process: proc,
    connection,
    sessionId: sessionResult.sessionId,
    capabilities: (initResult.agentCapabilities ?? {}) as Record<string, unknown>,
  };
}

/**
 * Spawn an agent and try to resume an existing session. Falls back to
 * `loadSession` if `unstable_resumeSession` is unavailable, then to a
 * fresh session if neither resume mechanism works.
 *
 * @throws on unrecoverable spawn / init failures (same conditions as
 *         {@link spawnAgent}).
 */
export async function spawnAndResumeAgent(
  opts: SpawnAgentOptions,
  previousSessionId: string,
): Promise<{ agent: AgentProcess; resumed: boolean }> {
  const { proc, connection, initResult } = await spawnAndInit(opts);
  const agentCaps = initResult.agentCapabilities;
  const caps = (agentCaps ?? {}) as Record<string, unknown>;

  const hasResume = !!agentCaps?.sessionCapabilities?.resume;
  const hasLoad = !!agentCaps?.loadSession;

  opts.logger.debug(
    { hasResume, hasLoad, previousSessionId },
    "agent capabilities for resume",
  );

  if (hasResume || hasLoad) {
    try {
      if (hasResume) {
        await connection.unstable_resumeSession({ sessionId: previousSessionId });
      } else {
        await connection.loadSession({ sessionId: previousSessionId, cwd: opts.cwd, mcpServers: [] });
      }
      opts.logger.info({ sessionId: previousSessionId, mode: hasResume ? "resume" : "load" }, "session resumed");
      return {
        agent: { process: proc, connection, sessionId: previousSessionId, capabilities: caps },
        resumed: true,
      };
    } catch (err) {
      opts.logger.warn({ err, previousSessionId }, "resume failed, will start fresh");
    }
  }

  let sessionResult: Awaited<ReturnType<typeof connection.newSession>>;
  try {
    sessionResult = await connection.newSession({ cwd: opts.cwd, mcpServers: [] });
  } catch (err) {
    throw new Error("Failed to create agent session after resume failure", { cause: err });
  }
  opts.logger.info({ sessionId: sessionResult.sessionId }, "fresh session created");

  return {
    agent: { process: proc, connection, sessionId: sessionResult.sessionId, capabilities: caps },
    resumed: false,
  };
}

async function spawnAndInit(opts: SpawnAgentOptions): Promise<SpawnInternal> {
  const { command, args, cwd, env, client, logger } = opts;

  logger.info({ command, args }, "spawning agent");

  const proc = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio: STDIO_PIPED,
    shell: process.platform === WIN32_PLATFORM,
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) logger.debug({ stream: "stderr" }, line);
  });

  // Non-null asserted: stdio: STDIO_PIPED guarantees pipe streams exist.
  const input = Writable.toWeb(proc.stdin!);
  const output = Readable.toWeb(proc.stdout!);
  const stream = acp.ndJsonStream(input, output);

  const connection = new acp.ClientSideConnection(() => client, stream);

  let initResult: Awaited<ReturnType<typeof connection.initialize>>;
  try {
    initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
  } catch (err) {
    throw new Error(
      `Failed to initialize agent (${command} ${args.join(" ")}). Is the agent installed?`,
      { cause: err },
    );
  }

  if (initResult.authMethods && initResult.authMethods.length > 0) {
    const method = initResult.authMethods[0];
    logger.info({ methodId: method.id, methodName: method.name }, "agent requires authentication");
    try {
      await connection.authenticate({ methodId: method.id });
    } catch (err) {
      throw new Error("Agent authentication failed during setup", { cause: err });
    }
  }

  return { proc, connection, initResult };
}

export function killAgent(proc: ChildProcess): void {
  try {
    if (!proc.killed && proc.exitCode === null) proc.kill("SIGTERM");
  } catch {
    // already dead
  }
}
