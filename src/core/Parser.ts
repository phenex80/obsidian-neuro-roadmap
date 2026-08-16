import type { CachedMetadata, MetadataCache, TFile } from 'obsidian';
import {
  propertyMappingSchema,
  roadmapNodeFrontmatterSchema,
  semanticValueMappingSchema,
  type CanonicalPropertyField,
  type NodeStatus,
  type Priority,
  type RoadmapNode,
} from '../types';
import {
  compilePropertyKeyMap,
  compileSemanticValueMap,
  mapNodeType,
  mapCalendarSemanticType,
  mapPriority,
  mapStatus,
  normalizeSemanticValue,
  readMappedValue,
  readValueStrings,
  uniqueNonEmptyValues,
  type PropertyKeyMap,
  type SemanticValueMap,
} from './SemanticMapping';
import {
  compileSourceScope,
  isFrontmatterInSourceScope,
  type SourceScopeConfig,
} from './SourceScope';

const INLINE_TASK_PATTERN = /^\s*[-*+]\s+\[([^\]])\]\s*(.*?)\s*$/u;
const INLINE_PROPERTY_PATTERN =
  /\[([^[\]:\r\n]+)::\s*(\[\[[^\]]+\]\]|[^\]]*?)\]/gu;
const BLOCK_ID_PATTERN = /\s+\^([A-Za-z0-9-]+)\s*$/u;

type FrontmatterValues = Record<string, unknown>;
type InlineProperties = ReadonlyMap<string, { readonly key: string; readonly value: string }>;

export interface RoadmapParserOptions {
  readonly propertyKeys: PropertyKeyMap;
  readonly semanticValues: SemanticValueMap;
  readonly excludedTemplateValues: readonly string[];
  readonly excludedPathPrefixes: readonly string[];
  readonly sourceScope: SourceScopeConfig;
  readonly defaultDurationBuffer: number;
  readonly defaultPriority: Priority;
}

export function createDefaultParserOptions(): RoadmapParserOptions {
  return {
    propertyKeys: compilePropertyKeyMap(propertyMappingSchema.parse({})),
    semanticValues: compileSemanticValueMap(semanticValueMappingSchema.parse({})),
    excludedTemplateValues: ['template'],
    excludedPathPrefixes: [],
    sourceScope: compileSourceScope('all', []),
    defaultDurationBuffer: 1.3,
    defaultPriority: 'medium',
  };
}

/** Parses cached Obsidian metadata and Markdown content into canonical roadmap nodes. */
export class RoadmapParser {
  private options: RoadmapParserOptions;
  private uniqueMarkdownPathByLinkpath = new Map<string, string>();

  constructor(
    private readonly metadataCache: MetadataCache,
    options: RoadmapParserOptions = createDefaultParserOptions(),
  ) {
    this.options = normalizeParserOptions(options);
  }

  setOptions(options: RoadmapParserOptions): void {
    this.options = normalizeParserOptions(options);
  }

  /** Supplies vault paths so plain-text linkpaths are canonicalized only when unambiguous. */
  setKnownMarkdownPaths(paths: readonly string[]): void {
    const candidates = new Map<string, Set<string>>();
    for (const path of paths) {
      const normalizedPath = normalizeVaultPath(path);
      if (!normalizedPath.toLocaleLowerCase().endsWith('.md')) {
        continue;
      }
      const pathWithoutExtension = normalizedPath.slice(0, -3);
      const basename = pathWithoutExtension.split('/').at(-1);
      for (const linkpath of [pathWithoutExtension, basename]) {
        if (linkpath === undefined || linkpath.length === 0) {
          continue;
        }
        const key = normalizeLinkpath(linkpath);
        const pathsForKey = candidates.get(key) ?? new Set<string>();
        pathsForKey.add(normalizedPath);
        candidates.set(key, pathsForKey);
      }
    }

    this.uniqueMarkdownPathByLinkpath = new Map(
      Array.from(candidates.entries())
        .filter((entry): entry is [string, Set<string>] => entry[1].size === 1)
        .map(([key, matchingPaths]) => [key, Array.from(matchingPaths)[0]!]),
    );
  }

