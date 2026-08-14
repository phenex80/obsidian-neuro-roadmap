import { App, Modal, Plugin, PluginSettingTab, Setting } from 'obsidian';
import {
  CANONICAL_PROPERTY_FIELDS,
  PRIORITIES,
  propertyMappingSchema,
  roadmapSettingsSchema,
  type CanonicalPropertyField,
  type ColorSettings,
  type Priority,
  type PropertyMappings,
  type RoadmapSettings,
  type SemanticValueMappings,
} from './types';
import { RoadmapIndexer } from './core/Indexer';
import type { RoadmapParserOptions } from './core/Parser';
import {
  compilePropertyKeyMap,
  compileSemanticValueMap,
  normalizePropertyKey,
  parseCommaSeparatedValues,
} from './core/SemanticMapping';
import { RoadmapScheduler } from './core/RoadmapScheduler';
import {
  migrateRoadmapSettingsData,
  withoutRoadmapTemplateValue,
} from './core/SettingsMigration';
import { GlobalItemView, VIEW_TYPE_NEURO_ROADMAP } from './ui/views/GlobalItemView';
import { registerRoadmapCodeblockProcessor } from './ui/processors/CodeblockProcessor';

const DEFAULT_SETTINGS: RoadmapSettings = roadmapSettingsSchema.parse({});
const PROPERTY_LABELS: Readonly<Record<CanonicalPropertyField, string>> = {
  title: 'Title',
  subject: 'Subject',
  semester: 'Semester',
  project: 'Project / workstream',
  type: 'Type',
  status: 'Status',
  priority: 'Priority',
  startDate: 'Start date',
  dueDate: 'Due date / deadline',
  milestone: 'Milestone',
  durationBuffer: 'Duration buffer',
  parent: 'Parent',
  dependsOn: 'Dependencies',
  hardDependency: 'Hard / fixed date',
};
type SettingsListener = (settings: Readonly<RoadmapSettings>) => void;

export default class NeuroAdaptiveRoadmapPlugin extends Plugin {
  settings: RoadmapSettings = DEFAULT_SETTINGS;
  readonly indexer = new RoadmapIndexer(this.app);
  readonly scheduler = new RoadmapScheduler(this.app, this.indexer);
  private readonly settingsListeners = new Set<SettingsListener>();

