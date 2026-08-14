import assert from 'node:assert/strict';
import test from 'node:test';
import type { App, CachedMetadata, MetadataCache, TFile } from 'obsidian';
import { RoadmapParser, createDefaultParserOptions, isCompletedTaskMarker } from '../src/core/Parser';
import {
  compilePropertyKeyMap,
  compileSemanticValueMap,
  mapPriority,
  mapStatus,
  mapCalendarSemanticType,
  readMappedValue,
} from '../src/core/SemanticMapping';
import { propertyMappingSchema, semanticValueMappingSchema } from '../src/types';
import { replaceTaskCheckbox } from '../src/core/MarkdownTask';
import {
  buildTimelineOverview,
  createTimelineDomain,
  isNodeOverdue,
} from '../src/core/TimelineDomain';
import type { RoadmapNode } from '../src/types';
import { DependencyEngine } from '../src/core/DependencyEngine';
import { RoadmapIndexer } from '../src/core/Indexer';
import { isCalendarEligible, projectCalendarEvent } from '../src/core/CalendarCore';
import { CalendarIdentityManager, calendarItemLocator } from '../src/core/CalendarIdentity';
import { exportCalendarEventsToICS, IcsCalendarProvider } from '../src/calendar/IcsCalendarProvider';
import type { CalendarEventProjection } from '../src/core/CalendarCore';
import { buildSubjectSummaries } from '../src/core/DashboardMetrics';
import { classifyHorizon, formatRelativeTaskDate } from '../src/core/HorizonPlanner';
import { migrateRoadmapSettingsData } from '../src/core/SettingsMigration';
import { roadmapSettingsSchema } from '../src/types';
import {
  compileSourceScope,
  isFrontmatterInSourceScope,
} from '../src/core/SourceScope';

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
  assert.equal(mapCalendarSemanticType('skúška', values), 'exam');
  assert.equal(mapCalendarSemanticType('prezentácia', values), 'presentation');
});

test('calendar policy includes meaningful dates and excludes regular tasks by default', () => {
  const options = createCalendarOptions();
  assert.equal(isCalendarEligible(createNode('exam', { calendarType: 'exam', dueDate: '2026-10-10' }), options), true);
  assert.equal(isCalendarEligible(createNode('milestone', { calendarType: 'milestone', dueDate: '2026-10-11' }), options), true);
  assert.equal(isCalendarEligible(createNode('project', { calendarType: 'project-deadline', dueDate: '2026-10-12' }), options), true);
  assert.equal(isCalendarEligible(createNode('task', { calendarType: 'regular-task', dueDate: '2026-10-13' }), options), false);
});

test('calendar item overrides take precedence over global policy', () => {
  const regularTask = createNode('task', { calendarType: 'regular-task', dueDate: '2026-10-13' });
  const milestone = createNode('milestone', { calendarType: 'milestone', dueDate: '2026-10-14' });
  assert.equal(isCalendarEligible(regularTask, { ...createCalendarOptions(), override: 'include' }), true);
  assert.equal(isCalendarEligible(milestone, { ...createCalendarOptions(), override: 'exclude' }), false);
});

test('calendar projection uses commitment date instead of the Gantt planning interval', () => {
  const node = createNode('assignment', {
    title: 'Odovzdať reflexiu',
    subject: 'ISKB02',
    calendarType: 'assignment-deadline',
    startDate: '2026-10-01',
    dueDate: '2026-10-10',
  });
  const event = projectCalendarEvent(node, 'stable-id', createCalendarOptions());
  assert.equal(event?.startDate, '2026-10-10');
  assert.equal(event?.endDateExclusive, '2026-10-11');
  assert.equal(event?.title, 'ISKB02 · Odovzdať reflexiu');
  assert.equal(event?.availability, 'free');
});

