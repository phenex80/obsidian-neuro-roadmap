import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { mount, unmount } from 'svelte';
import Component from './Component.svelte';
import type NeuroAdaptiveRoadmapPlugin from '../../main';
import type { RoadmapSettings } from '../../types';
import type { CalendarItemOverride, RoadmapNode } from '../../types';
import type { CalendarSyncRuntimeStatus } from '../../core/CalendarSyncController';

export const VIEW_TYPE_NEURO_ROADMAP = 'neuro-adaptive-roadmap';

export class GlobalItemView extends ItemView {
  private component: Record<string, unknown> | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: NeuroAdaptiveRoadmapPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_NEURO_ROADMAP;
  }

  getDisplayText(): string {
    return 'Neuro-Adaptive Roadmap';
  }

  getIcon(): string {
    return 'git-branch';
  }

  async onOpen(): Promise<void> {
    this.component = mount(Component, {
      target: this.contentEl,
      props: {
        app: this.app,
        indexer: this.plugin.indexer,
        scheduler: this.plugin.scheduler,
        initialSettings: this.plugin.settings,
        subscribeSettings: (listener: (settings: Readonly<RoadmapSettings>) => void) =>
          this.plugin.subscribeSettings(listener),
        getCalendarOverride: (node: RoadmapNode) => this.plugin.getCalendarOverride(node),
        setCalendarOverride: (node: RoadmapNode, override: CalendarItemOverride | null) =>
          this.plugin.setCalendarOverride(node, override),
        exportCalendar: (nodes: readonly RoadmapNode[]) => this.plugin.exportCalendar(nodes),
        isMicrosoftConnected: () => this.plugin.isMicrosoftConnected(),
        syncMicrosoftCalendar: () => this.plugin.syncMicrosoftCalendar(),
        subscribeCalendarSyncStatus: (listener: (status: CalendarSyncRuntimeStatus) => void) =>
          this.plugin.subscribeCalendarSyncStatus(listener),
      },
    });
  }

  async onClose(): Promise<void> {
    if (this.component !== null) {
      await unmount(this.component);
      this.component = null;
    }
  }
}
