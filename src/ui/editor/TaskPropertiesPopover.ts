import { setIcon } from 'obsidian';
import {
  CALENDAR_SEMANTIC_TYPES,
  NODE_STATUSES,
  PRIORITIES,
  type CalendarItemOverride,
  type CalendarSemanticType,
  type NodeStatus,
  type Priority,
  type RoadmapNode,
} from '../../types';
import {
  calendarTypeDisplayLabel,
  priorityDisplayLabel,
  statusDisplayLabel,
} from '../../core/TaskMetadata';
import {
  calendarActionStateLabel,
  describeCalendarAction,
} from '../../core/CalendarAction';
import type { EditableTaskProperty } from '../../core/InlineTaskProperties';

export interface TaskCalendarControlState {
  readonly included: boolean;
  readonly override?: CalendarItemOverride;
  readonly available: boolean;
}

export interface TaskPropertiesPopoverActions {
  updateProperty(
    node: RoadmapNode,
    field: Exclude<EditableTaskProperty, 'status'>,
    value: string | null,
  ): Promise<void>;
  updateStatus(node: RoadmapNode, status: NodeStatus): Promise<void>;
  calendarState(node: RoadmapNode): TaskCalendarControlState;
  toggleCalendar(node: RoadmapNode): Promise<void>;
}

let popoverSequence = 0;

