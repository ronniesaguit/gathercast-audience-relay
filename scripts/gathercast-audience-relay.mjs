import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const RELAY_HOST = process.env.GATHERCAST_RELAY_HOST || '0.0.0.0';
const RELAY_PORT = Number(
  process.env.GATHERCAST_RELAY_PORT ||
    process.env.PORT ||
    5082
);
const RELAY_PUBLIC_URL = String(
  process.env.GATHERCAST_RELAY_PUBLIC_URL || ''
).trim();
const RELAY_ALLOWED_ORIGIN = String(
  process.env.GATHERCAST_RELAY_ALLOWED_ORIGIN || '*'
).trim();
const RELAY_HOST_KEY = String(
  process.env.GATHERCAST_RELAY_HOST_KEY || ''
);
const MAX_JSON_BYTES = 64 * 1024;
const RELAY_MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const RELAY_MAX_FRAME_BYTES = 1536 * 1024;
const RELAY_MAX_VIEWERS = Number(
  process.env.GATHERCAST_RELAY_MAX_VIEWERS || 200
);
const RELAY_MAX_MESSAGES = Number(
  process.env.GATHERCAST_RELAY_MAX_MESSAGES || 300
);
const RELAY_MAX_MESSAGE_NAME_CHARS = 60;
const RELAY_MAX_MESSAGE_TEXT_CHARS = 500;
const RELAY_MAX_INTERACTIVE_GUESTS = 4;
const RELAY_MAX_INTERACTIVE_REQUESTS = 80;
const RELAY_MAX_INTERACTIVE_SIGNALS = 400;
const RELAY_MAX_INTERACTIVE_SIGNAL_CHARS = 20000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.resolve(__dirname, '..');
const publicDir = path.join(projectDir, 'public');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const relayState = {
  active: false,
  sessionId: '',
  title: '',
  mimeType: 'video/webm',
  startedAt: 0,
  endedAt: 0,
  chunkSequence: 0,
  initChunk: null,
  lastChunkAt: 0,
  frameSequence: 0,
  latestFrame: null,
  lastFrameAt: 0,
  bytesReceived: 0,
  viewers: new Set(),
  messages: [],
  nextMessageId: 1,
  interactiveRequests: [],
  interactiveSignals: [],
  nextInteractiveSignalId: 1,
};

function exitIfRelayIsUnsafe() {
  if (!RELAY_HOST_KEY || RELAY_HOST_KEY.length < 16) {
    console.error(
      'GatherCast Audience Relay requires GATHERCAST_RELAY_HOST_KEY with at least 16 characters.'
    );
    process.exit(1);
  }
}

function createCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': RELAY_ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, X-GatherCast-Host-Key, X-GatherCast-Frame-Source, X-GatherCast-Frame-Element',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    ...createCorsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });

  res.end(JSON.stringify(payload));
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;

      if (total > maxBytes) {
        reject(
          Object.assign(
            new Error('Request body is too large.'),
            { statusCode: 413 }
          )
        );
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = await readRequestBody(req, MAX_JSON_BYTES);

  if (body.length === 0) {
    return {};
  }

  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(
      new Error('Invalid JSON request body.'),
      { statusCode: 400 }
    );
  }
}

function normalizeAudienceMimeType(value) {
  const raw = String(value || '')
    .replace(/[\r\n]/g, '')
    .trim()
    .slice(0, 120);
  const lower = raw.toLowerCase();

  return lower.startsWith('video/webm')
    ? raw || 'video/webm'
    : 'video/webm';
}

function isValidAudienceSessionId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value || ''));
}

function getAudienceSessionFromUrl(requestUrl) {
  const sessionId = String(
    requestUrl.searchParams.get('session') || ''
  ).trim();

  return isValidAudienceSessionId(sessionId)
    ? sessionId
    : '';
}

function hasActiveAudienceSession(sessionId) {
  return Boolean(
    relayState.active &&
    relayState.sessionId &&
    sessionId === relayState.sessionId
  );
}

