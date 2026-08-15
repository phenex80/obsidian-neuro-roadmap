import type { RoadmapNode } from '../types';
import type {
  CalendarReconcileMode,
  CalendarReconcileOptions,
  CalendarSyncReport,
} from './CalendarSyncEngine';

export const CALENDAR_SYNC_DEBOUNCE_MS = 3_000;

export type CalendarSyncPhase = 'idle' | 'scheduled' | 'syncing' | 'error';

export interface CalendarSyncRuntimeStatus {
  readonly phase: CalendarSyncPhase;
  readonly message?: string;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type StatusListener = (status: CalendarSyncRuntimeStatus) => void;

export interface CalendarSyncControllerOptions {
  readonly reconcile: (
    nodes: readonly RoadmapNode[],
    options: CalendarReconcileOptions,
  ) => Promise<CalendarSyncReport>;
  readonly onDirty?: () => void | Promise<void>;
  readonly onSuccess?: (
    report: CalendarSyncReport,
    clearDirty: boolean,
  ) => void | Promise<void>;
  readonly onError?: (error: unknown) => void | Promise<void>;
  readonly scheduleTimer?: (callback: () => void, milliseconds: number) => TimerHandle;
  readonly cancelTimer?: (handle: TimerHandle) => void;
}

/** Debounces local changes, serializes reconciliation, and owns periodic safety verification. */
export class CalendarSyncController {
  private debounceTimer: TimerHandle | null = null;
  private verificationTimer: TimerHandle | null = null;
  private verificationIntervalMinutes = 0;
  private verificationNodes: (() => readonly RoadmapNode[]) | null = null;
  private pendingNodes: readonly RoadmapNode[] | null = null;
  private dirtyRevision = 0;
  private dirtyReady: Promise<void> = Promise.resolve();
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private status: CalendarSyncRuntimeStatus = { phase: 'idle' };
  private readonly listeners = new Set<StatusListener>();
  private readonly reconcile: CalendarSyncControllerOptions['reconcile'];
  private readonly onDirty: NonNullable<CalendarSyncControllerOptions['onDirty']>;
  private readonly onSuccess: NonNullable<CalendarSyncControllerOptions['onSuccess']>;
  private readonly onError: NonNullable<CalendarSyncControllerOptions['onError']>;
  private readonly scheduleTimer: NonNullable<CalendarSyncControllerOptions['scheduleTimer']>;
  private readonly cancelTimer: NonNullable<CalendarSyncControllerOptions['cancelTimer']>;

  constructor(options: CalendarSyncControllerOptions) {
    this.reconcile = options.reconcile;
    this.onDirty = options.onDirty ?? (() => undefined);
    this.onSuccess = options.onSuccess ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.scheduleTimer = options.scheduleTimer ?? ((callback, milliseconds) =>
      setTimeout(callback, milliseconds));
    this.cancelTimer = options.cancelTimer ?? clearTimeout;
  }

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  getStatus(): CalendarSyncRuntimeStatus {
    return { ...this.status };
  }

  schedule(nodes: readonly RoadmapNode[]): void {
    if (this.disposed) return;
    const isNewPendingBatch = this.pendingNodes === null;
    this.pendingNodes = [...nodes];
    if (isNewPendingBatch) {
      this.dirtyRevision += 1;
      this.dirtyReady = Promise.resolve(this.onDirty());
    }
    this.clearDebounceTimer();
    this.setStatus({ phase: 'scheduled' });
    this.debounceTimer = this.scheduleTimer(() => {
      this.debounceTimer = null;
      this.flushPending('fast');
    }, CALENDAR_SYNC_DEBOUNCE_MS);
  }

  async syncNow(nodes: readonly RoadmapNode[]): Promise<CalendarSyncReport> {
    this.assertAvailable();
    this.clearDebounceTimer();
    this.pendingNodes = null;
    this.dirtyRevision += 1;
    this.dirtyReady = Promise.resolve(this.onDirty());
    await this.dirtyReady;
    return this.enqueue([...nodes], { mode: 'full' }, this.dirtyRevision);
  }

