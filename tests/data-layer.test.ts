import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createServer } from 'node:http';
import test from 'node:test';
import { editorInfoField, editorLivePreviewField } from 'obsidian';
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
import {
  CALENDAR_POLICY_VERSION,
  RECOMMENDED_CALENDAR_POLICY,
  propertyMappingSchema,
  semanticValueMappingSchema,
} from '../src/types';
import { replaceTaskCheckbox } from '../src/core/MarkdownTask';
import {
  addDays,
  buildTimelineOverview,
  createFitTimelineDomain,
  createGanttTimelineDomain,
  createTimelineDataDomain,
  createTimelineDomain,
  createTimelineVisualItem,
  daysBetween,
  isNodeOverdue,
  selectTimelineZoomAnchor,
  timelineContentPixelWidth,
  timelineDayPixelWidth,
  timelineDatePositionPercent,
  timelineScrollOffsetForDate,
  timelineVisibleDayCount,
  todayDate,
  type TimelineScale,
} from '../src/core/TimelineDomain';
import { ganttBarPresentation, ganttPriorityMarker } from '../src/core/GanttPresentation';
import type { RoadmapNode } from '../src/types';
import { DependencyEngine } from '../src/core/DependencyEngine';
import { RoadmapIndexer } from '../src/core/Indexer';
import {
  deriveCalendarTemporalProjection,
  isCalendarEligible,
  projectCalendarEvent,
} from '../src/core/CalendarCore';
import { CalendarIdentityManager, calendarItemLocator } from '../src/core/CalendarIdentity';
import { exportCalendarEventsToICS, IcsCalendarProvider } from '../src/calendar/IcsCalendarProvider';
import type { CalendarEventProjection } from '../src/core/CalendarCore';
import { CalendarExportService } from '../src/core/CalendarExportService';
import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_REQUIRED_CAPABILITIES,
  GoogleAuthClient,
  GoogleAuthError,
  normalizeGoogleScope,
} from '../src/calendar/GoogleAuth';
import {
  startGoogleLoopbackServer,
  type GoogleLoopbackRuntime,
} from '../src/calendar/GoogleLoopbackServer';
import type {
  CalendarHttpRequest,
  CalendarHttpResponse,
  CalendarHttpTransport,
} from '../src/calendar/CalendarHttpTransport';
import {
  GoogleCalendarError,
  GoogleCalendarProvider,
  googleEventId,
  toGoogleCalendarEvent,
} from '../src/calendar/GoogleCalendarProvider';
import type {
  CalendarDescriptor,
  CalendarProvider,
  CalendarProviderCapabilities,
  ExternalCalendarEventRef,
} from '../src/core/CalendarProvider';
import { CalendarSyncEngine } from '../src/core/CalendarSyncEngine';
import {
  CALENDAR_SYNC_DEBOUNCE_MS,
  CalendarSyncController,
} from '../src/core/CalendarSyncController';
import { buildSubjectSummaries } from '../src/core/DashboardMetrics';
import { classifyHorizon, formatRelativeTaskDate } from '../src/core/HorizonPlanner';
import {
  migrateRoadmapSettingsData,
  needsCalendarPolicyMigration,
} from '../src/core/SettingsMigration';
import { roadmapSettingsSchema } from '../src/types';
import {
  compileSourceScope,
  isFrontmatterInSourceScope,
} from '../src/core/SourceScope';
import {
  calendarTypeDisplayLabel,
  formatCompactTaskDates,
  projectCompactTaskMetadata,
  shouldUseCompactTaskPresentation,
} from '../src/core/TaskMetadata';
import {
  findCompactTaskPropertyTokens,
  findManagedCalendarBlockId,
  replaceInlineTaskProperty,
  replaceInlineTaskStatus,
} from '../src/core/InlineTaskProperties';
import { InlineTaskPropertyWriter } from '../src/utils/obsidianHelpers';
import { describeCalendarAction } from '../src/core/CalendarAction';
import { TaskMetadataEditorIntegration } from '../src/ui/editor/TaskMetadataEditorExtension';

const GOOGLE_TEST_CLIENT_SECRET = 'desktop-client-secret-value';

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
  assert.equal(mapPriority('highest', values), 'high');
  assert.equal(mapPriority('lowest', values), 'low');
  assert.equal(mapCalendarSemanticType('skúška', values), 'exam');
  assert.equal(mapCalendarSemanticType('prezentácia', values), 'presentation');
});

test('calendar policy includes meaningful dates and excludes regular tasks by default', () => {
  const options = createCalendarOptions();
  assert.equal(isCalendarEligible(createNode('exam', { calendarType: 'exam', dueDate: '2026-10-10' }), options), true);
  assert.equal(isCalendarEligible(createNode('assignment', { calendarType: 'assignment-deadline', dueDate: '2026-10-10' }), options), true);
  assert.equal(isCalendarEligible(createNode('milestone', { calendarType: 'milestone', dueDate: '2026-10-11' }), options), true);
  assert.equal(isCalendarEligible(createNode('project', { calendarType: 'project-deadline', dueDate: '2026-10-12' }), options), true);
  assert.equal(isCalendarEligible(createNode('presentation', { calendarType: 'presentation', dueDate: '2026-10-12' }), options), true);
  assert.equal(isCalendarEligible(createNode('task', { calendarType: 'regular-task', dueDate: '2026-10-13' }), options), false);
  assert.deepEqual(options.automaticallyInclude, RECOMMENDED_CALENDAR_POLICY);
});

test('calendar item overrides take precedence over global policy', () => {
  const regularTask = createNode('task', { calendarType: 'regular-task', dueDate: '2026-10-13' });
  const milestone = createNode('milestone', { calendarType: 'milestone', dueDate: '2026-10-14' });
  assert.equal(isCalendarEligible(regularTask, { ...createCalendarOptions(), override: 'include' }), true);
  assert.equal(isCalendarEligible(milestone, { ...createCalendarOptions(), override: 'exclude' }), false);
  assert.equal(isCalendarEligible(regularTask, createCalendarOptions()), false);
  assert.equal(isCalendarEligible(milestone, createCalendarOptions()), true);
  const toggledOptions = createCalendarOptions();
  toggledOptions.automaticallyInclude['regular-task'] = true;
  assert.equal(isCalendarEligible(regularTask, toggledOptions), true);
});

