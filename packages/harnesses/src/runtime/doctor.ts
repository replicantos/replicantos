import type {
  DoctorContext,
  DoctorResult,
  HarnessManifest,
} from "@replicantos/protocol/harness";

import type { Clock } from "./events.js";
import type { TextRedactor } from "./environment.js";
import type { ProbeExecutable } from "./process-doctor.js";

export async function executableDoctor(
  manifest: HarnessManifest,
  command: string,
  versionArgs: readonly string[],
  probe: ProbeExecutable,
  clock: Clock,
  environment: NodeJS.ProcessEnv,
  redact: TextRedactor,
  context: DoctorContext = {},
): Promise<DoctorResult> {
  const result = await probe(command, versionArgs, {
    ...(context.cwd ? { cwd: context.cwd } : {}),
    environment,
    timeoutMs: context.timeoutMs ?? 5_000,
  });
  return {
    harnessId: manifest.id,
    status: result.available ? "ready" : "unavailable",
    checkedAt: clock(),
    checks: [
      result.available
        ? { id: "executable", status: "pass", message: redact(result.message) }
        : {
            id: "executable",
            status: "fail",
            message: redact(result.message),
            remediation: `Install ${manifest.displayName} and complete its provider-native authentication setup.`,
          },
      {
        id: "credentials",
        status: "pass",
        message:
          "ReplicantOS will use the provider's host credential store and will not persist a token.",
      },
    ],
  };
}
