import type { App, TAbstractFile, TFile } from 'obsidian';
import type { RoadmapNode } from '../types';
import { replaceTaskCheckbox } from '../core/MarkdownTask';
import {
  replaceInlineTaskProperty,
  replaceInlineTaskStatus,
  type EditableTaskProperty,
} from '../core/InlineTaskProperties';
import type { NodeStatus } from '../types';
import { isCompletedTaskMarker, stripMarkdownTaskTitle } from '../core/Parser';
import type { InlineFileMutationQueue } from '../core/InlineFileMutationQueue';

export interface NodeDateUpdate {
  node: RoadmapNode;
  startDate: string;
  dueDate: string;
}

export interface RoadmapCreationKeys {
  readonly title: string;
  readonly type: string;
  readonly startDate: string;
  readonly dueDate: string;
  readonly durationBuffer: string;
  readonly priority: string;
  readonly status: string;
  readonly hardDependency: string;
}

/** Serializes minimal inline-property edits per file and preserves unrelated Markdown. */
export class InlineTaskPropertyWriter {
  constructor(
    private readonly app: App,
    private readonly mutations: InlineFileMutationQueue,
  ) {}

  update(
    node: RoadmapNode,
    field: Exclude<EditableTaskProperty, 'status'>,
    value: string | null,
  ): Promise<boolean> {
    return this.apply(node, (line) => replaceInlineTaskProperty(line, node.writeKeys[field], value));
  }

  updateStatus(node: RoadmapNode, status: NodeStatus, value: string): Promise<boolean> {
    return this.apply(
      node,
      (line) => replaceInlineTaskStatus(line, node.writeKeys.status, value, status),
    );
  }

  private async apply(node: RoadmapNode, transformLine: (line: string) => string): Promise<boolean> {
    if (node.source !== 'inline') return false;
    return this.mutations.run(node.path, async () => {
      const file = getMarkdownFile(this.app, node.path);
      if (file === null) return false;
      let updated = false;
      await this.app.vault.process(file, (source) => {
        const document = splitSourceLines(source);
        const lineIndex = resolveInlineTaskLine(document.lines, node);
        const originalLine = document.lines[lineIndex];
        if (lineIndex === -1 || originalLine === undefined) return source;
        const nextLine = transformLine(originalLine);
        if (nextLine === originalLine) return source;
        document.lines[lineIndex] = nextLine;
        updated = true;
        return document.lines.join(document.lineEnding);
      });
      return updated;
    });
  }
}

/** Updates only the date fields belonging to a roadmap node. */
export async function updateNodeDates(
  app: App,
  mutations: InlineFileMutationQueue,
  node: RoadmapNode,
  startDate: string,
  dueDate: string,
): Promise<boolean> {
  const file = getMarkdownFile(app, node.path);
  if (file === null) {
    return false;
  }

  if (node.source === 'frontmatter') {
    await app.fileManager.processFrontMatter(file, (frontmatter) => {
      writeFrontmatterValue(frontmatter, node.writeKeys.startDate, startDate);
      writeFrontmatterValue(frontmatter, node.writeKeys.dueDate, dueDate);
    });
    return true;
  }

  return updateInlineTaskDates(app, mutations, file, node, startDate, dueDate);
}

function writeFrontmatterValue(frontmatter: unknown, key: string, value: string): void {
  if (!isMutableFrontmatter(frontmatter)) {
    throw new Error('Could not update invalid YAML frontmatter.');
  }
  frontmatter[key] = value;
}

