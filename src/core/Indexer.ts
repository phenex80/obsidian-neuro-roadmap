import type { App, CachedMetadata, EventRef, TAbstractFile, TFile } from 'obsidian';
import { RoadmapParser, type RoadmapParserOptions } from './Parser';
import type { RoadmapNode } from '../types';

export type RoadmapIndexListener = (nodes: readonly RoadmapNode[]) => void;

/**
 * Maintains an in-memory roadmap graph from Obsidian's metadata cache.
 * File contents are read only from Vault's cache when incomplete inline task lines are present.
 */
export class RoadmapIndexer {
  private readonly parser: RoadmapParser;
  private readonly nodesById = new Map<string, RoadmapNode>();
  private readonly nodeIdsByPath = new Map<string, Set<string>>();
  private readonly dependenciesByNodeId = new Map<string, Set<string>>();
  private readonly dependentIdsByNodeId = new Map<string, Set<string>>();
  private readonly listeners = new Set<RoadmapIndexListener>();
  private readonly revisionsByPath = new Map<string, number>();

  constructor(private readonly app: App) {
    this.parser = new RoadmapParser(app.metadataCache);
  }

  /** Performs the one-time cache-backed initial index before a view consumes the graph. */
  async initialize(): Promise<void> {
    await this.rebuild();
  }

  /** Applies YAML mapping settings to all subsequent parser operations. */
  setParserOptions(options: RoadmapParserOptions): void {
    this.parser.setOptions(options);
  }

  /** Rebuilds the graph after parser configuration changes. */
  async rebuild(): Promise<void> {
    this.resetGraph();
    const files = this.app.vault.getMarkdownFiles();
    this.parser.setKnownMarkdownPaths(files.map((file) => file.path));
    await Promise.all(files.map(async (file) => this.reindexFile(file, false)));
    this.emitChange();
  }

