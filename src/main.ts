import { App, Modal, Platform, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import {
  CALENDAR_VERIFICATION_INTERVALS,
  CANONICAL_PROPERTY_FIELDS,
  PRIORITIES,
  RECOMMENDED_CALENDAR_POLICY,
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
  GoogleAuthClient,
  GoogleAuthError,
  type GoogleAuthConfiguration,
  type GoogleAuthorizationSession,
} from './calendar/GoogleAuth';
import { ObsidianCalendarHttpTransport } from './calendar/CalendarHttpTransport';
import {
  GoogleCalendarError,
  GoogleCalendarProvider,
} from './calendar/GoogleCalendarProvider';
import {
  startGoogleLoopbackServer,
  type GoogleLoopbackSession,
} from './calendar/GoogleLoopbackServer';
import type { CalendarDescriptor } from './core/CalendarProvider';
import { CalendarSyncEngine, type CalendarSyncReport } from './core/CalendarSyncEngine';
import {
  CalendarSyncController,
  type CalendarSyncRuntimeStatus,
} from './core/CalendarSyncController';
import {
  migrateRoadmapSettingsData,
  needsCalendarPolicyMigration,
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
  private readonly calendarTransport = new ObsidianCalendarHttpTransport();
  readonly googleAuth = new GoogleAuthClient(
    this.calendarTransport,
    {
      getSecret: (id) => this.app.secretStorage.getSecret(id),
      setSecret: (id, secret) => this.app.secretStorage.setSecret(id, secret),
    },
  );
  readonly googleProvider = new GoogleCalendarProvider(
    () => this.getGoogleAuthConfiguration(),
    this.googleAuth,
    this.calendarTransport,
  );
  readonly googleSyncEngine = new CalendarSyncEngine(
    this.calendarIdentity,
    this.googleProvider,
    () => ({
      settings: this.settings.calendar,
      state: this.settings.calendarState,
      calendarId: this.settings.calendarState.google.selectedCalendarId ?? '',
      vaultName: this.app.vault.getName(),
    }),
    async (syncRecords) => {
      this.settings.calendarState.syncRecords = syncRecords;
      await this.saveSettings(false, false);
    },
  );
  readonly googleSyncController = new CalendarSyncController({
    reconcile: (nodes, options) => this.googleSyncEngine.reconcile(nodes, options),
    onDirty: () => this.markGoogleSyncDirty(),
    onSuccess: (report, clearDirty) => this.recordGoogleSyncSuccess(report, clearDirty),
    onError: (error) => this.recordGoogleSyncError(error),
  });
  private readonly settingsListeners = new Set<SettingsListener>();
  private googleCalendars: readonly CalendarDescriptor[] = [];
  private activeGoogleAuthModal: GoogleAuthorizationModal | null = null;
  private activeGoogleLoopback: GoogleLoopbackSession | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    const parserOptions = this.getParserOptions();
    this.indexer.setParserOptions(parserOptions);
    this.scheduler.setCreationPropertyKeys(parserOptions.propertyKeys);
    await this.indexer.initialize();
    this.indexer.registerEvents((eventRef) => this.registerEvent(eventRef));
    let initialIndexEmission = true;
    const unsubscribeGoogleSync = this.indexer.subscribe((nodes) => {
      if (initialIndexEmission) {
        initialIndexEmission = false;
        return;
      }
      if (this.shouldAutoSyncGoogle()) {
        this.googleSyncController.schedule(nodes);
      }
    });
    this.register(unsubscribeGoogleSync);
    this.configureGoogleVerification();
    if (this.shouldAutoSyncGoogle()) {
      void this.googleSyncController.syncStartup(this.indexer.getNodes()).catch(() => undefined);
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
    this.activeGoogleAuthModal?.close();
    this.activeGoogleAuthModal = null;
    this.activeGoogleLoopback?.close();
    this.activeGoogleLoopback = null;
    this.googleSyncController.dispose();
    this.settingsListeners.clear();
    this.indexer.clear();
  }

  async loadSettings(): Promise<void> {
    const savedSettings: unknown = await this.loadData();
    const persistCalendarMigration = needsCalendarPolicyMigration(savedSettings);
    const parsedSettings = roadmapSettingsSchema.safeParse(migrateRoadmapSettingsData(savedSettings));
    this.settings = parsedSettings.success ? parsedSettings.data : DEFAULT_SETTINGS;
    this.settings.excludedTemplateValues = withoutRoadmapTemplateValue(
      this.settings.excludedTemplateValues,
    );
    if (persistCalendarMigration) {
      await this.saveData(this.settings);
    }
  }

  async saveSettings(rebuildIndex = false, scheduleCalendarSync = false): Promise<void> {
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
    this.configureGoogleVerification();
    if (scheduleCalendarSync && this.shouldAutoSyncGoogle()) {
      this.googleSyncController.schedule(this.indexer.getNodes());
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
    await this.saveSettings(false, true);
  }

  async resetCalendarItemOverrides(): Promise<void> {
    if (Object.keys(this.settings.calendarState.itemOverrides).length === 0) return;
    this.settings.calendarState.itemOverrides = {};
    await this.saveSettings(false, true);
  }

  async useRecommendedCalendarPolicy(): Promise<void> {
    this.settings.calendar.automaticallyInclude = { ...RECOMMENDED_CALENDAR_POLICY };
    await this.saveSettings(false, true);
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
    return this.googleSyncController.subscribe(listener);
  }

  getCalendarSyncStatus(): CalendarSyncRuntimeStatus {
    return this.googleSyncController.getStatus();
  }

  isGoogleConnected(): boolean {
    const configuration = this.getGoogleAuthConfiguration();
    return (
      configuration.clientId.length > 0 &&
      configuration.clientSecret.length > 0 &&
      this.googleAuth.hasRefreshToken(configuration)
    );
  }

  isCalendarSyncAvailable(): boolean {
    return this.isGoogleConnected() && this.settings.calendarState.google.selectedCalendarId !== undefined;
  }

  getLastCalendarSyncAt(): string | undefined {
    return this.settings.calendarState.google.lastSyncAt;
  }

  getGoogleCalendars(): readonly CalendarDescriptor[] {
    return this.googleCalendars.map((calendar) => ({ ...calendar }));
  }

  async connectGoogle(): Promise<boolean> {
    if (!Platform.isDesktopApp) {
      await this.recordGoogleSyncError(new Error(
        'Direct Google Calendar connection requires the Obsidian desktop app. Use ICS export on mobile.',
      ));
      return false;
    }

    try {
      const configuration = await this.ensureGoogleAuthConfiguration();
      this.activeGoogleLoopback?.close();
      const loopback = await startGoogleLoopbackServer();
      this.activeGoogleLoopback = loopback;
      const session = await this.googleAuth.beginAuthorization(configuration, loopback.redirectUri);
      const result = await this.openGoogleAuthorizationModal(configuration, session, loopback);
      if (!result.authenticated) {
        this.googleAuth.discardPendingAuthorization();
        if (result.error !== undefined) throw result.error;
        return false;
      }

      const profile = await this.googleProvider.getAccountProfile();
      const previousAccountId = this.settings.calendarState.google.accountId;
      const hasExistingMappings = Object.values(this.settings.calendarState.syncRecords)
        .some((record) => record.provider === this.googleProvider.id);
      if (
        previousAccountId !== undefined &&
        previousAccountId !== profile.id &&
        hasExistingMappings
      ) {
        this.googleAuth.discardPendingAuthorization();
        await this.recordGoogleSyncError(new Error(
          'A different Google account was used. Reconnect the original account to preserve existing event mappings.',
        ));
        return false;
      }

      if (previousAccountId !== undefined && previousAccountId !== profile.id) {
        delete this.settings.calendarState.google.selectedCalendarId;
        delete this.settings.calendarState.google.selectedCalendarName;
        delete this.settings.calendarState.google.lastSyncAt;
      }

      this.googleAuth.commitPendingAuthorization(configuration);
      this.settings.calendarState.google.accountId = profile.id;
      this.settings.calendarState.google.accountDisplayName = profile.displayName;
      this.settings.calendarState.google.accountEmail = profile.email;
      delete this.settings.calendarState.google.lastSyncError;
      await this.saveSettings(false, false);
      await this.refreshGoogleCalendars();
      return true;
    } catch (error) {
      this.googleAuth.discardPendingAuthorization();
      await this.recordGoogleSyncError(error);
      return false;
    } finally {
      this.activeGoogleLoopback?.close();
      this.activeGoogleLoopback = null;
    }
  }

  async disconnectGoogle(): Promise<boolean> {
    try {
      await this.googleAuth.disconnect(this.getGoogleAuthConfiguration());
      this.googleCalendars = [];
      delete this.settings.calendarState.google.lastSyncError;
      await this.saveSettings(false, false);
      return true;
    } catch (error) {
      await this.recordGoogleSyncError(error);
      return false;
    }
  }

  async refreshGoogleCalendars(): Promise<readonly CalendarDescriptor[]> {
    try {
      this.googleCalendars = await this.googleProvider.listCalendars();
      const selectedId = this.settings.calendarState.google.selectedCalendarId;
      if (
        selectedId !== undefined &&
        !this.googleCalendars.some((calendar) => calendar.id === selectedId)
      ) {
        await this.recordGoogleSyncError(new Error(
          'The selected Google calendar no longer exists or is no longer writable. Select another calendar.',
        ));
      }
      return this.getGoogleCalendars();
    } catch (error) {
      await this.recordGoogleSyncError(error);
      return [];
    }
  }

  async createGoogleCalendar(name = 'Neuro Roadmap'): Promise<boolean> {
    try {
      const createCalendar = this.googleProvider.createCalendar;
      if (createCalendar === undefined) {
        throw new Error('Google Calendar creation is unavailable.');
      }
      const calendar = await createCalendar.call(this.googleProvider, name);
      this.googleCalendars = [
        ...this.googleCalendars.filter((candidate) => candidate.id !== calendar.id),
        calendar,
      ];
      return this.selectGoogleCalendar(calendar.id);
    } catch (error) {
      await this.recordGoogleSyncError(error);
      return false;
    }
  }

  async selectGoogleCalendar(calendarId: string): Promise<boolean> {
    const calendar = this.googleCalendars.find((candidate) => candidate.id === calendarId);
    if (calendar === undefined) {
      await this.recordGoogleSyncError(new Error(
        'Refresh the Google calendar list and select a writable calendar.',
      ));
      return false;
    }
    const previousId = this.settings.calendarState.google.selectedCalendarId;
    if (previousId !== undefined && previousId !== calendar.id) {
      try {
        await this.googleSyncEngine.releaseCalendar(previousId);
      } catch (error) {
        await this.recordGoogleSyncError(error);
        return false;
      }
    }
    this.settings.calendarState.google.selectedCalendarId = calendar.id;
    this.settings.calendarState.google.selectedCalendarName = calendar.name;
    delete this.settings.calendarState.google.lastSyncError;
    await this.saveSettings(false, false);
    if (this.settings.calendar.google.autoSync) {
      try {
        await this.syncGoogleCalendar();
      } catch {
        return false;
      }
    }
    return true;
  }

  async syncGoogleCalendar(): Promise<CalendarSyncReport> {
    if (!this.isGoogleConnected()) {
      throw new Error('Connect Google Calendar before synchronization.');
    }
    if (this.settings.calendarState.google.selectedCalendarId === undefined) {
      throw new Error('Select a Google calendar before synchronization.');
    }
    return this.googleSyncController.syncNow(this.indexer.getNodes());
  }

  getGoogleConnectionLabel(): string {
    const error = this.settings.calendarState.google.lastSyncError;
    if (!this.isGoogleConnected()) {
      return error === undefined ? 'Not connected' : `Not connected · ${error}`;
    }
    if (error !== undefined && isAuthenticationErrorMessage(error)) {
      return `Authentication expired/error: ${error}`;
    }
    const account = this.settings.calendarState.google.accountEmail
      ?? this.settings.calendarState.google.accountDisplayName;
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

  private getGoogleAuthConfiguration(): GoogleAuthConfiguration {
    return {
      clientId: this.settings.calendar.google.clientId,
      clientSecret: this.settings.calendar.google.clientSecret,
      refreshTokenSecretId: this.settings.calendarState.google.refreshTokenSecretId ?? '',
    };
  }

  private async ensureGoogleAuthConfiguration(): Promise<GoogleAuthConfiguration> {
    if (this.settings.calendarState.google.refreshTokenSecretId === undefined) {
      this.settings.calendarState.google.refreshTokenSecretId =
        `neuro-roadmap-google-${crypto.randomUUID().replaceAll('-', '')}`;
      await this.saveSettings(false, false);
    }
    return this.getGoogleAuthConfiguration();
  }

  private shouldAutoSyncGoogle(): boolean {
    return (
      this.settings.calendar.google.autoSync &&
      this.settings.calendarState.google.selectedCalendarId !== undefined &&
      this.isGoogleConnected()
    );
  }

  private configureGoogleVerification(): void {
    if (!this.shouldAutoSyncGoogle()) {
      this.googleSyncController.pauseAutomaticSync();
      return;
    }
    this.googleSyncController.configureVerification(
      () => this.indexer.getNodes(),
      this.settings.calendar.verificationIntervalMinutes,
    );
  }

  private async markGoogleSyncDirty(): Promise<void> {
    if (this.settings.calendarState.calendarSyncDirty) return;
    this.settings.calendarState.calendarSyncDirty = true;
    await this.saveData(this.settings);
  }

  private async recordGoogleSyncSuccess(
    report: CalendarSyncReport,
    clearDirty: boolean,
  ): Promise<void> {
    this.settings.calendarState.google.lastSyncAt = report.completedAt;
    if (clearDirty) this.settings.calendarState.calendarSyncDirty = false;
    delete this.settings.calendarState.google.lastSyncError;
    await this.saveSettings(false, false);
  }

  private async recordGoogleSyncError(error: unknown): Promise<void> {
    this.settings.calendarState.google.lastSyncError = safeGoogleErrorMessage(error);
    await this.saveSettings(false, false);
  }

  private openGoogleAuthorizationModal(
    configuration: GoogleAuthConfiguration,
    session: GoogleAuthorizationSession,
    loopback: GoogleLoopbackSession,
  ): Promise<GoogleAuthorizationResult> {
    return new Promise((resolve) => {
      const modal = new GoogleAuthorizationModal(
        this.app,
        session.authorizationUrl,
        async () => {
          const response = await loopback.response;
          await this.googleAuth.completeAuthorization(
            configuration,
            session,
            response,
            false,
          );
        },
        (result) => {
          if (this.activeGoogleAuthModal === modal) {
            this.activeGoogleAuthModal = null;
          }
          resolve(result);
        },
      );
      this.activeGoogleAuthModal?.close();
      this.activeGoogleAuthModal = modal;
      modal.open();
    });
  }
}

class NeuroAdaptiveRoadmapSettingTab extends PluginSettingTab {
  private unsubscribeCalendarSyncStatus: (() => void) | null = null;

  constructor(
    app: App,
    private readonly plugin: NeuroAdaptiveRoadmapPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.unsubscribeCalendarSyncStatus?.();
    this.unsubscribeCalendarSyncStatus = null;
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

    containerEl.createEl('h3', { text: 'Automatically add to calendar' });
    containerEl.createEl('p', {
      text: 'Calendar is a one-way projection of meaningful roadmap dates. Markdown remains the source of truth. Hard academic dates are included by default; regular tasks are opt-in.',
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
              await this.plugin.saveSettings(false, true);
            }),
        );
    }

    new Setting(containerEl)
      .setName('Recommended hard-date defaults')
      .setDesc('Include exams, assignment and project deadlines, milestones, and presentations. Keep regular tasks opt-in.')
      .addButton((button) =>
        button.setButtonText('Include all hard dates').onClick(async () => {
          await this.plugin.useRecommendedCalendarPolicy();
          this.display();
        }),
      );

    const overrideCount = Object.keys(this.plugin.settings.calendarState.itemOverrides).length;
    new Setting(containerEl)
      .setName('Calendar item overrides')
      .setDesc(overrideCount === 0
        ? 'No manual item overrides. Items follow the automatic inclusion policy.'
        : `${overrideCount} manual override${overrideCount === 1 ? '' : 's'} currently replace the automatic policy.`)
      .addButton((button) =>
        button
          .setButtonText('Reset calendar item overrides')
          .setWarning()
          .setDisabled(overrideCount === 0)
          .onClick(async () => {
            if (!window.confirm('Remove all manual calendar item overrides and return to automatic inclusion?')) {
              return;
            }
            await this.plugin.resetCalendarItemOverrides();
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('Enable calendar reminders')
      .setDesc('Include RFC 5545 VALARM reminders using the policy for each semantic type.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.calendar.remindersEnabled)
          .onChange(async (value) => {
            this.plugin.settings.calendar.remindersEnabled = value;
            await this.plugin.saveSettings(false, true);
            this.display();
          }),
      );

    if (this.plugin.settings.calendar.remindersEnabled) {
      this.addCalendarReminderSettings(containerEl);
    }

    this.addGoogleCalendarSettings(containerEl);

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
        .setDesc('Reminder timing for projected calendar events of this type.')
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
              await this.plugin.saveSettings(false, true);
            });
        });
    }
  }

  private addGoogleCalendarSettings(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Google Calendar' });
    containerEl.createEl('p', {
      text: Platform.isDesktopApp
        ? 'One-way sync only: Markdown owns managed events. Google Calendar edits are never written back to the vault.'
        : 'Direct Google Calendar sync requires Obsidian desktop. ICS export remains available on mobile.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Provider')
      .setDesc('Google Calendar API through desktop installed-app OAuth with PKCE.')
      .addText((text) => text.setValue('Google Calendar').setDisabled(true));

    new Setting(containerEl)
      .setName('OAuth client ID')
      .setDesc('Desktop OAuth client ID from Google Cloud.')
      .addText((text) =>
        text
          .setPlaceholder('000000000000-example.apps.googleusercontent.com')
          .setValue(this.plugin.settings.calendar.google.clientId)
          .setDisabled(this.plugin.isGoogleConnected())
          .onChange(async (value) => {
            this.plugin.settings.calendar.google.clientId = value.trim();
            await this.plugin.saveSettings(false, false);
          }),
      );

    new Setting(containerEl)
      .setName('OAuth client secret')
      .setDesc('Client secret from the Google Cloud Desktop OAuth client credentials. This is not your Google password or a refresh token.')
      .addText((text) => {
        text.inputEl.type = 'password';
        text
          .setPlaceholder('Google Cloud desktop client secret')
          .setValue(this.plugin.settings.calendar.google.clientSecret)
          .setDisabled(this.plugin.isGoogleConnected())
          .onChange(async (value) => {
            this.plugin.settings.calendar.google.clientSecret = value.trim();
            await this.plugin.saveSettings(false, false);
          });
      });

    const connection = new Setting(containerEl)
      .setName('Connection')
      .setDesc(this.plugin.getGoogleConnectionLabel());
    if (this.plugin.isGoogleConnected()) {
      connection
        .addButton((button) =>
          button
            .setButtonText('Reconnect')
            .setDisabled(!Platform.isDesktopApp)
            .onClick(async () => {
              await this.plugin.connectGoogle();
              this.display();
            }),
        )
        .addButton((button) =>
          button.setButtonText('Disconnect').setWarning().onClick(async () => {
            await this.plugin.disconnectGoogle();
            this.display();
          }),
        );
    } else {
      connection.addButton((button) =>
        button
          .setButtonText('Connect')
          .setCta()
          .setDisabled(
            !Platform.isDesktopApp ||
            this.plugin.settings.calendar.google.clientId.length === 0 ||
            this.plugin.settings.calendar.google.clientSecret.length === 0
          )
          .onClick(async () => {
            await this.plugin.connectGoogle();
            this.display();
          }),
      );
    }

    new Setting(containerEl)
      .setName('Automatic synchronization')
      .setDesc('Changes are synchronized automatically about three seconds after editing.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.calendar.google.autoSync)
          .onChange(async (value) => {
            this.plugin.settings.calendar.google.autoSync = value;
            await this.plugin.saveSettings(false, true);
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName('Calendar verification interval')
      .setDesc('Changes are normally synchronized automatically after editing. This interval periodically verifies the managed calendar as a safety check.')
      .addDropdown((dropdown) => {
        for (const interval of CALENDAR_VERIFICATION_INTERVALS) {
          dropdown.addOption(
            String(interval),
            interval === 0 ? 'Off' : `${interval} min`,
          );
        }
        dropdown
          .setValue(String(this.plugin.settings.calendar.verificationIntervalMinutes))
          .onChange(async (value) => {
            const interval = CALENDAR_VERIFICATION_INTERVALS.find(
              (candidate) => String(candidate) === value,
            );
            if (interval === undefined) return;
            this.plugin.settings.calendar.verificationIntervalMinutes = interval;
            await this.plugin.saveSettings(false, false);
            this.display();
          });
      });

    if (!this.plugin.isGoogleConnected()) return;

    const calendars = this.plugin.getGoogleCalendars();
    const selectedCalendarId = this.plugin.settings.calendarState.google.selectedCalendarId;
    const selectedCalendarName = this.plugin.settings.calendarState.google.selectedCalendarName;
    new Setting(containerEl)
      .setName('Calendar')
      .setDesc('Choose an existing writable calendar. Read-only calendars are not listed.')
      .addDropdown((dropdown) => {
        dropdown.addOption('', calendars.length === 0 ? 'Refresh calendars…' : 'Select calendar…');
        if (
          selectedCalendarId !== undefined &&
          !calendars.some((calendar) => calendar.id === selectedCalendarId)
        ) {
          dropdown.addOption(selectedCalendarId, selectedCalendarName ?? 'Previously selected calendar');
        }
        for (const calendar of calendars) {
          dropdown.addOption(calendar.id, calendar.primary ? `${calendar.name} (primary)` : calendar.name);
        }
        dropdown.setValue(selectedCalendarId ?? '').onChange(async (value) => {
          if (value.length > 0) await this.plugin.selectGoogleCalendar(value);
          this.display();
        });
      })
      .addButton((button) =>
        button.setButtonText('Refresh list').onClick(async () => {
          await this.plugin.refreshGoogleCalendars();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName('Dedicated calendar')
      .setDesc('Creates “Neuro Roadmap” only after this explicit action, then selects it for sync.')
      .addButton((button) =>
        button.setButtonText('Create and select').onClick(async () => {
          await this.plugin.createGoogleCalendar();
          this.display();
        }),
      );

    const lastSyncAt = this.plugin.settings.calendarState.google.lastSyncAt;
    const lastSyncError = this.plugin.settings.calendarState.google.lastSyncError;
    new Setting(containerEl)
      .setName('Last successful sync')
      .setDesc(lastSyncAt === undefined ? 'Not synchronized yet.' : formatTimestamp(lastSyncAt));

    const statusSetting = new Setting(containerEl)
      .setName('Status')
      .setDesc(formatCalendarSyncStatus(
        this.plugin.getCalendarSyncStatus(),
        lastSyncAt,
        lastSyncError,
      ))
      .addButton((button) =>
        button
          .setButtonText('Sync now')
          .setDisabled(selectedCalendarId === undefined)
          .onClick(async () => {
            try {
              await this.plugin.syncGoogleCalendar();
            } catch {
              // CalendarSyncController persists and surfaces the actionable error state.
            }
            this.display();
          }),
      );
    this.unsubscribeCalendarSyncStatus = this.plugin.subscribeCalendarSyncStatus((status) => {
      statusSetting.setDesc(formatCalendarSyncStatus(
        status,
        this.plugin.settings.calendarState.google.lastSyncAt,
        this.plugin.settings.calendarState.google.lastSyncError,
      ));
    });
  }

  hide(): void {
    this.unsubscribeCalendarSyncStatus?.();
    this.unsubscribeCalendarSyncStatus = null;
    super.hide();
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

interface GoogleAuthorizationResult {
  readonly authenticated: boolean;
  readonly error?: unknown;
}

class GoogleAuthorizationModal extends Modal {
  private settled = false;
  private authenticated = false;
  private error: unknown;

  constructor(
    app: App,
    private readonly authorizationUrl: string,
    private readonly complete: () => Promise<void>,
    private readonly resolve: (result: GoogleAuthorizationResult) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle('Connect Google Calendar');
    this.contentEl.createEl('p', {
      text: 'Open Google sign-in in your default browser. After consent, the browser returns securely to a temporary 127.0.0.1 callback and this dialog closes.',
    });
    const actions = new Setting(this.contentEl);
    const link = actions.controlEl.createEl('a', {
      text: 'Open Google sign-in',
      href: this.authorizationUrl,
    });
    link.setAttr('target', '_blank');
    link.setAttr('rel', 'noopener noreferrer');
    actions.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()));
    const status = this.contentEl.createEl('p', {
      text: 'Waiting for Google authorization…',
      cls: 'setting-item-description',
    });

    void this.complete()
      .then(() => {
        this.authenticated = true;
        status.setText('Google Calendar connected.');
        this.close();
      })
      .catch((error: unknown) => {
        this.error = error;
        status.setText(safeGoogleErrorMessage(error));
        new Setting(this.contentEl).addButton((button) =>
          button.setButtonText('Close').onClick(() => this.close()),
        );
      });
  }

  onClose(): void {
    this.contentEl.empty();
    if (this.settled) return;
    this.settled = true;
    this.resolve({ authenticated: this.authenticated, error: this.error });
  }
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

function isSourceScopeMode(value: string): value is SourceScopeMode {
  return SOURCE_SCOPE_MODES.some((mode) => mode === value);
}

function safeGoogleErrorMessage(error: unknown): string {
  const raw = error instanceof GoogleAuthError
    ? `${error.kind === 'authentication-expired' ? 'Authentication expired' : 'Authentication error'}: ${error.message}`
    : error instanceof GoogleCalendarError
      ? `${error.kind.replaceAll('-', ' ')}: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Google Calendar operation failed.';
  return raw
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/(?:1\/\/|ya29\.)[A-Za-z0-9._-]+/gu, '[token redacted]')
    .replace(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/gu, '[token redacted]');
}

function isAuthenticationErrorMessage(value: string): boolean {
  return /auth|token|grant|credential|revok/iu.test(value);
}

function formatTimestamp(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

function formatCalendarSyncStatus(
  status: CalendarSyncRuntimeStatus,
  lastSyncAt: string | undefined,
  lastSyncError?: string,
): string {
  if (status.phase === 'scheduled') return 'Waiting to sync…';
  if (status.phase === 'syncing') return 'Syncing…';
  if (status.phase === 'error') return `Error: ${status.message ?? 'Calendar synchronization failed.'}`;
  if (lastSyncError !== undefined) return `Error: ${lastSyncError}`;
  return lastSyncAt === undefined ? 'Waiting for first synchronization.' : 'Up to date';
}
