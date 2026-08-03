import { spawn, type ChildProcess } from "node:child_process";

export interface ExecutableProbeResult {
  available: boolean;
  version?: string;
  message: string;
}

export type ProbeExecutable = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    environment: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
) => Promise<ExecutableProbeResult>;

export const probeExecutable: ProbeExecutable = async (
  command,
  args,
  options,
) =>
  new Promise<ExecutableProbeResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.environment,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve({
        available: false,
        message: `${command} could not be started.`,
      });
      return;
    }

    let output = "";
    child.stdout?.on("data", (chunk: unknown) => {
      if (output.length < 512)
        output += String(chunk).slice(0, 512 - output.length);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({
        available: false,
        message: `${command} did not answer within the doctor timeout.`,
      });
    }, options.timeoutMs);
    timer.unref();

    child.once("error", () => {
      clearTimeout(timer);
      resolve({
        available: false,
        message: `${command} is not installed or is not executable.`,
      });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({
          available: false,
          message: `${command} exited before reporting a version.`,
        });
        return;
      }
      const firstLine = output.split(/\r?\n/, 1)[0]?.trim().slice(0, 160);
      resolve({
        available: true,
        ...(firstLine ? { version: firstLine } : {}),
        message: firstLine
          ? `${command} is available (${firstLine}).`
          : `${command} is available.`,
      });
    });
  });
