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
const RELAY_MAX_VIEWERS = Number(
  process.env.GATHERCAST_RELAY_MAX_VIEWERS || 200
);

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
  bytesReceived: 0,
  viewers: new Set(),
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
      'Content-Type, X-GatherCast-Host-Key',
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
    bytesReceived: sessionMatches ? relayState.bytesReceived : 0,
    viewerCount: sessionMatches ? relayState.viewers.size : 0,
    relay: true,
  };
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
  relayState.bytesReceived = 0;

  return {
    sessionId: relayState.sessionId,
    title: relayState.title,
    mimeType: relayState.mimeType,
    audienceUrl: getAudienceUrl(req, relayState.sessionId),
    relay: true,
  };
}

function stopAudienceSession(sessionId) {
  if (
    relayState.active &&
    (!sessionId || sessionId === relayState.sessionId)
  ) {
    relayState.active = false;
    relayState.endedAt = Date.now();
    closeAudienceViewers();
  }

  return {
    active: false,
    phase: 'stopped',
    relay: true,
  };
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