test('date-only temporal policy is all-day, free, and one day for every semantic type', () => {
  const semanticTypes = Object.keys(RECOMMENDED_CALENDAR_POLICY) as (keyof typeof RECOMMENDED_CALENDAR_POLICY)[];
  for (const calendarType of semanticTypes) {
    const temporal = deriveCalendarTemporalProjection(createNode(calendarType, {
      calendarType,
      dueDate: '2026-10-10',
    }));
    assert.deepEqual(temporal, {
      startDate: '2026-10-10',
      endDateExclusive: '2026-10-11',
      allDay: true,
      availability: 'free',
    });
  }
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

test('parser maps calendar semantic types without changing roadmap node eligibility', () => {
  const parser = new RoadmapParser(metadataCache, createDefaultParserOptions());
  const exam = parser.parseFile(
    createFile('Subjects/Exam.md'),
    createCache({ typ: 'skúška', deadline: '2026-12-10' }, []),
    '',
  )[0];
  const presentation = parser.parseFile(
    createFile('Subjects/Presentation.md'),
    createCache({ typ: 'task', calendar_type: 'prezentácia', deadline: '2026-11-10' }, []),
    '',
  )[0];

  assert.equal(exam?.type, 'task');
  assert.equal(exam?.calendarType, 'exam');
  assert.equal(presentation?.type, 'task');
  assert.equal(presentation?.calendarType, 'presentation');
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
  assert.equal(settings.calendarState.calendarSyncDirty, false);
  assert.deepEqual(settings.calendarState.google, {});
  assert.equal(settings.calendar.calendarPolicyVersion, CALENDAR_POLICY_VERSION);
  assert.equal(settings.calendar.verificationIntervalMinutes, 15);
  assert.deepEqual(settings.calendar.google, {
    clientId: '',
    clientSecret: '',
    autoSync: true,
    debounceMs: 3_000,
  });
});

test('Gantt scale defaults to Fit while preserving a saved valid preference', () => {
  assert.equal(roadmapSettingsSchema.parse({}).ganttScale, 'fit');
  assert.equal(roadmapSettingsSchema.parse({ ganttScale: 'months' }).ganttScale, 'months');
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

test('Google installed-app authorization uses loopback PKCE and required scopes', async () => {
  const transport = new QueueCalendarTransport([]);
  const client = new GoogleAuthClient(transport, createSecretStore());
  const configuration = {
    clientId: 'desktop-client.apps.googleusercontent.com',
    clientSecret: GOOGLE_TEST_CLIENT_SECRET,
    refreshTokenSecretId: 'google-token',
  };
  const session = await client.beginAuthorization(
    configuration,
    'http://127.0.0.1:49152/oauth2/callback',
  );
  const url = new URL(session.authorizationUrl);

  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), session.redirectUri);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.notEqual(url.searchParams.get('code_challenge'), session.codeVerifier);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.deepEqual(url.searchParams.get('scope')?.split(' '), [...GOOGLE_CALENDAR_SCOPES]);
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.doesNotMatch(session.authorizationUrl, new RegExp(GOOGLE_TEST_CLIENT_SECRET, 'u'));
});

test('Google authorization reports a clear error when the desktop client secret is missing', async () => {
  const client = new GoogleAuthClient(new QueueCalendarTransport([]), createSecretStore());
  await assert.rejects(
    client.beginAuthorization({
      clientId: 'desktop-client.apps.googleusercontent.com',
      clientSecret: '',
      refreshTokenSecretId: 'google-token',
    }, 'http://127.0.0.1:49152/oauth2/callback'),
    (error: unknown) =>
      error instanceof GoogleAuthError &&
      error.kind === 'configuration' &&
      error.message === 'Google OAuth client secret is required.',
  );
});

test('Google loopback receiver binds only to 127.0.0.1 and accepts one OAuth response', async (context) => {
  let httpModuleAccesses = 0;
  const desktopRuntime: GoogleLoopbackRuntime = {
    isDesktopApp: true,
    loadHttpModule: () => {
      httpModuleAccesses += 1;
      return { createServer } as typeof import('node:http');
    },
  };
  let loopback: Awaited<ReturnType<typeof startGoogleLoopbackServer>>;
  try {
    loopback = await startGoogleLoopbackServer(2_000, desktopRuntime);
  } catch (error) {
    if (isSystemErrorCode(error, 'EPERM')) {
      context.skip('The execution sandbox forbids binding a loopback listener.');
      return;
    }
    throw error;
  }
  assert.equal(httpModuleAccesses, 1);
  const redirect = new URL(loopback.redirectUri);
  assert.equal(redirect.hostname, '127.0.0.1');
  assert.equal(redirect.pathname, '/');
  assert.ok(Number(redirect.port) > 0);

  redirect.searchParams.set('state', 'expected-state');
  redirect.searchParams.set('code', 'authorization-code');
  const browserResponse = await fetch(redirect);
  assert.equal(browserResponse.status, 200);
  assert.match(await browserResponse.text(), /return to Obsidian/u);
  assert.deepEqual(await loopback.response, {
    state: 'expected-state',
    code: 'authorization-code',
    error: null,
  });
});

test('Google loopback rejects mobile before accessing the Node HTTP module', async () => {
  let httpModuleAccesses = 0;
  const mobileRuntime: GoogleLoopbackRuntime = {
    isDesktopApp: false,
    loadHttpModule: () => {
      httpModuleAccesses += 1;
      return { createServer } as typeof import('node:http');
    },
  };

  await assert.rejects(
    startGoogleLoopbackServer(2_000, mobileRuntime),
    /available only on desktop/u,
  );
  assert.equal(httpModuleAccesses, 0);
});

test('Google authorization validates state and stores refresh tokens outside settings', async () => {
  const secrets = new Map<string, string>();
  const transport = new QueueCalendarTransport([
    jsonResponse(200, {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    }),
  ]);
  const client = new GoogleAuthClient(transport, createSecretStore(secrets), () => 1_000);
  const configuration = {
    clientId: 'desktop-client.apps.googleusercontent.com',
    clientSecret: GOOGLE_TEST_CLIENT_SECRET,
    refreshTokenSecretId: 'google-token',
  };
  const session = await client.beginAuthorization(
    configuration,
    'http://127.0.0.1:49152/oauth2/callback',
  );
  await assert.rejects(
    client.completeAuthorization(configuration, session, {
      state: 'wrong-state',
      code: 'authorization-code',
      error: null,
    }),
    (error: unknown) => error instanceof GoogleAuthError && error.kind === 'authorization-expired',
  );
  const token = await client.completeAuthorization(configuration, session, {
    state: session.state,
    code: 'authorization-code',
    error: null,
  });

  assert.equal(token.accessToken, 'access-token');
  assert.equal(secrets.get('google-token'), 'refresh-token');
  const tokenBody = new URLSearchParams(transport.requests[0]?.body ?? '');
  assert.equal(tokenBody.get('client_id'), configuration.clientId);
  assert.equal(tokenBody.get('client_secret'), GOOGLE_TEST_CLIENT_SECRET);
  assert.equal(tokenBody.get('code_verifier'), session.codeVerifier);
  assert.equal(tokenBody.get('grant_type'), 'authorization_code');
  assert.equal(tokenBody.get('redirect_uri'), session.redirectUri);
});

test('Google OAuth canonicalizes the real token scope aliases and accepts all required capabilities', async () => {
  const grantedScopes = [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.calendars',
    'openid',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/userinfo.profile',
    'https://www.googleapis.com/auth/userinfo.email',
  ];
  const expectedCapabilities = [
    'calendar.calendarlist.readonly',
    'calendar.calendars',
    'openid',
    'calendar.events',
    'profile',
    'email',
  ];
  assert.deepEqual(grantedScopes.map(normalizeGoogleScope), expectedCapabilities);

  const token = await authorizeGoogleWithScopes(grantedScopes);
  assert.deepEqual(token.grantedScopes, grantedScopes);
  assert.deepEqual(
    GOOGLE_REQUIRED_CAPABILITIES.filter(
      (required) => !new Set(grantedScopes.map(normalizeGoogleScope)).has(required),
    ),
    [],
  );
});

test('Google OAuth uses explicit identity aliases and rejects unknown scopes', () => {
  assert.equal(normalizeGoogleScope('profile'), 'profile');
  assert.equal(
    normalizeGoogleScope('https://www.googleapis.com/auth/userinfo.profile'),
    'profile',
  );
  assert.equal(normalizeGoogleScope('email'), 'email');
  assert.equal(
    normalizeGoogleScope('https://www.googleapis.com/auth/userinfo.email'),
    'email',
  );
  assert.equal(normalizeGoogleScope('https://example.com/auth/calendar.events'), null);
  assert.equal(normalizeGoogleScope('userinfo.email'), null);
});

test('Google OAuth treats profile as optional but keeps email and calendar events required', async () => {
  const requiredScopesWithoutProfile = [
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.calendars',
  ];
  await authorizeGoogleWithScopes(requiredScopesWithoutProfile);

  await assert.rejects(
    authorizeGoogleWithScopes(requiredScopesWithoutProfile.filter(
      (scope) => scope !== 'https://www.googleapis.com/auth/userinfo.email',
    )),
    (error: unknown) =>
      error instanceof GoogleAuthError &&
      error.kind === 'permission' &&
      error.message.includes('email'),
  );

  await assert.rejects(
    authorizeGoogleWithScopes(requiredScopesWithoutProfile.filter(
      (scope) => scope !== 'https://www.googleapis.com/auth/calendar.events',
    )),
    (error: unknown) =>
      error instanceof GoogleAuthError &&
      error.kind === 'permission' &&
      error.message.includes('calendar.events'),
  );
});

test('Google authentication errors never expose the configured client secret', async () => {
  const transport = new QueueCalendarTransport([
    jsonResponse(401, {
      error: 'invalid_client',
      error_description: `Rejected credential ${GOOGLE_TEST_CLIENT_SECRET}`,
    }),
  ]);
  const client = new GoogleAuthClient(transport, createSecretStore());
  const configuration = {
    clientId: 'desktop-client.apps.googleusercontent.com',
    clientSecret: GOOGLE_TEST_CLIENT_SECRET,
    refreshTokenSecretId: 'google-token',
  };
  const session = await client.beginAuthorization(
    configuration,
    'http://127.0.0.1:49152/oauth2/callback',
  );

  await assert.rejects(
    client.completeAuthorization(configuration, session, {
      state: session.state,
      code: 'authorization-code',
      error: null,
    }),
    (error: unknown) =>
      error instanceof GoogleAuthError &&
      !error.message.includes(GOOGLE_TEST_CLIENT_SECRET) &&
      error.message.includes('[redacted]'),
  );
});

test('Google reconnect keeps the previous refresh token until account validation succeeds', async () => {
  const secrets = new Map([['google-token', 'previous-refresh-token']]);
  const transport = new QueueCalendarTransport([
    jsonResponse(200, {
      access_token: 'new-access-token',
      refresh_token: 'pending-refresh-token',
      expires_in: 3600,
      scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    }),
  ]);
  const client = new GoogleAuthClient(transport, createSecretStore(secrets));
  const configuration = {
    clientId: 'desktop-client.apps.googleusercontent.com',
    clientSecret: GOOGLE_TEST_CLIENT_SECRET,
    refreshTokenSecretId: 'google-token',
  };
  const session = await client.beginAuthorization(
    configuration,
    'http://127.0.0.1:49152/oauth2/callback',
  );
  await client.completeAuthorization(configuration, session, {
    state: session.state,
    code: 'authorization-code',
    error: null,
  }, false);

  assert.equal(secrets.get('google-token'), 'previous-refresh-token');
  client.discardPendingAuthorization();
  assert.equal(secrets.get('google-token'), 'previous-refresh-token');

  const secondClient = new GoogleAuthClient(
    new QueueCalendarTransport([jsonResponse(200, {
      access_token: 'accepted-access-token',
      refresh_token: 'accepted-refresh-token',
      expires_in: 3600,
      scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    })]),
    createSecretStore(secrets),
  );
  const secondSession = await secondClient.beginAuthorization(
    configuration,
    'http://127.0.0.1:49153/oauth2/callback',
  );
  await secondClient.completeAuthorization(configuration, secondSession, {
    state: secondSession.state,
    code: 'authorization-code',
    error: null,
  }, false);
  secondClient.commitPendingAuthorization(configuration);
  assert.equal(secrets.get('google-token'), 'accepted-refresh-token');
});

test('Google refresh, revocation, and revoked-grant errors preserve secure lifecycle', async () => {
  const secrets = new Map([['google-token', 'refresh-token']]);
  const transport = new QueueCalendarTransport([
    jsonResponse(200, {
      access_token: 'refreshed-access-token',
      expires_in: 3600,
      scope: GOOGLE_CALENDAR_SCOPES.join(' '),
    }),
    jsonResponse(200, null),
  ]);
  const configuration = {
    clientId: 'desktop-client.apps.googleusercontent.com',
    clientSecret: GOOGLE_TEST_CLIENT_SECRET,
    refreshTokenSecretId: 'google-token',
  };
  const client = new GoogleAuthClient(transport, createSecretStore(secrets));

  assert.equal(await client.getAccessToken(configuration), 'refreshed-access-token');
  await client.disconnect(configuration);
  assert.equal(secrets.get('google-token'), '');
  const refreshBody = new URLSearchParams(transport.requests[0]?.body ?? '');
  assert.equal(refreshBody.get('client_id'), configuration.clientId);
  assert.equal(refreshBody.get('client_secret'), GOOGLE_TEST_CLIENT_SECRET);
  assert.equal(refreshBody.get('refresh_token'), 'refresh-token');
  assert.equal(refreshBody.get('grant_type'), 'refresh_token');
  assert.match(transport.requests[1]?.body ?? '', /token=refresh-token/u);
  assert.equal(transport.requests[1]?.url, 'https://oauth2.googleapis.com/revoke');
  assert.equal(transport.requests.some((request) => request.url.includes('/calendar/v3/')), false);

  secrets.set('google-token', 'revoked-token');
  const revoked = new GoogleAuthClient(
    new QueueCalendarTransport([jsonResponse(400, { error: 'invalid_grant' })]),
    createSecretStore(secrets),
  );
  await assert.rejects(
    revoked.getAccessToken(configuration),
    (error: unknown) => error instanceof GoogleAuthError && error.kind === 'authentication-expired',
  );

  const alreadyRevokedSecrets = new Map([['google-token', 'already-revoked-token']]);
  const alreadyRevoked = new GoogleAuthClient(
    new QueueCalendarTransport([jsonResponse(400, { error: 'invalid_token' })]),
    createSecretStore(alreadyRevokedSecrets),
  );
  await alreadyRevoked.disconnect(configuration);
  assert.equal(alreadyRevokedSecrets.get('google-token'), '');
});

test('Google provider maps Calendar Core all-day, free, reminder, and Unicode semantics', async () => {
  const event = createCalendarEvent('stable-google-id', {
    title: 'ISKB02 · Skúška č. 1',
    description: 'Zdroj: Žluťoučký kôň',
    reminderMinutes: 1440,
  });
  const payload = toGoogleCalendarEvent(event);

  assert.equal(payload.summary, 'ISKB02 · Skúška č. 1');
  assert.equal(payload.description, 'Zdroj: Žluťoučký kôň');
  assert.deepEqual(payload.start, { date: '2026-10-10' });
  assert.deepEqual(payload.end, { date: '2026-10-11' });
  assert.equal(payload.transparency, 'transparent');
  assert.equal(payload.visibility, 'default');
  assert.deepEqual(payload.reminders, {
    useDefault: false,
    overrides: [{ method: 'popup', minutes: 1440 }],
  });
});

test('Google account profile falls back to email when optional profile name is absent', async () => {
  const provider = createGoogleProvider(new QueueCalendarTransport([
    jsonResponse(200, { sub: 'account-id', email: 'student@example.com' }),
  ]));
  assert.deepEqual(await provider.getAccountProfile(), {
    id: 'account-id',
    displayName: 'student@example.com',
    email: 'student@example.com',
  });
});

test('Google provider lists writable calendars and creates a dedicated calendar', async () => {
  const transport = new QueueCalendarTransport([
    jsonResponse(200, {
      items: [
        { id: 'secondary', summary: 'Study', accessRole: 'writer' },
        { id: 'primary@example.com', summary: 'Primary', primary: true, accessRole: 'owner' },
      ],
    }),
    jsonResponse(200, { id: 'created-calendar', summary: 'Neuro Roadmap' }),
  ]);
  const provider = createGoogleProvider(transport);

  assert.deepEqual(await provider.listCalendars(), [
    { id: 'primary@example.com', name: 'Primary', primary: true },
    { id: 'secondary', name: 'Study', primary: false },
  ]);
  assert.deepEqual(await provider.createCalendar('Neuro Roadmap'), {
    id: 'created-calendar',
    name: 'Neuro Roadmap',
    primary: false,
  });
  assert.match(transport.requests[0]?.url ?? '', /minAccessRole=writer/u);
  assert.deepEqual(JSON.parse(transport.requests[1]?.body ?? '{}'), {
    summary: 'Neuro Roadmap',
    description: 'One-way calendar projection managed by Obsidian Neuro Roadmap.',
  });
});

test('Google provider uses deterministic event IDs and treats create conflicts as idempotent', async () => {
  const event = createCalendarEvent('stable-google-id');
  const expectedId = await googleEventId(event.internalItemId);
  const transport = new QueueCalendarTransport([
    jsonResponse(409, { error: { code: 409, message: 'The requested identifier already exists.' } }),
  ]);
  const provider = createGoogleProvider(transport);
  const reference = await provider.createEvent('calendar-id', event);

  assert.deepEqual(reference, { calendarId: 'calendar-id', eventId: expectedId });
  assert.equal(JSON.parse(transport.requests[0]?.body ?? '{}').id, expectedId);
});

test('Google provider refreshes once on 401 and backs off for quota errors', async () => {
  let invalidations = 0;
  const waits: number[] = [];
  const transport = new QueueCalendarTransport([
    jsonResponse(401, { error: { message: 'Invalid Credentials' } }),
    {
      ...jsonResponse(429, { error: { message: 'Rate limit', errors: [{ reason: 'rateLimitExceeded' }] } }),
      headers: { 'Retry-After': '2' },
    },
    jsonResponse(200, { items: [] }),
  ]);
  const provider = createGoogleProvider(
    transport,
    { invalidate: () => { invalidations += 1; } },
    async (milliseconds) => { waits.push(milliseconds); },
  );

  assert.deepEqual(await provider.listCalendars(), []);
  assert.equal(invalidations, 1);
  assert.deepEqual(waits, [2_000]);
});

test('Google provider classifies revoked permissions, missing events, and hard permission errors', async () => {
  const missingProvider = createGoogleProvider(new QueueCalendarTransport([
    jsonResponse(404, { error: { message: 'Not found' } }),
  ]));
  assert.equal(await missingProvider.eventExists({ calendarId: 'calendar', eventId: 'event' }), false);

  const forbiddenProvider = createGoogleProvider(new QueueCalendarTransport([
    jsonResponse(403, { error: { message: 'Forbidden', errors: [{ reason: 'forbidden' }] } }),
  ]));
  await assert.rejects(
    forbiddenProvider.listCalendars(),
    (error: unknown) => error instanceof GoogleCalendarError && error.kind === 'permission',
  );
});

test('provider-neutral reconciliation creates, updates, and deletes the same managed event', async () => {
  const fixture = createSyncFixture();
  const original = createNode('exam', {
    source: 'frontmatter',
    calendarType: 'exam',
    dueDate: '2026-10-10',
    title: 'Original title',
  });
  const created = await fixture.engine.reconcile([original]);
  assert.equal(created.created, 1);
  assert.equal(fixture.provider.created.length, 1);
  const originalReference = fixture.provider.created[0]?.reference;

  const unchanged = await fixture.engine.reconcile([original], { mode: 'fast' });
  assert.equal(unchanged.unchanged, 1);
  assert.equal(fixture.provider.updated.length, 0);

  const changed = await fixture.engine.reconcile([{
    ...original,
    title: 'Renamed title',
    dueDate: '2026-11-11',
  }]);
  assert.equal(changed.updated, 1);
  assert.deepEqual(fixture.provider.updated[0]?.reference, originalReference);

  const deleted = await fixture.engine.reconcile([]);
  assert.equal(deleted.deleted, 1);
  assert.deepEqual(fixture.provider.deleted[0], originalReference);
  assert.deepEqual(fixture.state.syncRecords, {});
});

test('existence verification recreates deleted events without updating unchanged events', async () => {
  const fixture = createSyncFixture();
  const node = createNode('milestone', {
    source: 'frontmatter',
    calendarType: 'milestone',
    dueDate: '2026-10-10',
  });
  await fixture.engine.reconcile([node]);
  const reference = fixture.provider.created[0]?.reference;
  assert.ok(reference !== undefined);

  const existing = await fixture.engine.reconcile([node], { mode: 'verify-existence' });
  assert.equal(existing.unchanged, 1);
  assert.equal(fixture.provider.updated.length, 0);
  assert.equal(fixture.provider.existenceChecks.length, 1);

  const changedNode = { ...node, title: 'Changed locally' };
  const changed = await fixture.engine.reconcile([changedNode], { mode: 'verify-existence' });
  assert.equal(changed.updated, 1);
  assert.equal(fixture.provider.updated.length, 1);
  assert.equal(fixture.provider.existenceChecks.length, 1);

  fixture.provider.deleteExternally(reference);

  const report = await fixture.engine.reconcile([changedNode], { mode: 'verify-existence' });
  assert.equal(report.recreated, 1);
  assert.equal(fixture.provider.created.length, 2);
  assert.equal(fixture.provider.updated.length, 1);
  assert.equal(Object.keys(fixture.state.syncRecords).length, 1);
});

test('full reconciliation reasserts an unchanged Markdown projection', async () => {
  const fixture = createSyncFixture();
  const node = createNode('exam', {
    source: 'frontmatter',
    calendarType: 'exam',
    dueDate: '2026-10-10',
  });
  await fixture.engine.reconcile([node]);

  const report = await fixture.engine.reconcile([node], { mode: 'full' });
  assert.equal(report.updated, 1);
  assert.equal(fixture.provider.updated.length, 1);
  assert.equal(fixture.provider.existenceChecks.length, 0);
});

test('provider-neutral reconciliation scopes records by provider and honors explicit exclusion', async () => {
  const fixture = createSyncFixture();
  fixture.state.syncRecords['microsoft:other'] = {
    internalItemId: 'other',
    provider: 'microsoft',
    externalCalendarId: 'outlook-calendar',
    externalEventId: 'outlook-event',
  };
  const node = createNode('exam', {
    source: 'frontmatter',
    calendarType: 'exam',
    dueDate: '2026-10-10',
  });
  await fixture.engine.reconcile([node]);
  const internalItemId = Object.values(fixture.state.syncRecords)
    .find((record) => record.provider === 'google')?.internalItemId;
  assert.ok(internalItemId !== undefined);
  fixture.state.itemOverrides[internalItemId] = 'exclude';

  const report = await fixture.engine.reconcile([node]);
  assert.equal(report.deleted, 1);
  assert.ok(fixture.state.syncRecords['microsoft:other'] !== undefined);
  assert.equal(Object.values(fixture.state.syncRecords).some((record) => record.provider === 'google'), false);
});

test('calendar sync controller debounces rapid changes and the latest snapshot wins', async () => {
  const timers = new ManualTimers();
  const runs: { ids: string[]; mode: string | undefined }[] = [];
  let dirtyCalls = 0;
  const controller = new CalendarSyncController({
    reconcile: async (nodes, options) => {
      runs.push({ ids: nodes.map((node) => node.id), mode: options.mode });
      return emptySyncReport();
    },
    onDirty: () => { dirtyCalls += 1; },
    scheduleTimer: timers.schedule,
    cancelTimer: timers.cancel,
  });
  controller.schedule([createNode('first')]);
  controller.schedule([createNode('latest')]);
  assert.equal(dirtyCalls, 1);
  assert.deepEqual(timers.activeDelays(), [CALENDAR_SYNC_DEBOUNCE_MS]);
  timers.runNext();
  await drainMicrotasks();

  assert.deepEqual(runs, [{ ids: ['latest'], mode: 'fast' }]);
  controller.dispose();
});

test('calendar sync controller serializes work and recovers after an error', async () => {
  let active = 0;
  let maxActive = 0;
  let rejectFirst = true;
  const order: string[] = [];
  const controller = new CalendarSyncController({
    reconcile: async (nodes) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const id = nodes[0]?.id ?? 'empty';
      order.push(id);
      await Promise.resolve();
      active -= 1;
      if (rejectFirst) {
        rejectFirst = false;
        throw new Error('transient failure');
      }
      return emptySyncReport();
    },
  });

  const first = controller.syncStartup([createNode('first')]);
  const second = controller.syncStartup([createNode('second')]);
  await assert.rejects(first, /transient failure/u);
  await second;
  assert.equal(maxActive, 1);
  assert.deepEqual(order, ['first', 'second']);
  controller.dispose();
});

test('calendar sync dirty state clears only after success and shutdown flushes pending work', async () => {
  const timers = new ManualTimers();
  let dirty = false;
  let shouldFail = true;
  const modes: (string | undefined)[] = [];
  const controller = new CalendarSyncController({
    reconcile: async (_nodes, options) => {
      modes.push(options.mode);
      if (shouldFail) throw new Error('offline');
      return emptySyncReport();
    },
    onDirty: () => { dirty = true; },
    onSuccess: () => { dirty = false; },
    scheduleTimer: timers.schedule,
    cancelTimer: timers.cancel,
  });

  controller.schedule([createNode('failed')]);
  assert.equal(dirty, true);
  timers.runNext();
  await drainMicrotasks();
  assert.equal(dirty, true);

  shouldFail = false;
  controller.schedule([createNode('shutdown')]);
  controller.dispose();
  await drainMicrotasks();
  assert.equal(dirty, false);
  assert.deepEqual(modes, ['fast', 'fast']);
});

test('an older reconcile cannot clear dirty state for a newer pending snapshot', async () => {
  const timers = new ManualTimers();
  let dirty = true;
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let runCount = 0;
  const controller = new CalendarSyncController({
    reconcile: async () => {
      runCount += 1;
      if (runCount === 1) await firstGate;
      return emptySyncReport();
    },
    onDirty: () => { dirty = true; },
    onSuccess: (_report, clearDirty) => {
      if (clearDirty) dirty = false;
    },
    scheduleTimer: timers.schedule,
    cancelTimer: timers.cancel,
  });

  const startup = controller.syncStartup([createNode('old')]);
  await drainMicrotasks();
  controller.schedule([createNode('new')]);
  releaseFirst?.();
  await startup;
  assert.equal(dirty, true);

  timers.runNext();
  await drainMicrotasks();
  assert.equal(dirty, false);
  controller.dispose();
});

test('calendar sync startup and periodic verification use safe modes and dispose clears timers', async () => {
  const timers = new ManualTimers();
  let dirty = true;
  const modes: (string | undefined)[] = [];
  const controller = new CalendarSyncController({
    reconcile: async (_nodes, options) => {
      modes.push(options.mode);
      return emptySyncReport();
    },
    onSuccess: () => { dirty = false; },
    scheduleTimer: timers.schedule,
    cancelTimer: timers.cancel,
  });

  await controller.syncStartup([createNode('startup')]);
  assert.equal(dirty, false);
  assert.deepEqual(modes, ['fast']);

  controller.configureVerification(() => [createNode('periodic')], 0);
  assert.deepEqual(timers.activeDelays(), []);
  controller.configureVerification(() => [createNode('periodic')], 15);
  assert.deepEqual(timers.activeDelays(), [15 * 60_000]);
  timers.runNext();
  await drainMicrotasks();
  assert.deepEqual(modes, ['fast', 'verify-existence']);
  assert.deepEqual(timers.activeDelays(), [15 * 60_000]);

  controller.schedule([createNode('paused')]);
  assert.deepEqual(
    timers.activeDelays().sort((left, right) => left - right),
    [CALENDAR_SYNC_DEBOUNCE_MS, 15 * 60_000],
  );
  controller.pauseAutomaticSync();
  assert.deepEqual(timers.activeDelays(), []);

  controller.dispose();
  assert.deepEqual(timers.activeDelays(), []);
});

test('calendar sync default timer cleanup succeeds on first dispose and remains idempotent', () => {
  const originalClearTimeout = globalThis.clearTimeout;
  let usedGlobalReceiver = false;
  globalThis.clearTimeout = function receiverSensitiveClearTimeout(
    this: typeof globalThis,
    handle: Parameters<typeof clearTimeout>[0],
  ): void {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    usedGlobalReceiver = true;
    originalClearTimeout(handle);
  } as typeof clearTimeout;

  try {
    const controller = new CalendarSyncController({
      reconcile: async () => emptySyncReport(),
    });
    controller.configureVerification(() => [], 15);
    assert.doesNotThrow(() => controller.dispose());
    assert.doesNotThrow(() => controller.dispose());
    assert.equal(usedGlobalReceiver, true);
  } finally {
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test('calendar export service distinguishes filtered selection from all eligible items', async () => {
  let records: Record<string, string> = {};
  let sequence = 0;
  const identities = new CalendarIdentityManager(
    {} as App,
    () => records,
    async (nextRecords) => { records = nextRecords; },
    () => `export-id-${++sequence}`,
  );
  const provider = new IcsCalendarProvider({
    now: () => new Date('2026-08-15T10:20:30.000Z'),
  });
  const service = new CalendarExportService(identities, provider);
  const roadmapSettings = roadmapSettingsSchema.parse({});
  const context = {
    settings: roadmapSettings.calendar,
    state: roadmapSettings.calendarState,
    vaultName: 'Academic Vault',
  };
  const exam = createNode('exam', {
    source: 'frontmatter',
    calendarType: 'exam',
    dueDate: '2026-10-10',
  });
  const milestone = createNode('milestone', {
    source: 'frontmatter',
    calendarType: 'milestone',
    dueDate: '2026-11-10',
  });
  const regular = createNode('regular', {
    source: 'frontmatter',
    calendarType: 'regular-task',
    dueDate: '2026-12-10',
  });

  const current = await service.export([exam], context);
  const all = await service.export([exam, milestone, regular], context);
  assert.equal(current.eventCount, 1);
  assert.equal(all.eventCount, 2);
  assert.equal((current.content.match(/BEGIN:VEVENT/gu) ?? []).length, 1);
  assert.equal((all.content.match(/BEGIN:VEVENT/gu) ?? []).length, 2);
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
  await indexer.completeInitialIndex();
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

test('indexer delivers the same ready snapshot when a view subscribes before or after metadata resolution', async () => {
  const file = {
    ...createFile('Subjects/Cold start task.md'),
    extension: 'md',
  } as TFile;
  const readyCache = createCache(
    { typ: 'task', title: 'Cold start task', predmet: 'ISKB02' },
    [],
  );
  let currentCache: CachedMetadata | null = null;
  let resolvedHandler: (() => void) | undefined;
  const app = {
    metadataCache: {
      getFileCache: () => currentCache,
      getFirstLinkpathDest: () => null,
      on: (name: string, callback: () => void) => {
        if (name === 'resolved') resolvedHandler = callback;
        return {};
      },
    },
    vault: {
      getMarkdownFiles: () => [file],
      cachedRead: async () => '',
      on: () => ({}),
    },
  } as unknown as App;
  const indexer = new RoadmapIndexer(app);
  indexer.setParserOptions(createDefaultParserOptions());
  indexer.registerEvents(() => undefined);

  const earlySnapshots: Array<{ ready: boolean; nodeCount: number }> = [];
  let resolveLoadingPublication: (() => void) | undefined;
  const loadingPublished = new Promise<void>((resolve) => {
    resolveLoadingPublication = resolve;
  });
  const unsubscribeEarly = indexer.subscribe((snapshot) => {
    earlySnapshots.push({ ready: snapshot.ready, nodeCount: snapshot.nodes.length });
    if (earlySnapshots.length === 2) resolveLoadingPublication?.();
  });

  const initialization = indexer.initialize();
  await loadingPublished;
  assert.deepEqual(earlySnapshots.at(-1), { ready: false, nodeCount: 0 });

  currentCache = readyCache;
  assert.ok(resolvedHandler);
  resolvedHandler();
  await initialization;

  const earlyFinalSnapshot = earlySnapshots.at(-1);
  assert.deepEqual(earlyFinalSnapshot, { ready: true, nodeCount: 1 });

  let lateSnapshot: { ready: boolean; nodeCount: number } | undefined;
  const unsubscribeLate = indexer.subscribe((snapshot) => {
    lateSnapshot = { ready: snapshot.ready, nodeCount: snapshot.nodes.length };
  });
  assert.deepEqual(lateSnapshot, earlyFinalSnapshot);

  unsubscribeLate();
  unsubscribeEarly();
});

test('indexer distinguishes a pre-resolution empty scan from a confirmed empty vault', async () => {
  const app = {
    metadataCache: {
      getFirstLinkpathDest: () => null,
    },
    vault: {
      getMarkdownFiles: () => [],
    },
  } as unknown as App;
  const indexer = new RoadmapIndexer(app);
  const snapshots: Array<{ ready: boolean; nodeCount: number }> = [];
  let resolveInitialScan: (() => void) | undefined;
  const initialScanPublished = new Promise<void>((resolve) => {
    resolveInitialScan = resolve;
  });
  const unsubscribe = indexer.subscribe((snapshot) => {
    snapshots.push({ ready: snapshot.ready, nodeCount: snapshot.nodes.length });
    if (snapshots.length === 2) resolveInitialScan?.();
  });

  const initialization = indexer.initialize();
  await initialScanPublished;
  assert.deepEqual(snapshots.at(-1), { ready: false, nodeCount: 0 });

  await indexer.completeInitialIndex();
  await initialization;
  assert.deepEqual(snapshots.at(-1), { ready: true, nodeCount: 0 });
  unsubscribe();
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

test('Gantt priority markers stay independent from status color classes', () => {
  assert.deepEqual(ganttPriorityMarker('high'), {
    symbol: '▲',
    label: 'High priority',
    tone: 'high',
  });
  assert.equal(ganttPriorityMarker('highest')?.label, 'Highest priority');
  assert.equal(ganttPriorityMarker('medium'), null);
  assert.deepEqual(ganttPriorityMarker('low'), {
    symbol: '▼',
    label: 'Low priority',
    tone: 'low',
  });

  assert.equal(ganttBarPresentation('todo', 'high').statusClass, 'status-todo');
  assert.equal(ganttBarPresentation('todo', 'low').statusClass, 'status-todo');
  assert.equal(ganttBarPresentation('in-progress', 'high').statusClass, 'status-in-progress');
  assert.equal(ganttBarPresentation('done', 'high').statusClass, 'status-done');
  assert.equal(
    ganttBarPresentation('in-progress', 'medium').statusClass,
    ganttBarPresentation('in-progress', 'high').statusClass,
  );
});

test('Today uses the local calendar date and stable date-only coordinates across zoom levels', () => {
  const localLateEvening = new Date(2026, 8, 10, 23, 45);
  assert.equal(todayDate(localLateEvening), '2026-09-10');

  const nodes = [
    createNode('semester-range', { startDate: '2026-08-20', dueDate: '2027-01-20' }),
  ];
  const dataDomain = createTimelineDataDomain(nodes, '2026-09-10');
  const scales: readonly TimelineScale[] = ['weeks', 'months', 'semester', 'fit'];
  for (const scale of scales) {
    const domain = createGanttTimelineDomain(nodes, dataDomain, scale, '2026-09-10');
    const position = timelineDatePositionPercent('2026-09-10', domain);
    assert.notEqual(position, null);
    assert.equal(
      position,
      ((daysBetween(domain.startDate, '2026-09-10') + 0.5) / domain.dayCount) * 100,
    );
    assert.equal(
      timelineDatePositionPercent(addDays(domain.startDate, domain.dayCount), domain),
      null,
    );
  }
});

test('Gantt viewport zoom presets expose materially distinct time spans', () => {
  const viewportWidth = 700;

  assert.equal(timelineVisibleDayCount('weeks', 365), 35);
  assert.equal(timelineVisibleDayCount('months', 365), 70);
  assert.equal(timelineVisibleDayCount('semester', 365), 140);
  assert.equal(timelineVisibleDayCount('fit', 365), 365);

  const weeksWidth = timelineDayPixelWidth('weeks', viewportWidth, 365);
  const monthsWidth = timelineDayPixelWidth('months', viewportWidth, 365);
  const semesterWidth = timelineDayPixelWidth('semester', viewportWidth, 365);
  assert.ok(weeksWidth > monthsWidth);
  assert.ok(monthsWidth > semesterWidth);
  assert.equal(monthsWidth, 10);
  assert.equal(semesterWidth, 5);
  assert.equal(timelineContentPixelWidth('fit', viewportWidth, 365), viewportWidth);
});

test('non-fit Gantt scales retain the full data domain and make its end horizontally reachable', () => {
  const nodes = [
    createNode('year-range', { startDate: '2026-01-01', dueDate: '2026-12-31' }),
    createNode('late-milestone', { type: 'milestone', dueDate: '2026-12-20' }),
  ];
  const viewportWidth = 900;
  const dataDomain = createTimelineDataDomain(nodes, '2026-01-01');

  for (const scale of ['weeks', 'months', 'semester'] as const) {
    const domain = createGanttTimelineDomain(nodes, dataDomain, scale, '2026-01-01');
    assert.deepEqual(domain, dataDomain);
    assert.ok(timelineContentPixelWidth(scale, viewportWidth, domain.dayCount) > viewportWidth);
    const lastDateOffset = timelineScrollOffsetForDate(
      domain.endDate,
      domain,
      scale,
      viewportWidth,
    );
    assert.notEqual(lastDateOffset, null);
    assert.ok((lastDateOffset ?? 0) > 0);
    assert.ok(
      (lastDateOffset ?? Number.POSITIVE_INFINITY) <=
        timelineContentPixelWidth(scale, viewportWidth, domain.dayCount) - viewportWidth,
    );
  }

  const weeksDomain = createGanttTimelineDomain(nodes, dataDomain, 'weeks', '2026-01-01');
  const overview = buildTimelineOverview(nodes, weeksDomain, 32, '2026-06-15');
  assert.equal(overview.flatMap((item) => item.nodes).length, nodes.length);
  assert.ok(
    overview.some((item) => item.nodes.some((node) => node.id === 'late-milestone')),
  );
});

test('Gantt zoom switches preserve today, viewport center, then earliest-item anchor priority', () => {
  assert.equal(
    selectTimelineZoomAnchor(
      '2026-09-10',
      '2026-09-01',
      '2026-09-20',
      '2026-09-11',
      '2026-08-20',
    ),
    '2026-09-10',
  );
  assert.equal(
    selectTimelineZoomAnchor(
      '2026-09-10',
      '2026-10-01',
      '2026-10-20',
      '2026-10-11',
      '2026-08-20',
    ),
    '2026-10-11',
  );
  assert.equal(
    selectTimelineZoomAnchor('2026-09-10', null, null, null, '2026-08-20'),
    '2026-08-20',
  );
});

test('fit uses the complete dated domain while overview coordinates remain full-domain', () => {
  const singleDate = [createNode('single', { dueDate: '2026-09-10' })];
  const singleDateDomain = createTimelineDataDomain(singleDate, '2026-09-10');
  assert.equal(
    createGanttTimelineDomain(singleDate, singleDateDomain, 'months', '2026-09-10').dayCount,
    70,
  );
  assert.equal(
    createGanttTimelineDomain(singleDate, singleDateDomain, 'semester', '2026-09-10').dayCount,
    140,
  );

  const dated = [
    createNode('range', { startDate: '2026-09-01', dueDate: '2026-09-10' }),
    createNode('due-only', { dueDate: '2026-10-05' }),
    createNode('milestone', { type: 'milestone', dueDate: '2026-08-20' }),
  ];
  const unscheduled = createNode('unscheduled');
  const dataDomain = createTimelineDataDomain([...dated, unscheduled], '2026-09-10');
  const fit = createGanttTimelineDomain(
    [...dated, unscheduled],
    dataDomain,
    'fit',
    '2026-09-10',
  );
  const fitWithoutUnscheduled = createFitTimelineDomain(dated, 7, '2026-09-10');

  assert.deepEqual(fit, fitWithoutUnscheduled);
  assert.equal(fit.startDate, '2026-08-13');
  assert.equal(fit.endDate, '2026-10-12');
  for (const node of dated) {
    const visual = createTimelineVisualItem(node, fit);
    assert.notEqual(visual, null);
    assert.ok((visual?.leftPercent ?? -1) >= 0);
    assert.ok((visual?.centerPercent ?? 101) <= 100);
  }

  const overview = buildTimelineOverview(dated, fit, fit.dayCount, '2026-09-10');
  assert.equal(overview.flatMap((item) => item.nodes).length, dated.length);
  assert.ok(fit.dayCount > timelineVisibleDayCount('weeks', fit.dayCount));
  for (const item of overview.filter((candidate) => candidate.kind !== 'cluster')) {
    const node = item.nodes[0];
    assert.notEqual(node, undefined);
    if (node === undefined) continue;
    const visual = createTimelineVisualItem(node, fit);
    assert.equal(item.leftPercent, visual?.kind === 'marker' ? visual.centerPercent : visual?.leftPercent);
  }

  const emptyFit = createFitTimelineDomain([], 7, '2026-09-10');
  assert.equal(emptyFit.dayCount, 28);
  assert.equal(emptyFit.startDate, '2026-08-27');
  assert.equal(emptyFit.endDate, '2026-09-23');
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

test('calendar policy v2 migration applies recommended defaults once and preserves calendar state', () => {
  const legacy = {
    calendar: {
      automaticallyInclude: {
        exam: false,
        'assignment-deadline': false,
        'project-deadline': false,
        milestone: false,
        presentation: false,
        'regular-task': true,
      },
      remindersEnabled: false,
      reminderMinutes: { exam: 2_880 },
      google: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        autoSync: true,
      },
    },
    calendarState: {
      calendarSyncDirty: true,
      itemOverrides: { item: 'include' },
      syncRecords: {
        'google:item': {
          internalItemId: 'item',
          provider: 'google',
          externalCalendarId: 'calendar',
          externalEventId: 'event',
        },
      },
      google: {
        refreshTokenSecretId: 'secret-id',
        selectedCalendarId: 'calendar',
        selectedCalendarName: 'Neuro Roadmap',
      },
    },
  };

  assert.equal(needsCalendarPolicyMigration(legacy), true);
  const firstMigration = migrateRoadmapSettingsData(legacy);
  const migrated = roadmapSettingsSchema.parse(firstMigration);
  assert.equal(migrated.calendar.calendarPolicyVersion, CALENDAR_POLICY_VERSION);
  assert.deepEqual(migrated.calendar.automaticallyInclude, RECOMMENDED_CALENDAR_POLICY);
  assert.equal(migrated.calendar.remindersEnabled, false);
  assert.equal(migrated.calendar.reminderMinutes.exam, 2_880);
  assert.equal(migrated.calendar.google.clientId, 'client-id');
  assert.equal(migrated.calendar.google.clientSecret, 'client-secret');
  assert.equal(migrated.calendar.google.autoSync, true);
  assert.deepEqual(migrated.calendarState.itemOverrides, { item: 'include' });
  assert.equal(migrated.calendarState.calendarSyncDirty, true);
  assert.ok(migrated.calendarState.syncRecords['google:item'] !== undefined);
  assert.equal(migrated.calendarState.google.refreshTokenSecretId, 'secret-id');
  assert.equal(migrated.calendarState.google.selectedCalendarId, 'calendar');

  assert.equal(needsCalendarPolicyMigration(firstMigration), false);
  assert.deepEqual(migrateRoadmapSettingsData(firstMigration), firstMigration);
});

test('compact task dates collapse equal dates and format ranges and single endpoints', () => {
  const now = new Date('2026-01-15T12:00:00.000Z');
  assert.equal(formatCompactTaskDates('2026-08-27', '2026-08-27', 'en-US', now), 'Aug 27');
  assert.equal(
    formatCompactTaskDates('2026-08-20', '2026-08-27', 'en-US', now),
    'Aug 20 → Aug 27',
  );
  assert.equal(formatCompactTaskDates(undefined, '2026-08-27', 'en-US', now), 'Due Aug 27');
  assert.equal(formatCompactTaskDates('2026-08-27', undefined, 'en-US', now), 'Starts Aug 27');
  assert.equal(
    formatCompactTaskDates('2027-08-27', '2027-08-27', 'en-US', now),
    'Aug 27, 2027',
  );
});

test('compact metadata uses semantic labels and suppresses neutral or redundant values', () => {
  const allFields = {
    startDate: true,
    dueDate: true,
    type: true,
    priority: true,
    status: true,
  };
  const neutral = projectCompactTaskMetadata(
    createNode('neutral', {
      calendarType: 'assignment-deadline',
      startDate: '2026-08-20',
      dueDate: '2026-08-27',
      priority: 'medium',
      status: 'todo',
    }),
    allFields,
    'en-US',
    new Date('2026-01-15T12:00:00.000Z'),
  );
  assert.equal(neutral.dateLabel, 'Aug 20 → Aug 27');
  assert.equal(neutral.typeLabel, 'Assignment deadline');
  assert.equal(neutral.priorityLabel, undefined);
  assert.equal(neutral.statusLabel, undefined);
  assert.equal(calendarTypeDisplayLabel('regular-task'), 'Task');

  const meaningful = projectCompactTaskMetadata(
    createNode('meaningful', { priority: 'high', status: 'in-progress' }),
    allFields,
    'en-US',
  );
  assert.equal(meaningful.priorityLabel, 'High');
  assert.equal(meaningful.statusLabel, 'In progress');
  assert.equal(
    projectCompactTaskMetadata(
      createNode('low', { priority: 'low' }),
      allFields,
      'en-US',
    ).priorityLabel,
    'Low',
  );
});

test('compact token scoping ignores unknown metadata and ordinary block IDs', () => {
  const keys = compilePropertyKeyMap(propertyMappingSchema.parse({}));
  const line = '- [ ] Úloha [start:: 2026-08-20] [foo:: zachovať] [typ:: skúška] ^nr-cal-abc';
  const tokens = findCompactTaskPropertyTokens(line, keys);
  assert.deepEqual(tokens.map(({ field, key }) => ({ field, key })), [
    { field: 'startDate', key: 'start' },
    { field: 'type', key: 'typ' },
  ]);
  assert.equal(tokens.some((token) => token.key === 'foo'), false);
  assert.equal(findManagedCalendarBlockId(line, 'nr-cal-abc')?.blockId, 'nr-cal-abc');
  assert.equal(findManagedCalendarBlockId('- [ ] Úloha ^my-note-anchor'), undefined);
  assert.equal(findManagedCalendarBlockId(line, 'nr-cal-other'), undefined);
  assert.equal(shouldUseCompactTaskPresentation(true, createNode('inline')), true);
  assert.equal(shouldUseCompactTaskPresentation(false, createNode('source')), false);
  assert.equal(
    shouldUseCompactTaskPresentation(true, createNode('frontmatter', { source: 'frontmatter' })),
    false,
  );
});

test('inline property mutations preserve title, unknown metadata, order, and stable block identity', () => {
  const source = '- [ ] Žluťoučký kôň: príprava eseje [start:: 2026-08-20] [foo:: zachovať] [type:: exam] ^nr-cal-stable';
  const changedType = replaceInlineTaskProperty(source, 'type', 'presentation');
  assert.equal(
    changedType,
    '- [ ] Žluťoučký kôň: príprava eseje [start:: 2026-08-20] [foo:: zachovať] [type:: presentation] ^nr-cal-stable',
  );
  const changedStart = replaceInlineTaskProperty(changedType, 'start', '2026-08-22');
  assert.match(changedStart, /Žluťoučký kôň: príprava eseje/u);
  assert.match(changedStart, /\[foo:: zachovať\]/u);
  assert.match(changedStart, /\^nr-cal-stable$/u);
  const withDue = replaceInlineTaskProperty(changedStart, 'due', '2026-08-30');
  assert.match(withDue, /\[due:: 2026-08-30\] \^nr-cal-stable$/u);
  const clearedDue = replaceInlineTaskProperty(withDue, 'due', null);
  assert.doesNotMatch(clearedDue, /\[due::/u);
  assert.match(clearedDue, /\[foo:: zachovať\]/u);
  assert.match(clearedDue, /\^nr-cal-stable$/u);
});

test('status property edits keep the Markdown checkbox authoritative', () => {
  const open = '- [ ] Úloha ^nr-cal-status';
  const inProgress = replaceInlineTaskStatus(open, 'status', 'in-progress', 'in-progress');
  assert.equal(inProgress, '- [ ] Úloha [status:: in-progress] ^nr-cal-status');
  const done = replaceInlineTaskStatus(inProgress, 'status', 'done', 'done');
  assert.equal(done, '- [x] Úloha [status:: done] ^nr-cal-status');
  const todo = replaceInlineTaskStatus('- [x] Úloha ^nr-cal-status', 'status', 'todo', 'todo');
  assert.equal(todo, open);
});

test('shared Calendar action presentation preserves all P24 override states', () => {
  assert.equal(describeCalendarAction(true, undefined, true).iconName, 'calendar-check');
  assert.equal(describeCalendarAction(true, 'include', true).iconName, 'calendar-plus');
  assert.equal(describeCalendarAction(false, 'exclude', true).iconName, 'calendar-x');
  assert.equal(describeCalendarAction(false, undefined, false).iconName, 'calendar-off');
  assert.match(
    describeCalendarAction(true, undefined, true).actionLabel,
    /Included automatically/u,
  );
});

test('task metadata block decorations are provided directly from editor state', () => {
  const settings = roadmapSettingsSchema.parse({});
  const node = createNode('note.md#task-0', {
    path: 'note.md',
    title: 'Task',
    sourceLine: 0,
  });
  const integration = new TaskMetadataEditorIntegration({
    getInlineNodes: () => [node],
    getPropertyKeys: () => compilePropertyKeyMap(settings.propertyMappings),
    getSemanticValues: () => compileSemanticValueMap(settings.valueMappings),
    updateProperty: async () => {},
    updateStatus: async () => {},
    getCalendarOverride: () => undefined,
    isCalendarIncluded: () => false,
    isCalendarAvailable: () => false,
    toggleCalendar: async () => {},
  });
  const state = EditorState.create({
    doc: '- [ ] Task',
    extensions: [editorInfoField, editorLivePreviewField, integration.extension],
  });
  const decorationProviders = state.facet(EditorView.decorations);

  assert.equal(decorationProviders.length, 1);
  assert.notEqual(typeof decorationProviders[0], 'function');
});

test('serialized task property writes apply rapid edits without corrupting Markdown', async () => {
  const file = { ...createFile('Predmet/Úlohy.md'), extension: 'md' } as TFile;
  let source = '- [ ] Dlhý český a slovenský názov [start:: 2026-08-20] [unknown:: áno] ^nr-cal-rapid';
  const app = {
    vault: {
      getAbstractFileByPath: () => file,
      process: async (_file: TFile, transform: (value: string) => string) => {
        await Promise.resolve();
        source = transform(source);
      },
    },
  } as unknown as App;
  const node = createNode('rapid', {
    path: file.path,
    sourceLine: 0,
    blockId: 'nr-cal-rapid',
  });
  const writer = new InlineTaskPropertyWriter(app);
  await Promise.all([
    writer.update(node, 'startDate', '2026-08-22'),
    writer.update(node, 'dueDate', '2026-08-30'),
    writer.update(node, 'type', 'exam'),
    writer.update(node, 'priority', 'high'),
  ]);

  assert.match(source, /^- \[ \] Dlhý český a slovenský názov/u);
  assert.match(source, /\[start:: 2026-08-22\]/u);
  assert.match(source, /\[due:: 2026-08-30\]/u);
  assert.match(source, /\[type:: exam\]/u);
  assert.match(source, /\[priority:: high\]/u);
  assert.match(source, /\[unknown:: áno\]/u);
  assert.match(source, /\^nr-cal-rapid$/u);
});

test('inline property editor reuses configured and existing mapped write keys', () => {
  const mappings = propertyMappingSchema.parse({
    startDate: 'začiatok',
    dueDate: 'termín',
    type: 'typ',
    priority: 'priorita',
    status: 'stav',
  });
  const parser = new RoadmapParser(metadataCache, {
    ...createDefaultParserOptions(),
    propertyKeys: compilePropertyKeyMap(mappings),
  });
  const node = parser.parseFile(
    createFile('Predmet/Úlohy.md'),
    createCache({ predmet: 'ISKB02' }, [{ line: 0, task: ' ' }]),
    '- [ ] Skúška [typ:: exam] [priorita:: high] ^nr-cal-mapped',
  )[0];
  assert.deepEqual(node?.writeKeys, {
    startDate: 'začiatok',
    dueDate: 'termín',
    type: 'typ',
    priority: 'priorita',
    status: 'stav',
  });
});

test('task property edits retain calendar identity and re-evaluate P24 type policy', () => {
  const keys = compilePropertyKeyMap(propertyMappingSchema.parse({}));
  const values = compileSemanticValueMap(semanticValueMappingSchema.parse({}));
  const parser = new RoadmapParser(metadataCache, {
    ...createDefaultParserOptions(),
    propertyKeys: keys,
    semanticValues: values,
  });
  const file = createFile('Predmet/Úlohy.md');
  const cache = createCache({ predmet: 'ISKB02' }, [{ line: 0, task: ' ' }]);
  const regularSource = '- [ ] Odovzdať prácu [due:: 2026-08-27] [type:: task] ^nr-cal-policy';
  const examSource = replaceInlineTaskProperty(regularSource, 'type', 'exam');
  const regular = parser.parseFile(file, cache, regularSource)[0];
  const exam = parser.parseFile(file, cache, examSource)[0];
  assert.equal(regular?.calendarType, 'regular-task');
  assert.equal(exam?.calendarType, 'exam');
  assert.equal(calendarItemLocator(regular ?? createNode('missing')), 'inline:Predmet/Úlohy.md#^nr-cal-policy');
  assert.equal(calendarItemLocator(exam ?? createNode('missing')), 'inline:Predmet/Úlohy.md#^nr-cal-policy');
  assert.equal(isCalendarEligible(regular ?? createNode('missing'), createCalendarOptions()), false);
  assert.equal(isCalendarEligible(exam ?? createNode('missing'), createCalendarOptions()), true);
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
    writeKeys: {
      startDate: 'start',
      dueDate: 'due',
      type: 'type',
      priority: 'priority',
      status: 'status',
    },
    ...overrides,
  };
}

class QueueCalendarTransport implements CalendarHttpTransport {
  readonly requests: CalendarHttpRequest[] = [];

  constructor(private readonly responses: CalendarHttpResponse[]) {}

  async request(request: CalendarHttpRequest): Promise<CalendarHttpResponse> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (response === undefined) throw new Error('No queued calendar HTTP response.');
    return response;
  }
}

function jsonResponse(status: number, json: unknown): CalendarHttpResponse {
  return { status, headers: {}, json, text: JSON.stringify(json) };
}

async function authorizeGoogleWithScopes(grantedScopes: readonly string[]) {
  const client = new GoogleAuthClient(
    new QueueCalendarTransport([jsonResponse(200, {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expires_in: 3600,
      scope: grantedScopes.join(' '),
    })]),
    createSecretStore(),
  );
  const configuration = {
    clientId: 'desktop-client.apps.googleusercontent.com',
    clientSecret: GOOGLE_TEST_CLIENT_SECRET,
    refreshTokenSecretId: 'google-token',
  };
  const session = await client.beginAuthorization(
    configuration,
    'http://127.0.0.1:49152/oauth2/callback',
  );
  return client.completeAuthorization(configuration, session, {
    state: session.state,
    code: 'authorization-code',
    error: null,
  });
}

function createSecretStore(values = new Map<string, string>()) {
  return {
    getSecret: (id: string) => values.get(id) ?? null,
    setSecret: (id: string, value: string) => {
      values.set(id, value);
    },
  };
}

function isSystemErrorCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === code;
}

function createGoogleProvider(
  transport: CalendarHttpTransport,
  callbacks: { readonly invalidate?: () => void } = {},
  wait: (milliseconds: number) => Promise<void> = async () => undefined,
): GoogleCalendarProvider {
  return new GoogleCalendarProvider(
    () => ({
      clientId: 'desktop-client.apps.googleusercontent.com',
      clientSecret: GOOGLE_TEST_CLIENT_SECRET,
      refreshTokenSecretId: 'google-token',
    }),
    {
      getAccessToken: async () => 'access-token',
      invalidateAccessToken: () => callbacks.invalidate?.(),
    },
    transport,
    wait,
    () => 0,
  );
}

class MemoryCalendarProvider implements CalendarProvider {
  readonly id = 'google';
  readonly displayName = 'Google Calendar';
  readonly capabilities: CalendarProviderCapabilities = {
    export: false,
    remoteCalendars: true,
    create: true,
    update: true,
    delete: true,
    reminders: true,
  };
  readonly created: { reference: ExternalCalendarEventRef; event: CalendarEventProjection }[] = [];
  readonly updated: { reference: ExternalCalendarEventRef; event: CalendarEventProjection }[] = [];
  readonly deleted: ExternalCalendarEventRef[] = [];
  readonly existenceChecks: ExternalCalendarEventRef[] = [];
  private readonly existingEventIds = new Set<string>();
  private sequence = 0;

  async initialize() {
    return { connected: true };
  }

  async listCalendars(): Promise<readonly CalendarDescriptor[]> {
    return [{ id: 'google-calendar', name: 'Neuro Roadmap', primary: false }];
  }

  async createEvent(
    calendarId: string,
    event: CalendarEventProjection,
  ): Promise<ExternalCalendarEventRef> {
    const reference = { calendarId, eventId: `event-${++this.sequence}` };
    this.created.push({ reference, event });
    this.existingEventIds.add(reference.eventId);
    return reference;
  }

  async updateEvent(
    reference: ExternalCalendarEventRef,
    event: CalendarEventProjection,
  ): Promise<void> {
    if (!this.existingEventIds.has(reference.eventId)) {
      throw { kind: 'not-found' };
    }
    this.updated.push({ reference, event });
  }

  async deleteEvent(reference: ExternalCalendarEventRef): Promise<void> {
    this.deleted.push(reference);
    this.existingEventIds.delete(reference.eventId);
  }

  async eventExists(reference: ExternalCalendarEventRef): Promise<boolean> {
    this.existenceChecks.push(reference);
    return this.existingEventIds.has(reference.eventId);
  }

  deleteExternally(reference: ExternalCalendarEventRef): void {
    this.existingEventIds.delete(reference.eventId);
  }
}

class ManualTimers {
  private nextHandle = 1;
  private readonly callbacks = new Map<number, { callback: () => void; milliseconds: number }>();

  readonly schedule = (callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> => {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, { callback, milliseconds });
    return handle as ReturnType<typeof setTimeout>;
  };

  readonly cancel = (handle: ReturnType<typeof setTimeout>): void => {
    this.callbacks.delete(handle as number);
  };

  activeDelays(): number[] {
    return [...this.callbacks.values()].map(({ milliseconds }) => milliseconds);
  }

  runNext(): void {
    const entry = this.callbacks.entries().next().value as
      | readonly [number, { callback: () => void; milliseconds: number }]
      | undefined;
    if (entry === undefined) throw new Error('No scheduled timer is available.');
    this.callbacks.delete(entry[0]);
    entry[1].callback();
  }
}

function emptySyncReport() {
  return {
    created: 0,
    updated: 0,
    deleted: 0,
    recreated: 0,
    unchanged: 0,
    completedAt: '2026-08-15T00:00:00.000Z',
  };
}

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function createSyncFixture() {
  let identityRecords: Record<string, string> = {};
  let sequence = 0;
  const identities = new CalendarIdentityManager(
    {} as App,
    () => identityRecords,
    async (records) => { identityRecords = records; },
    () => `internal-${++sequence}`,
  );
  const provider = new MemoryCalendarProvider();
  const settings = roadmapSettingsSchema.parse({});
  const state = settings.calendarState;
  const engine = new CalendarSyncEngine(
    identities,
    provider,
    () => ({
      settings: settings.calendar,
      state,
      calendarId: 'google-calendar',
      vaultName: 'Academic Vault',
    }),
    async (records) => { state.syncRecords = records; },
    () => new Date('2026-08-15T00:00:00.000Z'),
  );
  return { engine, provider, state };
}
