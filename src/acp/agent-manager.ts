/**
 * Spawn and kill ACP agent subprocesses.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

export interface AgentProcessInfo {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
}

export interface SpawnAgentOpts {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: acp.Client;
  log: (msg: string) => void;
}

export async function spawnAgent(opts: SpawnAgentOpts): Promise<AgentProcessInfo> {
  const { command, args, cwd, env, client, log } = opts;

  log(`Spawning agent: ${command} ${args.join(" ")}`);

  const proc = spawn(command, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    const line = chunk.toString().trim();
    if (line) log(`[agent stderr] ${line}`);
  });

  // Wrap Node streams into Web streams for the ACP SDK
  const input = Writable.toWeb(proc.stdin!);
  const output = Readable.toWeb(proc.stdout!);
  const stream = acp.ndJsonStream(input, output);

  const connection = new acp.ClientSideConnection(() => client, stream);

  // Initialize protocol
  await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
  });

  // Create a session
  const sessionResult = await connection.newSession({ cwd, mcpServers: [] });
  log(`Agent initialized, session: ${sessionResult.sessionId}`);

  return { process: proc, connection, sessionId: sessionResult.sessionId };
}

export function killAgent(proc: ChildProcess): void {
  try {
    if (!proc.killed && proc.exitCode === null) proc.kill("SIGTERM");
  } catch {
    // already dead
  }
}
