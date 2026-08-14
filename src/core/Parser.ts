import type { CachedMetadata, MetadataCache, TFile } from 'obsidian';
import {
  PRIORITIES,
  NODE_STATUSES,
  NODE_TYPES,
  type Priority,
  type RoadmapNode,
  roadmapNodeFrontmatterSchema,
  wikilinkSchema,
} from '../types';

const ROADMAP_FRONTMATTER_KEYS = new Set([
  'type',
  'semester',
  'subject',
  'start_date',
  'due_date',
  'duration_buffer',
  'priority',
  'status',
  'parent',
  'depends_on',
  'hard_dependency',
]);
const INLINE_TASK_PATTERN = /^\s*[-*+]\s+\[[^\]]\]\s*(.*?)\s*$/;
const SUBJECT_PROPERTY_PATTERN = /\[subject::\s*(\[\[[^\]]+\]\])\s*\]/;
const START_PROPERTY_PATTERN = /\[start::\s*([^\]]+?)\s*\]/;
const DUE_PROPERTY_PATTERN = /\[due::\s*([^\]]+?)\s*\]/;
const PRIORITY_PROPERTY_PATTERN = /\[priority::\s*([^\]]+?)\s*\]/;
const INLINE_PROPERTY_PATTERN =
  /\[[^[\]:\r\n]+::\s*(?:\[\[[^\]]+\]\]|[^\]]*?)\]/gu;
const BLOCK_ID_PATTERN = /\s+\^([A-Za-z0-9-]+)\s*$/;

type FrontmatterValues = Record<string, unknown>;

export interface RoadmapParserOptions {
  subjectPropertyKeys: readonly string[];
  templatePropertyKey: string;
  excludedTemplateValues: readonly string[];
}

const DEFAULT_PARSER_OPTIONS: RoadmapParserOptions = {
  subjectPropertyKeys: ['predmet', 'subject'],
  templatePropertyKey: 'typ',
  excludedTemplateValues: ['roadmapa', 'šablóna', 'template'],
};

/** Parses cached Obsidian metadata and Markdown content into roadmap nodes. */
export class RoadmapParser {
  private options: RoadmapParserOptions;

  constructor(
    private readonly metadataCache: MetadataCache,
    options: RoadmapParserOptions = DEFAULT_PARSER_OPTIONS,
  ) {
    this.options = normalizeParserOptions(options);
  }

  setOptions(options: RoadmapParserOptions): void {
    this.options = normalizeParserOptions(options);
  }

  shouldIgnoreFile(cache: CachedMetadata): boolean {
    const frontmatter = asRecord(cache.frontmatter);
    return frontmatter !== null && this.isExcludedTemplate(frontmatter);
  }

  hasMappedSubject(file: TFile, cache: CachedMetadata): boolean {
    const frontmatter = asRecord(cache.frontmatter);
    return frontmatter !== null && this.extractSubject(frontmatter, file) !== undefined;
  }

  parseFile(file: TFile, cache: CachedMetadata, source: string): RoadmapNode[] {
    const frontmatter = asRecord(cache.frontmatter);
    if (this.shouldIgnoreFile(cache)) {
      return [];
    }

    const inheritedSubject =
      frontmatter === null ? undefined : this.extractSubject(frontmatter, file);
    const nodes: RoadmapNode[] = [];
    const frontmatterNode = this.parseFrontmatterNode(file, frontmatter, inheritedSubject);

    if (frontmatterNode !== null) {
      nodes.push(frontmatterNode);
    }

    nodes.push(...this.parseInlineTasks(file, cache, source, inheritedSubject));
    return nodes;
  }