test('completed and overdue items retain calendar projection semantics', () => {
  const completed = projectCalendarEvent(
    createNode('done', { calendarType: 'exam', dueDate: '2026-09-01', status: 'done', completed: true }),
    'done-id',
    createCalendarOptions('2026-09-10'),
  );
  const overdue = projectCalendarEvent(
    createNode('late', { calendarType: 'exam', dueDate: '2026-09-01' }),
    'late-id',
    createCalendarOptions('2026-09-10'),
  );
  assert.equal(completed?.completed, true);
  assert.equal(completed?.overdue, false);
  assert.equal(overdue?.overdue, true);
  assert.match(overdue?.description ?? '', /Overdue: yes/u);
});

test('calendar identity survives title and date changes', async () => {
  let records: Record<string, string> = {};
  const manager = new CalendarIdentityManager(
    {} as App,
    () => records,
    async (nextRecords) => { records = nextRecords; },
    () => 'stable-calendar-id',
  );
  const original = createNode('note', {
    source: 'frontmatter',
    path: 'Subjects/Exam.md',
    title: 'Original title',
    dueDate: '2026-10-10',
  });
  const first = await manager.ensureIdentity(original);
  const changed = await manager.ensureIdentity({
    ...original,
    title: 'Renamed title',
    dueDate: '2026-11-20',
  });
  assert.equal(first?.internalItemId, 'stable-calendar-id');
  assert.equal(changed?.internalItemId, 'stable-calendar-id');
});

test('inline block identity survives line movement and file rename migration', async () => {
  let records: Record<string, string> = {};
  let sequence = 0;
  const manager = new CalendarIdentityManager(
    {} as App,
    () => records,
    async (nextRecords) => { records = nextRecords; },
    () => `stable-${++sequence}`,
  );
  const original = createNode('task-line-4', {
    path: 'Subjects/Tasks.md',
    blockId: 'nr-cal-existing',
    sourceLine: 3,
  });
  const first = await manager.ensureIdentity(original);
  const moved = await manager.ensureIdentity({ ...original, id: 'task-line-40', sourceLine: 39 });
  assert.equal(first?.internalItemId, moved?.internalItemId);
  assert.equal(calendarItemLocator(moved?.node ?? original), 'inline:Subjects/Tasks.md#^nr-cal-existing');

  await manager.handleFileRename('Subjects/Tasks.md', 'Archive/Tasks.md');
  const renamed = await manager.ensureIdentity({ ...original, path: 'Archive/Tasks.md' });
  assert.equal(renamed?.internalItemId, first?.internalItemId);
});

test('calendar identity adds a minimal block ID only when an inline task needs one', async () => {
  const file = { ...createFile('Subjects/Tasks.md'), extension: 'md' } as TFile;
  let source = '- [ ] Submit paper [due:: 2026-10-10]';
  let records: Record<string, string> = {};
  const app = {
    vault: {
      getAbstractFileByPath: () => file,
      process: async (_file: TFile, transform: (value: string) => string) => {
        source = transform(source);
      },
    },
  } as unknown as App;
  const manager = new CalendarIdentityManager(
    app,
    () => records,
    async (nextRecords) => { records = nextRecords; },
    () => 'generated-stable-id',
  );
  const result = await manager.ensureIdentity(createNode('Subjects/Tasks.md#L1', {
    path: 'Subjects/Tasks.md',
    source: 'inline',
    sourceLine: 0,
  }));

  assert.match(source, / \^nr-cal-[a-f0-9]+$/u);
  assert.match(result?.node.blockId ?? '', /^nr-cal-[a-f0-9]+$/u);
  assert.equal(result?.internalItemId, 'generated-stable-id');
});

test('calendar sync state remains plugin-managed and defaults empty', () => {
  const settings = roadmapSettingsSchema.parse({});
  assert.deepEqual(settings.calendarState.itemIdentities, {});
  assert.deepEqual(settings.calendarState.itemOverrides, {});
  assert.deepEqual(settings.calendarState.syncRecords, {});
});

