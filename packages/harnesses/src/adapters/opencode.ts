import type {
  ApprovalDecision,
  DoctorContext,
  DoctorResult,
  HarnessAdapter,
  HarnessEventSink,
  ResumeInput,
  RunHandle,
  RunInput,
} from "@replicantos/protocol/harness";

import type { AcpAdapterOptions } from "./acp.js";
import { AcpAdapter } from "./acp.js";
import { OPENCODE_MANIFEST } from "./manifests.js";

/** Provider/config variables copied from the host when present. */
export const OPENCODE_CHILD_ENV_KEYS = [
  "OPENCODE_API_KEY",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
] as const;

export type OpenCodeAdapterOptions = Partial<
  Omit<
    AcpAdapterOptions,
    | "args"
    | "command"
    | "manifest"
    | "preferredAuthMethods"
    | "providerEnvironmentKeys"
    | "versionArgs"
  >
> & { command?: string };

export class OpenCodeAdapter implements HarnessAdapter {
  readonly manifest = OPENCODE_MANIFEST;
  readonly #adapter: AcpAdapter;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.#adapter = new AcpAdapter({
      ...options,
      command: options.command ?? "opencode",
      args: ["acp"],
      manifest: this.manifest,
      preferredAuthMethods: ["cached_token"],
      providerEnvironmentKeys: OPENCODE_CHILD_ENV_KEYS,
      versionArgs: ["--version"],
    });
  }

  doctor(context?: DoctorContext): Promise<DoctorResult> {
    return this.#adapter.doctor(context);
  }

  start(input: RunInput, events: HarnessEventSink): Promise<RunHandle> {
    return this.#adapter.start(input, events);
  }

  resume(input: ResumeInput, events: HarnessEventSink): Promise<RunHandle> {
    return this.#adapter.resume(input, events);
  }

  cancel(runId: string): Promise<void> {
    return this.#adapter.cancel(runId);
  }

  respondToApproval(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    return this.#adapter.respondToApproval(approvalId, decision);
  }
}
