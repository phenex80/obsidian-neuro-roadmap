import {
  CALENDAR_POLICY_VERSION,
  RECOMMENDED_CALENDAR_POLICY,
  propertyMappingSchema,
  roadmapSettingsSchema,
} from '../types';
import {
  normalizePropertyKey,
  normalizeSemanticValue,
  parseCommaSeparatedValues,
} from './SemanticMapping';

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

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