test('ICS provider emits stable RFC 5545 all-day events with reminders', () => {
  const event = createCalendarEvent('stable-id', {
    title: 'ISKB02 · Skúška, časť; A',
    description: 'Riadok 1\nRiadok 2; čiarka, spätné \\ lomítko',
    startDate: '2026-10-10',
    endDateExclusive: '2026-10-11',
    reminderMinutes: 1440,
  });
  const ics = exportCalendarEventsToICS([event], {
    now: () => new Date('2026-08-15T10:20:30.000Z'),
  });
  const unfolded = ics.replace(/\r\n /gu, '');

  assert.ok(ics.endsWith('\r\n'));
  assert.match(unfolded, /BEGIN:VCALENDAR\r\nVERSION:2\.0\r\n/u);
  assert.match(unfolded, /UID:stable-id@neuro-roadmap\r\n/u);
  assert.match(unfolded, /DTSTAMP:20260815T102030Z\r\n/u);
  assert.match(unfolded, /DTSTART;VALUE=DATE:20261010\r\n/u);
  assert.match(unfolded, /DTEND;VALUE=DATE:20261011\r\n/u);
  assert.match(unfolded, /SUMMARY:ISKB02 · Skúška\\, časť\\; A\r\n/u);
  assert.match(unfolded, /DESCRIPTION:Riadok 1\\nRiadok 2\\; čiarka\\, spätné \\\\ lomítko\r\n/u);
  assert.match(unfolded, /TRANSP:TRANSPARENT\r\n/u);
  assert.match(unfolded, /BEGIN:VALARM\r\nTRIGGER:-P1D\r\n/u);
});

test('ICS output is deterministic, ordered, and Unicode-safe when folded', () => {
  const options = { now: () => new Date('2026-08-15T10:20:30.000Z') };
  const events = [
    createCalendarEvent('later', {
      title: 'Veľmi dlhý český a slovenský názov skúšky s diakritikou žluťoučký kôň',
      startDate: '2026-12-10',
      endDateExclusive: '2026-12-11',
    }),
    createCalendarEvent('earlier', {
      title: 'Prezentácia',
      startDate: '2026-10-10',
      endDateExclusive: '2026-10-11',
    }),
  ];
  const first = exportCalendarEventsToICS(events, options);
  const second = exportCalendarEventsToICS([...events].reverse(), options);

  assert.equal(first, second);
  assert.ok(first.indexOf('UID:earlier@') < first.indexOf('UID:later@'));
  for (const line of first.split('\r\n').filter((value) => value.length > 0)) {
    assert.ok(new TextEncoder().encode(line).length <= 75, line);
  }
  assert.match(first.replace(/\r\n /gu, ''), /žluťoučký kôň/u);
});

test('ICS provider advertises file-only capabilities without remote APIs', async () => {
  const provider = new IcsCalendarProvider();
  assert.equal((await provider.initialize()).connected, true);
  assert.deepEqual(await provider.listCalendars(), []);
  assert.deepEqual(provider.capabilities, {
    export: true,
    remoteCalendars: false,
    create: false,
    update: false,
    delete: false,
    reminders: true,
  });
});

