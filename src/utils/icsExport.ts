import type { RoadmapNode } from '../types';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

/** Generates a complete RFC 5545-compatible calendar from scheduled roadmap nodes. */
export function exportToICS(nodes: RoadmapNode[]): string {
  const eventLines = nodes.flatMap((node) => createEvent(node));
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Neuro-Adaptive Roadmap//Academic Roadmap//EN',
    'CALSCALE:GREGORIAN',
    ...eventLines,
    'END:VCALENDAR',
  ].join('\n');
}

function createEvent(node: RoadmapNode): string[] {
  const startDate = formatDate(node.startDate ?? node.dueDate);
  if (startDate === null) {
    return [];
  }

  const lines = [
    'BEGIN:VEVENT',
    `SUMMARY:${escapeText(displayTitle(node))}`,
    `DTSTART;VALUE=DATE:${startDate}`,
  ];

  if (node.startDate !== undefined && node.dueDate !== undefined) {
    const exclusiveEndDate = addCalendarDays(node.dueDate, 1);
    if (exclusiveEndDate !== null) {
      lines.push(`DTEND;VALUE=DATE:${exclusiveEndDate}`);
    }
  }

  lines.push('END:VEVENT');
  return lines;
}

function formatDate(value: string | undefined): string | null {
  if (value === undefined || !DATE_PATTERN.test(value)) {
    return null;
  }

  const [yearValue, monthValue, dayValue] = value.split('-');
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return value.replaceAll('-', '');
}

function addCalendarDays(value: string, days: number): string | null {
  const formattedDate = formatDate(value);
  if (formattedDate === null) {
    return null;
  }

  const year = Number(formattedDate.slice(0, 4));
  const month = Number(formattedDate.slice(4, 6));
  const day = Number(formattedDate.slice(6, 8));
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return [
    String(shifted.getUTCFullYear()).padStart(4, '0'),
    String(shifted.getUTCMonth() + 1).padStart(2, '0'),
    String(shifted.getUTCDate()).padStart(2, '0'),
  ].join('');
}

function displayTitle(node: RoadmapNode): string {
  if (node.title.trim().length > 0) {
    return node.title;
  }

  const filename = node.path.split('/').at(-1) ?? '';
  const basename = filename.endsWith('.md') ? filename.slice(0, -3) : filename;
  return basename.length > 0 ? basename : 'Neznáma úloha';
}

function escapeText(value: string): string {
  return value
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', '\\n')
    .replaceAll(',', '\\,')
    .replaceAll(';', '\\;');
}
