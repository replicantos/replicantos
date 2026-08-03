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
import { GROK_MANIFEST } from "./manifests.js";

/** Provider/config variables copied from the host when present. */
export const GROK_CHILD_ENV_KEYS = ["GROK_HOME", "XAI_API_KEY"] as const;

export type GrokAdapterOptions = Partial<
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

export class GrokAdapter implements HarnessAdapter {
  readonly manifest = GROK_MANIFEST;
  readonly #adapter: AcpAdapter;

  constructor(options: GrokAdapterOptions = {}) {
    this.#adapter = new AcpAdapter({
      ...options,
      command: options.command ?? "grok",
      args: ["--no-auto-update", "agent", "stdio"],
      manifest: this.manifest,
      preferredAuthMethods: ["cached_token", "xai.api_key"],
      providerEnvironmentKeys: GROK_CHILD_ENV_KEYS,
      versionArgs: ["version"],
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