function isMutableFrontmatter(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Writes several dependency updates sequentially to prevent same-file write races. */
export async function updateNodeDatesBatch(
  app: App,
  mutations: InlineFileMutationQueue,
  updates: readonly NodeDateUpdate[],
): Promise<boolean> {
  for (const update of updates) {
    if (!await updateNodeDates(app, mutations, update.node, update.startDate, update.dueDate)) {
      return false;
    }
  }
  return true;
}

/** Atomically checks or unchecks the original Markdown checkbox task. */
export async function updateMarkdownTaskCompletion(
  app: App,
  mutations: InlineFileMutationQueue,
  node: RoadmapNode,
  completed: boolean,
): Promise<boolean> {
  if (node.source !== 'inline') {
    return false;
  }
  return mutations.run(node.path, async () => {
    const file = getMarkdownFile(app, node.path);
    if (file === null) return false;
    let updated = false;
    await app.vault.process(file, (source) => {
      const document = splitSourceLines(source);
      const lineIndex = resolveInlineTaskLine(document.lines, node);
      const originalLine = document.lines[lineIndex];
      if (lineIndex === -1 || originalLine === undefined) return source;
      const nextLine = replaceTaskCheckbox(originalLine, completed);
      if (nextLine === originalLine) return source;
      document.lines[lineIndex] = nextLine;
      updated = true;
      return document.lines.join(document.lineEnding);
    });
    return updated;
  });
}

/** Adds a stable Obsidian block ID only when a calendar operation needs one. */
export async function ensureInlineTaskBlockId(
  app: App,
  mutations: InlineFileMutationQueue,
  node: RoadmapNode,
): Promise<string | null> {
  if (node.source !== 'inline') {
    return null;
  }
  return mutations.run(node.path, async () => {
    const file = getMarkdownFile(app, node.path);
    if (file === null) return null;
    let resolvedBlockId: string | null = null;
    await app.vault.process(file, (source) => {
      const document = splitSourceLines(source);
      const lineIndex = resolveInlineTaskLine(document.lines, node);
      const originalLine = document.lines[lineIndex];
      if (lineIndex === -1 || originalLine === undefined) return source;
      const existingBlockIds = managedCalendarBlockIds(originalLine);
      if (existingBlockIds.length > 1) return source;
      const existingBlockId = existingBlockIds[0];
      if (existingBlockId !== undefined) {
        resolvedBlockId = existingBlockId;
        return source;
      }
      const blockId = `nr-cal-${crypto.randomUUID().replaceAll('-', '')}`;
      document.lines[lineIndex] = `${originalLine.trimEnd()} ^${blockId}`;
      resolvedBlockId = blockId;
      return document.lines.join(document.lineEnding);
    });
    return resolvedBlockId;
  });
}

/** Appends scratchpad text while preserving all existing note content. */
export async function appendScratchpadText(app: App, node: RoadmapNode, text: string): Promise<void> {
  const file = getMarkdownFile(app, node.path);
  const trimmedText = text.trim();
  if (file === null || trimmedText.length === 0) {
    return;
  }

  await app.vault.append(file, `\n\n${trimmedText}\n`);
}

/** Creates a real Markdown roadmap note with the selected timeline dates. */
export async function createRoadmapNote(
  app: App,
  startDate: string,
  dueDate: string,
  keys: RoadmapCreationKeys,
): Promise<TFile> {
  const basePath = `Roadmap ${startDate}`;
  const path = getAvailablePath(app, basePath);
  const content = [
    '---',
    `${yamlKey(keys.title)}: "New roadmap task"`,
    `${yamlKey(keys.type)}: task`,
    `${yamlKey(keys.startDate)}: ${startDate}`,
    `${yamlKey(keys.dueDate)}: ${dueDate}`,
    `${yamlKey(keys.durationBuffer)}: 1.3`,
    `${yamlKey(keys.priority)}: medium`,
    `${yamlKey(keys.status)}: todo`,
    `${yamlKey(keys.hardDependency)}: false`,
    '---',
    '',
  ].join('\n');

  return app.vault.create(path, content);
}

function yamlKey(value: string): string {
  return /^[\p{L}\p{N}_-]+$/u.test(value) ? value : JSON.stringify(value);
}

function getMarkdownFile(app: App, path: string): TFile | null {
  const file = app.vault.getAbstractFileByPath(path);
  return file !== null && isMarkdownFile(file) ? file : null;
}

function getAvailablePath(app: App, basePath: string): string {
  let index = 1;
  let path = `${basePath}.md`;
  while (app.vault.getAbstractFileByPath(path) !== null) {
    index += 1;
    path = `${basePath} ${index}.md`;
  }

  return path;
}

async function updateInlineTaskDates(
  app: App,
  mutations: InlineFileMutationQueue,
  file: TFile,
  node: RoadmapNode,
  startDate: string,
  dueDate: string,
): Promise<boolean> {
  return mutations.run(node.path, async () => {
    let updated = false;
    await app.vault.process(file, (source) => {
      const document = splitSourceLines(source);
      const lineIndex = resolveInlineTaskLine(document.lines, node);
      const originalLine = document.lines[lineIndex];
      if (lineIndex === -1 || originalLine === undefined) return source;
      const updatedLine = replaceInlineDateProperties(originalLine, node, startDate, dueDate);
      if (updatedLine === originalLine) return source;
      document.lines[lineIndex] = updatedLine;
      updated = true;
      return document.lines.join(document.lineEnding);
    });
    return updated;
  });
}

function resolveInlineTaskLine(lines: readonly string[], node: RoadmapNode): number {
  if (node.blockId !== undefined) {
    const matches = lines
      .map((line, index) => {
        const blockIds = managedCalendarBlockIds(line);
        return blockIds.length === 1 && blockIds[0] === node.blockId ? index : -1;
      })
      .filter((index) => index >= 0);
    return matches.length === 1 ? matches[0]! : -1;
  }

  const lineMatch = /#L(\d+)$/u.exec(node.id);
  const lineNumber = node.sourceLine === undefined
    ? (lineMatch?.[1] === undefined ? Number.NaN : Number(lineMatch[1]) - 1)
    : node.sourceLine;
  if (lineNumber >= 0 && taskLineMatchesNode(lines[lineNumber] ?? '', node)) {
    return lineNumber;
  }

  const candidates = lines
    .map((line, index) => taskLineMatchesNode(line, node) ? index : -1)
    .filter((index) => index >= 0);
  if (candidates.length === 1) return candidates[0]!;
  return -1;
}

function taskLineMatchesNode(line: string, node: RoadmapNode): boolean {
  if (managedCalendarBlockIds(line).length > 1) return false;
  const body = taskLineBody(line);
  return body !== null
    && taskLineCompleted(line) === node.completed
    && normalizeTaskTitle(stripMarkdownTaskTitle(body)) === normalizeTaskTitle(node.title);
}

function taskLineBody(line: string): string | null {
  return /^\s*[-*+]\s+\[([^\]])\]\s*(.*?)\s*$/u.exec(line)?.[2] ?? null;
}

