import { databaseLogger } from "./logger.js";

export class DatabaseSaveTrigger {
  private static saveFunction: (() => Promise<void>) | null = null;
  private static isInitialized = false;
  private static pendingSave = false;
  private static saveTimeout: NodeJS.Timeout | null = null;
  private static _dirty = false;
  private static changeVersion = 0;
  private static savedVersion = 0;
  private static saveQueue: Promise<void> = Promise.resolve();
  private static shutdownPromise: Promise<void> | null = null;

  static initialize(saveFunction: () => Promise<void>): void {
    this.saveFunction = saveFunction;
    this.isInitialized = true;
  }

  static get isDirty(): boolean {
    return this._dirty;
  }

  static async triggerSave(
    reason: string = "data_modification",
  ): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    if (!this.isInitialized || !this.saveFunction) {
      databaseLogger.warn("Database save trigger not initialized", {
        operation: "db_save_trigger_not_init",
        reason,
      });
      return;
    }

    this._dirty = true;
    this.changeVersion += 1;

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(async () => {
      this.saveTimeout = null;
      await this.enqueueSave(reason, false);
    }, 2000);
  }

  static async forceSave(reason: string = "critical_operation"): Promise<void> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return;
    }

    if (!this.isInitialized || !this.saveFunction) {
      databaseLogger.warn(
        "Database save trigger not initialized for force save",
        {
          operation: "db_save_trigger_force_not_init",
          reason,
        },
      );
      return;
    }

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    this._dirty = true;
    this.changeVersion += 1;
    await this.enqueueSave(reason, true);
  }

  static shutdown(reason: string = "database_shutdown"): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    if (!this.isInitialized || !this.saveFunction) {
      databaseLogger.warn(
        "Database save trigger not initialized for shutdown",
        {
          operation: "db_save_trigger_shutdown_not_init",
          reason,
        },
      );
      return Promise.resolve();
    }

    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    this._dirty = true;
    this.changeVersion += 1;
    this.shutdownPromise = this.enqueueSave(reason, true);
    return this.shutdownPromise;
  }

  private static enqueueSave(
    reason: string,
    propagateError: boolean,
  ): Promise<void> {
    const saveFunction = this.saveFunction!;
    const operation = propagateError
      ? "db_save_trigger_force_failed"
      : "db_save_trigger_failed";
    const message = propagateError
      ? "Database force save failed"
      : "Database save failed";

    const queued = this.saveQueue
      .catch(() => undefined)
      .then(async () => {
        this.pendingSave = true;
        const versionAtStart = this.changeVersion;
        try {
          await saveFunction();
          this.savedVersion = Math.max(this.savedVersion, versionAtStart);
          this._dirty = this.savedVersion < this.changeVersion;
        } catch (error) {
          databaseLogger.error(message, error, {
            operation,
            reason,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          if (propagateError) throw error;
        } finally {
          this.pendingSave = false;
        }
      });
    this.saveQueue = queued.catch(() => undefined);
    return queued;
  }

  static getStatus(): {
    initialized: boolean;
    pendingSave: boolean;
    hasPendingTimeout: boolean;
  } {
    return {
      initialized: this.isInitialized,
      pendingSave: this.pendingSave,
      hasPendingTimeout: this.saveTimeout !== null,
    };
  }

  static cleanup(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }

    this.pendingSave = false;
    this.isInitialized = false;
    this.saveFunction = null;
    this._dirty = false;
    this.changeVersion = 0;
    this.savedVersion = 0;
    this.saveQueue = Promise.resolve();
    this.shutdownPromise = null;
  }
}