  private parseFrontmatterNode(
    file: TFile,
    values: FrontmatterValues | null,
    subject: string | undefined,
  ): RoadmapNode | null {
    if (
      values === null ||
      !hasRoadmapFrontmatter(values, this.options.subjectPropertyKeys)
    ) {
      return null;
    }

    const candidate: FrontmatterValues = {};
    addNonEmptyString(candidate, 'title', values['title']);
    addOption(candidate, 'type', values['type'], NODE_TYPES);
    addNonEmptyString(candidate, 'semester', values['semester']);
    addDate(candidate, 'start_date', values['start_date']);
    addDate(candidate, 'due_date', values['due_date']);
    addPositiveNumber(candidate, 'duration_buffer', values['duration_buffer']);
    addOption(candidate, 'priority', values['priority'], PRIORITIES);
    addOption(candidate, 'status', values['status'], NODE_STATUSES);
    addWikilink(candidate, 'parent', values['parent']);
    addWikilinkArray(candidate, 'depends_on', values['depends_on']);
    addBoolean(candidate, 'hard_dependency', values['hard_dependency']);

    const parsed = roadmapNodeFrontmatterSchema.safeParse(candidate);
    if (!parsed.success) {
      return null;
    }

    const data = parsed.data;
    const startDate = data.start_date;
    const dueDate = data.due_date;

    return {
      id: file.path,
      path: file.path,
      title: data.title ?? file.basename,
      type: data.type,
      semester: data.semester,
      subject,
      startDate,
      dueDate,
      durationBuffer: data.duration_buffer,
      priority: data.priority,
      status: data.status,
      parent: this.resolveWikilink(data.parent, file),
      dependsOn: data.depends_on
        .map((link) => this.resolveWikilink(link, file))
        .filter((link): link is string => link !== undefined),
      hardDependency: data.hard_dependency,
      source: 'frontmatter',
    };
  }

  private isExcludedTemplate(values: FrontmatterValues): boolean {
    const propertyKey = this.options.templatePropertyKey;
    if (propertyKey.length === 0 || this.options.excludedTemplateValues.length === 0) {
      return false;
    }

    const excludedValues = new Set(
      this.options.excludedTemplateValues.map(normalizeComparisonValue),
    );
    return readFrontmatterStrings(values[propertyKey]).some((value) =>
      excludedValues.has(normalizeComparisonValue(value)),
    );
  }

  private extractSubject(values: FrontmatterValues, file: TFile): string | undefined {
    for (const propertyKey of this.options.subjectPropertyKeys) {
      const value = readFrontmatterStrings(values[propertyKey])[0];
      if (value === undefined) {
        continue;
      }

      if (wikilinkSchema.safeParse(value).success) {
        return this.resolveWikilink(value, file) ?? value;
      }
      return value;
    }

    return undefined;
  }

  private parseInlineTasks(
    file: TFile,
    cache: CachedMetadata,
    source: string,
    inheritedSubject: string | undefined,
  ): RoadmapNode[] {
    if (inheritedSubject === undefined) {
      return [];
    }

    const lines = source.split(/\r?\n/u);
    const tasks = cache.listItems?.filter((item) => item.task === ' ') ?? [];
    const nodes: RoadmapNode[] = [];

    for (const task of tasks) {
      const lineNumber = task.position.start.line;
      const line = lines[lineNumber];
      if (line === undefined) {
        continue;
      }

      const matchedTask = INLINE_TASK_PATTERN.exec(line);
      if (matchedTask === null) {
        continue;
      }

      const taskBody = matchedTask[1];
      if (taskBody === undefined) {
        continue;
      }

      const subject = readWikilinkProperty(taskBody, SUBJECT_PROPERTY_PATTERN);
      const startDate = readDateProperty(taskBody, START_PROPERTY_PATTERN);
      const dueDate = readDateProperty(taskBody, DUE_PROPERTY_PATTERN);
      const priority = readPriorityProperty(taskBody);
      const matchedBlockId = BLOCK_ID_PATTERN.exec(taskBody);
      const blockId = task.id ?? matchedBlockId?.[1];

      const title = taskBody
        .replace(INLINE_PROPERTY_PATTERN, '')
        .replace(BLOCK_ID_PATTERN, '')
        .replace(/[*_#]+/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
      if (title.length === 0) {
        continue;
      }

      const nodeId = blockId === undefined ? `${file.path}#L${lineNumber + 1}` : `${file.path}#^${blockId}`;
      nodes.push({
        id: nodeId,
        path: file.path,
        title,
        type: 'task',
        subject: this.resolveWikilink(subject, file) ?? inheritedSubject,
        startDate,
        dueDate,
        durationBuffer: 1.3,
        priority: priority ?? 'medium',
        status: startDate !== undefined && dueDate !== undefined ? 'todo' : 'unscheduled',
        dependsOn: [],
        hardDependency: false,
        source: 'inline',
        blockId,
      });
    }

    return nodes;
  }

  private resolveWikilink(wikilink: string | undefined, sourceFile: TFile): string | undefined {
    if (wikilink === undefined) {
      return undefined;
    }

    const linkpath = wikilink.slice(2, -2).split('|', 1)[0]?.split('#', 1)[0]?.trim();
    if (linkpath === undefined || linkpath.length === 0) {
      return undefined;
    }

    return this.metadataCache.getFirstLinkpathDest(linkpath, sourceFile.path)?.path;
  }
}

function asRecord(value: unknown): FrontmatterValues | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as FrontmatterValues)
    : null;
}