function taskLineCompleted(line: string): boolean {
  return isCompletedTaskMarker(/^\s*[-*+]\s+\[([^\]])\]/u.exec(line)?.[1] ?? '');
}

function normalizeTaskTitle(value: string): string {
  return value.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function managedCalendarBlockIds(line: string): string[] {
  return Array.from(
    line.matchAll(/(?:^|\s)\^(nr-cal-[A-Za-z0-9-]+)(?=\s|$)/gu),
    (match) => match[1]!,
  );
}

function splitSourceLines(source: string): { lines: string[]; lineEnding: '\r\n' | '\n' } {
  return {
    lines: source.split(/\r?\n/u),
    lineEnding: source.includes('\r\n') ? '\r\n' : '\n',
  };
}

function replaceInlineDateProperties(
  line: string,
  node: RoadmapNode,
  startDate: string,
  dueDate: string,
): string {
  const withStart = replaceOrInsertProperty(line, node.writeKeys.startDate, startDate);
  return replaceOrInsertProperty(withStart, node.writeKeys.dueDate, dueDate);
}

function replaceOrInsertProperty(line: string, property: string, value: string): string {
  const propertyPattern = new RegExp(`\\[${escapeRegExp(property)}::\\s*[^\\]]*\\]`, 'iu');
  if (propertyPattern.test(line)) {
    return line.replace(propertyPattern, `[${property}:: ${value}]`);
  }

  const blockAnchor = /\s+\^[A-Za-z0-9-]+\s*$/u.exec(line);
  const insertion = ` [${property}:: ${value}]`;
  if (blockAnchor === null || blockAnchor.index === undefined) {
    return `${line}${insertion}`;
  }

  return `${line.slice(0, blockAnchor.index)}${insertion}${line.slice(blockAnchor.index)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isMarkdownFile(file: TAbstractFile): file is TFile {
  return (
    'extension' in file &&
    typeof file.extension === 'string' &&
    file.extension.toLocaleLowerCase() === 'md'
  );
}