  shouldIgnoreFile(file: TFile, cache: CachedMetadata): boolean {
    if (this.isExcludedPath(file.path)) {
      return true;
    }

    const frontmatter = asRecord(cache.frontmatter);
    if (frontmatter !== null) {
      const typeEntry = readMappedValue(frontmatter, this.options.propertyKeys.type);
      const mappedType = mapNodeType(typeEntry?.value, this.options.semanticValues);
      if (mappedType !== 'roadmap') {
        const excludedValues = new Set(
          this.options.excludedTemplateValues.map(normalizeSemanticValue),
        );
        if (
          readValueStrings(typeEntry?.value).some((value) =>
            excludedValues.has(normalizeSemanticValue(value)),
          )
        ) {
          return true;
        }
      }
    }

    return !isFrontmatterInSourceScope(frontmatter, this.options.sourceScope);
  }

  parseFile(file: TFile, cache: CachedMetadata, source: string): RoadmapNode[] {
    if (this.shouldIgnoreFile(file, cache)) {
      return [];
    }

    const frontmatter = asRecord(cache.frontmatter);
    const inheritedSubject = this.readReference(frontmatter, 'subject', file);
    const inheritedProject = this.readReference(frontmatter, 'project', file);
    const inheritedSemester = this.readText(frontmatter, 'semester');
    const nodes: RoadmapNode[] = [];
    const frontmatterNode = this.parseFrontmatterNode(
      file,
      frontmatter,
      inheritedSubject,
      inheritedProject,
      inheritedSemester,
    );

    if (frontmatterNode !== null) {
      nodes.push(frontmatterNode);
    }

    nodes.push(
      ...this.parseInlineTasks(
        file,
        cache,
        source,
        inheritedSubject,
        inheritedProject,
        inheritedSemester,
      ),
    );
    return nodes;
  }

  private parseFrontmatterNode(
    file: TFile,
    values: FrontmatterValues | null,
    subject: string | undefined,
    project: string | undefined,
    semester: string | undefined,
  ): RoadmapNode | null {
    if (values === null) {
      return null;
    }

    const typeEntry = readMappedValue(values, this.options.propertyKeys.type);
    const milestoneEntry = readMappedValue(values, this.options.propertyKeys.milestone);
    const startEntry = readMappedValue(values, this.options.propertyKeys.startDate);
    const dueEntry = readMappedValue(values, this.options.propertyKeys.dueDate);
    const statusEntry = readMappedValue(values, this.options.propertyKeys.status);
    const calendarTypeEntry = readMappedValue(values, this.options.propertyKeys.calendarType);
    const priorityEntry = readMappedValue(values, this.options.propertyKeys.priority);
    const bufferEntry = readMappedValue(values, this.options.propertyKeys.durationBuffer);
    const hardEntry = readMappedValue(values, this.options.propertyKeys.hardDependency);
    const title = this.readText(values, 'title');
    const startDate = readDate(startEntry?.value);
    const milestoneDate = readDate(milestoneEntry?.value);
    const dueDate = readDate(dueEntry?.value) ?? milestoneDate;
    const mappedType = mapNodeType(typeEntry?.value, this.options.semanticValues);
    const milestoneFlag = readBoolean(milestoneEntry?.value) === true || milestoneDate !== undefined;

    // A roadmap note is an inheritance/inline-task anchor, not a task by itself.
    if (mappedType === 'roadmap') {
      return null;
    }

    const explicitlyEligible =
      mappedType === 'task' || mappedType === 'project' || mappedType === 'milestone';
    const hasSchedulingSignal =
      startDate !== undefined || dueDate !== undefined || milestoneFlag;
    if (!explicitlyEligible && !hasSchedulingSignal) {
      return null;
    }

    const type = mappedType ?? (milestoneFlag ? 'milestone' : 'task');
    const calendarType =
      mapCalendarSemanticType(calendarTypeEntry?.value, this.options.semanticValues) ??
      mapCalendarSemanticType(typeEntry?.value, this.options.semanticValues) ??
      inferCalendarType(type);
    const status = mapStatus(statusEntry?.value, this.options.semanticValues) ?? 'todo';
    const priority =
      mapPriority(priorityEntry?.value, this.options.semanticValues) ??
      this.options.defaultPriority;
    const durationBuffer = readPositiveNumber(bufferEntry?.value) ?? this.options.defaultDurationBuffer;
    const parent = this.readReference(values, 'parent', file);
    const dependsOn = this.readReferences(values, 'dependsOn', file);
    const hardDependency = readBoolean(hardEntry?.value) ?? false;

    const parsed = roadmapNodeFrontmatterSchema.safeParse({
      title,
      type,
      calendar_type: calendarType,
      semester,
      subject,
      project,
      start_date: startDate,
      due_date: dueDate,
      duration_buffer: durationBuffer,
      priority,
      status,
      parent,
      depends_on: dependsOn,
      hard_dependency: hardDependency,
    });
    if (!parsed.success) {
      return null;
    }

    const data = parsed.data;
    return {
      id: file.path,
      path: file.path,
      title: data.title ?? file.basename,
      type: data.type,
      calendarType: data.calendar_type,
      semester: data.semester,
      subject: data.subject,
      project: data.project,
      startDate: data.start_date,
      dueDate: data.due_date,
      durationBuffer: data.duration_buffer,
      priority: data.priority,
      status: data.status,
      parent: data.parent,
      dependsOn: data.depends_on,
      hardDependency: data.hard_dependency,
      source: 'frontmatter',
      completed: data.status === 'done',
      writeKeys: {
        startDate: startEntry?.key ?? primaryKey(this.options.propertyKeys.startDate, 'start_date'),
        dueDate: dueEntry?.key ?? primaryKey(this.options.propertyKeys.dueDate, 'due_date'),
        type: typeEntry?.key ?? primaryKey(this.options.propertyKeys.type, 'type'),
        priority: priorityEntry?.key ?? primaryKey(this.options.propertyKeys.priority, 'priority'),
        status: statusEntry?.key ?? primaryKey(this.options.propertyKeys.status, 'status'),
      },
    };
  }

