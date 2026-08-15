import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
import { CalendarExportService } from '../src/core/CalendarExportService';
import {
  GOOGLE_CALENDAR_SCOPES,
  GoogleAuthClient,
  GoogleAuthError,
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
import { CalendarSyncController } from '../src/core/CalendarSyncController';
import { buildSubjectSummaries } from '../src/core/DashboardMetrics';
import { classifyHorizon, formatRelativeTaskDate } from '../src/core/HorizonPlanner';
import { migrateRoadmapSettingsData } from '../src/core/SettingsMigration';
import { roadmapSettingsSchema } from '../src/types';
import {
  compileSourceScope,
  isFrontmatterInSourceScope,
} from '../src/core/SourceScope';

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
  assert.deepEqual(settings.calendarState.google, {});
  assert.deepEqual(settings.calendar.google, {
    clientId: '',
    clientSecret: '',
    autoSync: true,
    debounceMs: 2_000,
  });
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

test('provider-neutral reconciliation recreates externally deleted events without duplicates', async () => {
  const fixture = createSyncFixture();
  const node = createNode('milestone', {
    source: 'frontmatter',
    calendarType: 'milestone',
    dueDate: '2026-10-10',
  });
  await fixture.engine.reconcile([node]);
  fixture.provider.missingOnNextUpdate = true;

  const report = await fixture.engine.reconcile([node], { verifyRemote: true });
  assert.equal(report.recreated, 1);
  assert.equal(fixture.provider.created.length, 2);
  assert.equal(Object.keys(fixture.state.syncRecords).length, 1);
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

test('calendar sync controller debounces changes and serializes explicit sync', async () => {
  const scheduled: (() => void)[] = [];
  const runs: string[][] = [];
  const controller = new CalendarSyncController(
    async (nodes) => {
      runs.push(nodes.map((node) => node.id));
      return { created: 0, updated: 0, deleted: 0, recreated: 0, unchanged: 0, completedAt: '2026-08-15T00:00:00.000Z' };
    },
    () => 2_000,
    async () => undefined,
    async () => undefined,
    (callback) => {
      scheduled.push(callback);
      return scheduled.length as ReturnType<typeof setTimeout>;
    },
    () => undefined,
  );
  controller.schedule([createNode('first')]);
  controller.schedule([createNode('latest')]);
  scheduled.at(-1)?.();
  await controller.syncNow([createNode('manual')]);

  assert.deepEqual(runs, [['latest'], ['manual']]);
  controller.dispose();
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
  missingOnNextUpdate = false;
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
    return reference;
  }

  async updateEvent(
    reference: ExternalCalendarEventRef,
    event: CalendarEventProjection,
  ): Promise<void> {
    if (this.missingOnNextUpdate) {
      this.missingOnNextUpdate = false;
      throw { kind: 'not-found' };
    }
    this.updated.push({ reference, event });
  }

  async deleteEvent(reference: ExternalCalendarEventRef): Promise<void> {
    this.deleted.push(reference);
  }
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
