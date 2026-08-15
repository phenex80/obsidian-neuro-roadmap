import { z } from 'zod';

export const NODE_TYPES = ['roadmap', 'project', 'milestone', 'task'] as const;
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export const NODE_STATUSES = ['todo', 'in-progress', 'done', 'unscheduled'] as const;
export const SOURCE_SCOPE_MODES = ['all', 'rules'] as const;
export const CALENDAR_SEMANTIC_TYPES = [
  'exam',
  'assignment-deadline',
  'project-deadline',
  'milestone',
  'presentation',
  'regular-task',
] as const;

export const CANONICAL_PROPERTY_FIELDS = [
  'title',
  'subject',
  'semester',
  'project',
  'type',
  'calendarType',
  'status',
  'priority',
  'startDate',
  'dueDate',
  'milestone',
  'durationBuffer',
  'parent',
  'dependsOn',
  'hardDependency',
] as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
  const [yearValue, monthValue, dayValue] = value.split('-');
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const dateStringSchema = z
  .string()
  .regex(DATE_PATTERN, 'Expected date in YYYY-MM-DD format')
  .refine(isCalendarDate, {
    message: 'Expected a valid calendar date',
  });

export const wikilinkSchema = z
  .string()
  .trim()
  .regex(/^\[\[[^\]]+\]\]$/, 'Expected an Obsidian wikilink');

export const roadmapNodeFrontmatterSchema = z.object({
  title: z.string().trim().min(1).optional(),
  type: z.enum(NODE_TYPES).default('task'),
  calendar_type: z.enum(CALENDAR_SEMANTIC_TYPES).default('regular-task'),
  semester: z.string().trim().min(1).optional(),
  subject: z.string().trim().min(1).optional(),
  project: z.string().trim().min(1).optional(),
  start_date: dateStringSchema.optional(),
  due_date: dateStringSchema.optional(),
  duration_buffer: z.number().finite().positive().default(1.3),
  priority: z.enum(PRIORITIES).default('medium'),
  status: z.enum(NODE_STATUSES).default('todo'),
  parent: z.string().trim().min(1).optional(),
  depends_on: z.array(z.string().trim().min(1)).default([]),
  hard_dependency: z.boolean().default(false),
});

export const inlineTaskSchema = z.object({
  text: z.string().trim().min(1),
  completed: z.boolean(),
  subject: z.string().trim().min(1).optional(),
  project: z.string().trim().min(1).optional(),
  start: dateStringSchema.optional(),
  due: dateStringSchema.optional(),
  priority: z.enum(PRIORITIES).default('medium'),
  blockId: z.string().trim().min(1).optional(),
});

export const propertyMappingSchema = z.object({
  title: z.string().default('title, názov, nazov, name'),
  subject: z.string().default('predmet, subject, course, module'),
  semester: z.string().default('semester, obdobie, term'),
  project: z.string().default('project, projekt, workstream, work_stream'),
  type: z.string().default('type, typ, kind, category'),
  calendarType: z
    .string()
    .default('calendar_type, calendarType, event_type, eventType, udalosť, udalost'),
  status: z.string().default('status, stav'),
  priority: z.string().default('priority, priorita'),
  startDate: z.string().default('start_date, start, startDate, začiatok, zaciatok'),
  dueDate: z.string().default('due_date, due, dueDate, deadline, termín, termin, odovzdanie'),
  milestone: z.string().default('milestone, míľnik, milnik'),
  durationBuffer: z.string().default('duration_buffer, buffer, durationBuffer'),
  parent: z.string().default('parent, rodič, rodic'),
  dependsOn: z.string().default('depends_on, dependsOn, závisí_od, zavisi_od'),
  hardDependency: z.string().default('hard_dependency, hardDeadline, fixed_date, pevný_termín, pevny_termin'),
});

