import {
  createHarnessEvent,
  type HarnessEventDraft,
  type HarnessEventSink,
} from "@replicantos/protocol/harness";

import { redactStrings, type TextRedactor } from "./environment.js";

export type Clock = () => string;

export class NormalizedEventWriter {
  readonly #runId: string;
  readonly #sink: HarnessEventSink;
  readonly #clock: Clock;
  readonly #redact: TextRedactor;
  #sequence = 0;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    runId: string,
    sink: HarnessEventSink,
    clock: Clock = () => new Date().toISOString(),
    redact: TextRedactor = (value) => value,
  ) {
    this.#runId = runId;
    this.#sink = sink;
    this.#clock = clock;
    this.#redact = redact;
  }

  emit(draft: HarnessEventDraft): Promise<void> {
    const event = createHarnessEvent(
      this.#runId,
      this.#sequence++,
      this.#clock(),
      redactStrings(draft, this.#redact),
    );
    this.#tail = this.#tail.then(async () => this.#sink(event));
    return this.#tail;
  }

  flush(): Promise<void> {
    return this.#tail;
  }
}
