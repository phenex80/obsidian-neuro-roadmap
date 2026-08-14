import type { CalendarEventProjection } from './CalendarCore';
import { isCalendarEligible, projectCalendarEvent } from './CalendarCore';
import type { CalendarIdentityManager } from './CalendarIdentity';
import type { CalendarProvider } from './CalendarProvider';
import type { CalendarSettings, CalendarState, RoadmapNode } from '../types';

export interface CalendarExportContext {
  readonly settings: CalendarSettings;
  readonly state: CalendarState;
  readonly vaultName?: string;
}

export interface CalendarExportResult {
  readonly content: string;
  readonly eventCount: number;
}

/** Projects roadmap nodes through shared policy before handing them to a file provider. */
export class CalendarExportService {
  constructor(
    private readonly identities: CalendarIdentityManager,
    private readonly provider: CalendarProvider,
  ) {}

  async projectNodes(
    nodes: readonly RoadmapNode[],
    context: CalendarExportContext,
  ): Promise<readonly CalendarEventProjection[]> {
    const events: CalendarEventProjection[] = [];
    for (const node of nodes) {
      const existingItemId = this.identities.findIdentity(node);
      const existingOverride = existingItemId === undefined
        ? undefined
        : context.state.itemOverrides[existingItemId];
      const options = {
        automaticallyInclude: context.settings.automaticallyInclude,
        remindersEnabled: context.settings.remindersEnabled,
        reminderMinutes: context.settings.reminderMinutes,
        override: existingOverride,
        vaultName: context.vaultName,
      };
      if (!isCalendarEligible(node, options)) {
        continue;
      }

      const identity = await this.identities.ensureIdentity(node);
      if (identity === null) {
        continue;
      }
      const override = context.state.itemOverrides[identity.internalItemId] ?? existingOverride;
      const event = projectCalendarEvent(identity.node, identity.internalItemId, {
        ...options,
        override,
      });
      if (event !== null) {
        events.push(event);
      }
    }
    return events;
  }

  async export(
    nodes: readonly RoadmapNode[],
    context: CalendarExportContext,
  ): Promise<CalendarExportResult> {
    const events = await this.projectNodes(nodes, context);
    const exportEvents = this.provider.exportEvents;
    if (exportEvents === undefined) {
      throw new Error(`${this.provider.displayName} does not support calendar export.`);
    }
    return {
      content: exportEvents.call(this.provider, events),
      eventCount: events.length,
    };
  }
}
