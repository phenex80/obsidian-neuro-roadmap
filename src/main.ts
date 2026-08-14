import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import {
  PRIORITIES,
  type Priority,
  roadmapSettingsSchema,
  type RoadmapSettings,
} from './types';
import { RoadmapIndexer } from './core/Indexer';
import { RoadmapScheduler } from './core/RoadmapScheduler';
import { GlobalItemView, VIEW_TYPE_NEURO_ROADMAP } from './ui/views/GlobalItemView';
import { registerRoadmapCodeblockProcessor } from './ui/processors/CodeblockProcessor';

const DEFAULT_SETTINGS: RoadmapSettings = roadmapSettingsSchema.parse({});
type SettingsListener = (settings: Readonly<RoadmapSettings>) => void;

export default class NeuroAdaptiveRoadmapPlugin extends Plugin {
  settings: RoadmapSettings = DEFAULT_SETTINGS;
  readonly indexer = new RoadmapIndexer(this.app);
  readonly scheduler = new RoadmapScheduler(this.app, this.indexer);
  private readonly settingsListeners = new Set<SettingsListener>();

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.indexer.initialize();
    this.indexer.registerEvents((eventRef) => this.registerEvent(eventRef));
    this.registerView(VIEW_TYPE_NEURO_ROADMAP, (leaf) => new GlobalItemView(leaf, this));
    registerRoadmapCodeblockProcessor(this, this.app, this.indexer);
    this.addRibbonIcon('git-branch', 'Open Neuro-Adaptive Roadmap', () => {
      void this.activateRoadmapView();
    });
    this.addCommand({
      id: 'open-neuro-adaptive-roadmap',
      name: 'Open Neuro-Adaptive Roadmap',
      callback: () => {
        void this.activateRoadmapView();
      },
    });
    this.addSettingTab(new NeuroAdaptiveRoadmapSettingTab(this.app, this));
  }

  onunload(): void {
    this.settingsListeners.clear();
    this.indexer.clear();
  }

  async loadSettings(): Promise<void> {
    const savedSettings: unknown = await this.loadData();
    const parsedSettings = roadmapSettingsSchema.safeParse(savedSettings);
    this.settings = parsedSettings.success ? parsedSettings.data : DEFAULT_SETTINGS;
  }

  async saveSettings(): Promise<void> {
    this.settings = roadmapSettingsSchema.parse(this.settings);
    await this.saveData(this.settings);
    for (const listener of this.settingsListeners) {
      listener(this.settings);
    }
  }

  subscribeSettings(listener: SettingsListener): () => void {
    this.settingsListeners.add(listener);
    listener(this.settings);
    return () => {
      this.settingsListeners.delete(listener);
    };
  }

  private async activateRoadmapView(): Promise<void> {
    const existingLeaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_NEURO_ROADMAP)[0];
    const leaf = existingLeaf ?? this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE_NEURO_ROADMAP, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }
}

class NeuroAdaptiveRoadmapSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: NeuroAdaptiveRoadmapPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Neuro-Adaptive Roadmap settings' });

    new Setting(containerEl)
      .setName('Enable color coding')
      .setDesc('Use Monday.com status colors for tasks and cards across views.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableColorCoding)
          .onChange(async (value) => {
            this.plugin.settings.enableColorCoding = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Default duration buffer')
      .setDesc('Multiplier applied to scheduled task durations in roadmap views.')
      .addText((text) =>
        text
          .setPlaceholder('1.3')
          .setValue(String(this.plugin.settings.defaultDurationBuffer))
          .onChange(async (value) => {
            const buffer = Number(value);
            if (!Number.isFinite(buffer) || buffer <= 0) {
              return;
            }

            this.plugin.settings.defaultDurationBuffer = buffer;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Default priority')
      .setDesc('Priority assigned to roadmap nodes when none is defined in Markdown.')
      .addDropdown((dropdown) => {
        for (const priority of PRIORITIES) {
          dropdown.addOption(priority, this.formatPriority(priority));
        }

        dropdown
          .setValue(this.plugin.settings.defaultPriority)
          .onChange(async (value) => {
            const parsedPriority = PRIORITIES.find((priority) => priority === value);
            if (parsedPriority === undefined) {
              return;
            }

            this.plugin.settings.defaultPriority = parsedPriority;
            await this.plugin.saveSettings();
          });
      });
  }

  private formatPriority(priority: Priority): string {
    return `${priority.charAt(0).toUpperCase()}${priority.slice(1)}`;
  }
}