test('roadmap anchor notes contribute inline tasks but are not task nodes', () => {
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
  assert.equal(nodes.some((node) => node.source === 'frontmatter'), false);
  assert.equal(nodes.filter((node) => node.source === 'inline').length, 2);
  assert.deepEqual(
    nodes.filter((node) => node.source === 'inline').map((node) => node.status),
    ['todo', 'done'],
  );
  assert.equal(
    nodes.filter((node) => node.source === 'inline')[1]?.writeKeys.dueDate,
    'deadline',
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

test('frontmatter roadmap eligibility rejects generic note types and accepts explicit items', () => {
  const parser = new RoadmapParser(metadataCache, createDefaultParserOptions());
  const cases: readonly {
    readonly name: string;
    readonly frontmatter: Record<string, unknown>;
    readonly expectedType?: RoadmapNode['type'];
  }[] = [
    { name: 'dashboard', frontmatter: { typ: 'dashboard', stav: 'aktivny' } },
    { name: 'source', frontmatter: { typ: 'zdroj' } },
    { name: 'lecture', frontmatter: { typ: 'prednaska', stav: 'prebieha' } },
    { name: 'task', frontmatter: { typ: 'task' }, expectedType: 'task' },
    { name: 'project', frontmatter: { typ: 'projekt' }, expectedType: 'project' },
    { name: 'milestone', frontmatter: { typ: 'milestone' }, expectedType: 'milestone' },
    { name: 'implicit scheduled item', frontmatter: { typ: 'zdroj', deadline: '2026-11-03' }, expectedType: 'task' },
  ];

  for (const item of cases) {
    const nodes = parser.parseFile(
      createFile(`Notes/${item.name}.md`),
      createCache(item.frontmatter, []),
      '',
    );
    const frontmatterNode = nodes.find((node) => node.source === 'frontmatter');
    assert.equal(frontmatterNode?.type, item.expectedType, item.name);
  }
});

test('excluded path prefixes reject frontmatter nodes and inline tasks before parsing', () => {
  const parser = new RoadmapParser(metadataCache, {
    ...createDefaultParserOptions(),
    excludedPathPrefixes: ['40 Systém/Šablóny'],
  });
  const file = createFile('40 Systém/Šablóny/Prednáška.md');
  const cache = createCache(
    { typ: 'task', predmet: 'ISKB02', deadline: '2026-10-10' },
    [{ line: 4, task: ' ' }],
  );

  assert.equal(parser.shouldIgnoreFile(file, cache), true);
  assert.deepEqual(
    parser.parseFile(
      file,
      cache,
      '---\ntyp: task\npredmet: ISKB02\n---\n- [ ] Sample template task',
    ),
    [],
  );
});

test('all-files source scope preserves checkbox indexing from ordinary Markdown files', () => {
  const parser = new RoadmapParser(metadataCache, createDefaultParserOptions());
  const nodes = parser.parseFile(
    createFile('40 Systém/Backup.md'),
    createCache({ typ: 'systém' }, [{ line: 3, task: ' ' }]),
    '---\ntyp: systém\n---\n- [ ] Je vytvorená záloha vaultu.',
  );

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]?.source, 'inline');
});

test('rules source scope includes exact scalar and YAML list matches', () => {
  const scope = compileSourceScope('rules', [
    { property: 'typ', acceptedValues: 'predmet, projekt' },
  ]);

  assert.equal(isFrontmatterInSourceScope({ typ: 'predmet' }, scope), true);
  assert.equal(isFrontmatterInSourceScope({ typ: 'projekt' }, scope), true);
  assert.equal(isFrontmatterInSourceScope({ typ: ['niečo', 'predmet'] }, scope), true);
  assert.equal(isFrontmatterInSourceScope({ typ: 'projektová dokumentácia' }, scope), false);
  assert.equal(isFrontmatterInSourceScope({ typ: 'systém' }, scope), false);
  assert.equal(isFrontmatterInSourceScope({ typ: 'zdroj' }, scope), false);
  assert.equal(isFrontmatterInSourceScope({}, scope), false);
  assert.equal(isFrontmatterInSourceScope(null, scope), false);
});

test('source rules use normalized property/value matching and ANY semantics', () => {
  const scope = compileSourceScope('rules', [
    { property: 'TÝP', acceptedValues: 'PREDMET' },
    { property: 'area', acceptedValues: 'university' },
  ]);

  assert.equal(isFrontmatterInSourceScope({ typ: 'predmet' }, scope), true);
  assert.equal(isFrontmatterInSourceScope({ category: 'other', AREA: 'University' }, scope), true);
  assert.equal(isFrontmatterInSourceScope({ typ: 'zdroj', area: 'personal' }, scope), false);
});

test('rules mode indexes incomplete and completed tasks only from matching source documents', () => {
  const parser = createRulesParser([
    { property: 'typ', acceptedValues: 'predmet, projekt, roadmapa, prednáška' },
  ]);
  const source = [
    '---',
    'typ: prednáška',
    'predmet: ISKB02',
    '---',
    '- [ ] Prečítať článok',
    '- [x] Zapísať reflexiu',
  ].join('\n');
  const nodes = parser.parseFile(
    createFile('10 Štúdium/ISKB02/Prednáška 1.md'),
    createCache(
      { typ: 'prednáška', predmet: 'ISKB02' },
      [{ line: 4, task: ' ' }, { line: 5, task: 'x' }],
    ),
    source,
  );

  assert.equal(nodes.some((node) => node.source === 'frontmatter'), false);
  assert.deepEqual(nodes.map((node) => node.status), ['unscheduled', 'done']);
  assert.ok(nodes.every((node) => node.subject === 'ISKB02'));
});

test('rules mode rejects inline tasks from nonmatching and property-less source documents', () => {
  const parser = createRulesParser([
    { property: 'typ', acceptedValues: 'predmet, projekt' },
  ]);
  const cases = [
    { path: '40 Systém/Backup.md', frontmatter: { typ: 'systém' } },
    { path: '30 Zdroje/Kniha.md', frontmatter: { typ: 'zdroj' } },
    { path: 'Notes/Plain.md', frontmatter: {} },
  ];

  for (const item of cases) {
    const nodes = parser.parseFile(
      createFile(item.path),
      createCache(item.frontmatter, [{ line: 3, task: ' ' }]),
      '---\ntyp: ignored\n---\n- [ ] Noise task',
    );
    assert.deepEqual(nodes, [], item.path);
  }
});

test('matching explicit project source remains a project node', () => {
  const parser = createRulesParser([
    { property: 'typ', acceptedValues: 'predmet, projekt' },
  ]);
  const nodes = parser.parseFile(
    createFile('20 Projekty/Web.md'),
    createCache({ typ: 'projekt' }, []),
    '',
  );

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]?.type, 'project');
  assert.equal(nodes[0]?.source, 'frontmatter');
});