  private parseInlineTasks(
    file: TFile,
    cache: CachedMetadata,
    source: string,
    inheritedSubject: string | undefined,
    inheritedProject: string | undefined,
    inheritedSemester: string | undefined,
  ): RoadmapNode[] {
    if (source.length === 0) {
      return [];
    }

    const lines = source.split(/\r?\n/u);
    const tasks = cache.listItems?.filter((item) => item.task !== undefined) ?? [];
    const nodes: RoadmapNode[] = [];

    for (const task of tasks) {
      const lineNumber = task.position.start.line;
      const line = lines[lineNumber];
      if (line === undefined) {
        continue;
      }

      const matchedTask = INLINE_TASK_PATTERN.exec(line);
      const taskBody = matchedTask?.[2];
      if (taskBody === undefined) {
        continue;
      }

      const inlineProperties = extractInlineProperties(taskBody);
      const startEntry = this.readInlineEntry(inlineProperties, 'startDate');
      const dueEntry = this.readInlineEntry(inlineProperties, 'dueDate');
      const milestoneEntry = this.readInlineEntry(inlineProperties, 'milestone');
      const statusEntry = this.readInlineEntry(inlineProperties, 'status');
      const calendarTypeEntry = this.readInlineEntry(inlineProperties, 'calendarType');
      const inlineTypeEntry = this.readInlineEntry(inlineProperties, 'type');
      const priorityEntry = this.readInlineEntry(inlineProperties, 'priority');
      const startDate = readDate(startEntry?.value);
      const milestoneDate = readDate(milestoneEntry?.value);
      const dueDate = readDate(dueEntry?.value) ?? milestoneDate;
      const priority =
        mapPriority(priorityEntry?.value, this.options.semanticValues) ??
        this.options.defaultPriority;
      const explicitStatus = mapStatus(
        statusEntry?.value,
        this.options.semanticValues,
      );
      const completed = isCompletedTaskMarker(task.task ?? matchedTask?.[1] ?? ' ');
      const status = taskStatus(completed, explicitStatus, startDate, dueDate);
      const subject = this.resolveReference(
        readValueStrings(this.readInlineValue(inlineProperties, 'subject'))[0],
        file,
      ) ?? inheritedSubject;
      const project = this.resolveReference(
        readValueStrings(this.readInlineValue(inlineProperties, 'project'))[0],
        file,
      ) ?? inheritedProject;
      const matchedBlockId = BLOCK_ID_PATTERN.exec(taskBody);
      const managedBlockIds = Array.from(
        taskBody.matchAll(/(?:^|\s)\^(nr-cal-[A-Za-z0-9-]+)(?=\s|$)/gu),
        (match) => match[1],
      );
      const blockId = managedBlockIds.length > 1 ? undefined : task.id ?? matchedBlockId?.[1];
      const title = stripMarkdownTaskTitle(taskBody);
      if (title.length === 0) {
        continue;
      }

      const nodeId =
        blockId === undefined
          ? `${file.path}#L${lineNumber + 1}`
          : `${file.path}#^${blockId}`;
      nodes.push({
        id: nodeId,
        path: file.path,
        title,
        type: milestoneDate !== undefined ? 'milestone' : 'task',
        calendarType:
          mapCalendarSemanticType(calendarTypeEntry?.value, this.options.semanticValues) ??
          mapCalendarSemanticType(inlineTypeEntry?.value, this.options.semanticValues) ??
          (milestoneDate !== undefined ? 'milestone' : 'regular-task'),
        semester: inheritedSemester,
        subject,
        project,
        startDate,
        dueDate,
        durationBuffer: this.options.defaultDurationBuffer,
        priority,
        status,
        dependsOn: [],
        hardDependency:
          readBoolean(this.readInlineValue(inlineProperties, 'hardDependency')) ?? false,
        source: 'inline',
        blockId,
        sourceLine: lineNumber,
        completed,
        writeKeys: {
          startDate:
            startEntry?.key ?? preferredInlineKey(this.options.propertyKeys.startDate, 'start'),
          dueDate: dueEntry?.key ?? preferredInlineKey(this.options.propertyKeys.dueDate, 'due'),
          type:
            calendarTypeEntry?.key ??
            inlineTypeEntry?.key ??
            preferredInlineKey(this.options.propertyKeys.type, 'type'),
          priority:
            priorityEntry?.key ?? preferredInlineKey(this.options.propertyKeys.priority, 'priority'),
          status:
            statusEntry?.key ?? preferredInlineKey(this.options.propertyKeys.status, 'status'),
        },
      });
    }

    return nodes;
  }

