import {
  assertHarnessAdapter,
  type DoctorContext,
  type DoctorResult,
  type HarnessAdapter,
  type HarnessId,
  type HarnessManifest,
} from "@replicantos/protocol/harness";

export class HarnessRegistry {
  readonly #adapters = new Map<HarnessId, HarnessAdapter>();

  constructor(adapters: readonly HarnessAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: HarnessAdapter): void {
    assertHarnessAdapter(adapter);
    if (this.#adapters.has(adapter.manifest.id)) {
      throw new Error(`Harness ${adapter.manifest.id} is already registered.`);
    }
    this.#adapters.set(adapter.manifest.id, adapter);
  }

  get(id: HarnessId): HarnessAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new Error(`Harness ${id} is not registered.`);
    return adapter;
  }

  list(): readonly HarnessManifest[] {
    return [...this.#adapters.values()]
      .map((adapter) => adapter.manifest)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  async doctorAll(
    context: DoctorContext = {},
  ): Promise<readonly DoctorResult[]> {
    return Promise.all(
      [...this.#adapters.values()].map((adapter) => adapter.doctor(context)),
    );
  }
}
