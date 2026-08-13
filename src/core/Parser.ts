import type { CachedMetadata, MetadataCache, TFile } from 'obsidian';
import {
  ENERGY_LEVELS,
  NODE_STATUSES,
  NODE_TYPES,
  type EnergyLevel,
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
  'energy_level',
  'status',
  'parent',
  'depends_on',
  'hard_dependency',
]);
const INLINE_TASK_PATTERN = /^\s*[-*+]\s+\[([^\]])\]\s+(.+?)\s*$/;
const SUBJECT_PROPERTY_PATTERN = /\[subject::\s*(\[\[[^\]]+\]\])\s*\]/;
const START_PROPERTY_PATTERN = /\[start::\s*([^\]]+?)\s*\]/;
const DUE_PROPERTY_PATTERN = /\[due::\s*([^\]]+?)\s*\]/;
const ENERGY_PROPERTY_PATTERN = /\[energy::\s*([^\]]+?)\s*\]/;
const INLINE_PROPERTY_PATTERN =
  /\[(?:subject|start|due|energy)::\s*(?:\[\[[^\]]+\]\]|[^\]]+?)\s*\]/g;
const BLOCK_ID_PATTERN = /\s+\^([A-Za-z0-9-]+)\s*$/;

type FrontmatterValues = Record<string, unknown>;

/** Parses cached Obsidian metadata and Markdown content into roadmap nodes. */
export class RoadmapParser {
  constructor(private readonly metadataCache: MetadataCache) {}

  parseFile(file: TFile, cache: CachedMetadata, source: string): RoadmapNode[] {
    const nodes: RoadmapNode[] = [];
    const frontmatterNode = this.parseFrontmatterNode(file, cache.frontmatter);

    if (frontmatterNode !== null) {
      nodes.push(frontmatterNode);
    }

    nodes.push(...this.parseInlineTasks(file, cache, source));
    return nodes;
  }

  private parseFrontmatterNode(
    file: TFile,
    frontmatter: unknown,
  ): RoadmapNode | null {
    const values = asRecord(frontmatter);
    if (values === null || !hasRoadmapFrontmatter(values)) {
      return null;
    }

    const candidate: FrontmatterValues = {};
    addNonEmptyString(candidate, 'title', values['title']);
    addOption(candidate, 'type', values['type'], NODE_TYPES);
    addNonEmptyString(candidate, 'semester', values['semester']);
    addWikilink(candidate, 'subject', values['subject']);
    addDate(candidate, 'start_date', values['start_date']);
    addDate(candidate, 'due_date', values['due_date']);
    addPositiveNumber(candidate, 'duration_buffer', values['duration_buffer']);
    addOption(candidate, 'energy_level', values['energy_level'], ENERGY_LEVELS);
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
      subject: this.resolveWikilink(data.subject, file),
      startDate,
      dueDate,
      durationBuffer: data.duration_buffer,
      energyLevel: data.energy_level,
      status: data.status,
      parent: this.resolveWikilink(data.parent, file),
      dependsOn: data.depends_on
        .map((link) => this.resolveWikilink(link, file))
        .filter((link): link is string => link !== undefined),
      hardDependency: data.hard_dependency,
      source: 'frontmatter',
    };
  }

  private parseInlineTasks(file: TFile, cache: CachedMetadata, source: string): RoadmapNode[] {
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
      if (matchedTask === null) {
        continue;
      }

      const marker = matchedTask[1];
      const taskBody = matchedTask[2];
      if (marker === undefined || taskBody === undefined) {
        continue;
      }

      const subject = readWikilinkProperty(taskBody, SUBJECT_PROPERTY_PATTERN);
      const startDate = readDateProperty(taskBody, START_PROPERTY_PATTERN);
      const dueDate = readDateProperty(taskBody, DUE_PROPERTY_PATTERN);
      const energyLevel = readEnergyProperty(taskBody);
      const matchedBlockId = BLOCK_ID_PATTERN.exec(taskBody);
      const blockId = task.id ?? matchedBlockId?.[1];

      if (
        subject === undefined &&
        startDate === undefined &&
        dueDate === undefined &&
        energyLevel === undefined &&
        blockId === undefined
      ) {
        continue;
      }

      const title = taskBody
        .replace(INLINE_PROPERTY_PATTERN, '')
        .replace(BLOCK_ID_PATTERN, '')
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
        subject: this.resolveWikilink(subject, file),
        startDate,
        dueDate,
        durationBuffer: 1.3,
        energyLevel: energyLevel ?? 'medium',
        status: marker === ' ' ? 'todo' : 'done',
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

function hasRoadmapFrontmatter(values: FrontmatterValues): boolean {
  return Object.keys(values).some((key) => ROADMAP_FRONTMATTER_KEYS.has(key));
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

function readEnergyProperty(taskBody: string): EnergyLevel | undefined {
  const value = ENERGY_PROPERTY_PATTERN.exec(taskBody)?.[1]?.trim();
  return value !== undefined && ENERGY_LEVELS.includes(value as EnergyLevel)
    ? (value as EnergyLevel)
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
