import { describe, expect, it, beforeEach } from "vitest";
import { withMutex, resetMutexes } from "../src/lib/concurrency/mutex";

describe("QStash concurrency protection", () => {
  beforeEach(() => resetMutexes());

  it("serializes overlapping executions: second caller is not acquired", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    const first = withMutex("email-sync", async () => {
      await gate;
      return "first";
    });

    // Give the first call a tick to acquire.
    await new Promise((r) => setTimeout(r, 10));
    const second = await withMutex("email-sync", async () => "second");

    expect(second.acquired).toBe(false);
    release();
    const firstResult = await first;
    expect(firstResult.acquired).toBe(true);
    expect(firstResult.value).toBe("first");
  });

  it("allows sequential executions after the first completes", async () => {
    const a = await withMutex("email-sync", async () => "a");
    const b = await withMutex("email-sync", async () => "b");
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });
});