  private readText(
    values: FrontmatterValues | null,
    field: CanonicalPropertyField,
  ): string | undefined {
    if (values === null) {
      return undefined;
    }
    return readValueStrings(readMappedValue(values, this.options.propertyKeys[field])?.value)[0];
  }

  private readReference(
    values: FrontmatterValues | null,
    field: CanonicalPropertyField,
    file: TFile,
  ): string | undefined {
    return this.resolveReference(this.readText(values, field), file);
  }

  private readReferences(
    values: FrontmatterValues,
    field: CanonicalPropertyField,
    file: TFile,
  ): string[] {
    const entry = readMappedValue(values, this.options.propertyKeys[field]);
    return readValueStrings(entry?.value)
      .map((value) => this.resolveReference(value, file))
      .filter((value): value is string => value !== undefined);
  }

  private readInlineValue(
    properties: InlineProperties,
    field: CanonicalPropertyField,
  ): string | undefined {
    return this.readInlineEntry(properties, field)?.value;
  }

  private readInlineEntry(
    properties: InlineProperties,
    field: CanonicalPropertyField,
  ): { readonly key: string; readonly value: string } | undefined {
    for (const key of this.options.propertyKeys[field]) {
      const entry = properties.get(normalizeSemanticValue(key).replace(/-/gu, ''));
      if (entry !== undefined) {
        return entry;
      }
    }
    return undefined;
  }

  private resolveReference(value: string | undefined, sourceFile: TFile): string | undefined {
    if (value === undefined) {
      return undefined;
    }

    const trimmed = value.trim();
    const wikilink = /^\[\[([^\]]+)\]\]$/u.exec(trimmed);
    if (wikilink === null) {
      if (trimmed.length === 0) {
        return undefined;
      }
      const plainLinkpath = trimmed.split('#', 1)[0]?.replace(/\.md$/iu, '').trim();
      if (plainLinkpath === undefined || plainLinkpath.length === 0) {
        return trimmed;
      }
      const uniquePath = this.uniqueMarkdownPathByLinkpath.get(normalizeLinkpath(plainLinkpath));
      const resolvedPath = this.metadataCache.getFirstLinkpathDest(plainLinkpath, sourceFile.path)?.path;
      return uniquePath !== undefined && normalizeVaultPath(resolvedPath ?? '') === uniquePath
        ? uniquePath
        : trimmed;
    }

    const linkpath = wikilink[1]?.split('|', 1)[0]?.split('#', 1)[0]?.trim();
    if (linkpath === undefined || linkpath.length === 0) {
      return undefined;
    }

