import {
  Prec,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view';
import {
  editorInfoField,
  editorLivePreviewField,
  getLanguage,
  setIcon,
  type MarkdownFileInfo,
} from 'obsidian';
import type {
  CalendarItemOverride,
  CalendarSemanticType,
  NodeStatus,
  Priority,
  RoadmapNode,
} from '../../types';
import type { PropertyKeyMap, SemanticValueMap } from '../../core/SemanticMapping';
import {
  mapCalendarSemanticType,
  mapPriority,
  mapStatus,
} from '../../core/SemanticMapping';
import {
  findCompactTaskPropertyTokens,
  findManagedCalendarBlockId,
  type EditableTaskProperty,
  type InlineTaskPropertyToken,
} from '../../core/InlineTaskProperties';
import {
  projectCompactTaskMetadata,
  shouldUseCompactTaskPresentation,
  type CompactTaskFieldPresence,
  type CompactTaskMetadata,
} from '../../core/TaskMetadata';
import { describeCalendarAction } from '../../core/CalendarAction';
import {
  TaskPropertiesPopover,
  type TaskCalendarControlState,
  type TaskPropertiesPopoverActions,
} from './TaskPropertiesPopover';

export interface TaskMetadataEditorOptions {
  getInlineNodes(path: string): readonly RoadmapNode[];
  getPropertyKeys(): PropertyKeyMap;
  getSemanticValues(): SemanticValueMap;
  updateProperty(
    node: RoadmapNode,
    field: Exclude<EditableTaskProperty, 'status'>,
    value: string | null,
  ): Promise<void>;
  updateStatus(node: RoadmapNode, status: NodeStatus, persistedValue: string): Promise<void>;
  getCalendarOverride(node: RoadmapNode): CalendarItemOverride | undefined;
  isCalendarIncluded(node: RoadmapNode): boolean;
  isCalendarAvailable(node: RoadmapNode): boolean;
  toggleCalendar(node: RoadmapNode): Promise<void>;
}

const refreshTaskMetadata = StateEffect.define<number>();

export class TaskMetadataEditorIntegration {
  readonly extension: Extension;
  private readonly views = new Set<EditorView>();
  private generation = 0;
  private popover: TaskPropertiesPopover | null = null;
  private disposed = false;

  constructor(private readonly options: TaskMetadataEditorOptions) {
    const owner = this;
    const decorations = StateField.define<DecorationSet>({
      create(state) {
        return owner.buildDecorations(state);
      },
      update(value, transaction) {
        const refreshed = transaction.effects.some((effect) => effect.is(refreshTaskMetadata));
        const fileChanged = editorPath(transaction.startState) !== editorPath(transaction.state);
        const livePreviewChanged = livePreviewEnabled(transaction.startState) !==
          livePreviewEnabled(transaction.state);
        if (
          transaction.docChanged ||
          transaction.selection !== undefined ||
          refreshed ||
          fileChanged ||
          livePreviewChanged
        ) {
          return owner.buildDecorations(transaction.state);
        }
        return value;
      },
      provide: (field) => EditorView.decorations.from(field),
    });
    const viewTracker = ViewPlugin.fromClass(
      class {
        constructor(readonly view: EditorView) {
          owner.views.add(view);
        }

        destroy(): void {
          owner.views.delete(this.view);
        }
      },
    );
    this.extension = Prec.highest([decorations, viewTracker]);
  }

  refresh(): void {
    if (this.disposed) return;
    this.generation += 1;
    this.popover?.close();
    this.popover = null;
    for (const view of [...this.views]) {
      try {
        view.dispatch({ effects: refreshTaskMetadata.of(this.generation) });
      } catch {
        this.views.delete(view);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.popover?.close();
    this.popover = null;
    this.views.clear();
  }

  openProperties(anchor: HTMLButtonElement, node: RoadmapNode): void {
    this.popover?.close();
    this.popover = new TaskPropertiesPopover(anchor, node, this.popoverActions());
    this.popover.open();
  }

  async toggleCalendar(node: RoadmapNode): Promise<void> {
    await this.options.toggleCalendar(node);
    this.refresh();
  }

  calendarState(node: RoadmapNode): TaskCalendarControlState {
    return {
      included: this.options.isCalendarIncluded(node),
      override: this.options.getCalendarOverride(node),
      available: this.options.isCalendarAvailable(node),
    };
  }

  private buildDecorations(state: EditorState): DecorationSet {
    if (!livePreviewEnabled(state)) return Decoration.none;
    const path = editorPath(state);
    if (path === undefined) return Decoration.none;
    const nodes = this.options.getInlineNodes(path);
    if (nodes.length === 0) return Decoration.none;

    const propertyKeys = this.options.getPropertyKeys();
    const semanticValues = this.options.getSemanticValues();
    const ranges: Range<Decoration>[] = [];
    for (const node of nodes) {
      if (!shouldUseCompactTaskPresentation(true, node)) continue;
      if (node.sourceLine === undefined || node.sourceLine >= state.doc.lines) continue;
      const line = state.doc.line(node.sourceLine + 1);
      if (!/^\s*[-*+]\s+\[[^\]]\]/u.test(line.text)) continue;
      const tokens = findCompactTaskPropertyTokens(line.text, propertyKeys);
      const projectedTokens = tokens.filter((token) =>
        tokenCanBeProjected(token, node, semanticValues),
      );
      const fields = fieldPresence(projectedTokens);
      const metadata = projectCompactTaskMetadata(node, fields, getLanguage());

      for (const token of projectedTokens) {
        const from = line.from + token.from;
        const to = line.from + token.to;
        if (!selectionIntersects(state, from, to)) {
          ranges.push(Decoration.replace({}).range(from, to));
        }
      }

      const blockId = findManagedCalendarBlockId(line.text, node.blockId);
      if (blockId !== undefined) {
        const from = line.from + blockId.from;
        const to = line.from + blockId.to;
        if (!selectionIntersects(state, from, to)) {
          ranges.push(Decoration.replace({}).range(from, to));
        }
      }

      ranges.push(
        Decoration.widget({
          widget: new TaskMetadataWidget(this, node, metadata, this.calendarState(node)),
          block: true,
          side: 1,
        }).range(line.to),
      );
    }
    return Decoration.set(ranges, true);
  }

  private popoverActions(): TaskPropertiesPopoverActions {
    return {
      updateProperty: async (node, field, value) => {
        const persistedValue = value === null
          ? null
          : preferredPersistedValue(field, value, this.options.getSemanticValues());
        await this.options.updateProperty(node, field, persistedValue);
      },
      updateStatus: async (node, status) => {
        const persistedValue = this.options.getSemanticValues().status[status][0] ?? status;
        await this.options.updateStatus(node, status, persistedValue);
      },
      calendarState: (node) => this.calendarState(node),
      toggleCalendar: (node) => this.toggleCalendar(node),
    };
  }
}

class TaskMetadataWidget extends WidgetType {
  constructor(
    private readonly owner: TaskMetadataEditorIntegration,
    private readonly node: RoadmapNode,
    private readonly metadata: CompactTaskMetadata,
    private readonly calendar: TaskCalendarControlState,
  ) {
    super();
  }

  eq(other: TaskMetadataWidget): boolean {
    return widgetFingerprint(this.node, this.metadata, this.calendar) ===
      widgetFingerprint(other.node, other.metadata, other.calendar);
  }

  toDOM(view: EditorView): HTMLElement {
    const row = view.dom.ownerDocument.createElement('div');
    row.className = 'nr-task-metadata-row';
    row.classList.toggle('is-minimal', Object.keys(this.metadata).length === 0);
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', `Task metadata for ${this.node.title}`);

    appendMetadataChip(row, this.metadata.dateLabel, 'nr-task-date-chip');
    appendMetadataChip(row, this.metadata.typeLabel, 'nr-task-type-chip');
    appendMetadataChip(
      row,
      this.metadata.priorityLabel,
      `nr-task-priority-chip priority-${this.node.priority}`,
    );
    appendMetadataChip(row, this.metadata.statusLabel, 'nr-task-status-chip');

    if (this.calendar.available || this.calendar.override !== undefined) {
      row.append(this.createCalendarButton(view.dom.ownerDocument));
    }
    row.append(this.createPropertiesButton(view.dom.ownerDocument));
    return row;
  }

  private createCalendarButton(document: Document): HTMLButtonElement {
    const presentation = describeCalendarAction(
      this.calendar.included,
      this.calendar.override,
      this.calendar.available,
    );
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nr-task-metadata-action nr-task-calendar-action';
    button.classList.toggle('is-included', this.calendar.included);
    button.classList.toggle('is-manual', presentation.manual);
    button.title = presentation.actionLabel;
    button.setAttribute('aria-label', `${presentation.actionLabel} ${this.node.title}`);
    button.setAttribute('aria-pressed', String(this.calendar.included));
    button.disabled = !presentation.available;
    setIcon(button, presentation.iconName);
    button.addEventListener('click', () => {
      button.disabled = true;
      void this.owner.toggleCalendar(this.node).catch(() => {
        button.disabled = false;
        button.title = 'Could not update Calendar inclusion.';
      });
    });
    return button;
  }

  private createPropertiesButton(document: Document): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'nr-task-metadata-action nr-task-properties-action';
    button.title = 'Task properties';
    button.setAttribute('aria-label', 'Task properties');
    setIcon(button, 'info');
    button.addEventListener('click', () => this.owner.openProperties(button, this.node));
    return button;
  }
}

function appendMetadataChip(parent: HTMLElement, value: string | undefined, className: string): void {
  if (value === undefined) return;
  const chip = parent.ownerDocument.createElement('span');
  chip.className = `nr-task-metadata-chip ${className}`;
  chip.textContent = value;
  parent.append(chip);
}

function tokenCanBeProjected(
  token: InlineTaskPropertyToken,
  node: RoadmapNode,
  semanticValues: SemanticValueMap,
): boolean {
  if (token.field === 'startDate') return token.value === node.startDate;
  if (token.field === 'dueDate') return token.value === node.dueDate;
  if (token.field === 'type') {
    return mapCalendarSemanticType(token.value, semanticValues) === node.calendarType;
  }
  if (token.field === 'priority') {
    return mapPriority(token.value, semanticValues) === node.priority;
  }
  return mapStatus(token.value, semanticValues) === node.status;
}

function fieldPresence(tokens: readonly InlineTaskPropertyToken[]): CompactTaskFieldPresence {
  const fields = new Set(tokens.map((token) => token.field));
  return {
    startDate: fields.has('startDate'),
    dueDate: fields.has('dueDate'),
    type: fields.has('type'),
    priority: fields.has('priority'),
    status: fields.has('status'),
  };
}

function selectionIntersects(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function editorPath(state: EditorState): string | undefined {
  const info = state.field(editorInfoField, false) as MarkdownFileInfo | undefined;
  return info?.file?.path;
}

function livePreviewEnabled(state: EditorState): boolean {
  return (state.field(editorLivePreviewField, false) as boolean | undefined) ?? false;
}

function preferredPersistedValue(
  field: Exclude<EditableTaskProperty, 'status'>,
  value: string,
  mappings: SemanticValueMap,
): string {
  if (field === 'type') {
    const type = value as CalendarSemanticType;
    return mappings.calendarType[type]?.[0] ?? type;
  }
  if (field === 'priority') {
    const priority = value as Priority;
    return mappings.priority[priority]?.[0] ?? priority;
  }
  return value;
}

function widgetFingerprint(
  node: RoadmapNode,
  metadata: CompactTaskMetadata,
  calendar: TaskCalendarControlState,
): string {
  return JSON.stringify([
    node.id,
    node.title,
    node.startDate,
    node.dueDate,
    node.calendarType,
    node.priority,
    node.status,
    metadata,
    calendar,
  ]);
}
