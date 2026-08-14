import type { App } from 'obsidian';
import type { RoadmapNode } from '../types';
import { ensureInlineTaskBlockId } from '../utils/obsidianHelpers';

export interface CalendarIdentityResult {
  readonly internalItemId: string;
  readonly node: RoadmapNode;
}

type IdentityRecords = Readonly<Record<string, string>>;

/** Maintains stable internal identities without storing provider metadata in Markdown. */
export class CalendarIdentityManager {
  constructor(
    private readonly app: App,
    private readonly getRecords: () => IdentityRecords,
    private readonly saveRecords: (records: Record<string, string>) => Promise<void>,
    private readonly createId: () => string = createInternalItemId,
  ) {}

  findIdentity(node: RoadmapNode): string | undefined {
    const locator = calendarItemLocator(node);
    return locator === null ? undefined : this.getRecords()[locator];
  }

  async ensureIdentity(node: RoadmapNode): Promise<CalendarIdentityResult | null> {
    let stableNode = node;
    if (node.source === 'inline' && node.blockId === undefined) {
      const blockId = await ensureInlineTaskBlockId(this.app, node);
      if (blockId === null) {
        return null;
      }
      stableNode = {
        ...node,
        id: `${node.path}#^${blockId}`,
        blockId,
      };
    }

    const locator = calendarItemLocator(stableNode);
    if (locator === null) {
      return null;
    }
    const existing = this.getRecords()[locator];
    if (existing !== undefined) {
      return { internalItemId: existing, node: stableNode };
    }

    const internalItemId = this.createId();
    await this.saveRecords({ ...this.getRecords(), [locator]: internalItemId });
    return { internalItemId, node: stableNode };
  }

  async handleFileRename(oldPath: string, newPath: string): Promise<void> {
    const records = this.getRecords();
    const migrated: Record<string, string> = {};
    let changed = false;
    for (const [locator, itemId] of Object.entries(records)) {
      const nextLocator = renameLocator(locator, oldPath, newPath);
      migrated[nextLocator] = itemId;
      changed ||= nextLocator !== locator;
    }
    if (changed) {
      await this.saveRecords(migrated);
    }
  }
}

export function calendarItemLocator(node: RoadmapNode): string | null {
  if (node.source === 'frontmatter') {
    return `frontmatter:${node.path}`;
  }
  return node.blockId === undefined ? null : `inline:${node.path}#^${node.blockId}`;
}

function renameLocator(locator: string, oldPath: string, newPath: string): string {
  if (locator === `frontmatter:${oldPath}`) {
    return `frontmatter:${newPath}`;
  }
  const inlinePrefix = `inline:${oldPath}#^`;
  return locator.startsWith(inlinePrefix)
    ? `inline:${newPath}#^${locator.slice(inlinePrefix.length)}`
    : locator;
}

function createInternalItemId(): string {
  return `nr-${crypto.randomUUID()}`;
}
