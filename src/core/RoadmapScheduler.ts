import { TFile, type App } from 'obsidian';
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
}
