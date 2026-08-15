import { Notice, TFile, type App } from 'obsidian';
import { DependencyEngine } from './DependencyEngine';
import type { RoadmapIndexer } from './Indexer';
import type { RoadmapNode } from '../types';
import type { PropertyKeyMap } from './SemanticMapping';
import type { InlineFileMutationQueue } from './InlineFileMutationQueue';
import {
  appendScratchpadText,
  createRoadmapNote,
  updateMarkdownTaskCompletion,
  updateNodeDates,
  updateNodeDatesBatch,
  type RoadmapCreationKeys,
} from '../utils/obsidianHelpers';

/** Coordinates roadmap UI actions with atomic Markdown writes. */
export class RoadmapScheduler {
  private readonly dependencyEngine: DependencyEngine;
  private creationKeys: RoadmapCreationKeys = {
    title: 'title',
    type: 'type',
    startDate: 'start_date',
    dueDate: 'due_date',
    durationBuffer: 'duration_buffer',
    priority: 'priority',
    status: 'status',
    hardDependency: 'hard_dependency',
  };

  constructor(
    private readonly app: App,
    indexer: RoadmapIndexer,
    private readonly mutations: InlineFileMutationQueue,
  ) {
    this.dependencyEngine = new DependencyEngine(indexer);
  }

  async rescheduleNode(node: RoadmapNode, startDate: string, dueDate: string): Promise<void> {
    const dependentUpdates = this.dependencyEngine.calculateSoftDependencyUpdates(node, startDate);
    if (!await updateNodeDates(this.app, this.mutations, node, startDate, dueDate)) {
      this.reportConflict();
      return;
    }
    if (!await updateNodeDatesBatch(this.app, this.mutations, dependentUpdates)) {
      this.reportConflict();
    }
  }

  async scheduleUnscheduledNode(node: RoadmapNode, startDate: string, dueDate: string): Promise<void> {
    if (!await updateNodeDates(this.app, this.mutations, node, startDate, dueDate)) {
      this.reportConflict();
    }
  }

  async createNode(startDate: string, dueDate: string): Promise<void> {
    await createRoadmapNote(this.app, startDate, dueDate, this.creationKeys);
  }

  setCreationPropertyKeys(propertyKeys: PropertyKeyMap): void {
    this.creationKeys = {
      title: propertyKeys.title[0] ?? 'title',
      type: propertyKeys.type[0] ?? 'type',
      startDate: propertyKeys.startDate[0] ?? 'start_date',
      dueDate: propertyKeys.dueDate[0] ?? 'due_date',
      durationBuffer: propertyKeys.durationBuffer[0] ?? 'duration_buffer',
      priority: propertyKeys.priority[0] ?? 'priority',
      status: propertyKeys.status[0] ?? 'status',
      hardDependency: propertyKeys.hardDependency[0] ?? 'hard_dependency',
    };
  }

  async appendScratchpad(node: RoadmapNode, text: string): Promise<void> {
    await appendScratchpadText(this.app, node, text);
  }

  async setTaskCompletion(node: RoadmapNode, completed: boolean): Promise<boolean> {
    const updated = await updateMarkdownTaskCompletion(this.app, this.mutations, node, completed);
    if (!updated) this.reportConflict();
    return updated;
  }

  async openSource(node: RoadmapNode): Promise<void> {
    if (node.blockId !== undefined) {
      await this.app.workspace.openLinkText(`${node.path}#^${node.blockId}`, node.path, false);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(node.path);
    if (!(file instanceof TFile)) {
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file, {
      active: true,
      eState: node.sourceLine === undefined ? undefined : { line: node.sourceLine },
    });
  }

  private reportConflict(): void {
    new Notice('Task changed externally and could not be identified safely. Refresh the roadmap and try again.');
  }
}