export class TaskPropertiesPopover {
  private readonly document: Document;
  private readonly element: HTMLDivElement;
  private closed = false;
  private readonly handleOutsidePointer = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node && !this.element.contains(target) && !this.anchor.contains(target)) {
      this.close();
    }
  };
  private readonly handleKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      this.anchor.focus();
    }
  };
  private readonly handleViewportChange = (): void => this.position();

  constructor(
    private readonly anchor: HTMLButtonElement,
    private readonly node: RoadmapNode,
    private readonly actions: TaskPropertiesPopoverActions,
  ) {
    this.document = anchor.ownerDocument;
    this.element = this.document.body.createDiv({ cls: 'nr-task-properties-popover' });
    this.element.detach();
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-modal', 'false');
    const headingId = `nr-task-properties-${++popoverSequence}`;
    this.element.setAttribute('aria-labelledby', headingId);

    const heading = this.element.createDiv({ cls: 'nr-task-properties-heading' });
    const title = heading.createEl('strong');
    title.id = headingId;
    title.textContent = 'Task properties';
    this.createCloseButton(heading);

    const form = this.element.createDiv({ cls: 'nr-task-properties-form' });
    form.append(
      this.createTypeControl(),
      this.createDateControl('Start', 'startDate', node.startDate),
      this.createDateControl('Due', 'dueDate', node.dueDate),
      this.createPriorityControl(),
      this.createStatusControl(),
      this.createCalendarControl(),
    );
  }

  open(): void {
    this.document.body.append(this.element);
    this.position();
    this.document.addEventListener('pointerdown', this.handleOutsidePointer, true);
    this.document.addEventListener('keydown', this.handleKeydown, true);
    this.document.defaultView?.addEventListener('resize', this.handleViewportChange);
    this.document.addEventListener('scroll', this.handleViewportChange, true);
    this.element.querySelector<HTMLElement>('select, input, button')?.focus();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.document.removeEventListener('pointerdown', this.handleOutsidePointer, true);
    this.document.removeEventListener('keydown', this.handleKeydown, true);
    this.document.defaultView?.removeEventListener('resize', this.handleViewportChange);
    this.document.removeEventListener('scroll', this.handleViewportChange, true);
    this.element.remove();
  }

  private createCloseButton(parent: HTMLElement): HTMLButtonElement {
    const button = parent.createEl('button', { cls: 'nr-task-icon-button' });
    button.type = 'button';
    button.title = 'Close task properties';
    button.setAttribute('aria-label', 'Close task properties');
    setIcon(button, 'x');
    button.addEventListener('click', () => this.close());
    return button;
  }

  private createTypeControl(): HTMLLabelElement {
    const select = this.createSelect<CalendarSemanticType>(
      CALENDAR_SEMANTIC_TYPES,
      this.node.calendarType,
      calendarTypeDisplayLabel,
    );
    select.addEventListener('change', () => {
      void this.commit(select, () => this.actions.updateProperty(this.node, 'type', select.value));
    });
    return this.createField('Type', select);
  }

  private createDateControl(
    label: string,
    field: 'startDate' | 'dueDate',
    value: string | undefined,
  ): HTMLLabelElement {
    const input = this.element.createEl('input');
    input.detach();
    input.type = 'date';
    input.value = value ?? '';
    input.setAttribute('aria-label', `${label} date`);
    input.addEventListener('change', () => {
      void this.commit(input, () =>
        this.actions.updateProperty(this.node, field, input.value.length === 0 ? null : input.value),
      );
    });
    return this.createField(label, input);
  }

  private createPriorityControl(): HTMLLabelElement {
    const select = this.createSelect<Priority>(PRIORITIES, this.node.priority, priorityDisplayLabel);
    select.addEventListener('change', () => {
      void this.commit(select, () =>
        this.actions.updateProperty(this.node, 'priority', select.value),
      );
    });
    return this.createField('Priority', select);
  }

  private createStatusControl(): HTMLLabelElement {
    const select = this.createSelect<NodeStatus>(NODE_STATUSES, this.node.status, statusDisplayLabel);
    select.addEventListener('change', () => {
      void this.commit(select, () => this.actions.updateStatus(this.node, select.value as NodeStatus));
    });
    return this.createField('Status', select);
  }

  private createCalendarControl(): HTMLDivElement {
    const state = this.actions.calendarState(this.node);
    const row = this.element.createDiv({ cls: 'nr-task-property-field' });
    row.detach();
    const label = row.createSpan({ cls: 'nr-task-property-label' });
    label.textContent = 'Calendar';
    const value = row.createDiv({ cls: 'nr-task-calendar-field' });
    const stateText = value.createSpan();
    stateText.textContent = calendarActionStateLabel(state.included, state.override, state.available);
    this.createCalendarButton(value, state);
    return row;
  }

  private createCalendarButton(parent: HTMLElement, state: TaskCalendarControlState): HTMLButtonElement {
    const presentation = describeCalendarAction(state.included, state.override, state.available);
    const button = parent.createEl('button', { cls: 'nr-task-icon-button nr-task-calendar-button' });
    button.type = 'button';
    button.classList.toggle('is-included', state.included);
    button.classList.toggle('is-manual', presentation.manual);
    button.title = presentation.actionLabel;
    button.setAttribute('aria-label', `${presentation.actionLabel} ${this.node.title}`);
    button.setAttribute('aria-pressed', String(state.included));
    button.disabled = !state.available;
    setIcon(button, presentation.iconName);
    button.addEventListener('click', () => {
      void this.commit(button, () => this.actions.toggleCalendar(this.node));
    });
    return button;
  }

  private createSelect<T extends string>(
    values: readonly T[],
    selected: T,
    label: (value: T) => string,
  ): HTMLSelectElement {
    const select = this.element.createEl('select');
    select.detach();
    for (const value of values) {
      const option = select.createEl('option');
      option.value = value;
      option.textContent = label(value);
      option.selected = value === selected;
    }
    return select;
  }

  private createField(labelText: string, control: HTMLElement): HTMLLabelElement {
    const label = this.element.createEl('label', { cls: 'nr-task-property-field' });
    label.detach();
    const text = label.createSpan({ cls: 'nr-task-property-label' });
    text.textContent = labelText;
    label.append(control);
    return label;
  }

  private async commit(control: HTMLButtonElement | HTMLInputElement | HTMLSelectElement, operation: () => Promise<void>): Promise<void> {
    control.disabled = true;
    this.clearError();
    try {
      await operation();
    } catch {
      control.disabled = false;
      this.showError('Could not update this task property. The Markdown source was not replaced.');
    }
  }

  private showError(message: string): void {
    const error = this.element.createEl('p', { cls: 'nr-task-properties-error' });
    error.setAttribute('role', 'alert');
    error.textContent = message;
  }

  private clearError(): void {
    this.element.querySelector('.nr-task-properties-error')?.remove();
  }

  private position(): void {
    if (this.closed || !this.element.isConnected) return;
    const anchor = this.anchor.getBoundingClientRect();
    const popover = this.element.getBoundingClientRect();
    const viewportWidth = this.document.documentElement.clientWidth;
    const viewportHeight = this.document.documentElement.clientHeight;
    const spacing = Number.parseFloat(
      this.document.defaultView?.getComputedStyle(this.element).getPropertyValue('--size-4-2') ?? '',
    ) || 8;
    const left = Math.min(Math.max(spacing, anchor.left), viewportWidth - popover.width - spacing);
    const below = anchor.bottom + spacing;
    const top = below + popover.height <= viewportHeight
      ? below
      : Math.max(spacing, anchor.top - popover.height - spacing);
    this.element.style.left = `${left}px`;
    this.element.style.top = `${top}px`;
  }
}
