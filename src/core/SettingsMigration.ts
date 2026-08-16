import {
  CALENDAR_POLICY_VERSION,
  RECOMMENDED_CALENDAR_POLICY,
  calendarItemOverrideSchema,
  calendarPolicySchema,
  calendarReminderPolicySchema,
  calendarSettingsSchema,
  calendarStateSchema,
  calendarSyncRecordSchema,
  colorSettingsSchema,
  googleCalendarSettingsSchema,
  googleCalendarStateSchema,
  propertyMappingSchema,
  roadmapSettingsSchema,
  semanticValueMappingSchema,
  type RoadmapSettings,
} from '../types';
import {
  normalizePropertyKey,
  normalizeSemanticValue,
  parseCommaSeparatedValues,
} from './SemanticMapping';

interface FieldSchema {
  safeParse(value: unknown):
    | { success: true; data: unknown }
    | { success: false };
}

export interface SettingsNormalizationResult {
  readonly settings: RoadmapSettings;
  readonly recoverable: boolean;
  readonly shouldPersistMigration: boolean;
}

/** Migrates legacy mapping fields without modifying any vault note. */
export function migrateRoadmapSettingsData(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const legacy = value as Record<string, unknown>;
  const existingMappings =
    legacy['propertyMappings'] !== null &&
    typeof legacy['propertyMappings'] === 'object' &&
    !Array.isArray(legacy['propertyMappings'])
      ? (legacy['propertyMappings'] as Record<string, unknown>)
      : {};
  const defaults = propertyMappingSchema.parse({});
  const propertyMappings: Record<string, unknown> = { ...existingMappings };
  const existingCalendar = objectRecord(legacy['calendar']);
  const calendar = existingCalendar['calendarPolicyVersion'] === CALENDAR_POLICY_VERSION
    ? existingCalendar
    : {
        ...existingCalendar,
        calendarPolicyVersion: CALENDAR_POLICY_VERSION,
        automaticallyInclude: { ...RECOMMENDED_CALENDAR_POLICY },
      };

  const legacySubjectKeys = legacy['subjectPropertyKeys'];
  if (propertyMappings['subject'] === undefined && typeof legacySubjectKeys === 'string') {
    propertyMappings['subject'] = legacySubjectKeys;
  }
  const legacyTemplateKey = legacy['templatePropertyKey'];
  if (typeof legacyTemplateKey === 'string') {
    propertyMappings['type'] = appendMappingKey(
      typeof propertyMappings['type'] === 'string' ? propertyMappings['type'] : defaults.type,
      legacyTemplateKey,
    );
  }

  return {
    ...legacy,
    propertyMappings,
    calendar,
    excludedTemplateValues: withoutRoadmapTemplateValue(
      typeof legacy['excludedTemplateValues'] === 'string'
        ? legacy['excludedTemplateValues']
        : roadmapSettingsSchema.parse({}).excludedTemplateValues,
    ),
  };
}

export function needsCalendarPolicyMigration(value: unknown): boolean {
  const root = objectRecord(value);
  const calendar = objectRecord(root['calendar']);
  return calendar['calendarPolicyVersion'] !== CALENDAR_POLICY_VERSION;
}

/**
 * Recovers persisted settings one field at a time so one malformed preference
 * cannot erase valid calendar identities, provider state, or sync records.
 */
