import type { HarnessId } from "@replicantos/protocol/harness";

export class DuplicateRunError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is already active.`);
    this.name = "DuplicateRunError";
  }
}

export class UnknownRunError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is not active.`);
    this.name = "UnknownRunError";
  }
}

export class ActiveRunRegistry<T> {
  readonly #harnessId: HarnessId;
  readonly #runs = new Map<string, T>();

  constructor(harnessId: HarnessId) {
    this.#harnessId = harnessId;
  }

  add(runId: string, run: T): void {
    if (this.#runs.has(runId)) throw new DuplicateRunError(runId);
    this.#runs.set(runId, run);
  }

  get(runId: string): T {
    const run = this.#runs.get(runId);
    if (!run) throw new UnknownRunError(runId);
    return run;
  }

  find(runId: string): T | undefined {
    return this.#runs.get(runId);
  }

  delete(runId: string): void {
    this.#runs.delete(runId);
  }

  get harnessId(): HarnessId {
    return this.#harnessId;
  }
}
