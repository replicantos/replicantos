import type { IntervalScheduler } from "./ports.js";

export const nodeIntervalScheduler: IntervalScheduler = Object.freeze({
  every(intervalMs: number, callback: () => Promise<void> | void) {
    const timer = setInterval(() => {
      void callback();
    }, intervalMs);
    timer.unref();
    return { cancel: () => clearInterval(timer) };
  },
});
