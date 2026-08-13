import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import {
  ENERGY_LEVELS,
  type EnergyLevel,
  roadmapSettingsSchema,
  type RoadmapSettings,
} from './types';
import { RoadmapIndexer } from './core/Indexer';
import { RoadmapScheduler } from './core/RoadmapScheduler';
import { GlobalItemView, VIEW_TYPE_NEURO_ROADMAP } from './ui/views/GlobalItemView';
import { registerRoadmapCodeblockProcessor } from './ui/processors/CodeblockProcessor';

const DEFAULT_SETTINGS: RoadmapSettings = roadmapSettingsSchema.parse({});

export default class NeuroAdaptiveRoadmapPlugin extends Plugin {
  settings: RoadmapSettings = DEFAULT_SETTINGS;
  readonly indexer = new RoadmapIndexer(this.app);
  readonly scheduler = new RoadmapScheduler(this.app, this.indexer);

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
      .setName('Default energy level')
      .setDesc('Energy level assigned to roadmap nodes when none is defined in Markdown.')
      .addDropdown((dropdown) => {
        for (const energyLevel of ENERGY_LEVELS) {
          dropdown.addOption(energyLevel, this.formatEnergyLevel(energyLevel));
        }

        dropdown
          .setValue(this.plugin.settings.defaultEnergyLevel)
          .onChange(async (value) => {
            const parsedEnergyLevel = ENERGY_LEVELS.find((energyLevel) => energyLevel === value);
            if (parsedEnergyLevel === undefined) {
              return;
            }

            this.plugin.settings.defaultEnergyLevel = parsedEnergyLevel;
            await this.plugin.saveSettings();
          });
      });
  }

  private formatEnergyLevel(energyLevel: EnergyLevel): string {
    return `${energyLevel.charAt(0).toUpperCase()}${energyLevel.slice(1)}`;
  }
}
