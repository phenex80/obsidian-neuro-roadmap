import { MarkdownRenderChild, type App, type Plugin } from 'obsidian';
import { mount, unmount } from 'svelte';
import type { RoadmapIndexer } from '../../core/Indexer';
import EmbeddedRoadmap from '../components/EmbeddedRoadmap.svelte';
import CodeblockError from '../components/CodeblockError.svelte';
import type { EmbeddedRoadmapConfig } from '../embeddedRoadmap';

type CodeblockParseResult =
  | { success: true; config: EmbeddedRoadmapConfig }
  | { success: false; message: string };

/** Registers lifecycle-managed, Svelte-rendered roadmap codeblocks. */
export function registerRoadmapCodeblockProcessor(
  plugin: Plugin,
  app: App,
  indexer: RoadmapIndexer,
): void {
  plugin.registerMarkdownCodeBlockProcessor('roadmap', (source, element, context) => {
    const result = parseRoadmapCodeblock(source, app, context.sourcePath);
    if (!result.success) {
      context.addChild(new CodeblockErrorChild(element, result.message));
      return;
    }

    context.addChild(new EmbeddedRoadmapChild(element, indexer, result.config));
  });
}

function parseRoadmapCodeblock(source: string, app: App, sourcePath: string): CodeblockParseResult {
  const entries = new Map<string, string>();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    const separator = line.indexOf(':');
    if (separator === -1) {
      return { success: false, message: `Expected “key: value”, received “${line}”.` };
    }

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!['subject', 'view', 'mode'].includes(key) || value.length === 0) {
      return { success: false, message: `Unsupported or empty configuration key “${key}”.` };
    }
    entries.set(key, value);
  }

  const mode = entries.get('mode') ?? 'gantt';
  if (mode !== 'gantt' && mode !== 'horizon') {
    return { success: false, message: 'Mode must be “gantt” or “horizon”.' };
  }

  const view = entries.get('view') ?? 'compact';
  if (view !== 'compact' && view !== 'detailed') {
    return { success: false, message: 'View must be “compact” or “detailed”.' };
  }

  const subject = entries.get('subject');
  if (subject === undefined) {
    return { success: true, config: { mode, view } };
  }

  const linkpath = parseWikilink(subject);
  if (linkpath === null) {
    return { success: false, message: 'Subject must be a valid wikilink such as [[Matematika 1]].' };
  }

  const file = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
  if (file === null) {
    return { success: false, message: `Subject link “${subject}” could not be resolved.` };
  }

  return { success: true, config: { mode, view, subjectPath: file.path } };
}

function parseWikilink(value: string): string | null {
  const match = /^\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]$/u.exec(value.trim());
  const linkpath = match?.[1]?.trim();
  return linkpath === undefined || linkpath.length === 0 ? null : linkpath;
}

class EmbeddedRoadmapChild extends MarkdownRenderChild {
  private component: Record<string, unknown> | null = null;

  constructor(
    containerEl: HTMLElement,
    private readonly indexer: RoadmapIndexer,
    private readonly config: EmbeddedRoadmapConfig,
  ) {
    super(containerEl);
  }

  onload(): void {
    this.component = mount(EmbeddedRoadmap, {
      target: this.containerEl,
      props: { indexer: this.indexer, config: this.config },
    });
  }

  onunload(): void {
    if (this.component !== null) {
      void unmount(this.component);
      this.component = null;
    }
  }
}

class CodeblockErrorChild extends MarkdownRenderChild {
  private component: Record<string, unknown> | null = null;

  constructor(
    containerEl: HTMLElement,
    private readonly message: string,
  ) {
    super(containerEl);
  }

  onload(): void {
    this.component = mount(CodeblockError, {
      target: this.containerEl,
      props: { message: this.message },
    });
  }

  onunload(): void {
    if (this.component !== null) {
      void unmount(this.component);
      this.component = null;
    }
  }
}