test('source eligibility never promotes matching non-roadmap document types into task nodes', () => {
  const parser = createRulesParser([
    { property: 'typ', acceptedValues: 'predmet, prednáška' },
  ]);

  assert.deepEqual(
    parser.parseFile(
      createFile('Subjects/ISKB02.md'),
      createCache({ typ: 'predmet' }, []),
      '',
    ),
    [],
  );
  assert.deepEqual(
    parser.parseFile(
      createFile('Lectures/Lecture.md'),
      createCache({ typ: 'prednáška', stav: 'prebieha' }, []),
      '',
    ),
    [],
  );
});

test('roadmap anchor semantics remain intact inside rules source scope', () => {
  const parser = createRulesParser([
    { property: 'typ', acceptedValues: 'roadmapa' },
  ]);
  const nodes = parser.parseFile(
    createFile('10 Štúdium/ISKB02/00 Roadmap.md'),
    createCache({ typ: 'roadmapa', predmet: 'ISKB02' }, [{ line: 4, task: ' ' }]),
    '---\ntyp: roadmapa\npredmet: ISKB02\n---\n- [ ] Pripraviť plán skúšky',
  );

  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]?.source, 'inline');
  assert.equal(nodes[0]?.subject, 'ISKB02');
});

test('hard path and template exclusions win over matching source rules', () => {
  const options = {
    ...createDefaultParserOptions(),
    excludedPathPrefixes: ['40 Systém/Šablóny'],
    sourceScope: compileSourceScope('rules', [
      { property: 'typ', acceptedValues: 'projekt, šablóna' },
    ]),
  };
  const parser = new RoadmapParser(metadataCache, options);
  const taskSource = '---\ntyp: projekt\n---\n- [ ] Sample';

  assert.deepEqual(
    parser.parseFile(
      createFile('40 Systém/Šablóny/Projekt.md'),
      createCache({ typ: 'projekt' }, [{ line: 3, task: ' ' }]),
      taskSource,
    ),
    [],
  );
  assert.deepEqual(
    parser.parseFile(
      createFile('Notes/Template.md'),
      createCache({ typ: 'šablóna' }, [{ line: 3, task: ' ' }]),
      '---\ntyp: šablóna\n---\n- [ ] Sample',
    ),
    [],
  );
});