function hasRoadmapFrontmatter(
  values: FrontmatterValues,
  subjectPropertyKeys: readonly string[],
): boolean {
  return Object.keys(values).some(
    (key) => ROADMAP_FRONTMATTER_KEYS.has(key) || subjectPropertyKeys.includes(key),
  );
}

function normalizeParserOptions(options: RoadmapParserOptions): RoadmapParserOptions {
  return {
    subjectPropertyKeys: uniqueNonEmptyValues(options.subjectPropertyKeys),
    templatePropertyKey: options.templatePropertyKey.trim(),
    excludedTemplateValues: uniqueNonEmptyValues(options.excludedTemplateValues),
  };
}

function uniqueNonEmptyValues(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  );
}

function readFrontmatterStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((entry) =>
      typeof entry === 'string'
        ? entry.trim()
        : typeof entry === 'number'
          ? String(entry)
          : '',
    )
    .filter((entry) => entry.length > 0);
}

function normalizeComparisonValue(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function addNonEmptyString(target: FrontmatterValues, key: string, value: unknown): void {
  if (typeof value === 'string' && value.trim().length > 0) {
    target[key] = value.trim();
  }
}

function addDate(target: FrontmatterValues, key: string, value: unknown): void {
  const candidate = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (typeof candidate === 'string') {
    target[key] = candidate.trim();
  }
}

function addPositiveNumber(target: FrontmatterValues, key: string, value: unknown): void {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    target[key] = value;
  }
}

function addBoolean(target: FrontmatterValues, key: string, value: unknown): void {
  if (typeof value === 'boolean') {
    target[key] = value;
  }
}

function addOption<const T extends readonly string[]>(
  target: FrontmatterValues,
  key: string,
  value: unknown,
  options: T,
): void {
  if (typeof value === 'string' && options.includes(value)) {
    target[key] = value;
  }
}

function addWikilink(target: FrontmatterValues, key: string, value: unknown): void {
  if (typeof value === 'string' && wikilinkSchema.safeParse(value.trim()).success) {
    target[key] = value.trim();
  }
}

function addWikilinkArray(target: FrontmatterValues, key: string, value: unknown): void {
  const sourceValues = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  const wikilinks = sourceValues.filter(
    (entry): entry is string =>
      typeof entry === 'string' && wikilinkSchema.safeParse(entry.trim()).success,
  );

  if (wikilinks.length > 0) {
    target[key] = wikilinks.map((link) => link.trim());
  }
}

function readWikilinkProperty(taskBody: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(taskBody)?.[1]?.trim();
  return value !== undefined && wikilinkSchema.safeParse(value).success ? value : undefined;
}

function readDateProperty(taskBody: string, pattern: RegExp): string | undefined {
  const value = pattern.exec(taskBody)?.[1]?.trim();
  return value !== undefined && dateIsValid(value) ? value : undefined;
}

function readPriorityProperty(taskBody: string): Priority | undefined {
  const value = PRIORITY_PROPERTY_PATTERN.exec(taskBody)?.[1]?.trim();
  return value !== undefined && PRIORITIES.includes(value as Priority)
    ? (value as Priority)
    : undefined;
}

function dateIsValid(value: string): boolean {
  const [yearValue, monthValue, dayValue] = value.split('-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

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
