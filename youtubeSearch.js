const { request } = require('undici');

const YT_RESULTS_URL = 'https://www.youtube.com/results';
const DEFAULT_OPTIONS = {
  limit: 10,
  type: 'video',
  hl: 'fr',
  gl: 'FR',
};
const VALID_TYPES = new Set(['video', 'playlist', 'channel', 'all']);

const parseText = value => {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value.runs)) return value.runs.map(x => x.text || '').join('');
  return '';
};

const parseCount = value => {
  const text = parseText(value);
  const digits = text.replace(/[^\d]/g, '');
  return digits ? Number(digits) : null;
};

const normalizeThumbs = thumbObj => {
  const thumbs = Array.isArray(thumbObj && thumbObj.thumbnails) ? [...thumbObj.thumbnails] : [];
  thumbs.sort((a, b) => (b.width || 0) - (a.width || 0));
  return thumbs.map(t => ({
    url: t.url || null,
    width: t.width || null,
    height: t.height || null,
  }));
};

const extractJsonObject = (html, marker) => {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return null;

  const start = html.indexOf('{', markerIndex + marker.length);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        try {
          return JSON.parse(raw);
        } catch (_) {
          return null;
        }
      }
    }
  }

  return null;
};

const extractInitialData = html =>
  extractJsonObject(html, 'var ytInitialData = ') ||
  extractJsonObject(html, 'window["ytInitialData"] = ') ||
  extractJsonObject(html, 'ytInitialData = ');

const walk = (node, fn) => {
  if (!node || typeof node !== 'object') return;
  fn(node);
  if (Array.isArray(node)) {
    for (const value of node) walk(value, fn);
    return;
  }
  for (const value of Object.values(node)) walk(value, fn);
};

const collectByRendererKey = (root, rendererKey) => {
  const out = [];
  walk(root, node => {
    if (Object.prototype.hasOwnProperty.call(node, rendererKey)) out.push(node[rendererKey]);
  });
  return out;
};

const parseVideo = renderer => {
  const ownerRun = renderer.ownerText && Array.isArray(renderer.ownerText.runs) ? renderer.ownerText.runs[0] : null;
  const ownerEndpoint = ownerRun && ownerRun.navigationEndpoint;
  const ownerUrl =
    (ownerEndpoint &&
      ownerEndpoint.browseEndpoint &&
      ownerEndpoint.browseEndpoint.canonicalBaseUrl) ||
    (ownerEndpoint &&
      ownerEndpoint.commandMetadata &&
      ownerEndpoint.commandMetadata.webCommandMetadata &&
      ownerEndpoint.commandMetadata.webCommandMetadata.url) ||
    null;

  const badges = Array.isArray(renderer.badges)
    ? renderer.badges.map(x => x.metadataBadgeRenderer && x.metadataBadgeRenderer.label).filter(Boolean)
    : [];

  return {
    type: 'video',
    id: renderer.videoId || null,
    title: parseText(renderer.title),
    url: renderer.videoId ? `https://www.youtube.com/watch?v=${renderer.videoId}` : null,
    channel: ownerRun
      ? {
          name: ownerRun.text || null,
          id:
            ownerEndpoint &&
            ownerEndpoint.browseEndpoint &&
            ownerEndpoint.browseEndpoint.browseId
              ? ownerEndpoint.browseEndpoint.browseId
              : null,
          url: ownerUrl ? new URL(ownerUrl, 'https://www.youtube.com').toString() : null,
        }
      : null,
    description: parseText(renderer.descriptionSnippet),
    duration: parseText(renderer.lengthText),
    views: parseCount(renderer.viewCountText),
    publishedAt: parseText(renderer.publishedTimeText),
    isLive: badges.some(x => x.toUpperCase().includes('LIVE')),
    thumbnails: normalizeThumbs(renderer.thumbnail),
  };
};

const parsePlaylist = renderer => {
  const bylineRun = renderer.shortBylineText && Array.isArray(renderer.shortBylineText.runs)
    ? renderer.shortBylineText.runs[0]
    : null;

  return {
    type: 'playlist',
    id: renderer.playlistId || null,
    title: parseText(renderer.title),
    url: renderer.playlistId ? `https://www.youtube.com/playlist?list=${renderer.playlistId}` : null,
    channel: bylineRun
      ? {
          name: bylineRun.text || null,
          id:
            bylineRun.navigationEndpoint &&
            bylineRun.navigationEndpoint.browseEndpoint &&
            bylineRun.navigationEndpoint.browseEndpoint.browseId
              ? bylineRun.navigationEndpoint.browseEndpoint.browseId
              : null,
        }
      : null,
    videoCount: parseCount(renderer.videoCountText || renderer.videoCount),
    thumbnails: normalizeThumbs(renderer.thumbnails && renderer.thumbnails[0]),
  };
};

const parseChannel = renderer => ({
  type: 'channel',
  id: renderer.channelId || null,
  title: parseText(renderer.title),
  url: renderer.channelId ? `https://www.youtube.com/channel/${renderer.channelId}` : null,
  description: parseText(renderer.descriptionSnippet),
  subscribers: parseText(renderer.subscriberCountText),
  videoCount: parseCount(renderer.videoCountText),
  thumbnails: normalizeThumbs(renderer.thumbnail),
});

const dedupe = items => {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = `${item.type}:${item.id || item.url || item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};

module.exports = async (query, options = {}) => {
  if (!query || typeof query !== 'string') {
    throw new Error('query must be a non-empty string');
  }

  const opts = Object.assign({}, DEFAULT_OPTIONS, options);
  opts.limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Number(opts.limit) : DEFAULT_OPTIONS.limit;
  opts.type = VALID_TYPES.has(opts.type) ? opts.type : DEFAULT_OPTIONS.type;

  const params = new URLSearchParams({
    search_query: query,
    hl: String(opts.hl || DEFAULT_OPTIONS.hl),
    gl: String(opts.gl || DEFAULT_OPTIONS.gl),
  });

  const res = await request(`${YT_RESULTS_URL}?${params.toString()}`, {
    headers: {
      cookie: 'SOCS=CAI',
      'accept-language': `${opts.hl},en;q=0.9`,
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    },
  });

  if (res.statusCode !== 200) {
    throw new Error(`youtube returned status ${res.statusCode}`);
  }

  const html = await res.body.text();
  const initialData = extractInitialData(html);
  if (!initialData) throw new Error('unable to parse ytInitialData');

  const parsed = [];
  if (opts.type === 'video' || opts.type === 'all') {
    parsed.push(...collectByRendererKey(initialData, 'videoRenderer').map(parseVideo));
    parsed.push(...collectByRendererKey(initialData, 'gridVideoRenderer').map(parseVideo));
  }
  if (opts.type === 'playlist' || opts.type === 'all') {
    parsed.push(...collectByRendererKey(initialData, 'playlistRenderer').map(parsePlaylist));
  }
  if (opts.type === 'channel' || opts.type === 'all') {
    parsed.push(...collectByRendererKey(initialData, 'channelRenderer').map(parseChannel));
  }

  const items = dedupe(parsed).filter(item => item.id || item.url).slice(0, opts.limit);

  return {
    query,
    estimatedResults: Number(initialData.estimatedResults) || null,
    items,
  };
};
