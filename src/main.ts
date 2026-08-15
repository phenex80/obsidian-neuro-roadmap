import { App, Modal, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import {
  CANONICAL_PROPERTY_FIELDS,
  PRIORITIES,
  SOURCE_SCOPE_MODES,
  propertyMappingSchema,
  roadmapSettingsSchema,
  type CanonicalPropertyField,
  type ColorSettings,
  type CalendarItemOverride,
  type CalendarSemanticType,
  type Priority,
  type PropertyMappings,
  type RoadmapSettings,
  type RoadmapNode,
  type SemanticValueMappings,
  type SourceScopeMode,
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
import { compileSourceScope, hasValidSourceScopeRules } from './core/SourceScope';
import { CalendarIdentityManager } from './core/CalendarIdentity';
import { CalendarExportService, type CalendarExportResult } from './core/CalendarExportService';
import { IcsCalendarProvider } from './calendar/IcsCalendarProvider';
import {
  MicrosoftAuthClient,
  MicrosoftAuthError,
  type MicrosoftAuthConfiguration,
  type MicrosoftDeviceCodeSession,
} from './calendar/MicrosoftAuth';
import { ObsidianMicrosoftHttpTransport } from './calendar/ObsidianMicrosoftHttpTransport';
import {
  MicrosoftCalendarProvider,
  MicrosoftGraphError,
} from './calendar/MicrosoftCalendarProvider';
import { CalendarSyncEngine, type CalendarSyncReport } from './core/CalendarSyncEngine';
import {
  CalendarSyncController,
  type CalendarSyncRuntimeStatus,
} from './core/CalendarSyncController';
import type { CalendarDescriptor } from './core/CalendarProvider';
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
  calendarType: 'Calendar type',
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
const CALENDAR_TYPE_LABELS: Readonly<Record<CalendarSemanticType, string>> = {
  exam: 'Exams',
  'assignment-deadline': 'Assignment deadlines',
  'project-deadline': 'Project deadlines',
  milestone: 'Milestones',
  presentation: 'Presentations',
  'regular-task': 'Regular tasks',
};

export default class NeuroAdaptiveRoadmapPlugin extends Plugin {
  settings: RoadmapSettings = DEFAULT_SETTINGS;
  readonly indexer = new RoadmapIndexer(this.app);
  readonly scheduler = new RoadmapScheduler(this.app, this.indexer);
  readonly calendarIdentity = new CalendarIdentityManager(
    this.app,
    () => this.settings.calendarState.itemIdentities,
    async (itemIdentities) => {
      this.settings.calendarState.itemIdentities = itemIdentities;
      await this.saveSettings(false, false);
    },
  );
  readonly calendarExporter = new CalendarExportService(
    this.calendarIdentity,
    new IcsCalendarProvider(),
  );
  private readonly microsoftTransport = new ObsidianMicrosoftHttpTransport();
  readonly microsoftAuth = new MicrosoftAuthClient(
    this.microsoftTransport,
    {
      getSecret: (id) => this.app.secretStorage.getSecret(id),
      setSecret: (id, secret) => this.app.secretStorage.setSecret(id, secret),
    },
  );
  readonly microsoftProvider = new MicrosoftCalendarProvider(
    () => this.getMicrosoftAuthConfiguration(),
    this.microsoftAuth,
    this.microsoftTransport,
  );
  readonly microsoftSyncEngine = new CalendarSyncEngine(
    this.calendarIdentity,
    this.microsoftProvider,
    () => ({
      settings: this.settings.calendar,
      state: this.settings.calendarState,
      calendarId: this.settings.calendarState.microsoft.selectedCalendarId ?? '',
      vaultName: this.app.vault.getName(),
    }),
    async (syncRecords) => {
      this.settings.calendarState.syncRecords = syncRecords;
      await this.saveSettings(false, false);
    },
  );
  readonly microsoftSyncController = new CalendarSyncController(
    (nodes, options) => this.microsoftSyncEngine.reconcile(nodes, options),
    () => this.settings.calendar.microsoft.debounceMs,
    (report) => this.recordMicrosoftSyncSuccess(report),
    (error) => this.recordMicrosoftSyncError(error),
  );
  private readonly settingsListeners = new Set<SettingsListener>();
  private microsoftCalendars: readonly CalendarDescriptor[] = [];
  private activeMicrosoftAuthModal: MicrosoftDeviceCodeModal | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    const parserOptions = this.getParserOptions();
    this.indexer.setParserOptions(parserOptions);
    this.scheduler.setCreationPropertyKeys(parserOptions.propertyKeys);
    await this.indexer.initialize();
    this.indexer.registerEvents((eventRef) => this.registerEvent(eventRef));
    const unsubscribeMicrosoftSync = this.indexer.subscribe((nodes) => {
      if (this.shouldAutoSyncMicrosoft()) {
        this.microsoftSyncController.schedule(nodes);
      }
    });
    this.register(unsubscribeMicrosoftSync);
    if (this.shouldAutoSyncMicrosoft()) {
      void this.microsoftSyncController.syncNow(this.indexer.getNodes()).catch(() => undefined);
    }
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (file instanceof TFile && file.extension.toLocaleLowerCase() === 'md') {
          void this.calendarIdentity.handleFileRename(oldPath, file.path);
        }
      }),
    );
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
    this.activeMicrosoftAuthModal?.close();
    this.activeMicrosoftAuthModal = null;
    this.microsoftSyncController.dispose();
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

  async saveSettings(rebuildIndex = false, scheduleCalendarSync = true): Promise<void> {
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
    if (scheduleCalendarSync && this.shouldAutoSyncMicrosoft()) {
      this.microsoftSyncController.schedule(this.indexer.getNodes());
    }
  }

  subscribeSettings(listener: SettingsListener): () => void {
    this.settingsListeners.add(listener);
    listener(this.settings);
    return () => {
      this.settingsListeners.delete(listener);
    };
  }

  getCalendarOverride(node: RoadmapNode): CalendarItemOverride | undefined {
    const itemId = this.calendarIdentity.findIdentity(node);
    return itemId === undefined ? undefined : this.settings.calendarState.itemOverrides[itemId];
  }

  async setCalendarOverride(
    node: RoadmapNode,
    override: CalendarItemOverride | null,
  ): Promise<void> {
    const identity = await this.calendarIdentity.ensureIdentity(node);
    if (identity === null) {
      return;
    }
    const itemOverrides = { ...this.settings.calendarState.itemOverrides };
    if (override === null) {
      delete itemOverrides[identity.internalItemId];
    } else {
      itemOverrides[identity.internalItemId] = override;
    }
    this.settings.calendarState.itemOverrides = itemOverrides;
    await this.saveSettings();
  }

  async exportCalendar(nodes: readonly RoadmapNode[]): Promise<CalendarExportResult> {
    return this.calendarExporter.export(nodes, {
      settings: this.settings.calendar,
      state: this.settings.calendarState,
      vaultName: this.app.vault.getName(),
    });
  }

  subscribeCalendarSyncStatus(
    listener: (status: CalendarSyncRuntimeStatus) => void,
  ): () => void {
    return this.microsoftSyncController.subscribe(listener);
  }

  isMicrosoftConnected(): boolean {
    const configuration = this.getMicrosoftAuthConfiguration();
    return configuration.clientId.length > 0 && this.microsoftAuth.hasRefreshToken(configuration);
  }

  getMicrosoftCalendars(): readonly CalendarDescriptor[] {
    return this.microsoftCalendars.map((calendar) => ({ ...calendar }));
  }

  async connectMicrosoft(): Promise<boolean> {
    try {
      const configuration = await this.ensureMicrosoftAuthConfiguration();
      const session = await this.microsoftAuth.beginDeviceCode(configuration);
      const authenticated = await this.openMicrosoftDeviceCodeModal(configuration, session);
      if (!authenticated) return false;

      const profile = await this.microsoftProvider.getAccountProfile();
      const previousAccountId = this.settings.calendarState.microsoft.accountId;
      const hasExistingMappings = Object.values(this.settings.calendarState.syncRecords)
        .some((record) => record.provider === 'microsoft');
      if (
        previousAccountId !== undefined &&
        previousAccountId !== profile.id &&
        hasExistingMappings
      ) {
        this.microsoftAuth.disconnect(configuration);
        await this.recordMicrosoftSyncError(new Error(
          'A different Microsoft account was used. Reconnect the original account to preserve existing event mappings.',
        ));
        return false;
      }

      this.settings.calendarState.microsoft.accountId = profile.id;
      this.settings.calendarState.microsoft.accountDisplayName = profile.displayName;
      this.settings.calendarState.microsoft.accountEmail = profile.email;
      delete this.settings.calendarState.microsoft.lastSyncError;
      await this.saveSettings(false, false);
      await this.refreshMicrosoftCalendars();
      return true;
    } catch (error) {
      await this.recordMicrosoftSyncError(error);
      return false;
    }
  }

  async disconnectMicrosoft(): Promise<void> {
    this.microsoftAuth.disconnect(this.getMicrosoftAuthConfiguration());
    this.microsoftCalendars = [];
    await this.saveSettings(false, false);
  }

  async refreshMicrosoftCalendars(): Promise<readonly CalendarDescriptor[]> {
    try {
      this.microsoftCalendars = await this.microsoftProvider.listCalendars();
      const selectedId = this.settings.calendarState.microsoft.selectedCalendarId;
      if (
        selectedId !== undefined &&
        !this.microsoftCalendars.some((calendar) => calendar.id === selectedId)
      ) {
        await this.recordMicrosoftSyncError(new Error(
          'The selected Microsoft calendar no longer exists. Select another calendar.',
        ));
      }
      return this.getMicrosoftCalendars();
    } catch (error) {
      await this.recordMicrosoftSyncError(error);
      return [];
    }
  }

  async createMicrosoftCalendar(name = 'Neuro Roadmap'): Promise<boolean> {
    try {
      const calendar = await this.microsoftProvider.createCalendar(name);
      this.microsoftCalendars = [
        ...this.microsoftCalendars.filter((candidate) => candidate.id !== calendar.id),
        calendar,
      ];
      return this.selectMicrosoftCalendar(calendar.id);
    } catch (error) {
      await this.recordMicrosoftSyncError(error);
      return false;
    }
  }

  async selectMicrosoftCalendar(calendarId: string): Promise<boolean> {
    const calendar = this.microsoftCalendars.find((candidate) => candidate.id === calendarId);
    if (calendar === undefined) {
      await this.recordMicrosoftSyncError(new Error('Refresh the Microsoft calendar list and select a valid calendar.'));
      return false;
    }
    const previousId = this.settings.calendarState.microsoft.selectedCalendarId;
    if (previousId !== undefined && previousId !== calendar.id) {
      try {
        await this.microsoftSyncEngine.releaseCalendar(previousId);
      } catch (error) {
        await this.recordMicrosoftSyncError(error);
        return false;
      }
    }
    this.settings.calendarState.microsoft.selectedCalendarId = calendar.id;
    this.settings.calendarState.microsoft.selectedCalendarName = calendar.name;
    delete this.settings.calendarState.microsoft.lastSyncError;
    await this.saveSettings(false, false);
    if (this.settings.calendar.microsoft.autoSync) {
      try {
        await this.syncMicrosoftCalendar();
      } catch {
        return false;
      }
    }
    return true;
  }

  async syncMicrosoftCalendar(): Promise<CalendarSyncReport> {
    if (!this.isMicrosoftConnected()) {
      throw new Error('Connect Microsoft 365 before synchronization.');
    }
    if (this.settings.calendarState.microsoft.selectedCalendarId === undefined) {
      throw new Error('Select a Microsoft calendar before synchronization.');
    }
    return this.microsoftSyncController.syncNow(this.indexer.getNodes());
  }

  getMicrosoftConnectionLabel(): string {
    const error = this.settings.calendarState.microsoft.lastSyncError;
    if (!this.isMicrosoftConnected()) {
      return error === undefined ? 'Not connected' : `Not connected · ${error}`;
    }
    if (error !== undefined && isAuthenticationErrorMessage(error)) {
      return `Authentication expired/error: ${error}`;
    }
    const account = this.settings.calendarState.microsoft.accountEmail
      ?? this.settings.calendarState.microsoft.accountDisplayName;
    return account === undefined ? 'Connected (not yet verified)' : `Connected as ${account}`;
  }

  getParserOptions(): RoadmapParserOptions {
    return {
      propertyKeys: compilePropertyKeyMap(this.settings.propertyMappings),
      semanticValues: compileSemanticValueMap(this.settings.valueMappings),
      excludedTemplateValues: parseCommaSeparatedValues(this.settings.excludedTemplateValues),
      excludedPathPrefixes: parsePathPrefixes(this.settings.excludedPathPrefixes),
      sourceScope: compileSourceScope(
        this.settings.sourceScopeMode,
        this.settings.sourceScopeRules,
      ),
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

  private getMicrosoftAuthConfiguration(): MicrosoftAuthConfiguration {
    return {
      clientId: this.settings.calendar.microsoft.clientId,
      tenant: this.settings.calendar.microsoft.tenant,
      refreshTokenSecretId: this.settings.calendarState.microsoft.refreshTokenSecretId ?? '',
    };
  }

  private async ensureMicrosoftAuthConfiguration(): Promise<MicrosoftAuthConfiguration> {
    if (this.settings.calendarState.microsoft.refreshTokenSecretId === undefined) {
      this.settings.calendarState.microsoft.refreshTokenSecretId =
        `neuro-roadmap-ms-${crypto.randomUUID().replaceAll('-', '')}`;
      await this.saveSettings(false, false);
    }
    return this.getMicrosoftAuthConfiguration();
  }

  private shouldAutoSyncMicrosoft(): boolean {
    return (
      this.settings.calendar.microsoft.autoSync &&
      this.settings.calendarState.microsoft.selectedCalendarId !== undefined &&
      this.isMicrosoftConnected()
    );
  }

  private async recordMicrosoftSyncSuccess(report: CalendarSyncReport): Promise<void> {
    this.settings.calendarState.microsoft.lastSyncAt = report.completedAt;
    delete this.settings.calendarState.microsoft.lastSyncError;
    await this.saveSettings(false, false);
  }

  private async recordMicrosoftSyncError(error: unknown): Promise<void> {
    this.settings.calendarState.microsoft.lastSyncError = safeMicrosoftErrorMessage(error);
    await this.saveSettings(false, false);
  }

  private openMicrosoftDeviceCodeModal(
    configuration: MicrosoftAuthConfiguration,
    session: MicrosoftDeviceCodeSession,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const modal = new MicrosoftDeviceCodeModal(
        this.app,
        session,
        (signal) => this.microsoftAuth.completeDeviceCode(configuration, session, signal),
        (authenticated) => {
          if (this.activeMicrosoftAuthModal === modal) {
            this.activeMicrosoftAuthModal = null;
          }
          resolve(authenticated);
        },
      );
      this.activeMicrosoftAuthModal?.close();
      this.activeMicrosoftAuthModal = modal;
      modal.open();
    });
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

    containerEl.createEl('h3', { text: 'Hard exclusions' });
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
      .setDesc('Hard exclusion: files under these vault paths are never indexed, even when they match source scope rules.')
      .addTextArea((text) =>
        text
          .setPlaceholder('40 Systém/Šablóny')
          .setValue(this.plugin.settings.excludedPathPrefixes)
          .onChange(async (value) => {
            this.plugin.settings.excludedPathPrefixes = value;
            await this.plugin.saveSettings(true);
          }),
      );

    containerEl.createEl('h3', { text: 'Roadmap source scope' });
    containerEl.createEl('p', {
      text: 'Choose which remaining Markdown documents Neuro Roadmap indexes for tasks and roadmap data.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Index documents')
      .setDesc('All files preserves existing behavior. Rules mode indexes only documents matching at least one source rule.')
      .addDropdown((dropdown) => {
        dropdown.addOption('all', 'All Markdown files');
        dropdown.addOption('rules', 'Only matching documents');
        dropdown
          .setValue(this.plugin.settings.sourceScopeMode)
          .onChange(async (value) => {
            if (isSourceScopeMode(value)) {
              this.plugin.settings.sourceScopeMode = value;
              await this.plugin.saveSettings(true);
              this.display();
            }
          });
      });

    if (this.plugin.settings.sourceScopeMode === 'rules') {
      this.addSourceScopeRules(containerEl);
    }

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

    containerEl.createEl('h3', { text: 'Calendar' });
    containerEl.createEl('p', {
      text: 'Calendar is a one-way projection of meaningful roadmap dates. Markdown remains the source of truth.',
      cls: 'setting-item-description',
    });
    for (const type of Object.keys(CALENDAR_TYPE_LABELS) as CalendarSemanticType[]) {
      new Setting(containerEl)
        .setName(CALENDAR_TYPE_LABELS[type])
        .setDesc(`Automatically include ${CALENDAR_TYPE_LABELS[type].toLocaleLowerCase()} with a usable date.`)
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.calendar.automaticallyInclude[type])
            .onChange(async (value) => {
              this.plugin.settings.calendar.automaticallyInclude[type] = value;
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName('Enable calendar reminders')
      .setDesc('Apply type-specific reminders to ICS and connected calendar providers.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.calendar.remindersEnabled)
          .onChange(async (value) => {
            this.plugin.settings.calendar.remindersEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.calendar.remindersEnabled) {
      this.addCalendarReminderSettings(containerEl);
    }

    this.addMicrosoftCalendarSettings(containerEl);

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
      { key: 'calendarExam', name: 'Calendar: Exam', description: 'Values classified as exams.' },
      { key: 'calendarAssignmentDeadline', name: 'Calendar: Assignment deadline', description: 'Values classified as assignment deadlines.' },
      { key: 'calendarProjectDeadline', name: 'Calendar: Project deadline', description: 'Values classified as project deadlines.' },
      { key: 'calendarMilestone', name: 'Calendar: Milestone', description: 'Values classified as milestones.' },
      { key: 'calendarPresentation', name: 'Calendar: Presentation', description: 'Values classified as presentations.' },
      { key: 'calendarRegularTask', name: 'Calendar: Regular task', description: 'Values classified as ordinary tasks.' },
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

  private addSourceScopeRules(containerEl: HTMLElement): void {
    if (!hasValidSourceScopeRules(this.plugin.settings.sourceScopeRules)) {
      new Setting(containerEl)
        .setName('No valid source rules')
        .setDesc('Rules mode intentionally produces an empty roadmap until a property and accepted value are provided.');
    }

    for (const [index, rule] of this.plugin.settings.sourceScopeRules.entries()) {
      new Setting(containerEl)
        .setName(`Source rule ${index + 1}`)
        .setDesc('First field: YAML property. Second field: comma-separated accepted values. Matching is exact after normalization.')
        .addText((text) => {
          text
            .setPlaceholder('Property, for example typ')
            .setValue(rule.property)
            .onChange(async (value) => {
              const currentRule = this.plugin.settings.sourceScopeRules[index];
              if (currentRule !== undefined) {
                currentRule.property = value;
                await this.plugin.saveSettings(true);
              }
            });
          text.inputEl.setAttr('aria-label', `Source rule ${index + 1} property`);
        })
        .addText((text) => {
          text
            .setPlaceholder('Values, comma separated')
            .setValue(rule.acceptedValues)
            .onChange(async (value) => {
              const currentRule = this.plugin.settings.sourceScopeRules[index];
              if (currentRule !== undefined) {
                currentRule.acceptedValues = value;
                await this.plugin.saveSettings(true);
              }
            });
          text.inputEl.setAttr('aria-label', `Source rule ${index + 1} accepted values`);
        })
        .addButton((button) =>
          button
            .setIcon('trash-2')
            .setTooltip(`Remove source rule ${index + 1}`)
            .onClick(async () => {
              this.plugin.settings.sourceScopeRules.splice(index, 1);
              await this.plugin.saveSettings(true);
              this.display();
            }),
        );
    }

    new Setting(containerEl)
      .setName('Source rules')
      .setDesc('Rules use OR matching: a document is included when any rule matches.')
      .addButton((button) =>
        button.setButtonText('Add rule').onClick(async () => {
          this.plugin.settings.sourceScopeRules.push({ property: '', acceptedValues: '' });
          await this.plugin.saveSettings(true);
          this.display();
        }),
      );
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

  private addCalendarReminderSettings(containerEl: HTMLElement): void {
    const options: readonly [string, string][] = [
      ['none', 'No reminder'],
      ['0', 'At event time'],
      ['60', '1 hour before'],
      ['1440', '1 day before'],
      ['2880', '2 days before'],
      ['10080', '1 week before'],
    ];
    for (const type of Object.keys(CALENDAR_TYPE_LABELS) as CalendarSemanticType[]) {
      new Setting(containerEl)
        .setName(`${CALENDAR_TYPE_LABELS[type]} reminder`)
        .setDesc('Reminder timing for exported calendar events of this type.')
        .addDropdown((dropdown) => {
          for (const [value, label] of options) {
            dropdown.addOption(value, label);
          }
          const current = this.plugin.settings.calendar.reminderMinutes[type];
          dropdown
            .setValue(current === null ? 'none' : String(current))
            .onChange(async (value) => {
              this.plugin.settings.calendar.reminderMinutes[type] =
                value === 'none' ? null : Number(value);
              await this.plugin.saveSettings();
            });
        });
    }
  }

  private addMicrosoftCalendarSettings(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Microsoft 365 / Outlook' });
    containerEl.createEl('p', {
      text: 'One-way sync only: Markdown owns managed events. Outlook edits are never written back to the vault.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Microsoft 365 through delegated Microsoft Graph permissions.')
      .addText((text) => text.setValue('Microsoft 365').setDisabled(true));

    new Setting(containerEl)
      .setName('Application (client) ID')
      .setDesc('Public-client App Registration ID. No client secret is used or accepted.')
      .addText((text) =>
        text
          .setPlaceholder('00000000-0000-0000-0000-000000000000')
          .setValue(this.plugin.settings.calendar.microsoft.clientId)
          .onChange(async (value) => {
            this.plugin.settings.calendar.microsoft.clientId = value.trim();
            await this.plugin.saveSettings(false, false);
          }),
      );

    new Setting(containerEl)
      .setName('Tenant')
      .setDesc('Use common for work, school, and personal Microsoft accounts, or enter a tenant ID.')
      .addText((text) =>
        text
          .setPlaceholder('common')
          .setValue(this.plugin.settings.calendar.microsoft.tenant)
          .onChange(async (value) => {
            const tenant = value.trim();
            if (tenant.length > 0) {
              this.plugin.settings.calendar.microsoft.tenant = tenant;
              await this.plugin.saveSettings(false, false);
            }
          }),
      );

    const connection = new Setting(containerEl)
      .setName('Connection')
      .setDesc(this.plugin.getMicrosoftConnectionLabel());
    if (this.plugin.isMicrosoftConnected()) {
      connection
        .addButton((button) =>
          button.setButtonText('Reconnect').onClick(async () => {
            await this.plugin.connectMicrosoft();
            this.display();
          }),
        )
        .addButton((button) =>
          button.setButtonText('Disconnect').setWarning().onClick(async () => {
            await this.plugin.disconnectMicrosoft();
            this.display();
          }),
        );
    } else {
      connection.addButton((button) =>
        button.setButtonText('Connect').setCta().onClick(async () => {
          await this.plugin.connectMicrosoft();
          this.display();
        }),
      );
    }

    if (this.plugin.isMicrosoftConnected()) {
      const calendars = this.plugin.getMicrosoftCalendars();
      const selectedCalendarId = this.plugin.settings.calendarState.microsoft.selectedCalendarId;
      const selectedCalendarName = this.plugin.settings.calendarState.microsoft.selectedCalendarName;
      new Setting(containerEl)
        .setName('Outlook calendar')
        .setDesc('Select an existing calendar. Changing it first removes managed events from the previous calendar.')
        .addDropdown((dropdown) => {
          dropdown.addOption('', 'Select a calendar');
          if (
            selectedCalendarId !== undefined &&
            !calendars.some((calendar) => calendar.id === selectedCalendarId)
          ) {
            dropdown.addOption(selectedCalendarId, selectedCalendarName ?? 'Previously selected calendar');
          }
          for (const calendar of calendars) {
            dropdown.addOption(calendar.id, calendar.primary ? `${calendar.name} (default)` : calendar.name);
          }
          dropdown.setValue(selectedCalendarId ?? '').onChange(async (value) => {
            if (value.length > 0) await this.plugin.selectMicrosoftCalendar(value);
            this.display();
          });
        })
        .addButton((button) =>
          button.setButtonText('Refresh list').onClick(async () => {
            await this.plugin.refreshMicrosoftCalendars();
            this.display();
          }),
        );

      new Setting(containerEl)
        .setName('Dedicated calendar')
        .setDesc('Creates “Neuro Roadmap” only after this explicit action, then selects it for sync.')
        .addButton((button) =>
          button.setButtonText('Create and select').onClick(async () => {
            await this.plugin.createMicrosoftCalendar();
            this.display();
          }),
        );

      new Setting(containerEl)
        .setName('Automatic synchronization')
        .setDesc('Debounce roadmap changes and reconcile them without waiting for an Obsidian restart.')
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.calendar.microsoft.autoSync)
            .onChange(async (value) => {
              this.plugin.settings.calendar.microsoft.autoSync = value;
              await this.plugin.saveSettings();
            }),
        );

      const lastSyncAt = this.plugin.settings.calendarState.microsoft.lastSyncAt;
      const lastSyncError = this.plugin.settings.calendarState.microsoft.lastSyncError;
      new Setting(containerEl)
        .setName('Synchronization')
        .setDesc(
          lastSyncError !== undefined
            ? `Sync error: ${lastSyncError}`
            : lastSyncAt === undefined
              ? 'Not synchronized yet.'
              : `Last sync: ${formatTimestamp(lastSyncAt)}`,
        )
        .addButton((button) =>
          button
            .setButtonText('Sync now')
            .setDisabled(selectedCalendarId === undefined)
            .onClick(async () => {
              try {
                await this.plugin.syncMicrosoftCalendar();
              } catch {
                // The controller persists and surfaces the actionable error state.
              }
              this.display();
            }),
        );
    }

    new Setting(containerEl)
      .setName('Credential storage')
      .setDesc('Refresh tokens are stored in Obsidian SecretStorage. Access tokens stay in memory and are never written to plugin data or logs.');
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

class MicrosoftDeviceCodeModal extends Modal {
  private readonly abortController = new AbortController();
  private settled = false;
  private authenticated = false;

  constructor(
    app: App,
    private readonly session: MicrosoftDeviceCodeSession,
    private readonly complete: (signal: AbortSignal) => Promise<unknown>,
    private readonly resolve: (authenticated: boolean) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle('Connect Microsoft 365');
    this.contentEl.createEl('p', { text: this.session.message });
    const code = this.contentEl.createEl('code', { text: this.session.userCode });
    code.setAttr('aria-label', 'Microsoft device sign-in code');
    const actions = new Setting(this.contentEl);
    const link = actions.controlEl.createEl('a', {
      text: 'Open Microsoft sign-in',
      href: this.session.verificationUri,
    });
    link.setAttr('target', '_blank');
    link.setAttr('rel', 'noopener noreferrer');
    actions.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()));
    const status = this.contentEl.createEl('p', {
      text: 'Waiting for Microsoft authorization…',
      cls: 'setting-item-description',
    });

    void this.complete(this.abortController.signal)
      .then(() => {
        this.authenticated = true;
        status.setText('Authorization completed. Continue to load your calendars.');
        new Setting(this.contentEl).addButton((button) =>
          button.setButtonText('Continue').setCta().onClick(() => this.close()),
        );
      })
      .catch((error: unknown) => {
        if (this.abortController.signal.aborted) return;
        status.setText(safeMicrosoftErrorMessage(error));
        new Setting(this.contentEl).addButton((button) =>
          button.setButtonText('Close').onClick(() => this.close()),
        );
      });
  }

  onClose(): void {
    this.abortController.abort();
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolve(this.authenticated);
    }
  }
}

function appendMappingKey(existing: string, key: string): string {
  const values = parseCommaSeparatedValues(existing);
  if (!values.some((value) => normalizePropertyKey(value) === normalizePropertyKey(key))) {
    values.push(key);
  }
  return values.join(', ');
}

function safeMicrosoftErrorMessage(error: unknown): string {
  const raw = error instanceof MicrosoftAuthError
    ? `${error.kind === 'authentication-expired' ? 'Authentication expired' : 'Authentication error'}: ${error.message}`
    : error instanceof MicrosoftGraphError
      ? `${error.kind.replaceAll('-', ' ')}: ${error.message}`
    : error instanceof Error
      ? error.message
      : 'Microsoft calendar operation failed.';
  return raw
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu, '[token redacted]')
    .slice(0, 500);
}

function isAuthenticationErrorMessage(message: string): boolean {
  return /auth|authorization|token|permission|reconnect|401|403/iu.test(message);
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
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

function isSourceScopeMode(value: string): value is SourceScopeMode {
  return SOURCE_SCOPE_MODES.some((mode) => mode === value);
}