  /** Returns cached YAML key usage without reading Markdown file bodies. */
  detectFrontmatterPropertyUsage(): ReadonlyMap<string, number> {
    const usage = new Map<string, number>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (frontmatter === undefined) {
        continue;
      }
      for (const key of Object.keys(frontmatter)) {
        if (key === 'position') {
          continue;
        }
        usage.set(key, (usage.get(key) ?? 0) + 1);
      }
    }
    return usage;
  }

  /** Registers all cache and vault lifecycle events with the owning plugin. */
  registerEvents(registerEvent: (eventRef: EventRef) => void): void {
    registerEvent(
      this.app.metadataCache.on('changed', (file, source, cache) => {
        this.updateFile(file, cache, source);
      }),
    );
    registerEvent(
      this.app.metadataCache.on('deleted', (file) => {
        this.removePath(file.path);
      }),
    );
    registerEvent(
      this.app.vault.on('delete', (file) => {
        this.handleVaultDelete(file);
      }),
    );
    registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.handleVaultRename(file, oldPath);
      }),
    );
  }

  getNodes(): readonly RoadmapNode[] {
    return Array.from(this.nodesById.values(), cloneNode);
  }

  getNode(nodeId: string): RoadmapNode | undefined {
    const node = this.nodesById.get(nodeId);
    return node === undefined ? undefined : cloneNode(node);
  }

  /** Returns indexed inline tasks for one editor without scanning the rest of the vault. */
  getInlineNodesForPath(path: string): readonly RoadmapNode[] {
    return Array.from(this.nodeIdsByPath.get(path) ?? [])
      .map((nodeId) => this.nodesById.get(nodeId))
      .filter((node): node is RoadmapNode => node?.source === 'inline')
      .map(cloneNode);
  }

  getDependencies(nodeId: string): readonly RoadmapNode[] {
    return Array.from(this.dependenciesByNodeId.get(nodeId) ?? [])
      .map((dependencyId) => this.nodesById.get(dependencyId))
      .filter((node): node is RoadmapNode => node !== undefined)
      .map(cloneNode);
  }

  getDependents(nodeId: string): readonly RoadmapNode[] {
    return Array.from(this.dependentIdsByNodeId.get(nodeId) ?? [])
      .map((dependentId) => this.nodesById.get(dependentId))
      .filter((node): node is RoadmapNode => node !== undefined)
      .map(cloneNode);
  }

  /** Returns every dependency cycle as node ID paths without mutating the graph. */
  getCircularDependencyCycles(): readonly (readonly string[])[] {
    const cycles: string[][] = [];
    const visited = new Set<string>();
    const activePath: string[] = [];
    const activeNodes = new Set<string>();
    const recordedCycles = new Set<string>();

    const visit = (nodeId: string): void => {
      if (activeNodes.has(nodeId)) {
        const cycleStart = activePath.indexOf(nodeId);
        const cycle = [...activePath.slice(cycleStart), nodeId];
        const identity = canonicalCycleIdentity(cycle);
        if (!recordedCycles.has(identity)) {
          recordedCycles.add(identity);
          cycles.push(cycle);
        }
        return;
      }
      if (visited.has(nodeId)) {
        return;
      }

      visited.add(nodeId);
      activeNodes.add(nodeId);
      activePath.push(nodeId);
      for (const dependencyId of this.dependenciesByNodeId.get(nodeId) ?? []) {
        if (this.nodesById.has(dependencyId)) {
          visit(dependencyId);
        }
      }
      activePath.pop();
      activeNodes.delete(nodeId);
    };

    for (const nodeId of this.nodesById.keys()) {
      visit(nodeId);
    }

    return cycles.map((cycle) => [...cycle]);
  }

  subscribe(listener: RoadmapIndexListener): () => void {
    this.listeners.add(listener);
    listener(this.getNodes());
    return () => this.listeners.delete(listener);
  }

  clear(): void {
    this.resetGraph();
    this.listeners.clear();
    this.revisionsByPath.clear();
  }

  private resetGraph(): void {
    this.nodesById.clear();
    this.nodeIdsByPath.clear();
    this.dependenciesByNodeId.clear();
    this.dependentIdsByNodeId.clear();
  }

  private updateFile(file: TFile, cache: CachedMetadata, source: string): void {
    this.incrementRevision(file.path);
    this.replaceFileNodes(file.path, this.parser.parseFile(file, cache, source));
    this.emitChange();
  }

  private async reindexFile(file: TFile, emitChange: boolean): Promise<void> {
    const path = file.path;
    const revision = this.incrementRevision(path);
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache === null) {
      this.removePath(path, emitChange);
      return;
    }

    if (this.parser.shouldIgnoreFile(file, cache)) {
      this.removePath(path, emitChange);
      return;
    }

    const source = await this.readSourceForInlineTasks(file, cache);
    if (this.revisionsByPath.get(path) !== revision || file.path !== path) {
      return;
    }

    this.replaceFileNodes(path, this.parser.parseFile(file, cache, source));
    if (emitChange) {
      this.emitChange();
    }
  }

  private async readSourceForInlineTasks(file: TFile, cache: CachedMetadata): Promise<string> {
    if (this.parser.shouldIgnoreFile(file, cache)) {
      return '';
    }

    const containsTask = cache.listItems?.some((item) => item.task !== undefined) ?? false;
    if (!containsTask) {
      return '';
    }

    try {
      return await this.app.vault.cachedRead(file);
    } catch {
      return '';
    }
  }

  private handleVaultDelete(file: TAbstractFile): void {
    if (isMarkdownFile(file)) {
      this.removePath(file.path);
    }
  }

  private handleVaultRename(file: TAbstractFile, oldPath: string): void {
    if (!isMarkdownFile(file)) {
      return;
    }

    this.incrementRevision(oldPath);
    this.removePath(oldPath, false);
    void this.reindexFile(file, true);
  }

  private removePath(path: string, emitChange = true): void {
    this.incrementRevision(path);
    const nodeIds = this.nodeIdsByPath.get(path);
    if (nodeIds === undefined) {
      return;
    }

    for (const nodeId of nodeIds) {
      this.removeNode(nodeId);
    }
    this.nodeIdsByPath.delete(path);

    if (emitChange) {
      this.emitChange();
    }
  }

  private replaceFileNodes(path: string, nodes: readonly RoadmapNode[]): void {
    this.removePath(path, false);

    for (const node of nodes) {
      this.nodesById.set(node.id, cloneNode(node));
      const nodeIds = this.nodeIdsByPath.get(path) ?? new Set<string>();
      nodeIds.add(node.id);
      this.nodeIdsByPath.set(path, nodeIds);
      this.addDependencies(node);
    }
  }

  private addDependencies(node: RoadmapNode): void {
    const dependencies = new Set(node.dependsOn);
    this.dependenciesByNodeId.set(node.id, dependencies);

    for (const dependencyId of dependencies) {
      const dependents = this.dependentIdsByNodeId.get(dependencyId) ?? new Set<string>();
      dependents.add(node.id);
      this.dependentIdsByNodeId.set(dependencyId, dependents);
    }
  }

  private removeNode(nodeId: string): void {
    const dependencies = this.dependenciesByNodeId.get(nodeId) ?? new Set<string>();
    for (const dependencyId of dependencies) {
      const dependents = this.dependentIdsByNodeId.get(dependencyId);
      dependents?.delete(nodeId);
      if (dependents?.size === 0) {
        this.dependentIdsByNodeId.delete(dependencyId);
      }
    }

    this.nodesById.delete(nodeId);
    this.dependenciesByNodeId.delete(nodeId);
  }

  private incrementRevision(path: string): number {
    const revision = (this.revisionsByPath.get(path) ?? 0) + 1;
    this.revisionsByPath.set(path, revision);
    return revision;
  }

  private emitChange(): void {
    const nodes = this.getNodes();
    for (const listener of this.listeners) {
      listener(nodes);
    }
  }
}

function cloneNode(node: RoadmapNode): RoadmapNode {
  return {
    ...node,
    dependsOn: [...node.dependsOn],
  };
}

function canonicalCycleIdentity(cycle: readonly string[]): string {
  const members = cycle.slice(0, -1).sort();
  return members.join('\u0000');
}

function isMarkdownFile(file: TAbstractFile): file is TFile {
  return (
    'extension' in file &&
    typeof file.extension === 'string' &&
    file.extension.toLocaleLowerCase() === 'md'
  );
}
