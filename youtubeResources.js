const { request } = require('undici');

const YT_BASE_URL = 'https://www.youtube.com';
const DEFAULT_LOCALE = { hl: 'fr', gl: 'FR' };

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

const extractInitialPlayerResponse = html =>
  extractJsonObject(html, 'var ytInitialPlayerResponse = ') ||
  extractJsonObject(html, 'window["ytInitialPlayerResponse"] = ') ||
  extractJsonObject(html, 'ytInitialPlayerResponse = ');

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

const dedupe = (items, keyFn) => {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
};

const buildWatchUrl = (videoId, opts) => {
  const params = new URLSearchParams({
    v: videoId,
    hl: String(opts.hl || DEFAULT_LOCALE.hl),
    gl: String(opts.gl || DEFAULT_LOCALE.gl),
  });
  return `${YT_BASE_URL}/watch?${params.toString()}`;
};

const buildPlaylistUrl = (listId, opts) => {
  const params = new URLSearchParams({
    list: listId,
    hl: String(opts.hl || DEFAULT_LOCALE.hl),
    gl: String(opts.gl || DEFAULT_LOCALE.gl),
  });
  return `${YT_BASE_URL}/playlist?${params.toString()}`;
};

const buildChannelUrl = (channelIdOrHandle, opts) => {
  const raw = String(channelIdOrHandle || '').trim();
  if (!raw) throw new Error('channel id/handle is required');

  let basePath = '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    const parsed = new URL(raw);
    basePath = parsed.pathname;
  } else if (raw.startsWith('@')) {
    basePath = `/${raw}`;
  } else if (raw.startsWith('UC')) {
    basePath = `/channel/${raw}`;
  } else {
    basePath = `/${raw}`;
  }

  if (!basePath.endsWith('/videos')) basePath = `${basePath.replace(/\/+$/, '')}/videos`;

  const params = new URLSearchParams({
    hl: String(opts.hl || DEFAULT_LOCALE.hl),
    gl: String(opts.gl || DEFAULT_LOCALE.gl),
  });
  return `${YT_BASE_URL}${basePath}?${params.toString()}`;
};

const fetchHtml = async url => {
  const res = await request(url, {
    headers: {
      cookie: 'SOCS=CAI',
      'accept-language': 'fr,en;q=0.9',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
    },
  });

  if (res.statusCode !== 200) {
    throw new Error(`youtube returned status ${res.statusCode}`);
  }
  return res.body.text();
};

const parseVideoCard = renderer => {
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

  return {
    id: renderer.videoId || null,
    title: parseText(renderer.title),
    url: renderer.videoId ? `${YT_BASE_URL}/watch?v=${renderer.videoId}` : null,
    channel: ownerRun
      ? {
          name: ownerRun.text || null,
          id:
            ownerEndpoint &&
            ownerEndpoint.browseEndpoint &&
            ownerEndpoint.browseEndpoint.browseId
              ? ownerEndpoint.browseEndpoint.browseId
              : null,
          url: ownerUrl ? new URL(ownerUrl, YT_BASE_URL).toString() : null,
        }
      : null,
    description: parseText(renderer.descriptionSnippet),
    duration: parseText(renderer.lengthText),
    views: parseCount(renderer.viewCountText),
    publishedAt: parseText(renderer.publishedTimeText),
    thumbnails: normalizeThumbs(renderer.thumbnail),
  };
};

const parseCompactVideo = renderer => ({
  id: renderer.videoId || null,
  title: parseText(renderer.title),
  url: renderer.videoId ? `${YT_BASE_URL}/watch?v=${renderer.videoId}` : null,
  channel: renderer.shortBylineText && Array.isArray(renderer.shortBylineText.runs)
    ? {
        name: renderer.shortBylineText.runs[0].text || null,
        id:
          renderer.shortBylineText.runs[0].navigationEndpoint &&
          renderer.shortBylineText.runs[0].navigationEndpoint.browseEndpoint
            ? renderer.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId || null
            : null,
      }
    : null,
  duration: parseText(renderer.lengthText),
  views: parseCount(renderer.viewCountText),
  publishedAt: parseText(renderer.publishedTimeText),
  thumbnails: normalizeThumbs(renderer.thumbnail),
});

const parsePlaylistItem = renderer => {
  const bylineRun = renderer.shortBylineText && Array.isArray(renderer.shortBylineText.runs)
    ? renderer.shortBylineText.runs[0]
    : null;
  return {
    id: renderer.videoId || null,
    title: parseText(renderer.title),
    url: renderer.videoId ? `${YT_BASE_URL}/watch?v=${renderer.videoId}` : null,
    index: parseText(renderer.index),
    duration: parseText(renderer.lengthText),
    channel: bylineRun
      ? {
          name: bylineRun.text || null,
          id:
            bylineRun.navigationEndpoint &&
            bylineRun.navigationEndpoint.browseEndpoint
              ? bylineRun.navigationEndpoint.browseEndpoint.browseId || null
              : null,
        }
      : null,
    thumbnails: normalizeThumbs(renderer.thumbnail),
  };
};

const parseCaptionTracks = playerResponse => {
  const tracks =
    playerResponse &&
    playerResponse.captions &&
    playerResponse.captions.playerCaptionsTracklistRenderer &&
    Array.isArray(playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks)
      ? playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
      : [];

  return tracks.map(track => ({
    languageCode: track.languageCode || null,
    name: track.name ? parseText(track.name) : null,
    kind: track.kind || null,
    isAutoGenerated: track.kind === 'asr',
    url: track.baseUrl || null,
  }));
};

