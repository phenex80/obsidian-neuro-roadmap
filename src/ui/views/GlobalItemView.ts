import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { mount, unmount } from 'svelte';
import Component from './Component.svelte';
import type NeuroAdaptiveRoadmapPlugin from '../../main';
import type { RoadmapSettings } from '../../types';

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
