const http = require('http');
const searchYoutube = require('./youtubeSearch');
const { getVideoDetails, getPlaylistDetails, getChannelDetails } = require('./youtubeResources');

const PORT = Number(process.env.PORT || 3053);
const HOST = process.env.HOST || '0.0.0.0';

const sendJson = (res, statusCode, data) => {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(JSON.stringify(data));
};

const parseBody = req =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', reject);
  });

const toNumberIfPresent = value => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const parseQueryParams = url => ({
  q: url.searchParams.get('q') || url.searchParams.get('query') || '',
  type: url.searchParams.get('type') || undefined,
  hl: url.searchParams.get('hl') || undefined,
  gl: url.searchParams.get('gl') || undefined,
  limit: toNumberIfPresent(url.searchParams.get('limit')),
});

const parseDetailOptions = url => ({
  hl: url.searchParams.get('hl') || undefined,
  gl: url.searchParams.get('gl') || undefined,
  limit: toNumberIfPresent(url.searchParams.get('limit')),
  relatedLimit: toNumberIfPresent(url.searchParams.get('relatedLimit')),
});

const parsePostParams = body => ({
  q: typeof body.q === 'string' ? body.q : typeof body.query === 'string' ? body.query : '',
  type: typeof body.type === 'string' ? body.type : undefined,
  hl: typeof body.hl === 'string' ? body.hl : undefined,
  gl: typeof body.gl === 'string' ? body.gl : undefined,
  limit: toNumberIfPresent(body.limit),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathParts = url.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    const input = parseQueryParams(url);
    if (!input.q) {
      sendJson(res, 400, { error: 'missing query: use ?q=...' });
      return;
    }

    try {
      const result = await searchYoutube(input.q, {
        type: input.type,
        hl: input.hl,
        gl: input.gl,
        limit: input.limit,
      });
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 502, { error: error.message || 'upstream error' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/search') {
    try {
      const body = await parseBody(req);
      const input = parsePostParams(body);
      if (!input.q) {
        sendJson(res, 400, { error: 'missing query: body.q or body.query required' });
        return;
      }

      const result = await searchYoutube(input.q, {
        type: input.type,
        hl: input.hl,
        gl: input.gl,
        limit: input.limit,
      });
      sendJson(res, 200, result);
    } catch (error) {
      if (error.message === 'invalid json body' || error.message === 'payload too large') {
        sendJson(res, 400, { error: error.message });
        return;
      }
      sendJson(res, 502, { error: error.message || 'upstream error' });
    }
    return;
  }

  if (req.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'video' && pathParts[2]) {
    try {
      const id = decodeURIComponent(pathParts.slice(2).join('/'));
      const result = await getVideoDetails(id, parseDetailOptions(url));
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 502, { error: error.message || 'upstream error' });
    }
    return;
  }

  if (req.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'playlist' && pathParts[2]) {
    try {
      const id = decodeURIComponent(pathParts.slice(2).join('/'));
      const result = await getPlaylistDetails(id, parseDetailOptions(url));
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 502, { error: error.message || 'upstream error' });
    }
    return;
  }

  if (req.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'channel' && pathParts[2]) {
    try {
      const id = decodeURIComponent(pathParts.slice(2).join('/'));
      const result = await getChannelDetails(id, parseDetailOptions(url));
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 502, { error: error.message || 'upstream error' });
    }
    return;
  }

  sendJson(res, 404, {
    error: 'not found',
    routes: {
      health: 'GET /health',
      search_get: 'GET /api/search?q=booba&type=video&limit=5',
      search_post: 'POST /api/search {"q":"booba","type":"video","limit":5}',
      video_get: 'GET /api/video/dQw4w9WgXcQ?relatedLimit=5',
      playlist_get: 'GET /api/playlist/PL...?...',
      channel_get: 'GET /api/channel/UC...?...',
    },
  });
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`API running on http://${HOST}:${PORT}`);
});
