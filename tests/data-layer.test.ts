import assert from 'node:assert/strict';
import test from 'node:test';
import type { CachedMetadata, MetadataCache, TFile } from 'obsidian';
import { RoadmapParser, createDefaultParserOptions, isCompletedTaskMarker } from '../src/core/Parser';
import {
  compilePropertyKeyMap,
  compileSemanticValueMap,
  mapPriority,
  mapStatus,
  readMappedValue,
} from '../src/core/SemanticMapping';
import { propertyMappingSchema, semanticValueMappingSchema } from '../src/types';
import { replaceTaskCheckbox } from '../src/core/MarkdownTask';

const metadataCache = {
  getFirstLinkpathDest: () => null,
} as unknown as MetadataCache;

test('semantic property aliases adapt Slovak and English vault conventions', () => {
  const keys = compilePropertyKeyMap(propertyMappingSchema.parse({}));
  assert.equal(readMappedValue({ predmet: 'ISKB02' }, keys.subject)?.value, 'ISKB02');
  assert.equal(readMappedValue({ course: 'ISKB02' }, keys.subject)?.value, 'ISKB02');
  assert.equal(readMappedValue({ deadline: '2026-10-10' }, keys.dueDate)?.value, '2026-10-10');
  assert.equal(readMappedValue({ due: '2026-10-11' }, keys.dueDate)?.value, '2026-10-11');
});

test('semantic status and priority values normalize aliases and diacritics', () => {
  const values = compileSemanticValueMap(semanticValueMappingSchema.parse({}));
  assert.equal(mapStatus('hotové', values), 'done');
  assert.equal(mapStatus('AKTÍVNY', values), 'in-progress');
  assert.equal(mapPriority('vysoká', values), 'high');
});

test('roadmap anchor notes are indexed while real templates are excluded', () => {
  const parser = new RoadmapParser(metadataCache, createDefaultParserOptions());
  const file = createFile('ISKB02/00 Roadmap.md');
  const cache = createCache(
    { typ: 'roadmapa', predmet: 'ISKB02', semester: '1. semester' },
    [
      { line: 5, task: ' ' },
      { line: 6, task: 'x' },
    ],
  );
  const source = [
    '---',
    'typ: roadmapa',
    'predmet: ISKB02',
    'semester: 1. semester',
    '---',
    '- [ ] Read chapter [due:: 2026-10-10]',
    '- [x] Submit reflection [deadline:: 2026-10-11]',
  ].join('\n');

  const nodes = parser.parseFile(file, cache, source);
  assert.equal(nodes[0]?.type, 'roadmap');
  assert.equal(nodes.filter((node) => node.source === 'inline').length, 2);
  assert.deepEqual(
    nodes.filter((node) => node.source === 'inline').map((node) => node.status),
    ['todo', 'done'],
  );
  assert.ok(nodes.every((node) => node.subject === 'ISKB02'));

  const templateCache = createCache(
    { typ: 'šablóna', predmet: 'ISKB02' },
    [{ line: 4, task: ' ' }],
  );
  assert.deepEqual(
    parser.parseFile(
      createFile('Templates/Subject.md'),
      templateCache,
      '---\ntyp: šablóna\npredmet: ISKB02\n---\n- [ ] Placeholder',
    ),
    [],
  );
});

test('inline tasks inherit subject, semester, and optional project/workstream', () => {
  const parser = new RoadmapParser(metadataCache, createDefaultParserOptions());
  const file = createFile('ISKB02/Semester project.md');
  const cache = createCache(
    {
      predmet: 'ISKB02',
      semester: '1. semester',
      projekt: 'Semester project',
    },
    [
      { line: 5, task: ' ' },
      { line: 6, task: 'x' },
    ],
  );
  const source = [
    '---',
    'predmet: ISKB02',
    'semester: 1. semester',
    'projekt: Semester project',
    '---',
    '- [ ] **Draft:** outline [start:: 2026-09-01] [due:: 2026-09-03]',
    '- [x] Finalize report',
  ].join('\n');
  const tasks = parser.parseFile(file, cache, source).filter((node) => node.source === 'inline');

  assert.equal(tasks.length, 2);
  assert.equal(tasks[0]?.title, 'Draft: outline');
  assert.equal(tasks[0]?.subject, 'ISKB02');
  assert.equal(tasks[0]?.project, 'Semester project');
  assert.equal(tasks[0]?.semester, '1. semester');
  assert.equal(tasks[1]?.completed, true);
  assert.equal(tasks[1]?.status, 'done');
});

test('only x markers are treated as completed checkboxes', () => {
  assert.equal(isCompletedTaskMarker('x'), true);
  assert.equal(isCompletedTaskMarker('X'), true);
  assert.equal(isCompletedTaskMarker(' '), false);
  assert.equal(isCompletedTaskMarker('-'), false);
});

test('checkbox mutation changes only the original Markdown marker', () => {
  const task = '- [ ] Keep **formatting** [due:: 2026-10-10] ^task-1';
  const completed = replaceTaskCheckbox(task, true);
  assert.equal(completed, '- [x] Keep **formatting** [due:: 2026-10-10] ^task-1');
  assert.equal(replaceTaskCheckbox(completed, false), task);
});

function createFile(path: string): TFile {
  const filename = path.split('/').at(-1) ?? path;
  return {
    path,
    basename: filename.endsWith('.md') ? filename.slice(0, -3) : filename,
  } as TFile;
}

function createCache(
  frontmatter: Record<string, unknown>,
  tasks: readonly { readonly line: number; readonly task: string }[],
): CachedMetadata {
  return {
    frontmatter,
    listItems: tasks.map(({ line, task }) => ({
      task,
      position: {
        start: { line, col: 0, offset: 0 },
        end: { line, col: 1, offset: 1 },
      },
      parent: -1,
    })),
  };
}
