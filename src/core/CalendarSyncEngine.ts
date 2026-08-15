import type { CalendarEventProjection } from './CalendarCore';
import { isCalendarEligible, projectCalendarEvent } from './CalendarCore';
import type { CalendarIdentityManager } from './CalendarIdentity';
import type { CalendarProvider, ExternalCalendarEventRef } from './CalendarProvider';
import type {
  CalendarSettings,
  CalendarState,
  CalendarSyncRecord,
  RoadmapNode,
} from '../types';

const MICROSOFT_PROVIDER_ID = 'microsoft';

export interface CalendarSyncContext {
  readonly settings: CalendarSettings;
  readonly state: CalendarState;
  readonly calendarId: string;
  readonly vaultName?: string;
}

export interface CalendarReconcileOptions {
  readonly verifyRemote?: boolean;
}

export interface CalendarSyncReport {
  readonly created: number;
  readonly updated: number;
  readonly deleted: number;
  readonly recreated: number;
  readonly unchanged: number;
  readonly completedAt: string;
}

type SyncRecords = Readonly<Record<string, CalendarSyncRecord>>;

/** Reconciles the downstream provider to the current Markdown-backed projection. */
export class CalendarSyncEngine {
  constructor(
    private readonly identities: CalendarIdentityManager,
    private readonly provider: CalendarProvider,
    private readonly getContext: () => CalendarSyncContext,
    private readonly saveRecords: (records: Record<string, CalendarSyncRecord>) => Promise<void>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reconcile(
    nodes: readonly RoadmapNode[],
    options: CalendarReconcileOptions = {},
  ): Promise<CalendarSyncReport> {
    validateProvider(this.provider);
    const initialContext = this.getContext();
    if (initialContext.calendarId.length === 0) {
      throw new Error('Select a Microsoft calendar before synchronization.');
    }

    const projected = await this.projectEligibleNodes(nodes);
    let created = 0;
    let updated = 0;
    let deleted = 0;
    let recreated = 0;
    let unchanged = 0;

    const records = microsoftRecords(this.getContext().state.syncRecords);
    for (const [internalItemId, record] of [...records.entries()].sort(compareEntries)) {
      if (projected.has(internalItemId)) continue;
      const reference = externalReference(record);
      if (reference !== null) {
        await this.provider.deleteEvent?.(reference);
      }
      await this.removeRecord(internalItemId);
      deleted += 1;
    }

    for (const [internalItemId, event] of [...projected.entries()].sort(compareEntries)) {
      const context = this.getContext();
      const hash = await calendarEventHash(event);
      const record = microsoftRecords(context.state.syncRecords).get(internalItemId);
      if (record === undefined || externalReference(record) === null) {
        await this.createAndStore(context.calendarId, event, hash);
        created += 1;
        continue;
      }

      const reference = externalReference(record);
      if (reference === null) continue;
      if (reference.calendarId !== context.calendarId) {
        await this.provider.deleteEvent?.(reference);
        await this.removeRecord(internalItemId);
        await this.createAndStore(context.calendarId, event, hash);
        deleted += 1;
        created += 1;
        continue;
      }

      if (record.lastSyncedHash !== hash) {
        try {
          await this.provider.updateEvent?.(reference, event);
          await this.storeRecord(reference, event, hash);
          updated += 1;
        } catch (error) {
          if (!isProviderNotFound(error)) throw error;
          await this.createAndStore(context.calendarId, event, hash);
          recreated += 1;
        }
        continue;
      }

      if (options.verifyRemote === true && this.provider.eventExists !== undefined) {
        const exists = await this.provider.eventExists(reference);
        if (!exists) {
          await this.createAndStore(context.calendarId, event, hash);
          recreated += 1;
          continue;
        }
      }
      unchanged += 1;
    }

    return {
      created,
      updated,
      deleted,
      recreated,
      unchanged,
      completedAt: this.now().toISOString(),
    };
  }

  /** Deletes managed events from their old calendar before the selection is changed. */
  async releaseCalendar(calendarId: string): Promise<number> {
    validateProvider(this.provider);
    let deleted = 0;
    const records = microsoftRecords(this.getContext().state.syncRecords);
    for (const [internalItemId, record] of [...records.entries()].sort(compareEntries)) {
      const reference = externalReference(record);
      if (reference === null || reference.calendarId !== calendarId) continue;
      await this.provider.deleteEvent?.(reference);
      await this.removeRecord(internalItemId);
      deleted += 1;
    }
    return deleted;
  }

  private async projectEligibleNodes(
    nodes: readonly RoadmapNode[],
  ): Promise<Map<string, CalendarEventProjection>> {
    const events = new Map<string, CalendarEventProjection>();
    for (const node of nodes) {
      const beforeIdentity = this.identities.findIdentity(node);
      const beforeContext = this.getContext();
      const beforeOverride = beforeIdentity === undefined
        ? undefined
        : beforeContext.state.itemOverrides[beforeIdentity];
      const eligibility = projectionOptions(beforeContext, beforeOverride);
      if (!isCalendarEligible(node, eligibility)) continue;

      const identity = await this.identities.ensureIdentity(node);
      if (identity === null) continue;
      const context = this.getContext();
      const override = context.state.itemOverrides[identity.internalItemId] ?? beforeOverride;
      const event = projectCalendarEvent(
        identity.node,
        identity.internalItemId,
        projectionOptions(context, override),
      );
      if (event !== null) events.set(identity.internalItemId, event);
    }
    return events;
  }

  private async createAndStore(
    calendarId: string,
    event: CalendarEventProjection,
    hash: string,
  ): Promise<void> {
    const reference = await this.provider.createEvent?.(calendarId, event);
    if (reference === undefined) {
      throw new Error(`${this.provider.displayName} cannot create calendar events.`);
    }
    await this.storeRecord(reference, event, hash);
  }

  private async storeRecord(
    reference: ExternalCalendarEventRef,
    event: CalendarEventProjection,
    hash: string,
  ): Promise<void> {
    const records = { ...this.getContext().state.syncRecords };
    records[syncRecordKey(event.internalItemId)] = {
      internalItemId: event.internalItemId,
      provider: MICROSOFT_PROVIDER_ID,
      externalCalendarId: reference.calendarId,
      externalEventId: reference.eventId,
      lastSyncedHash: hash,
      lastSyncedAt: this.now().toISOString(),
    };
    await this.saveRecords(records);
  }

  private async removeRecord(internalItemId: string): Promise<void> {
    const records = { ...this.getContext().state.syncRecords };
    delete records[syncRecordKey(internalItemId)];
    await this.saveRecords(records);
  }
}

export async function calendarEventHash(event: CalendarEventProjection): Promise<string> {
  const canonical = JSON.stringify({
    semanticType: event.semanticType,
    title: event.title,
    description: event.description,
    startDate: event.startDate,
    endDateExclusive: event.endDateExclusive,
    allDay: event.allDay,
    availability: event.availability,
    reminderMinutes: event.reminderMinutes,
    completed: event.completed,
    overdue: event.overdue,
  });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function projectionOptions(
  context: CalendarSyncContext,
  override: 'include' | 'exclude' | undefined,
) {
  return {
    automaticallyInclude: context.settings.automaticallyInclude,
    remindersEnabled: context.settings.remindersEnabled,
    reminderMinutes: context.settings.reminderMinutes,
    override,
    vaultName: context.vaultName,
  };
}

function microsoftRecords(records: SyncRecords): Map<string, CalendarSyncRecord> {
  return new Map(
    Object.values(records)
      .filter((record) => record.provider === MICROSOFT_PROVIDER_ID)
      .map((record) => [record.internalItemId, record]),
  );
}

function externalReference(record: CalendarSyncRecord): ExternalCalendarEventRef | null {
  return record.externalCalendarId === undefined || record.externalEventId === undefined
    ? null
    : { calendarId: record.externalCalendarId, eventId: record.externalEventId };
}

function syncRecordKey(internalItemId: string): string {
  return `${MICROSOFT_PROVIDER_ID}:${internalItemId}`;
}

function compareEntries<T>(left: readonly [string, T], right: readonly [string, T]): number {
  return left[0].localeCompare(right[0]);
}

function validateProvider(provider: CalendarProvider): void {
  if (
    provider.id !== MICROSOFT_PROVIDER_ID ||
    provider.createEvent === undefined ||
    provider.updateEvent === undefined ||
    provider.deleteEvent === undefined
  ) {
    throw new Error('Microsoft one-way sync requires a writable Microsoft provider.');
  }
}

function isProviderNotFound(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'kind' in error && error.kind === 'not-found';
}
