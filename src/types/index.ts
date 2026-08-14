import { z } from 'zod';

export const NODE_TYPES = ['project', 'milestone', 'task'] as const;
export const PRIORITIES = ['high', 'medium', 'low'] as const;
export const NODE_STATUSES = ['todo', 'in-progress', 'done', 'unscheduled'] as const;

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
  subject: wikilinkSchema.optional(),
  start_date: dateStringSchema.optional(),
  due_date: dateStringSchema.optional(),
  duration_buffer: z.number().finite().positive().default(1.3),
  priority: z.enum(PRIORITIES).default('medium'),
  status: z.enum(NODE_STATUSES).default('todo'),
  parent: wikilinkSchema.optional(),
  depends_on: z.array(wikilinkSchema).default([]),
  hard_dependency: z.boolean().default(false),
});

export const inlineTaskSchema = z.object({
  text: z.string().trim().min(1),
  completed: z.boolean(),
  subject: wikilinkSchema.optional(),
  start: dateStringSchema.optional(),
  due: dateStringSchema.optional(),
  priority: z.enum(PRIORITIES).default('medium'),
  blockId: z.string().trim().min(1).optional(),
});

export const roadmapSettingsSchema = z.object({
  defaultDurationBuffer: z.number().finite().positive().default(1.3),
  defaultPriority: z.enum(PRIORITIES).default('medium'),
  enableColorCoding: z.boolean().default(true),
  subjectPropertyKeys: z.string().default('predmet, subject'),
  templatePropertyKey: z.string().default('typ'),
  excludedTemplateValues: z.string().default('roadmapa, šablóna, template'),
});

export type NodeType = z.infer<typeof roadmapNodeFrontmatterSchema>['type'];
export type Priority = z.infer<typeof roadmapNodeFrontmatterSchema>['priority'];
export type NodeStatus = z.infer<typeof roadmapNodeFrontmatterSchema>['status'];
export type RoadmapNodeFrontmatter = z.infer<typeof roadmapNodeFrontmatterSchema>;
export type InlineTask = z.infer<typeof inlineTaskSchema>;
export type RoadmapSettings = z.infer<typeof roadmapSettingsSchema>;

export interface RoadmapNode {
  id: string;
  path: string;
  title: string;
  type: NodeType;
  semester?: string;
  subject?: string;
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
}
