import { z } from 'zod';

export const NODE_TYPES = ['roadmap', 'project', 'milestone', 'task'] as const;
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export const NODE_STATUSES = ['todo', 'in-progress', 'done', 'unscheduled'] as const;

export const CANONICAL_PROPERTY_FIELDS = [
  'title',
  'subject',
  'semester',
  'project',
  'type',
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
  priorityHigh: z.string().default('high, urgent, vysoká, vysoka, kritická, kriticka'),
  priorityMedium: z.string().default('medium, normal, stredná, stredna'),
  priorityLow: z.string().default('low, nízka, nizka, someday'),
  typeRoadmap: z.string().default('roadmap, roadmapa'),
  typeProject: z.string().default('project, projekt, workstream'),
  typeMilestone: z.string().default('milestone, míľnik, milnik'),
  typeTask: z.string().default('task, úloha, uloha'),
});

export const colorSettingsSchema = z.object({
  todo: z.string().default('#579bfc'),
  inProgress: z.string().default('#fdab3d'),
  done: z.string().default('#00c875'),
  overdue: z.string().default('#ff3b30'),
  priorityHigh: z.string().default('#e2445c'),
  priorityMedium: z.string().default('#fdab3d'),
  priorityLow: z.string().default('#c4c4c4'),
});

export const roadmapSettingsSchema = z.object({
  defaultDurationBuffer: z.number().finite().positive().default(1.3),
  defaultPriority: z.enum(PRIORITIES).default('medium'),
  enableColorCoding: z.boolean().default(true),
  propertyMappings: propertyMappingSchema.default({}),
  valueMappings: semanticValueMappingSchema.default({}),
  excludedTemplateValues: z.string().default('template, šablóna, sablona'),
  horizonNextDays: z.number().int().min(1).max(90).default(7),
  horizonCriticalDays: z.number().int().min(0).max(30).default(0),
  horizonOverduePreviewLimit: z.number().int().min(1).max(50).default(5),
  colors: colorSettingsSchema.default({}),
});

export type NodeType = (typeof NODE_TYPES)[number];
export type Priority = (typeof PRIORITIES)[number];
export type NodeStatus = (typeof NODE_STATUSES)[number];
export type CanonicalPropertyField = (typeof CANONICAL_PROPERTY_FIELDS)[number];
export type PropertyMappings = z.infer<typeof propertyMappingSchema>;
export type SemanticValueMappings = z.infer<typeof semanticValueMappingSchema>;
export type ColorSettings = z.infer<typeof colorSettingsSchema>;
export type RoadmapNodeFrontmatter = z.infer<typeof roadmapNodeFrontmatterSchema>;
export type InlineTask = z.infer<typeof inlineTaskSchema>;
export type RoadmapSettings = z.infer<typeof roadmapSettingsSchema>;

export interface RoadmapNodeWriteKeys {
  startDate: string;
  dueDate: string;
  status: string;
}

export interface RoadmapNode {
  id: string;
  path: string;
  title: string;
  type: NodeType;
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