export function normalizeRoadmapSettingsData(value: unknown): SettingsNormalizationResult {
  const defaults = roadmapSettingsSchema.parse({});
  const freshInstall = value === null || value === undefined;
  if (!freshInstall && !isObjectRecord(value)) {
    return {
      settings: defaults,
      recoverable: false,
      shouldPersistMigration: false,
    };
  }

  try {
    const shouldPersistMigration = needsCalendarPolicyMigration(value);
    const migrated = objectRecord(migrateRoadmapSettingsData(value));
    const root = normalizeKnownObject(migrated, defaults, roadmapSettingsSchema.shape);

    root['propertyMappings'] = propertyMappingSchema.parse(normalizeKnownObject(
      migrated['propertyMappings'],
      defaults.propertyMappings,
      propertyMappingSchema.shape,
    ));
    root['valueMappings'] = semanticValueMappingSchema.parse(normalizeKnownObject(
      migrated['valueMappings'],
      defaults.valueMappings,
      semanticValueMappingSchema.shape,
    ));
    root['colors'] = colorSettingsSchema.parse(normalizeKnownObject(
      migrated['colors'],
      defaults.colors,
      colorSettingsSchema.shape,
    ));
    root['calendar'] = normalizeCalendarSettings(migrated['calendar'], defaults.calendar);
    root['calendarState'] = normalizeCalendarState(
      migrated['calendarState'],
      defaults.calendarState,
    );

    return {
      settings: roadmapSettingsSchema.parse(root),
      recoverable: true,
      shouldPersistMigration,
    };
  } catch {
    return {
      settings: defaults,
      recoverable: false,
      shouldPersistMigration: false,
    };
  }
}

export function withoutRoadmapTemplateValue(value: string): string {
  return parseCommaSeparatedValues(value)
    .filter((entry) => normalizeSemanticValue(entry) !== normalizeSemanticValue('roadmapa'))
    .join(', ');
}

function appendMappingKey(existing: string, key: string): string {
  const values = parseCommaSeparatedValues(existing);
  if (!values.some((value) => normalizePropertyKey(value) === normalizePropertyKey(key))) {
    values.push(key);
  }
  return values.join(', ');
}

function normalizeCalendarSettings(
  value: unknown,
  defaults: RoadmapSettings['calendar'],
): RoadmapSettings['calendar'] {
  const source = objectRecord(value);
  const normalized = normalizeKnownObject(source, defaults, calendarSettingsSchema.shape);
  normalized['automaticallyInclude'] = calendarPolicySchema.parse(normalizeKnownObject(
    source['automaticallyInclude'],
    defaults.automaticallyInclude,
    calendarPolicySchema.shape,
  ));
  normalized['reminderMinutes'] = calendarReminderPolicySchema.parse(normalizeKnownObject(
    source['reminderMinutes'],
    defaults.reminderMinutes,
    calendarReminderPolicySchema.shape,
  ));
  normalized['google'] = googleCalendarSettingsSchema.parse(normalizeKnownObject(
    source['google'],
    defaults.google,
    googleCalendarSettingsSchema.shape,
  ));
  return calendarSettingsSchema.parse(normalized);
}

function normalizeCalendarState(
  value: unknown,
  defaults: RoadmapSettings['calendarState'],
): RoadmapSettings['calendarState'] {
  const source = objectRecord(value);
  const normalized = normalizeKnownObject(source, defaults, calendarStateSchema.shape);
  normalized['itemIdentities'] = normalizeRecord(source['itemIdentities'], {
    safeParse: (entry) => typeof entry === 'string' && entry.length > 0
      ? { success: true, data: entry }
      : { success: false },
  });
  normalized['itemOverrides'] = normalizeRecord(
    source['itemOverrides'],
    calendarItemOverrideSchema,
  );
  normalized['syncRecords'] = normalizeRecord(source['syncRecords'], calendarSyncRecordSchema);
  normalized['google'] = googleCalendarStateSchema.parse(normalizeKnownObject(
    source['google'],
    defaults.google,
    googleCalendarStateSchema.shape,
  ));
  return calendarStateSchema.parse(normalized);
}

function normalizeKnownObject(
  value: unknown,
  defaults: Readonly<Record<string, unknown>>,
  schemas: Readonly<Record<string, FieldSchema>>,
): Record<string, unknown> {
  const source = objectRecord(value);
  const normalized: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(schemas)) {
    const parsed = schema.safeParse(source[key]);
    if (parsed.success) {
      if (parsed.data !== undefined) normalized[key] = parsed.data;
      continue;
    }
    const fallback = defaults[key];
    if (fallback !== undefined) normalized[key] = fallback;
  }
  return normalized;
}

function normalizeRecord(
  value: unknown,
  entrySchema: FieldSchema,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(objectRecord(value))) {
    const parsed = entrySchema.safeParse(entry);
    if (parsed.success) normalized[key] = parsed.data;
  }
  return normalized;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return isObjectRecord(value) ? value : {};
}