test('changing source scope options excludes previously accepted parser input', () => {
  const parser = new RoadmapParser(metadataCache, createDefaultParserOptions());
  const file = createFile('40 Systém/Backup.md');
  const cache = createCache({ typ: 'systém' }, [{ line: 3, task: ' ' }]);
  const source = '---\ntyp: systém\n---\n- [ ] Je vytvorená záloha vaultu.';
  assert.equal(parser.parseFile(file, cache, source).length, 1);

  parser.setOptions({
    ...createDefaultParserOptions(),
    sourceScope: compileSourceScope('rules', [
      { property: 'typ', acceptedValues: 'predmet' },
    ]),
  });
  assert.deepEqual(parser.parseFile(file, cache, source), []);
});

test('indexer rebuild removes stale out-of-scope nodes without reading excluded Markdown', async () => {
  const file = {
    ...createFile('40 Systém/Backup.md'),
    extension: 'md',
  } as TFile;
  const cache = createCache({ typ: 'systém' }, [{ line: 3, task: ' ' }]);
  const source = '---\ntyp: systém\n---\n- [ ] Je vytvorená záloha vaultu.';
  let cachedReadCount = 0;
  const app = {
    metadataCache: {
      getFileCache: () => cache,
      getFirstLinkpathDest: () => null,
    },
    vault: {
      getMarkdownFiles: () => [file],
      cachedRead: async () => {
        cachedReadCount += 1;
        return source;
      },
    },
  } as unknown as App;
  const indexer = new RoadmapIndexer(app);

  indexer.setParserOptions(createDefaultParserOptions());
  await indexer.initialize();
  assert.equal(indexer.getNodes().length, 1);
  assert.equal(cachedReadCount, 1);

  indexer.setParserOptions({
    ...createDefaultParserOptions(),
    sourceScope: compileSourceScope('rules', [
      { property: 'typ', acceptedValues: 'predmet' },
    ]),
  });
  await indexer.rebuild();
  assert.deepEqual(indexer.getNodes(), []);
  assert.equal(cachedReadCount, 1);
});

test('wikilink and unambiguous plain subject linkpath share one canonical identity', () => {
  const subjectFile = createFile('Subjects/01 ISKB02 Úvod do knihovníctví.md');
  const resolvingCache = {
    getFirstLinkpathDest: (linkpath: string) =>
      linkpath === '01 ISKB02 Úvod do knihovníctví' ? subjectFile : null,
  } as unknown as MetadataCache;
  const parser = new RoadmapParser(resolvingCache, createDefaultParserOptions());
  parser.setKnownMarkdownPaths([
    subjectFile.path,
    'Tasks/Wikilink task.md',
    'Tasks/Plain task.md',
  ]);

  const wikilinkNode = parser.parseFile(
    createFile('Tasks/Wikilink task.md'),
    createCache({ typ: 'task', predmet: '[[01 ISKB02 Úvod do knihovníctví]]' }, []),
    '',
  )[0];
  const plainNode = parser.parseFile(
    createFile('Tasks/Plain task.md'),
    createCache({ typ: 'task', predmet: '01 ISKB02 Úvod do knihovníctví' }, []),
    '',
  )[0];

  assert.equal(wikilinkNode?.subject, subjectFile.path);
  assert.equal(plainNode?.subject, subjectFile.path);
  assert.equal(new Set([wikilinkNode?.subject, plainNode?.subject]).size, 1);
});

