import type { App } from 'obsidian';
import { DependencyEngine } from './DependencyEngine';
import type { RoadmapIndexer } from './Indexer';
import type { RoadmapNode } from '../types';
import {
  appendScratchpadText,
  createRoadmapNote,
  updateMarkdownTaskCompletion,
  updateNodeDates,
  updateNodeDatesBatch,
} from '../utils/obsidianHelpers';

/** Coordinates roadmap UI actions with atomic Markdown writes. */
export class RoadmapScheduler {
  private readonly dependencyEngine: DependencyEngine;

  constructor(
    private readonly app: App,
    indexer: RoadmapIndexer,
  ) {
    this.dependencyEngine = new DependencyEngine(indexer);
  }

  async rescheduleNode(node: RoadmapNode, startDate: string, dueDate: string): Promise<void> {
    const dependentUpdates = this.dependencyEngine.calculateSoftDependencyUpdates(node, startDate);
    await updateNodeDates(this.app, node, startDate, dueDate);
    await updateNodeDatesBatch(this.app, dependentUpdates);
  }

  async scheduleUnscheduledNode(node: RoadmapNode, startDate: string, dueDate: string): Promise<void> {
    await updateNodeDates(this.app, node, startDate, dueDate);
  }

  async createNode(startDate: string, dueDate: string): Promise<void> {
    await createRoadmapNote(this.app, startDate, dueDate);
  }

  async appendScratchpad(node: RoadmapNode, text: string): Promise<void> {
    await appendScratchpadText(this.app, node, text);
  }

  async setTaskCompletion(node: RoadmapNode, completed: boolean): Promise<boolean> {
    return updateMarkdownTaskCompletion(this.app, node, completed);
  }

  async openSource(node: RoadmapNode): Promise<void> {
    const linktext =
      node.blockId === undefined ? node.path : `${node.path}#^${node.blockId}`;
    await this.app.workspace.openLinkText(linktext, node.path, false);
  }
}
