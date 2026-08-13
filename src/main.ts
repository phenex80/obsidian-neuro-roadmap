import { App, Plugin, PluginSettingTab, Setting } from 'obsidian';
import {
  ENERGY_LEVELS,
  type EnergyLevel,
  roadmapSettingsSchema,
  type RoadmapSettings,
} from './types';

const DEFAULT_SETTINGS: RoadmapSettings = roadmapSettingsSchema.parse({});

export default class NeuroAdaptiveRoadmapPlugin extends Plugin {
  settings: RoadmapSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new NeuroAdaptiveRoadmapSettingTab(this.app, this));
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