exports.getVideoDetails = async (videoId, options = {}) => {
  if (!videoId || typeof videoId !== 'string') throw new Error('video id is required');

  const opts = Object.assign({}, DEFAULT_LOCALE, options);
  const html = await fetchHtml(buildWatchUrl(videoId, opts));
  const initialData = extractInitialData(html);
  const playerResponse = extractInitialPlayerResponse(html);

  if (!playerResponse) throw new Error('unable to parse ytInitialPlayerResponse');

  const details = playerResponse.videoDetails || {};
  const micro = (playerResponse.microformat && playerResponse.microformat.playerMicroformatRenderer) || {};
  const relatedLimit = Number.isFinite(Number(opts.relatedLimit)) && Number(opts.relatedLimit) > 0 ? Number(opts.relatedLimit) : 10;

  const relatedRaw = initialData ? collectByRendererKey(initialData, 'compactVideoRenderer') : [];
  const related = dedupe(relatedRaw.map(parseCompactVideo), item => item.id || item.url).slice(0, relatedLimit);

  return {
    type: 'video',
    id: details.videoId || videoId,
    title: details.title || null,
    url: details.videoId ? `${YT_BASE_URL}/watch?v=${details.videoId}` : `${YT_BASE_URL}/watch?v=${videoId}`,
    description: details.shortDescription || null,
    channel: {
      id: details.channelId || null,
      name: details.author || null,
      url: details.channelId ? `${YT_BASE_URL}/channel/${details.channelId}` : null,
    },
    durationSeconds: details.lengthSeconds ? Number(details.lengthSeconds) : null,
    viewCount: details.viewCount ? Number(details.viewCount) : null,
    isLive: !!details.isLiveContent,
    keywords: Array.isArray(details.keywords) ? details.keywords : [],
    thumbnails: normalizeThumbs(details.thumbnail),
    publishDate: micro.publishDate || null,
    uploadDate: micro.uploadDate || null,
    category: micro.category || null,
    captions: parseCaptionTracks(playerResponse),
    related,
  };
};

exports.getPlaylistDetails = async (listId, options = {}) => {
  if (!listId || typeof listId !== 'string') throw new Error('playlist id is required');

  const opts = Object.assign({}, DEFAULT_LOCALE, options);
  const html = await fetchHtml(buildPlaylistUrl(listId, opts));
  const initialData = extractInitialData(html);
  if (!initialData) throw new Error('unable to parse ytInitialData');

  const metadata = (initialData.metadata && initialData.metadata.playlistMetadataRenderer) || {};
  const primaryInfo = collectByRendererKey(initialData, 'playlistSidebarPrimaryInfoRenderer')[0] || {};
  const secondaryInfo = collectByRendererKey(initialData, 'playlistSidebarSecondaryInfoRenderer')[0] || {};
  const ownerRun =
    secondaryInfo.videoOwner &&
    secondaryInfo.videoOwner.videoOwnerRenderer &&
    secondaryInfo.videoOwner.videoOwnerRenderer.title &&
    Array.isArray(secondaryInfo.videoOwner.videoOwnerRenderer.title.runs)
      ? secondaryInfo.videoOwner.videoOwnerRenderer.title.runs[0]
      : null;

  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Number(opts.limit) : 100;
  const videos = dedupe(
    collectByRendererKey(initialData, 'playlistVideoRenderer').map(parsePlaylistItem),
    item => item.id || item.url,
  ).slice(0, limit);

  const continuation = collectByRendererKey(initialData, 'continuationItemRenderer')[0];
  const continuationToken =
    continuation &&
    continuation.continuationEndpoint &&
    continuation.continuationEndpoint.continuationCommand
      ? continuation.continuationEndpoint.continuationCommand.token || null
      : null;

  return {
    type: 'playlist',
    id: listId,
    title: metadata.title || null,
    url: `${YT_BASE_URL}/playlist?list=${listId}`,
    description: metadata.description || null,
    channel: ownerRun
      ? {
          name: ownerRun.text || null,
          id:
            ownerRun.navigationEndpoint &&
            ownerRun.navigationEndpoint.browseEndpoint
              ? ownerRun.navigationEndpoint.browseEndpoint.browseId || null
              : null,
        }
      : null,
    stats: Array.isArray(primaryInfo.stats) ? primaryInfo.stats.map(parseText).filter(Boolean) : [],
    videoCount: videos.length,
    videos,
    continuationToken,
  };
};

exports.getChannelDetails = async (channelIdOrHandle, options = {}) => {
  if (!channelIdOrHandle || typeof channelIdOrHandle !== 'string') {
    throw new Error('channel id/handle is required');
  }

  const opts = Object.assign({}, DEFAULT_LOCALE, options);
  const html = await fetchHtml(buildChannelUrl(channelIdOrHandle, opts));
  const initialData = extractInitialData(html);
  if (!initialData) throw new Error('unable to parse ytInitialData');

  const metadata = (initialData.metadata && initialData.metadata.channelMetadataRenderer) || {};
  const header = collectByRendererKey(initialData, 'c4TabbedHeaderRenderer')[0] || {};
  const limit = Number.isFinite(Number(opts.limit)) && Number(opts.limit) > 0 ? Number(opts.limit) : 30;

  const videos = dedupe(
    collectByRendererKey(initialData, 'videoRenderer').map(parseVideoCard),
    item => item.id || item.url,
  ).slice(0, limit);

  return {
    type: 'channel',
    id: metadata.externalId || null,
    title: metadata.title || parseText(header.title) || null,
    handle: metadata.vanityChannelUrl ? metadata.vanityChannelUrl.replace(`${YT_BASE_URL}/`, '') : null,
    url: metadata.channelUrl || null,
    description: metadata.description || null,
    avatars: normalizeThumbs(metadata.avatar),
    subscribers: parseText(header.subscriberCountText),
    videosCount: parseCount(header.videosCountText),
    videos,
  };
};