    return this.metadataCache.getFirstLinkpathDest(linkpath, sourceFile.path)?.path ?? trimmed;
  }

  private isExcludedPath(filePath: string): boolean {
    const normalizedPath = normalizeVaultPath(filePath);
    return this.options.excludedPathPrefixes.some((prefix) => {
      const normalizedPrefix = normalizeVaultPath(prefix);
      return (
        normalizedPrefix.length > 0 &&
        (normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`))
      );
    });
  }
}

export function isCompletedTaskMarker(marker: string): boolean {
  return marker.trim().toLocaleLowerCase() === 'x';
}

export function stripMarkdownTaskTitle(taskBody: string): string {
  return taskBody
    .replace(INLINE_PROPERTY_PATTERN, '')
    .replace(BLOCK_ID_PATTERN, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/gu, '$2')
    .replace(/\[\[([^\]]+)\]\]/gu, '$1')
    .replace(/\\?[*_#~`]+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function taskStatus(
  completed: boolean,
  explicitStatus: NodeStatus | undefined,
  startDate: string | undefined,
  dueDate: string | undefined,
): NodeStatus {
  if (completed) {
    return 'done';
  }
  if (explicitStatus === 'in-progress' || explicitStatus === 'todo') {
    return explicitStatus;
  }
  if (explicitStatus === 'unscheduled') {
    return 'unscheduled';
  }
  return startDate === undefined && dueDate === undefined ? 'unscheduled' : 'todo';
}

function inferCalendarType(type: RoadmapNode['type']): RoadmapNode['calendarType'] {
  if (type === 'milestone') {
    return 'milestone';
  }
  if (type === 'project') {
    return 'project-deadline';
  }
  return 'regular-task';
}

function extractInlineProperties(taskBody: string): InlineProperties {
  const properties = new Map<string, { readonly key: string; readonly value: string }>();
  for (const match of taskBody.matchAll(INLINE_PROPERTY_PATTERN)) {
    const key = match[1]?.trim();
    const value = match[2]?.trim();
    if (key !== undefined && value !== undefined) {
      properties.set(normalizeSemanticValue(key).replace(/-/gu, ''), { key, value });
    }
  }
  return properties;
}

function asRecord(value: unknown): FrontmatterValues | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as FrontmatterValues)
    : null;
}

function normalizeParserOptions(options: RoadmapParserOptions): RoadmapParserOptions {
  const propertyKeys = {} as Record<CanonicalPropertyField, readonly string[]>;
  for (const field of Object.keys(options.propertyKeys) as CanonicalPropertyField[]) {
    propertyKeys[field] = uniqueNonEmptyValues(options.propertyKeys[field]);
  }

  return {
    propertyKeys,
    semanticValues: options.semanticValues,
    excludedTemplateValues: uniqueNonEmptyValues(options.excludedTemplateValues).filter(
      (value) => normalizeSemanticValue(value) !== normalizeSemanticValue('roadmapa'),
    ),
    excludedPathPrefixes: uniqueNonEmptyValues(options.excludedPathPrefixes),
    sourceScope: options.sourceScope,
    defaultDurationBuffer:
      Number.isFinite(options.defaultDurationBuffer) && options.defaultDurationBuffer > 0
        ? options.defaultDurationBuffer
        : 1.3,
    defaultPriority: options.defaultPriority,
  };
}

function normalizeVaultPath(value: string): string {
  return value
    .trim()
    .replace(/\\/gu, '/')
    .replace(/^\.\//u, '')
    .replace(/^\/+|\/+$/gu, '');
}

function normalizeLinkpath(value: string): string {
  return value.normalize('NFC').trim().replace(/\.md$/iu, '').toLocaleLowerCase();
}

function primaryKey(keys: readonly string[], fallback: string): string {
  return keys[0] ?? fallback;
}

function preferredInlineKey(keys: readonly string[], fallback: string): string {
  return keys.find((key) => normalizeSemanticValue(key) === normalizeSemanticValue(fallback))
    ?? keys[0]
    ?? fallback;
}

function readDate(value: unknown): string | undefined {
  const candidate = value instanceof Date ? value.toISOString().slice(0, 10) : readValueStrings(value)[0];
  return candidate !== undefined && dateIsValid(candidate) ? candidate : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  const candidate = typeof value === 'number' ? value : Number(readValueStrings(value)[0]);
  return Number.isFinite(candidate) && candidate > 0 ? candidate : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = normalizeSemanticValue(readValueStrings(value)[0] ?? '');
  if (['true', 'yes', '1', 'ano'].includes(normalized)) {
    return true;
  }
  if (['false', 'no', '0', 'nie'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function dateIsValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
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