  async syncStartup(nodes: readonly RoadmapNode[]): Promise<CalendarSyncReport> {
    this.assertAvailable();
    return this.enqueue([...nodes], { mode: 'fast' });
  }

  configureVerification(
    getNodes: () => readonly RoadmapNode[],
    intervalMinutes: number,
  ): void {
    if (this.disposed) return;
    this.verificationNodes = getNodes;
    if (this.verificationIntervalMinutes === intervalMinutes && this.verificationTimer !== null) {
      return;
    }
    this.clearVerificationTimer();
    this.verificationIntervalMinutes = intervalMinutes;
    this.scheduleNextVerification();
  }

  pauseAutomaticSync(): void {
    if (this.disposed) return;
    this.clearDebounceTimer();
    this.clearVerificationTimer();
    this.pendingNodes = null;
    this.verificationIntervalMinutes = 0;
    this.setStatus({ phase: 'idle' });
  }

  /** Stops timers and starts a non-blocking FAST flush for the latest pending local snapshot. */
  dispose(): void {
    if (this.disposed) return;
    this.clearDebounceTimer();
    this.clearVerificationTimer();
    const pending = this.pendingNodes;
    const dirtyReady = this.dirtyReady;
    const dirtyRevision = this.dirtyRevision;
    this.pendingNodes = null;
    this.disposed = true;
    this.listeners.clear();
    if (pending === null) return;

    const flush = this.queue.then(async () => {
      await dirtyReady;
      const report = await this.reconcile(pending, { mode: 'fast' });
      await this.onSuccess(report, this.dirtyRevision === dirtyRevision);
    });
    this.queue = flush.catch(async (error: unknown) => {
      await this.onError(error);
    });
  }

  private flushPending(mode: CalendarReconcileMode): void {
    const pending = this.pendingNodes;
    const dirtyReady = this.dirtyReady;
    const dirtyRevision = this.dirtyRevision;
    this.pendingNodes = null;
    if (pending === null) return;
    void dirtyReady
      .then(() => this.enqueue(pending, { mode }, dirtyRevision))
      .catch(async (error: unknown) => {
        await this.onError(error);
        this.setStatus({
          phase: 'error',
          message: safeSyncErrorMessage(error),
        });
      });
  }

  private enqueue(
    nodes: readonly RoadmapNode[],
    options: CalendarReconcileOptions,
    dirtyRevision = this.dirtyRevision,
  ): Promise<CalendarSyncReport> {
    const run = this.queue.then(async () => {
      this.assertAvailable();
      this.setStatus({ phase: 'syncing' });
      try {
        const report = await this.reconcile(nodes, options);
        await this.onSuccess(
          report,
          this.dirtyRevision === dirtyRevision && this.pendingNodes === null,
        );
        if (!this.disposed) this.setStatus({ phase: 'idle' });
        return report;
      } catch (error) {
        await this.onError(error);
        if (!this.disposed) {
          this.setStatus({
            phase: 'error',
            message: safeSyncErrorMessage(error),
          });
        }
        throw error;
      }
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private scheduleNextVerification(): void {
    if (
      this.disposed ||
      this.verificationTimer !== null ||
      this.verificationIntervalMinutes <= 0 ||
      this.verificationNodes === null
    ) {
      return;
    }
    this.verificationTimer = this.scheduleTimer(() => {
      this.verificationTimer = null;
      const nodes = this.verificationNodes?.() ?? [];
      void this.enqueue([...nodes], { mode: 'verify-existence' })
        .catch(() => undefined)
        .finally(() => this.scheduleNextVerification());
    }, this.verificationIntervalMinutes * 60_000);
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer === null) return;
    this.cancelTimer(this.debounceTimer);
    this.debounceTimer = null;
  }

  private clearVerificationTimer(): void {
    if (this.verificationTimer === null) return;
    this.cancelTimer(this.verificationTimer);
    this.verificationTimer = null;
  }

  private assertAvailable(): void {
    if (this.disposed) {
      throw new Error('Calendar sync is not available after plugin unload.');
    }
  }

  private setStatus(status: CalendarSyncRuntimeStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}

function safeSyncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Calendar synchronization failed.';
}