  async onload(): Promise<void> {
    await this.loadSettings();
    const parserOptions = this.getParserOptions();
    this.indexer.setParserOptions(parserOptions);
    this.scheduler.setCreationPropertyKeys(parserOptions.propertyKeys);
    await this.indexer.initialize();
    this.indexer.registerEvents((eventRef) => this.registerEvent(eventRef));
    this.registerView(VIEW_TYPE_NEURO_ROADMAP, (leaf) => new GlobalItemView(leaf, this));
    registerRoadmapCodeblockProcessor(this, this.app, this.indexer);
    this.addRibbonIcon('git-branch', 'Open Neuro Roadmap', () => {
      void this.activateRoadmapView();
    });
    this.addCommand({
      id: 'open-neuro-adaptive-roadmap',
      name: 'Open Neuro Roadmap',
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
    const parsedSettings = roadmapSettingsSchema.safeParse(migrateRoadmapSettingsData(savedSettings));
    this.settings = parsedSettings.success ? parsedSettings.data : DEFAULT_SETTINGS;
    this.settings.excludedTemplateValues = withoutRoadmapTemplateValue(
      this.settings.excludedTemplateValues,
    );
  }

  async saveSettings(rebuildIndex = false): Promise<void> {
    this.settings.excludedTemplateValues = withoutRoadmapTemplateValue(
      this.settings.excludedTemplateValues,
    );
    this.settings = roadmapSettingsSchema.parse(this.settings);
    await this.saveData(this.settings);
    if (rebuildIndex) {
      const parserOptions = this.getParserOptions();
      this.indexer.setParserOptions(parserOptions);
      this.scheduler.setCreationPropertyKeys(parserOptions.propertyKeys);
      await this.indexer.rebuild();
    }
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

  getParserOptions(): RoadmapParserOptions {
    return {
      propertyKeys: compilePropertyKeyMap(this.settings.propertyMappings),
      semanticValues: compileSemanticValueMap(this.settings.valueMappings),
      excludedTemplateValues: parseCommaSeparatedValues(this.settings.excludedTemplateValues),
      excludedPathPrefixes: parsePathPrefixes(this.settings.excludedPathPrefixes),
      defaultDurationBuffer: this.settings.defaultDurationBuffer,
      defaultPriority: this.settings.defaultPriority,
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
    containerEl.createEl('h2', { text: 'Neuro Roadmap settings' });

    new Setting(containerEl)
      .setName('Enable color coding')
      .setDesc('Use semantic status colors across Dashboard, Gantt, and Horizon.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableColorCoding)
          .onChange(async (value) => {
            this.plugin.settings.enableColorCoding = value;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: 'Property mapping' });
    containerEl.createEl('p', {
      text: 'Comma-separated YAML keys accepted for each canonical meaning. Existing Markdown keys are preserved when the plugin writes updates.',
      cls: 'setting-item-description',
    });

    for (const field of CANONICAL_PROPERTY_FIELDS) {
      new Setting(containerEl)
        .setName(PROPERTY_LABELS[field])
        .setDesc(`Accepted YAML properties for ${PROPERTY_LABELS[field].toLocaleLowerCase()}.`)
        .addText((text) =>
          text
            .setValue(this.plugin.settings.propertyMappings[field])
            .onChange(async (value) => {
              this.plugin.settings.propertyMappings[field] = value;
              await this.plugin.saveSettings(true);
            }),
        );
    }

    new Setting(containerEl)
      .setName('Detect existing properties')
      .setDesc('Inspect cached YAML keys and propose mappings. Nothing is changed without confirmation.')
      .addButton((button) =>
        button.setButtonText('Detect').onClick(() => {
          const suggestions = suggestPropertyMappings(
            this.plugin.indexer.detectFrontmatterPropertyUsage(),
            this.plugin.settings.propertyMappings,
          );
          new PropertyMappingSuggestionModal(this.app, suggestions, async () => {
            for (const suggestion of suggestions) {
              const current = this.plugin.settings.propertyMappings[suggestion.field];
              this.plugin.settings.propertyMappings[suggestion.field] = appendMappingKey(
                current,
                suggestion.key,
              );
            }
            await this.plugin.saveSettings(true);
            this.display();
          }).open();
        }),
      );

    new Setting(containerEl)
      .setName('Excluded template values')
      .setDesc('Values of the mapped Type property that identify real templates. “roadmapa” is always treated as a valid roadmap note.')
      .addText((text) =>
        text
          .setPlaceholder('template, šablóna, sablona')
          .setValue(this.plugin.settings.excludedTemplateValues)
          .onChange(async (value) => {
            this.plugin.settings.excludedTemplateValues = value;
            await this.plugin.saveSettings(true);
          }),
      );

    new Setting(containerEl)
      .setName('Excluded folders / paths')
      .setDesc('Comma- or newline-separated vault path prefixes ignored before parsing, including inline tasks.')
      .addTextArea((text) =>
        text
          .setPlaceholder('40 Systém/Šablóny')
          .setValue(this.plugin.settings.excludedPathPrefixes)
          .onChange(async (value) => {
            this.plugin.settings.excludedPathPrefixes = value;
            await this.plugin.saveSettings(true);
          }),
      );

    containerEl.createEl('h3', { text: 'Value mapping' });
    this.addValueMappingSettings(containerEl, this.plugin.settings.valueMappings);

    containerEl.createEl('h3', { text: 'Planning defaults' });
    new Setting(containerEl)
      .setName('Default duration buffer')
      .setDesc('Multiplier applied to scheduled task durations.')
      .addText((text) =>
        text
          .setPlaceholder('1.3')
          .setValue(String(this.plugin.settings.defaultDurationBuffer))
          .onChange(async (value) => {
            const buffer = Number(value);
            if (Number.isFinite(buffer) && buffer > 0) {
              this.plugin.settings.defaultDurationBuffer = buffer;
              await this.plugin.saveSettings(true);
            }
          }),
      );

    new Setting(containerEl)
      .setName('Default priority')
      .setDesc('Priority assigned when Markdown contains no mapped value.')
      .addDropdown((dropdown) => {
        for (const priority of PRIORITIES) {
          dropdown.addOption(priority, formatLabel(priority));
        }
        dropdown
          .setValue(this.plugin.settings.defaultPriority)
          .onChange(async (value) => {
            const parsedPriority = PRIORITIES.find((priority) => priority === value);
            if (parsedPriority !== undefined) {
              this.plugin.settings.defaultPriority = parsedPriority;
              await this.plugin.saveSettings(true);
            }
          });
      });

    this.addNumberSetting(
      containerEl,
      'Horizon “Next” window',
      'Number of upcoming days shown in Next. This is a UX default, not a clinical claim.',
      this.plugin.settings.horizonNextDays,
      1,
      90,
      async (value) => {
        this.plugin.settings.horizonNextDays = value;
        await this.plugin.saveSettings();
      },
    );
    this.addNumberSetting(
      containerEl,
      'Critical horizon',
      'Incomplete tasks due within this many days are promoted to Now. Use 0 for today only.',
      this.plugin.settings.horizonCriticalDays,
      0,
      30,
      async (value) => {
        this.plugin.settings.horizonCriticalDays = value;
        await this.plugin.saveSettings();
      },
    );
    this.addNumberSetting(
      containerEl,
      'Overdue preview limit',
      'Maximum overdue cards shown in Now before the Show all control appears.',
      this.plugin.settings.horizonOverduePreviewLimit,
      1,
      50,
      async (value) => {
        this.plugin.settings.horizonOverduePreviewLimit = value;
        await this.plugin.saveSettings();
      },
    );

    containerEl.createEl('h3', { text: 'Colors' });
    this.addColorSettings(containerEl, this.plugin.settings.colors);
  }

  private addValueMappingSettings(containerEl: HTMLElement, mappings: SemanticValueMappings): void {
    const settings: readonly {
      key: keyof SemanticValueMappings;
      name: string;
      description: string;
    }[] = [
      { key: 'statusTodo', name: 'Status: Todo', description: 'Values normalized to Todo.' },
      { key: 'statusInProgress', name: 'Status: In progress', description: 'Values normalized to In Progress.' },
      { key: 'statusDone', name: 'Status: Done', description: 'Values normalized to Done.' },
      { key: 'statusUnscheduled', name: 'Status: Unscheduled', description: 'Legacy unscheduled values.' },
      { key: 'priorityHigh', name: 'Priority: High', description: 'Values normalized to High.' },
      { key: 'priorityMedium', name: 'Priority: Medium', description: 'Values normalized to Medium.' },
      { key: 'priorityLow', name: 'Priority: Low', description: 'Values normalized to Low.' },
      { key: 'typeRoadmap', name: 'Type: Roadmap note', description: 'Valid roadmap anchor values.' },
      { key: 'typeProject', name: 'Type: Project', description: 'Project or workstream values.' },
      { key: 'typeMilestone', name: 'Type: Milestone', description: 'Milestone values.' },
      { key: 'typeTask', name: 'Type: Task', description: 'Task values.' },
    ];

    for (const item of settings) {
      new Setting(containerEl)
        .setName(item.name)
        .setDesc(item.description)
        .addText((text) =>
          text.setValue(mappings[item.key]).onChange(async (value) => {
            mappings[item.key] = value;
            await this.plugin.saveSettings(true);
          }),
        );
    }
  }

  private addColorSettings(containerEl: HTMLElement, colors: ColorSettings): void {
    const settings: readonly { key: keyof ColorSettings; name: string }[] = [
      { key: 'todo', name: 'Todo' },
      { key: 'inProgress', name: 'In Progress' },
      { key: 'done', name: 'Done' },
      { key: 'overdue', name: 'Overdue / warning' },
      { key: 'priorityHigh', name: 'Priority: High' },
      { key: 'priorityMedium', name: 'Priority: Medium' },
      { key: 'priorityLow', name: 'Priority: Low' },
    ];

    for (const item of settings) {
      new Setting(containerEl)
        .setName(item.name)
        .setDesc(`Semantic color for ${item.name.toLocaleLowerCase()}.`)
        .addColorPicker((picker) =>
          picker.setValue(colors[item.key]).onChange(async (value) => {
            colors[item.key] = value;
            await this.plugin.saveSettings();
          }),
        );
    }
  }

  private addNumberSetting(
    containerEl: HTMLElement,
    name: string,
    description: string,
    currentValue: number,
    minimum: number,
    maximum: number,
    onChange: (value: number) => Promise<void>,
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) =>
        text.setValue(String(currentValue)).onChange(async (value) => {
          const parsed = Number(value);
          if (Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum) {
            await onChange(parsed);
          }
        }),
      );
  }
}

interface PropertySuggestion {
  readonly field: CanonicalPropertyField;
  readonly key: string;
  readonly count: number;
}

class PropertyMappingSuggestionModal extends Modal {
  constructor(
    app: App,
    private readonly suggestions: readonly PropertySuggestion[],
    private readonly onApply: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle('Detected property mappings');
    if (this.suggestions.length === 0) {
      this.contentEl.createEl('p', {
        text: 'No recognized, currently unmapped YAML keys were found in the metadata cache.',
      });
      new Setting(this.contentEl).addButton((button) =>
        button.setButtonText('Close').onClick(() => this.close()),
      );
      return;
    }

    this.contentEl.createEl('p', {
      text: 'Review the proposals below. Apply only adds aliases to settings; it never rewrites notes.',
    });
    const list = this.contentEl.createEl('ul');
    for (const suggestion of this.suggestions) {
      list.createEl('li', {
        text: `${suggestion.key} → ${PROPERTY_LABELS[suggestion.field]} (${suggestion.count} files)`,
      });
    }
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText('Apply suggestions')
          .setCta()
          .onClick(async () => {
            await this.onApply();
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function appendMappingKey(existing: string, key: string): string {
  const values = parseCommaSeparatedValues(existing);
  if (!values.some((value) => normalizePropertyKey(value) === normalizePropertyKey(key))) {
    values.push(key);
  }
  return values.join(', ');
}

function suggestPropertyMappings(
  usage: ReadonlyMap<string, number>,
  currentMappings: PropertyMappings,
): PropertySuggestion[] {
  const defaults = propertyMappingSchema.parse({});
  const currentKeys = new Set(
    CANONICAL_PROPERTY_FIELDS.flatMap((field) =>
      parseCommaSeparatedValues(currentMappings[field]).map(normalizePropertyKey),
    ),
  );
  const knownFieldByKey = new Map<string, CanonicalPropertyField>();
  for (const field of CANONICAL_PROPERTY_FIELDS) {
    for (const key of parseCommaSeparatedValues(defaults[field])) {
      knownFieldByKey.set(normalizePropertyKey(key), field);
    }
  }

  return Array.from(usage.entries())
    .map(([key, count]): PropertySuggestion | undefined => {
      const normalizedKey = normalizePropertyKey(key);
      const field = knownFieldByKey.get(normalizedKey);
      return field === undefined || currentKeys.has(normalizedKey)
        ? undefined
        : { field, key, count };
    })
    .filter((suggestion): suggestion is PropertySuggestion => suggestion !== undefined)
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function formatLabel(priority: Priority): string {
  return `${priority.charAt(0).toUpperCase()}${priority.slice(1)}`;
}

function parsePathPrefixes(value: string): string[] {
  return value
    .split(/[,\n]/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
