import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSaveTrigger } from "../../utils/database-save-trigger.js";

describe("DatabaseSaveTrigger", () => {
  afterEach(() => {
    vi.useRealTimers();
    DatabaseSaveTrigger.cleanup();
  });

  it("force saves through the initialized save function", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    DatabaseSaveTrigger.initialize(save);

    await DatabaseSaveTrigger.forceSave("test_force_save");

    expect(save).toHaveBeenCalledTimes(1);
    expect(DatabaseSaveTrigger.getStatus()).toMatchObject({
      initialized: true,
      pendingSave: false,
      hasPendingTimeout: false,
    });
  });

  it("debounces dirty saves and marks the database clean after saving", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    DatabaseSaveTrigger.initialize(save);

    await DatabaseSaveTrigger.triggerSave("first");
    await DatabaseSaveTrigger.triggerSave("second");

    expect(DatabaseSaveTrigger.isDirty).toBe(true);
    expect(DatabaseSaveTrigger.getStatus().hasPendingTimeout).toBe(true);

    await vi.advanceTimersByTimeAsync(2000);

    expect(save).toHaveBeenCalledTimes(1);
    expect(DatabaseSaveTrigger.isDirty).toBe(false);
    expect(DatabaseSaveTrigger.getStatus().pendingSave).toBe(false);
  });

  it("queues a force save behind an in-progress save and waits for both", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const save = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstBlocked)
      .mockResolvedValue(undefined);
    DatabaseSaveTrigger.initialize(save);

    const first = DatabaseSaveTrigger.forceSave("first");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    let secondFinished = false;
    const second = DatabaseSaveTrigger.forceSave("second").then(() => {
      secondFinished = true;
    });
    await Promise.resolve();

    expect(secondFinished).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(save).toHaveBeenCalledTimes(2);
    expect(secondFinished).toBe(true);
    expect(DatabaseSaveTrigger.isDirty).toBe(false);
  });

  it("propagates force-save failures while allowing the next save to run", async () => {
    const save = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    DatabaseSaveTrigger.initialize(save);

    await expect(DatabaseSaveTrigger.forceSave("failed")).rejects.toThrow(
      "disk full",
    );
    expect(DatabaseSaveTrigger.isDirty).toBe(true);

    await DatabaseSaveTrigger.forceSave("retry");

    expect(save).toHaveBeenCalledTimes(2);
    expect(DatabaseSaveTrigger.isDirty).toBe(false);
  });

  it("closes the save queue after one final shutdown save", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const save = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstBlocked)
      .mockResolvedValue(undefined);
    DatabaseSaveTrigger.initialize(save);

    const first = DatabaseSaveTrigger.forceSave("in_progress");
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    const shutdown = DatabaseSaveTrigger.shutdown("shutdown");
    const lateSave = DatabaseSaveTrigger.forceSave("late_save");

    releaseFirst();
    await Promise.all([first, shutdown, lateSave]);

    expect(save).toHaveBeenCalledTimes(2);
    expect(DatabaseSaveTrigger.isDirty).toBe(false);
  });
});