export const semanticValueMappingSchema = z.object({
  statusTodo: z.string().default('todo, to-do, open, pending, plánované, planovane'),
  statusInProgress: z
    .string()
    .default('in-progress, in progress, active, aktívny, aktivny, prebieha, working, started'),
  statusDone: z
    .string()
    .default('done, completed, complete, hotový, hotovy, hotové, hotove, ukončený, ukonceny, finished, closed'),
  statusUnscheduled: z.string().default('unscheduled, inbox, backlog, neplánované, neplanovane'),
  priorityHigh: z.string().default('high, highest, urgent, vysoká, vysoka, kritická, kriticka'),
  priorityMedium: z.string().default('medium, normal, stredná, stredna'),
  priorityLow: z.string().default('low, lowest, nízka, nizka, someday'),
  typeRoadmap: z.string().default('roadmap, roadmapa'),
  typeProject: z.string().default('project, projekt, workstream'),
  typeMilestone: z.string().default('milestone, míľnik, milnik'),
  typeTask: z.string().default('task, úloha, uloha'),
  calendarExam: z.string().default('exam, skúška, skuska, test'),
  calendarAssignmentDeadline: z
    .string()
    .default('assignment deadline, assignment, zadanie, odovzdanie zadania'),
  calendarProjectDeadline: z
    .string()
    .default('project deadline, project due, projektový termín, projektovy termin'),
  calendarMilestone: z.string().default('milestone, míľnik, milnik'),
  calendarPresentation: z.string().default('presentation, prezentácia, prezentacia'),
  calendarRegularTask: z.string().default('regular task, task, úloha, uloha'),
});

