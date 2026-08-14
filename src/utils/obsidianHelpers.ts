import { TFile, type App } from 'obsidian';
import type { RoadmapNode } from '../types';
import { replaceTaskCheckbox } from '../core/MarkdownTask';

export interface NodeDateUpdate {
  node: RoadmapNode;
  startDate: string;
  dueDate: string;
}

/** Updates only the date fields belonging to a roadmap node. */
export async function updateNodeDates(
  app: App,
  node: RoadmapNode,
  startDate: string,
  dueDate: string,
): Promise<void> {
  const file = getMarkdownFile(app, node.path);
  if (file === null) {
    return;
  }

  if (node.source === 'frontmatter') {
    await app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter[node.writeKeys.startDate] = startDate;
      frontmatter[node.writeKeys.dueDate] = dueDate;
    });
    return;
  }

  await updateInlineTaskDates(app, file, node, startDate, dueDate);
}

/** Writes several dependency updates sequentially to prevent same-file write races. */
export async function updateNodeDatesBatch(app: App, updates: readonly NodeDateUpdate[]): Promise<void> {
  for (const update of updates) {
    await updateNodeDates(app, update.node, update.startDate, update.dueDate);
  }
}

/** Atomically checks or unchecks the original Markdown checkbox task. */
export async function updateMarkdownTaskCompletion(
  app: App,
  node: RoadmapNode,
  completed: boolean,
): Promise<boolean> {
  if (node.source !== 'inline') {
    return false;
  }
  const file = getMarkdownFile(app, node.path);
  if (file === null) {
    return false;
  }

  let updated = false;
  await app.vault.process(file, (source) => {
    const lines = source.split(/\r?\n/u);
    const lineIndex = findInlineTaskLine(lines, node);
    const originalLine = lines[lineIndex];
    if (lineIndex === -1 || originalLine === undefined) {
      return source;
    }

    const nextLine = replaceTaskCheckbox(originalLine, completed);
    if (nextLine === originalLine) {
      return source;
    }
    lines[lineIndex] = nextLine;
    updated = true;
    return lines.join('\n');
  });
  return updated;
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
export async function createRoadmapNote(app: App, startDate: string, dueDate: string): Promise<TFile> {
  const basePath = `Roadmap ${startDate}`;
  const path = getAvailablePath(app, basePath);
  const content = [
    '---',
    'title: "New roadmap task"',
    'type: task',
    `start_date: ${startDate}`,
    `due_date: ${dueDate}`,
    'duration_buffer: 1.3',
    'priority: medium',
    'status: todo',
    'hard_dependency: false',
    '---',
    '',
  ].join('\n');

  return app.vault.create(path, content);
}

function getMarkdownFile(app: App, path: string): TFile | null {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? file : null;
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
  file: TFile,
  node: RoadmapNode,
  startDate: string,
  dueDate: string,
): Promise<void> {
  await app.vault.process(file, (source) => {
    const lines = source.split(/\r?\n/u);
    const lineIndex = findInlineTaskLine(lines, node);
    const originalLine = lines[lineIndex];
    if (lineIndex === -1 || originalLine === undefined) {
      return source;
    }

    const updatedLine = replaceInlineDateProperties(originalLine, node, startDate, dueDate);
    if (updatedLine === originalLine) {
      return source;
    }
    lines[lineIndex] = updatedLine;
    return lines.join('\n');
  });
}

function findInlineTaskLine(lines: readonly string[], node: RoadmapNode): number {
  if (node.blockId !== undefined) {
    const blockPattern = new RegExp(`\\^${escapeRegExp(node.blockId)}\\s*$`, 'u');
    return lines.findIndex((line) => isTaskLine(line) && blockPattern.test(line));
  }

  const lineMatch = /#L(\d+)$/u.exec(node.id);
  const lineNumber = lineMatch?.[1] === undefined ? Number.NaN : Number(lineMatch[1]);
  const lineIndex = lineNumber - 1;
  return lineIndex >= 0 && isTaskLine(lines[lineIndex] ?? '') ? lineIndex : -1;
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

function isTaskLine(line: string): boolean {
  return /^\s*[-*+]\s+\[[^\]]\]/u.test(line);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
