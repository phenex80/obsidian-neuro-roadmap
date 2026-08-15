import type { RoadmapNode } from '../types';
import type {
  CalendarReconcileOptions,
  CalendarSyncReport,
} from './CalendarSyncEngine';

export type CalendarSyncPhase = 'idle' | 'scheduled' | 'syncing' | 'error';

export interface CalendarSyncRuntimeStatus {
  readonly phase: CalendarSyncPhase;
  readonly message?: string;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type StatusListener = (status: CalendarSyncRuntimeStatus) => void;

/** Debounces index changes and serializes reconciliations to avoid provider request storms. */
export class CalendarSyncController {
  private timer: TimerHandle | null = null;
  private pendingNodes: readonly RoadmapNode[] | null = null;
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private status: CalendarSyncRuntimeStatus = { phase: 'idle' };
  private readonly listeners = new Set<StatusListener>();

  constructor(
    private readonly reconcile: (
      nodes: readonly RoadmapNode[],
      options: CalendarReconcileOptions,
    ) => Promise<CalendarSyncReport>,
    private readonly debounceMs: () => number,
    private readonly onSuccess: (report: CalendarSyncReport) => Promise<void> = async () => undefined,
    private readonly onError: (error: unknown) => Promise<void> = async () => undefined,
    private readonly scheduleTimer: (callback: () => void, milliseconds: number) => TimerHandle =
      (callback, milliseconds) => setTimeout(callback, milliseconds),
    private readonly cancelTimer: (handle: TimerHandle) => void = clearTimeout,
  ) {}

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  schedule(nodes: readonly RoadmapNode[]): void {
    if (this.disposed) return;
    this.pendingNodes = [...nodes];
    if (this.timer !== null) this.cancelTimer(this.timer);
    this.setStatus({ phase: 'scheduled' });
    this.timer = this.scheduleTimer(() => {
      this.timer = null;
      const pending = this.pendingNodes;
      this.pendingNodes = null;
      if (pending !== null) void this.enqueue(pending, { verifyRemote: false });
    }, this.debounceMs());
  }

  async syncNow(nodes: readonly RoadmapNode[]): Promise<CalendarSyncReport> {
    if (this.disposed) throw new Error('Calendar sync is not available after plugin unload.');
    if (this.timer !== null) {
      this.cancelTimer(this.timer);
      this.timer = null;
    }
    this.pendingNodes = null;
    return this.enqueue([...nodes], { verifyRemote: true });
  }

  dispose(): void {
    this.disposed = true;
    this.pendingNodes = null;
    if (this.timer !== null) {
      this.cancelTimer(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
  }

  private enqueue(
    nodes: readonly RoadmapNode[],
    options: CalendarReconcileOptions,
  ): Promise<CalendarSyncReport> {
    const run = this.queue.then(async () => {
      if (this.disposed) throw new Error('Calendar sync is not available after plugin unload.');
      this.setStatus({ phase: 'syncing' });
      try {
        const report = await this.reconcile(nodes, options);
        if (!this.disposed) {
          await this.onSuccess(report);
          this.setStatus({ phase: 'idle' });
        }
        return report;
      } catch (error) {
        if (!this.disposed) {
          await this.onError(error);
          this.setStatus({
            phase: 'error',
            message: error instanceof Error ? error.message : 'Calendar synchronization failed.',
          });
        }
        throw error;
      }
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private setStatus(status: CalendarSyncRuntimeStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener(status);
  }
}