const colorValueSchema = z.string().regex(/^#[0-9a-f]{6}$/iu);

export const colorSettingsSchema = z.object({
  todo: colorValueSchema.default('#579bfc'),
  inProgress: colorValueSchema.default('#fdab3d'),
  done: colorValueSchema.default('#00c875'),
  overdue: colorValueSchema.default('#ff3b30'),
  priorityHigh: colorValueSchema.default('#e2445c'),
  priorityMedium: colorValueSchema.default('#fdab3d'),
  priorityLow: colorValueSchema.default('#c4c4c4'),
});

export const sourceScopeRuleSchema = z.object({
  property: z.string().default(''),
  acceptedValues: z.string().default(''),
});

export const CALENDAR_POLICY_VERSION = 2 as const;
export const RECOMMENDED_CALENDAR_POLICY = {
  exam: true,
  'assignment-deadline': true,
  'project-deadline': true,
  milestone: true,
  presentation: true,
  'regular-task': false,
} as const;

export const CALENDAR_VERIFICATION_INTERVALS = [0, 5, 10, 15, 30, 60] as const;

export const calendarPolicySchema = z.object({
  exam: z.boolean().default(true),
  'assignment-deadline': z.boolean().default(true),
  'project-deadline': z.boolean().default(true),
  milestone: z.boolean().default(true),
  presentation: z.boolean().default(true),
  'regular-task': z.boolean().default(false),
});

export const calendarReminderPolicySchema = z.object({
  exam: z.number().int().min(0).nullable().default(1440),
  'assignment-deadline': z.number().int().min(0).nullable().default(1440),
  'project-deadline': z.number().int().min(0).nullable().default(1440),
  milestone: z.number().int().min(0).nullable().default(1440),
  presentation: z.number().int().min(0).nullable().default(60),
  'regular-task': z.number().int().min(0).nullable().default(60),
});

export const calendarSettingsSchema = z.object({
  calendarPolicyVersion: z.literal(CALENDAR_POLICY_VERSION).default(CALENDAR_POLICY_VERSION),
  automaticallyInclude: calendarPolicySchema.default({}),
  remindersEnabled: z.boolean().default(true),
  reminderMinutes: calendarReminderPolicySchema.default({}),
  verificationIntervalMinutes: z.union([
    z.literal(0),
    z.literal(5),
    z.literal(10),
    z.literal(15),
    z.literal(30),
    z.literal(60),
  ]).default(15),
  google: z.object({
    clientId: z.string().trim().default(''),
    clientSecret: z.string().trim().default(''),
    autoSync: z.boolean().default(true),
    debounceMs: z.number().int().min(500).max(60_000).default(3_000),
  }).default({}),
});

export const calendarItemOverrideSchema = z.enum(['include', 'exclude']);

export const calendarSyncRecordSchema = z.object({
  internalItemId: z.string().min(1),
  provider: z.string().min(1),
  externalCalendarId: z.string().min(1).optional(),
  externalEventId: z.string().min(1).optional(),
  lastSyncedHash: z.string().min(1).optional(),
  lastSyncedAt: z.string().min(1).optional(),
});

export const googleCalendarStateSchema = z.object({
  refreshTokenSecretId: z.string().min(1).optional(),
  accountId: z.string().min(1).optional(),
  accountDisplayName: z.string().min(1).optional(),
  accountEmail: z.string().min(1).optional(),
  selectedCalendarId: z.string().min(1).optional(),
  selectedCalendarName: z.string().min(1).optional(),
  lastSyncAt: z.string().min(1).optional(),
  lastSyncError: z.string().min(1).optional(),
});

export const calendarStateSchema = z.object({
  itemIdentities: z.record(z.string().min(1)).default({}),
  itemOverrides: z.record(calendarItemOverrideSchema).default({}),
  syncRecords: z.record(calendarSyncRecordSchema).default({}),
  calendarSyncDirty: z.boolean().default(false),
  google: googleCalendarStateSchema.default({}),
});

export const roadmapSettingsSchema = z.object({
  defaultDurationBuffer: z.number().finite().positive().default(1.3),
  defaultPriority: z.enum(PRIORITIES).default('medium'),
  enableColorCoding: z.boolean().default(true),
  propertyMappings: propertyMappingSchema.default({}),
  valueMappings: semanticValueMappingSchema.default({}),
  excludedTemplateValues: z.string().default('template, šablóna, sablona'),
  excludedPathPrefixes: z.string().default(''),
  sourceScopeMode: z.enum(SOURCE_SCOPE_MODES).default('all'),
  sourceScopeRules: z.array(sourceScopeRuleSchema).default([]),
  horizonNextDays: z.number().int().min(1).max(90).default(7),
  horizonCriticalDays: z.number().int().min(0).max(30).default(0),
  horizonOverduePreviewLimit: z.number().int().min(1).max(50).default(5),
  colors: colorSettingsSchema.default({}),
  calendar: calendarSettingsSchema.default({}),
  calendarState: calendarStateSchema.default({}),
});

export type NodeType = (typeof NODE_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type NodeStatus = (typeof NODE_STATUSES)[number];
export type SourceScopeMode = (typeof SOURCE_SCOPE_MODES)[number];
export type CalendarSemanticType = (typeof CALENDAR_SEMANTIC_TYPES)[number];
export type CanonicalPropertyField = (typeof CANONICAL_PROPERTY_FIELDS)[number];
export type PropertyMappings = z.infer<typeof propertyMappingSchema>;
export type SemanticValueMappings = z.infer<typeof semanticValueMappingSchema>;
export type ColorSettings = z.infer<typeof colorSettingsSchema>;
export type SourceScopeRule = z.infer<typeof sourceScopeRuleSchema>;
export type CalendarPolicy = z.infer<typeof calendarPolicySchema>;
export type CalendarReminderPolicy = z.infer<typeof calendarReminderPolicySchema>;
export type CalendarSettings = z.infer<typeof calendarSettingsSchema>;
export type CalendarItemOverride = z.infer<typeof calendarItemOverrideSchema>;
export type CalendarSyncRecord = z.infer<typeof calendarSyncRecordSchema>;
export type GoogleCalendarSettings = z.infer<typeof calendarSettingsSchema>['google'];
export type GoogleCalendarState = z.infer<typeof googleCalendarStateSchema>;
export type CalendarState = z.infer<typeof calendarStateSchema>;
export type RoadmapNodeFrontmatter = z.infer<typeof roadmapNodeFrontmatterSchema>;
export type InlineTask = z.infer<typeof inlineTaskSchema>;
export type RoadmapSettings = z.infer<typeof roadmapSettingsSchema>;

export interface RoadmapNodeWriteKeys {
  startDate: string;
  dueDate: string;
  type: string;
  priority: string;
  status: string;
}

export interface RoadmapNode {
  id: string;
  path: string;
  title: string;
  type: NodeType;
  calendarType: CalendarSemanticType;
  semester?: string;
  subject?: string;
  project?: string;
  startDate?: string;
  dueDate?: string;
  durationBuffer: number;
  priority: Priority;
  status: NodeStatus;
  parent?: string;
  dependsOn: readonly string[];
  hardDependency: boolean;
  source: 'frontmatter' | 'inline';
  blockId?: string;
  sourceLine?: number;
  completed: boolean;
  writeKeys: RoadmapNodeWriteKeys;
}