test('ambiguous plain subject basename remains a distinct plain-text identity', () => {
  const firstSubject = createFile('Subjects/A/Shared subject.md');
  const resolvingCache = {
    getFirstLinkpathDest: () => firstSubject,
  } as unknown as MetadataCache;
  const parser = new RoadmapParser(resolvingCache, createDefaultParserOptions());
  parser.setKnownMarkdownPaths([
    firstSubject.path,
    'Subjects/B/Shared subject.md',
    'Tasks/Task.md',
  ]);

  const node = parser.parseFile(
    createFile('Tasks/Task.md'),
    createCache({ typ: 'task', predmet: 'Shared subject' }, []),
    '',
  )[0];

  assert.equal(node?.subject, 'Shared subject');
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
  assert.equal(tasks[0]?.writeKeys.startDate, 'start');
  assert.equal(tasks[0]?.writeKeys.dueDate, 'due');
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

test('derived overdue state never replaces the persistent task status', () => {
  const node = createNode('late', { dueDate: '2026-01-01', status: 'in-progress' });
  assert.equal(isNodeOverdue(node, '2026-01-02'), true);
  assert.equal(node.status, 'in-progress');
  assert.equal(isNodeOverdue({ ...node, completed: true, status: 'done' }, '2026-01-02'), false);
});

test('overview density stays bounded for 5, 50, and 200 tasks', () => {
  for (const count of [5, 50, 200]) {
    const nodes = Array.from({ length: count }, (_, index) =>
      createNode(`task-${index}`, {
        startDate: `2026-09-${String((index % 28) + 1).padStart(2, '0')}`,
        dueDate: `2026-09-${String((index % 28) + 1).padStart(2, '0')}`,
      }),
    );
    const domain = createTimelineDomain(nodes, 30, '2026-09-01');
    const overview = buildTimelineOverview(nodes, domain, 24, '2026-09-15');
    assert.ok(overview.length <= 24);
    assert.equal(overview.flatMap((item) => item.nodes).length, count);
  }
});

test('compact timeline preserves scheduled distribution without positioning unscheduled items', () => {
  const nodes = [
    createNode('range', { startDate: '2026-09-02', dueDate: '2026-09-05' }),
    createNode('due-only', { dueDate: '2026-09-12' }),
    createNode('milestone', { type: 'milestone', dueDate: '2026-09-20' }),
    createNode('unscheduled-a'),
    createNode('unscheduled-b'),
  ];
  const domain = createTimelineDomain(nodes, 30, '2026-09-01');
  const compact = buildTimelineOverview(nodes, domain, 30, '2026-09-10');

  assert.equal(compact.flatMap((item) => item.nodes).length, 3);
  assert.equal(compact.some((item) => item.nodes.some((node) => node.id === 'unscheduled-a')), false);
  assert.equal(compact.find((item) => item.nodes[0]?.id === 'range')?.kind, 'segment');
  assert.equal(compact.find((item) => item.nodes[0]?.id === 'due-only')?.kind, 'marker');
  assert.equal(compact.find((item) => item.nodes[0]?.id === 'milestone')?.kind, 'marker');
});

test('automatic dependency propagation never shifts a fixed downstream deadline', () => {
  const moved = createNode('moved', { startDate: '2026-09-01', dueDate: '2026-09-03' });
  const soft = createNode('soft', { startDate: '2026-09-04', dueDate: '2026-09-05' });
  const fixed = createNode('fixed', {
    startDate: '2026-09-06',
    dueDate: '2026-09-06',
    hardDependency: true,
  });
  const indexer = {
    getDependents: (nodeId: string) => nodeId === moved.id ? [soft, fixed] : [],
  } as RoadmapIndexer;
  const updates = new DependencyEngine(indexer).calculateSoftDependencyUpdates(
    moved,
    '2026-09-03',
  );

  assert.deepEqual(updates.map((update) => update.node.id), ['soft']);
  assert.equal(updates[0]?.startDate, '2026-09-06');
  assert.equal(updates[0]?.dueDate, '2026-09-07');
});

test('dashboard completion counts tasks but not roadmap or project anchor nodes', () => {
  const nodes = [
    createNode('anchor', { type: 'roadmap', subject: 'ISKB02', source: 'frontmatter' }),
    createNode('project', { type: 'project', subject: 'ISKB02', source: 'frontmatter' }),
    createNode('todo', { subject: 'ISKB02', dueDate: '2026-09-10' }),
    createNode('done', { subject: 'ISKB02', completed: true, status: 'done' }),
    createNode('late', { subject: 'ISKB02', dueDate: '2026-09-01' }),
  ];
  const summary = buildSubjectSummaries(nodes, '2026-09-05')[0];

  assert.equal(summary?.totalTasks, 3);
  assert.equal(summary?.completedTasks, 1);
  assert.equal(summary?.completionPercent, 33);
  assert.equal(summary?.overdueCount, 1);
  assert.equal(summary?.nextDeadline?.id, 'todo');
});

test('Horizon separates overdue, today, next week, later, and unscheduled tasks', () => {
  const nodes = [
    createNode('overdue', { dueDate: '2026-09-09' }),
    createNode('today', { dueDate: '2026-09-10' }),
    createNode('active', { status: 'in-progress' }),
    createNode('next', { dueDate: '2026-09-15' }),
    createNode('later', { dueDate: '2026-10-01' }),
    createNode('unscheduled'),
    createNode('done', { dueDate: '2026-09-01', status: 'done', completed: true }),
  ];
  const plan = classifyHorizon(nodes, { nextDays: 7, criticalDays: 0 }, '2026-09-10');

  assert.deepEqual(plan.overdue.map((node) => node.id), ['overdue']);
  assert.deepEqual(plan.now.map((node) => node.id), ['active', 'today']);
  assert.deepEqual(plan.next.map((node) => node.id), ['next']);
  assert.deepEqual(plan.later.map((node) => node.id), ['later']);
  assert.deepEqual(plan.unscheduled.map((node) => node.id), ['unscheduled']);
  assert.equal(formatRelativeTaskDate(nodes[0]!, '2026-09-12'), '3 days overdue');
});

test('legacy settings migrate roadmap anchors out of the template guard', () => {
  const migrated = roadmapSettingsSchema.parse(migrateRoadmapSettingsData({
    subjectPropertyKeys: 'predmet, course',
    templatePropertyKey: 'typ',
    excludedTemplateValues: 'roadmapa, šablóna, template',
  }));

  assert.equal(migrated.propertyMappings.subject, 'predmet, course');
  assert.ok(migrated.propertyMappings.type.split(',').map((value) => value.trim()).includes('typ'));
  assert.equal(migrated.excludedTemplateValues, 'šablóna, template');
  assert.equal(migrated.sourceScopeMode, 'all');
  assert.deepEqual(migrated.sourceScopeRules, []);
});

function createRulesParser(
  rules: readonly { readonly property: string; readonly acceptedValues: string }[],
): RoadmapParser {
  return new RoadmapParser(metadataCache, {
    ...createDefaultParserOptions(),
    sourceScope: compileSourceScope('rules', rules),
  });
}

function createCalendarOptions(today = '2026-09-01') {
  const settings = roadmapSettingsSchema.parse({}).calendar;
  return {
    automaticallyInclude: settings.automaticallyInclude,
    remindersEnabled: settings.remindersEnabled,
    reminderMinutes: settings.reminderMinutes,
    today,
    vaultName: 'Academic Vault',
  };
}

function createCalendarEvent(
  internalItemId: string,
  overrides: Partial<CalendarEventProjection> = {},
): CalendarEventProjection {
  return {
    internalItemId,
    sourceNodeId: internalItemId,
    semanticType: 'milestone',
    title: internalItemId,
    description: 'Managed by Obsidian Neuro Roadmap',
    startDate: '2026-10-10',
    endDateExclusive: '2026-10-11',
    allDay: true,
    availability: 'free',
    reminderMinutes: null,
    completed: false,
    overdue: false,
    ...overrides,
  };
}

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

function createNode(
  id: string,
  overrides: Partial<RoadmapNode> = {},
): RoadmapNode {
  return {
    id,
    path: `${id}.md`,
    title: id,
    type: 'task',
    calendarType: 'regular-task',
    durationBuffer: 1.3,
    priority: 'medium',
    status: 'todo',
    dependsOn: [],
    hardDependency: false,
    source: 'inline',
    completed: false,
    writeKeys: { startDate: 'start', dueDate: 'due', status: 'status' },
    ...overrides,
  };
}