function normalizePublicBaseUrl(req) {
  if (RELAY_PUBLIC_URL) {
    try {
      const parsed = new URL(RELAY_PUBLIC_URL);

      if (
        parsed.protocol === 'https:' ||
        parsed.protocol === 'http:'
      ) {
        parsed.pathname = parsed.pathname.replace(/\/+$/, '');
        parsed.search = '';
        parsed.hash = '';
        return parsed.toString().replace(/\/+$/, '');
      }
    } catch {
      // Fall through to request host.
    }
  }

  const host = String(req.headers.host || '').trim();

  if (!host) {
    return `http://127.0.0.1:${RELAY_PORT}`;
  }

  const forwardedProto = String(
    req.headers['x-forwarded-proto'] || ''
  )
    .split(',')[0]
    .trim()
    .toLowerCase();
  const proto =
    forwardedProto === 'https' ? 'https' : 'http';

  return `${proto}://${host}`;
}

function getAudienceUrl(req, sessionId) {
  const baseUrl = normalizePublicBaseUrl(req);
  return `${baseUrl}/watch?session=${encodeURIComponent(sessionId)}`;
}

function isAuthorizedHostKey(req) {
  const provided = String(
    req.headers['x-gathercast-host-key'] || ''
  );

  if (!provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(RELAY_HOST_KEY);
  const providedBuffer = Buffer.from(provided);

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function requireHostKey(req) {
  if (!isAuthorizedHostKey(req)) {
    throw Object.assign(
      new Error('The relay host key is missing or invalid.'),
      { statusCode: 401 }
    );
  }
}

function getAudienceStatusPayload(sessionId = '') {
  const sessionMatches = hasActiveAudienceSession(sessionId);

  return {
    active: sessionMatches,
    phase: sessionMatches ? 'live' : 'idle',
    title: sessionMatches ? relayState.title : '',
    mimeType: sessionMatches ? relayState.mimeType : 'video/webm',
    startedAt: sessionMatches ? relayState.startedAt : 0,
    lastChunkAt: sessionMatches ? relayState.lastChunkAt : 0,
    lastFrameAt: sessionMatches ? relayState.lastFrameAt : 0,
    frameSequence: sessionMatches ? relayState.frameSequence : 0,
    bytesReceived: sessionMatches ? relayState.bytesReceived : 0,
    viewerCount: sessionMatches ? relayState.viewers.size : 0,
    relay: true,
  };
}

function normalizeAudienceMessageText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function createHttpError(message, statusCode = 400) {
  return Object.assign(new Error(message), {
    statusCode,
  });
}

function appendAudienceMessage({
  role = 'audience',
  name = '',
  text = '',
} = {}) {
  const safeRole =
    role === 'teacher' ? 'teacher' : 'audience';
  const safeName = normalizeAudienceMessageText(
    name,
    RELAY_MAX_MESSAGE_NAME_CHARS
  ) || (safeRole === 'teacher' ? 'Teacher' : 'Audience');
  const safeText = normalizeAudienceMessageText(
    text,
    RELAY_MAX_MESSAGE_TEXT_CHARS
  );

  if (!safeText) {
    throw createHttpError('Message text is required.', 400);
  }

  const message = {
    id: relayState.nextMessageId,
    role: safeRole,
    name: safeName,
    text: safeText,
    createdAt: Date.now(),
  };

  relayState.nextMessageId += 1;
  relayState.messages.push(message);

  if (relayState.messages.length > RELAY_MAX_MESSAGES) {
    relayState.messages.splice(
      0,
      relayState.messages.length - RELAY_MAX_MESSAGES
    );
  }

  return message;
}

function getAudienceMessagesPayload(sessionId = '', afterId = 0) {
  const sessionMatches = hasActiveAudienceSession(sessionId);
  const lastSeen = Number(afterId) || 0;
  const messages = sessionMatches
    ? relayState.messages.filter(
        (message) => message.id > lastSeen
      )
    : [];

  return {
    active: sessionMatches,
    messages,
    latestMessageId: sessionMatches && relayState.messages.length
      ? relayState.messages[relayState.messages.length - 1].id
      : lastSeen,
    relay: true,
  };
}

function resetAudienceInteractiveState() {
  relayState.interactiveRequests = [];
  relayState.interactiveSignals = [];
  relayState.nextInteractiveSignalId = 1;
}

function normalizeAudienceParticipantId(value) {
  const raw = String(value || '')
    .trim()
    .slice(0, 80);

  if (!/^[a-z0-9_-]{8,80}$/i.test(raw)) {
    throw createHttpError('A valid audience participant ID is required.', 400);
  }

  return raw;
}

function normalizeAudienceInteractiveName(value) {
  return (
    normalizeAudienceMessageText(
      value,
      RELAY_MAX_MESSAGE_NAME_CHARS
    ) || 'Audience'
  );
}

function normalizeAudienceInteractiveSignalType(value) {
  const type = String(value || '')
    .trim()
    .toLowerCase();

  if (
    ![
      'offer',
      'answer',
      'candidate',
      'leave',
    ].includes(type)
  ) {
    throw createHttpError('Unsupported interactive signal type.', 400);
  }

  return type;
}

function normalizeAudienceInteractivePayload(value) {
  if (value === undefined || value === null) {
    return {};
  }

  const encoded = JSON.stringify(value);

  if (
    !encoded ||
    encoded.length > RELAY_MAX_INTERACTIVE_SIGNAL_CHARS
  ) {
    throw createHttpError('Interactive signal payload is too large.', 413);
  }

  return JSON.parse(encoded);
}

function getAudienceInteractiveRequest(participantId) {
  return relayState.interactiveRequests.find(
    (request) => request.participantId === participantId
  ) || null;
}

function getApprovedAudienceInteractiveGuests() {
  return relayState.interactiveRequests.filter(
    (request) => request.status === 'approved'
  );
}

function trimAudienceInteractiveRequests() {
  if (
    relayState.interactiveRequests.length <=
    RELAY_MAX_INTERACTIVE_REQUESTS
  ) {
    return;
  }

  const pinned = relayState.interactiveRequests.filter(
    (request) => request.status === 'approved'
  );
  const recent = relayState.interactiveRequests
    .filter((request) => request.status !== 'approved')
    .slice(
      -Math.max(
        RELAY_MAX_INTERACTIVE_REQUESTS - pinned.length,
        0
      )
    );

  relayState.interactiveRequests = [
    ...pinned,
    ...recent,
  ].slice(-RELAY_MAX_INTERACTIVE_REQUESTS);
}

function appendAudienceInteractiveSignal({
  participantId = '',
  from = '',
  target = '',
  type = '',
  payload = {},
} = {}) {
  const signal = {
    id: relayState.nextInteractiveSignalId,
    participantId: normalizeAudienceParticipantId(participantId),
    from: from === 'teacher' ? 'teacher' : 'audience',
    target: target === 'teacher' ? 'teacher' : 'audience',
    type: normalizeAudienceInteractiveSignalType(type),
    payload: normalizeAudienceInteractivePayload(payload),
    createdAt: Date.now(),
  };

  relayState.nextInteractiveSignalId += 1;
  relayState.interactiveSignals.push(signal);

  if (
    relayState.interactiveSignals.length >
    RELAY_MAX_INTERACTIVE_SIGNALS
  ) {
    relayState.interactiveSignals.splice(
      0,
      relayState.interactiveSignals.length -
        RELAY_MAX_INTERACTIVE_SIGNALS
    );
  }

  return signal;
}

function getAudienceInteractiveSignals({
  participantId = '',
  target = '',
  afterId = 0,
} = {}) {
  const lastSeen = Number(afterId) || 0;

  return relayState.interactiveSignals.filter((signal) => {
    if (signal.id <= lastSeen) {
      return false;
    }

    if (participantId && signal.participantId !== participantId) {
      return false;
    }

    return !target || signal.target === target;
  });
}

function getAudienceInteractiveIceServers() {
  const configured = String(
    process.env.GATHERCAST_WEBRTC_ICE_SERVERS || ''
  ).trim();

  if (configured) {
    try {
      const parsed = JSON.parse(configured);

      if (Array.isArray(parsed)) {
        return parsed
          .filter((item) => item && typeof item === 'object')
          .slice(0, 8);
      }
    } catch {
      const urls = configured
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 8);

      if (urls.length) {
        return urls.map((url) => ({ urls: url }));
      }
    }
  }

  return [
    {
      urls: 'stun:stun.l.google.com:19302',
    },
  ];
}

function getAudienceInteractivePublicPayload(
  sessionId = '',
  participantId = '',
  afterId = 0
) {
  const active = hasActiveAudienceSession(sessionId);
  const safeParticipantId = participantId
    ? normalizeAudienceParticipantId(participantId)
    : '';
  const participant =
    active && safeParticipantId
      ? getAudienceInteractiveRequest(safeParticipantId)
      : null;
  const signals =
    active && participant?.status === 'approved'
      ? getAudienceInteractiveSignals({
          participantId: safeParticipantId,
          target: 'audience',
          afterId,
        })
      : [];

  return {
    active,
    participant,
    signals,
    latestSignalId: signals.length
      ? signals[signals.length - 1].id
      : Number(afterId) || 0,
    maxGuests: RELAY_MAX_INTERACTIVE_GUESTS,
    iceServers: getAudienceInteractiveIceServers(),
    relay: true,
  };
}

function getAudienceInteractiveTeacherPayload(
  sessionId = '',
  afterId = 0
) {
  const active = hasActiveAudienceSession(sessionId);
  const signals = active
    ? getAudienceInteractiveSignals({
        target: 'teacher',
        afterId,
      })
    : [];

  return {
    active,
    requests: active
      ? relayState.interactiveRequests
      : [],
    approvedGuests: active
      ? getApprovedAudienceInteractiveGuests()
      : [],
    signals,
    latestSignalId: signals.length
      ? signals[signals.length - 1].id
      : Number(afterId) || 0,
    maxGuests: RELAY_MAX_INTERACTIVE_GUESTS,
    iceServers: getAudienceInteractiveIceServers(),
    relay: true,
  };
}

async function receiveAudienceInteractiveRaiseHand(
  req,
  res,
  requestUrl
) {
  const sessionId = getAudienceSessionFromUrl(requestUrl);

  if (!hasActiveAudienceSession(sessionId)) {
    sendJson(res, 409, {
      error: 'The audience relay broadcast is not live.',
    });
    return;
  }

  const body = await readJsonBody(req);
  const participantId = normalizeAudienceParticipantId(
    body.participantId
  );
  const now = Date.now();
  let request =
    getAudienceInteractiveRequest(participantId);

  if (request) {
    request.name = normalizeAudienceInteractiveName(body.name);
    request.status =
      request.status === 'approved' ? 'approved' : 'pending';
    request.updatedAt = now;
  } else {
    request = {
      participantId,
      name: normalizeAudienceInteractiveName(body.name),
      status: 'pending',
      requestedAt: now,
      updatedAt: now,
    };
    relayState.interactiveRequests.push(request);
  }

  trimAudienceInteractiveRequests();

  sendJson(res, 200, {
    accepted: true,
    participant: request,
    maxGuests: RELAY_MAX_INTERACTIVE_GUESTS,
    relay: true,
  });
}

async function receiveAudienceInteractiveSignal(
  req,
  res,
  requestUrl
) {
  const sessionId = getAudienceSessionFromUrl(requestUrl);

  if (!hasActiveAudienceSession(sessionId)) {
    sendJson(res, 409, {
      error: 'The audience relay broadcast is not live.',
    });
    return;
  }

  const body = await readJsonBody(req);
  const participantId = normalizeAudienceParticipantId(
    body.participantId
  );
  const request = getAudienceInteractiveRequest(participantId);
  const type = normalizeAudienceInteractiveSignalType(body.type);

  if (type !== 'leave' && request?.status !== 'approved') {
    throw createHttpError('The teacher has not approved this guest.', 403);
  }

  const signal = appendAudienceInteractiveSignal({
    participantId,
    from: 'audience',
    target: 'teacher',
    type,
    payload: body.payload,
  });

  sendJson(res, 200, {
    accepted: true,
    signalId: signal.id,
    relay: true,
  });
}

async function receiveAudienceInteractiveLeave(
  req,
  res,
  requestUrl
) {
  const sessionId = getAudienceSessionFromUrl(requestUrl);

  if (!hasActiveAudienceSession(sessionId)) {
    sendJson(res, 200, {
      accepted: true,
      relay: true,
    });
    return;
  }

  const body = await readJsonBody(req);
  const participantId = normalizeAudienceParticipantId(
    body.participantId
  );
  const request = getAudienceInteractiveRequest(participantId);

  if (request) {
    request.status = 'left';
    request.updatedAt = Date.now();
  }

  appendAudienceInteractiveSignal({
    participantId,
    from: 'audience',
    target: 'teacher',
    type: 'leave',
    payload: {},
  });

  sendJson(res, 200, {
    accepted: true,
    relay: true,
  });
}

async function receiveTeacherAudienceInteractiveAction(
  req,
  res,
  requestUrl
) {
  requireHostKey(req);

  const sessionId = getAudienceSessionFromUrl(requestUrl);

  if (!hasActiveAudienceSession(sessionId)) {
    sendJson(res, 409, {
      error: 'The audience relay broadcast is not live.',
    });
    return;
  }

  const body = await readJsonBody(req);
  const participantId = normalizeAudienceParticipantId(
    body.participantId
  );
  const action = String(body.action || '')
    .trim()
    .toLowerCase();
  const request = getAudienceInteractiveRequest(participantId);

  if (!request) {
    throw createHttpError('Audience guest request was not found.', 404);
  }

  if (action === 'approve') {
    const approvedCount =
      getApprovedAudienceInteractiveGuests().filter(
        (guest) => guest.participantId !== participantId
      ).length;

    if (approvedCount >= RELAY_MAX_INTERACTIVE_GUESTS) {
      throw createHttpError('The interactive guest panel is full.', 409);
    }

    request.status = 'approved';
    request.approvedAt = Date.now();
  } else if (action === 'reject') {
    request.status = 'rejected';
  } else if (action === 'remove') {
    request.status = 'removed';
    appendAudienceInteractiveSignal({
      participantId,
      from: 'teacher',
      target: 'audience',
      type: 'leave',
      payload: {},
    });
  } else {
    throw createHttpError('Unsupported interactive guest action.', 400);
  }

  request.updatedAt = Date.now();

  sendJson(res, 200, {
    accepted: true,
    participant: request,
    maxGuests: RELAY_MAX_INTERACTIVE_GUESTS,
    relay: true,
  });
}

async function receiveTeacherAudienceInteractiveSignal(
  req,
  res,
  requestUrl
) {
  requireHostKey(req);

  const sessionId = getAudienceSessionFromUrl(requestUrl);

  if (!hasActiveAudienceSession(sessionId)) {
    sendJson(res, 409, {
      error: 'The audience relay broadcast is not live.',
    });
    return;
  }

  const body = await readJsonBody(req);
  const participantId = normalizeAudienceParticipantId(
    body.participantId
  );
  const request = getAudienceInteractiveRequest(participantId);

  if (request?.status !== 'approved') {
    throw createHttpError('The audience guest is not approved.', 403);
  }

  const signal = appendAudienceInteractiveSignal({
    participantId,
    from: 'teacher',
    target: 'audience',
    type: body.type,
    payload: body.payload,
  });

  sendJson(res, 200, {
    accepted: true,
    signalId: signal.id,
    relay: true,
  });
}

function closeAudienceViewers() {
  for (const viewer of relayState.viewers) {
    try {
      viewer.res.end();
    } catch {
      // Viewer connection is already gone.
    }
  }

  relayState.viewers.clear();
}

function normalizeAudienceFrameMimeType(value = '') {
  const contentType = String(value || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  return [
    'image/webp',
    'image/jpeg',
    'image/png',
  ].includes(contentType)
    ? contentType
    : '';
}

function normalizeAudienceFrameSource(value = '') {
  const source = String(value || '').trim().toLowerCase();

  return source === 'stage-rect' ? 'stage-rect' : 'unknown';
}

function startAudienceSession(req, {
  title = '',
  mimeType = '',
} = {}) {
  closeAudienceViewers();

  relayState.active = true;
  relayState.sessionId = randomUUID();
  relayState.title =
    String(title || 'GatherCast Live')
      .replace(/[\r\n]/g, ' ')
      .trim()
      .slice(0, 120) ||
    'GatherCast Live';
  relayState.mimeType = normalizeAudienceMimeType(mimeType);
  relayState.startedAt = Date.now();
  relayState.endedAt = 0;
  relayState.chunkSequence = 0;
  relayState.initChunk = null;
  relayState.lastChunkAt = 0;
  relayState.frameSequence = 0;
  relayState.latestFrame = null;
  relayState.lastFrameAt = 0;
  relayState.bytesReceived = 0;
  relayState.messages = [];
  relayState.nextMessageId = 1;
  resetAudienceInteractiveState();

  return {
    sessionId: relayState.sessionId,
    title: relayState.title,
    mimeType: relayState.mimeType,
    audienceUrl: getAudienceUrl(req, relayState.sessionId),
    relay: true,
  };
}

async function receiveAudienceMessage(req, res, requestUrl) {
  const sessionId = getAudienceSessionFromUrl(requestUrl);

  if (!hasActiveAudienceSession(sessionId)) {
    sendJson(res, 409, {
      error: 'The audience relay broadcast is not live.',
    });
    return;
  }

  const body = await readJsonBody(req);
  const message = appendAudienceMessage({
    role: 'audience',
    name: body.name,
    text: body.text,
  });

  sendJson(res, 200, {
    accepted: true,
    message,
    latestMessageId: message.id,
    relay: true,
  });
}

async function receiveTeacherAudienceMessage(req, res, requestUrl) {
  requireHostKey(req);

  const sessionId = getAudienceSessionFromUrl(requestUrl);

  if (!hasActiveAudienceSession(sessionId)) {
    sendJson(res, 409, {
      error: 'The audience relay broadcast is not live.',
    });
    return;
  }

  const body = await readJsonBody(req);
  const message = appendAudienceMessage({
    role: 'teacher',
    name: 'Teacher',
    text: body.text,
  });

  sendJson(res, 200, {
    accepted: true,
    message,
    latestMessageId: message.id,
    relay: true,
  });
}

function stopAudienceSession(sessionId) {
  if (
    relayState.active &&
    (!sessionId || sessionId === relayState.sessionId)
  ) {
    relayState.active = false;
    relayState.endedAt = Date.now();
    closeAudienceViewers();
    resetAudienceInteractiveState();
    relayState.latestFrame = null;
    relayState.lastFrameAt = 0;
  }

  return {
    active: false,
    phase: 'stopped',
    relay: true,
  };
}

async function receiveAudienceFrame(req, res, requestUrl) {
  requireHostKey(req);

  const sessionId = getAudienceSessionFromUrl(requestUrl);

  if (!hasActiveAudienceSession(sessionId)) {
    sendJson(res, 409, {
      error: 'No active relay audience session is available.',
    });
    return;
  }

  const mimeType = normalizeAudienceFrameMimeType(
    req.headers['content-type']
  );

  if (!mimeType) {
    sendJson(res, 415, {
      error: 'Audience frames must be image/webp, image/jpeg, or image/png.',
    });
    return;
  }

  const body = await readRequestBody(
    req,
    RELAY_MAX_FRAME_BYTES
  );
  const frameSource = normalizeAudienceFrameSource(
    req.headers['x-gathercast-frame-source']
  );
  const frameElement = String(
    req.headers['x-gathercast-frame-element'] || ''
  )
    .trim()
    .slice(0, 80);

  if (body.length === 0) {
    sendJson(res, 200, {
      accepted: false,
      sequence: relayState.frameSequence,
      relay: true,
    });
    return;
  }

  relayState.frameSequence += 1;
  relayState.lastFrameAt = Date.now();
  relayState.latestFrame = {
    sequence: relayState.frameSequence,
    capturedAt: relayState.lastFrameAt,
    mimeType,
    source: frameSource,
    element: frameElement,
    body,
  };

  sendJson(res, 200, {
    accepted: true,
    sequence: relayState.frameSequence,
    capturedAt: relayState.lastFrameAt,
    relay: true,
  });
}

function serveAudienceFrame(req, res, requestUrl) {
  const sessionId = getAudienceSessionFromUrl(requestUrl);

  if (!hasActiveAudienceSession(sessionId)) {
    sendJson(res, 404, {
      error: 'The audience relay broadcast is not live.',
    });
    return;
  }

  const frame = relayState.latestFrame;

  if (!frame) {
    res.writeHead(204, {
      ...createCorsHeaders(),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end();
    return;
  }

  res.writeHead(200, {
    ...createCorsHeaders(),
    'Content-Type': frame.mimeType,
    'Content-Length': frame.body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-GatherCast-Frame-Sequence': String(frame.sequence),
    'X-GatherCast-Frame-Captured-At': String(frame.capturedAt),
    'X-GatherCast-Frame-Source': frame.source || 'unknown',
    'X-GatherCast-Frame-Element': frame.element || '',
  });
  res.end(frame.body);
}

function writeAudienceChunkToViewers(buffer) {
  for (const viewer of [...relayState.viewers]) {
    try {
      viewer.res.write(buffer);
    } catch {
      relayState.viewers.delete(viewer);
    }
  }
}

async function receiveAudienceChunk(req, res, requestUrl) {
  requireHostKey(req);

  const sessionId = getAudienceSessionFromUrl(requestUrl);

  if (!hasActiveAudienceSession(sessionId)) {
    sendJson(res, 409, {
      error: 'No active relay audience session is available.',
    });
    return;
  }

  const body = await readRequestBody(
    req,
    RELAY_MAX_CHUNK_BYTES
  );

  if (body.length === 0) {
    sendJson(res, 200, {
      accepted: false,
      sequence: relayState.chunkSequence,
      viewerCount: relayState.viewers.size,
    });
    return;
  }

  relayState.chunkSequence += 1;
  relayState.bytesReceived += body.length;
  relayState.lastChunkAt = Date.now();

  if (!relayState.initChunk) {
    relayState.initChunk = body;
  }

  writeAudienceChunkToViewers(body);

  sendJson(res, 200, {
    accepted: true,
    sequence: relayState.chunkSequence,
    bytesReceived: relayState.bytesReceived,
    viewerCount: relayState.viewers.size,
  });
}

function serveAudienceStream(req, res, requestUrl) {
  const sessionId = getAudienceSessionFromUrl(requestUrl);

  if (!hasActiveAudienceSession(sessionId)) {
    sendJson(res, 404, {
      error: 'The audience relay broadcast is not live.',
    });
    return;
  }

  if (relayState.viewers.size >= RELAY_MAX_VIEWERS) {
    sendJson(res, 429, {
      error: 'The audience relay is full.',
    });
    return;
  }

  res.writeHead(200, {
    ...createCorsHeaders(),
    'Content-Type': relayState.mimeType,
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Content-Type-Options': 'nosniff',
  });

  const viewer = { res };
  relayState.viewers.add(viewer);

  if (relayState.initChunk) {
    try {
      res.write(relayState.initChunk);
    } catch {
      relayState.viewers.delete(viewer);
      return;
    }
  }

  req.on('close', () => {
    relayState.viewers.delete(viewer);
  });
}

async function serveAudienceAsset(res, fileName) {
  const filePath = path.resolve(publicDir, fileName);

  if (
    filePath !== publicDir &&
    !filePath.startsWith(publicDir + path.sep)
  ) {
    sendJson(res, 404, {
      error: 'Not found',
    });
    return;
  }

  const content = await fs.readFile(filePath);
  const extension = path.extname(filePath).toLowerCase();

  res.writeHead(200, {
    ...createCorsHeaders(),
    'Content-Type':
      mimeTypes[extension] ||
      'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(content);
}

async function handleRoute(req, res) {
  const requestUrl = new URL(
    req.url || '/',
    `http://127.0.0.1:${RELAY_PORT}`
  );
  const pathname = requestUrl.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, createCorsHeaders());
    res.end();
    return;
  }

  if (pathname === '/api/relay/health') {
    sendJson(res, 200, {
      ok: true,
      relay: true,
      active: relayState.active,
      viewerCount: relayState.viewers.size,
    });
    return;
  }

  if (pathname === '/watch') {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    await serveAudienceAsset(res, 'audience-view.html');
    return;
  }

  if (
    pathname === '/audience-view.html' ||
    pathname === '/audience-view.css' ||
    pathname === '/audience-view.js'
  ) {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    await serveAudienceAsset(
      res,
      pathname.replace(/^\/+/, '')
    );
    return;
  }

  if (pathname === '/api/relay/start') {
    requireHostKey(req);

    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    const body = await readJsonBody(req);
    sendJson(res, 200, startAudienceSession(req, body));
    return;
  }

  if (pathname === '/api/relay/chunk') {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    await receiveAudienceChunk(req, res, requestUrl);
    return;
  }

  if (
    pathname === '/api/relay/frame' ||
    pathname === '/api/audience/frame'
  ) {
    if (req.method === 'POST') {
      await receiveAudienceFrame(req, res, requestUrl);
      return;
    }

    if (req.method === 'GET') {
      serveAudienceFrame(req, res, requestUrl);
      return;
    }

    sendJson(res, 405, {
      error: 'Method not allowed',
    });
    return;
  }

  if (pathname === '/api/relay/stop') {
    requireHostKey(req);

    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    const body = await readJsonBody(req);
    const sessionId = String(body.sessionId || '').trim();
    sendJson(res, 200, stopAudienceSession(sessionId));
    return;
  }

  if (pathname === '/api/audience/status') {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    sendJson(
      res,
      200,
      getAudienceStatusPayload(
        getAudienceSessionFromUrl(requestUrl)
      )
    );
    return;
  }

  if (pathname === '/api/audience/messages') {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    sendJson(
      res,
      200,
      getAudienceMessagesPayload(
        getAudienceSessionFromUrl(requestUrl),
        requestUrl.searchParams.get('after')
      )
    );
    return;
  }

  if (pathname === '/api/audience/interactive') {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    sendJson(
      res,
      200,
      getAudienceInteractivePublicPayload(
        getAudienceSessionFromUrl(requestUrl),
        requestUrl.searchParams.get('participant'),
        requestUrl.searchParams.get('after')
      )
    );
    return;
  }

  if (pathname === '/api/relay/interactive/teacher') {
    requireHostKey(req);

    if (req.method !== 'GET') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    sendJson(
      res,
      200,
      getAudienceInteractiveTeacherPayload(
        getAudienceSessionFromUrl(requestUrl),
        requestUrl.searchParams.get('after')
      )
    );
    return;
  }

  if (pathname === '/api/audience/message') {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    await receiveAudienceMessage(req, res, requestUrl);
    return;
  }

  if (pathname === '/api/audience/interactive/raise-hand') {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    await receiveAudienceInteractiveRaiseHand(req, res, requestUrl);
    return;
  }

  if (pathname === '/api/audience/interactive/signal') {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    await receiveAudienceInteractiveSignal(req, res, requestUrl);
    return;
  }

  if (pathname === '/api/audience/interactive/leave') {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    await receiveAudienceInteractiveLeave(req, res, requestUrl);
    return;
  }

  if (pathname === '/api/relay/message') {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    await receiveTeacherAudienceMessage(req, res, requestUrl);
    return;
  }

  if (pathname === '/api/relay/interactive/action') {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    await receiveTeacherAudienceInteractiveAction(req, res, requestUrl);
    return;
  }

  if (pathname === '/api/relay/interactive/signal') {
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    await receiveTeacherAudienceInteractiveSignal(req, res, requestUrl);
    return;
  }

  if (pathname === '/api/audience/stream') {
    if (req.method !== 'GET') {
      sendJson(res, 405, {
        error: 'Method not allowed',
      });
      return;
    }

    serveAudienceStream(req, res, requestUrl);
    return;
  }

  sendJson(res, 404, {
    error: 'Not found',
  });
}

exitIfRelayIsUnsafe();

const server = http.createServer(async (req, res) => {
  try {
    await handleRoute(req, res);
  } catch (error) {
    sendJson(res, error?.statusCode || 500, {
      error:
        error?.statusCode && error.message
          ? error.message
          : 'The GatherCast Audience Relay could not complete the request.',
    });
  }
});

server.listen(RELAY_PORT, RELAY_HOST, () => {
  console.log(
    `GatherCast Audience Relay running on http://${RELAY_HOST}:${RELAY_PORT}`
  );

  if (RELAY_PUBLIC_URL) {
    console.log(
      `GatherCast Audience Relay public URL: ${RELAY_PUBLIC_URL}`
    );
  }
});
