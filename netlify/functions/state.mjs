import { connectLambda, getStore } from '@netlify/blobs';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};

const defaults = {
  predictions: [],
  knockoutPredictions: [],
  specialPredictions: {},
  matches: [],
  knockoutMatches: [],
  actualGroupWinners: {},
  actualTopScorer: '',
  actualChampion: '',
  specialsLocked: false
};

function json(statusCode, body) {
  return {statusCode, headers, body: JSON.stringify(body)};
}

function cleanText(value) {
  return (value || '')
    .toString()
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .trim();
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeSpecialPredictionKeys(pred={}) {
  const normalized = {...objectOrEmpty(pred)};
  const aliases = {
    pred_tournament_winner: 'tournament_winner',
    pred_tournament_winner_time: 'tournament_winner_time',
    pred_sf1_winner: 'sf1_winner',
    pred_sf1_winner_time: 'sf1_winner_time',
    pred_sf2_winner: 'sf2_winner',
    pred_sf2_winner_time: 'sf2_winner_time'
  };
  Object.entries(aliases).forEach(([from, to]) => {
    if (normalized[from] && !normalized[to]) normalized[to] = normalized[from];
  });
  return normalized;
}

function normalizeSpecials(specials={}) {
  return Object.fromEntries(
    Object.entries(objectOrEmpty(specials)).map(([userId, pred]) => [userId, normalizeSpecialPredictionKeys(pred)])
  );
}

function sanitizeState(input) {
  const source = objectOrEmpty(input);
  return {
    predictions: Array.isArray(source.predictions) ? source.predictions.filter(Boolean) : [],
    knockoutPredictions: Array.isArray(source.knockoutPredictions) ? source.knockoutPredictions.filter(Boolean) : [],
    specialPredictions: normalizeSpecials(source.specialPredictions),
    matches: Array.isArray(source.matches) ? source.matches.filter(m => m && m.id) : [],
    knockoutMatches: Array.isArray(source.knockoutMatches) ? source.knockoutMatches.filter(m => m && m.id) : [],
    actualGroupWinners: objectOrEmpty(source.actualGroupWinners),
    actualTopScorer: cleanText(source.actualTopScorer),
    actualChampion: cleanText(source.actualChampion),
    specialsLocked: !!source.specialsLocked
  };
}

function latestTime(record) {
  return Math.max(
    Number(record?.updatedAt || 0),
    Number(record?.submittedAt || 0),
    Number(record?.scoredAt || 0),
    Number(record?.createdAt || 0)
  );
}

function mergeByKey(existing, incoming, keyFn) {
  const map = new Map();
  [...existing, ...incoming].forEach(item => {
    const key = keyFn(item);
    if (!key) return;
    const previous = map.get(key);
    if (!previous || latestTime(item) >= latestTime(previous)) {
      map.set(key, {...previous, ...item});
    }
  });
  return [...map.values()];
}

function hasResult(match) {
  return match?.actualHomeScore !== null && match?.actualHomeScore !== undefined
    || match?.actualAwayScore !== null && match?.actualAwayScore !== undefined
    || !!match?.actualWinner
    || !!match?.advancingTeam
    || match?.status === 'finished'
    || match?.status === 'scored';
}

function mergeMatch(base, incoming) {
  const merged = {...base, ...incoming};
  if (hasResult(base) && !hasResult(incoming)) {
    ['actualHomeScore','actualAwayScore','actualWinner','advancingTeam','scoredAt','status'].forEach(key => {
      merged[key] = base[key];
    });
  }
  if (hasResult(base) && hasResult(incoming) && latestTime(base) >= latestTime(incoming)) {
    ['actualHomeScore','actualAwayScore','actualWinner','advancingTeam','scoredAt','status'].forEach(key => {
      merged[key] = base[key];
    });
  }
  return merged;
}

function mergeMatches(existing, incoming) {
  const map = new Map();
  [...existing, ...incoming].forEach(match => {
    if (!match?.id) return;
    const previous = map.get(match.id);
    map.set(match.id, previous ? mergeMatch(previous, match) : {...match});
  });
  return [...map.values()];
}

function mergeSpecials(existing, incoming) {
  const merged = {...existing};
  Object.entries(incoming || {}).forEach(([userId, pred]) => {
    merged[userId] = normalizeSpecialPredictionKeys({
      ...normalizeSpecialPredictionKeys(merged[userId]),
      ...normalizeSpecialPredictionKeys(pred)
    });
  });
  return normalizeSpecials(merged);
}

function mergeState(existingState, incomingState, replace=false) {
  const existing = sanitizeState(existingState || defaults);
  const incoming = sanitizeState(incomingState || {});
  if (replace) return incoming;
  return {
    predictions: mergeByKey(existing.predictions, incoming.predictions, p => p?.userId && p?.matchId ? `${p.userId}:${p.matchId}` : p?.id),
    knockoutPredictions: mergeByKey(existing.knockoutPredictions, incoming.knockoutPredictions, p => p?.userId && p?.matchId ? `${p.userId}:${p.matchId}` : p?.id),
    specialPredictions: mergeSpecials(existing.specialPredictions, incoming.specialPredictions),
    matches: mergeMatches(existing.matches, incoming.matches),
    knockoutMatches: mergeMatches(existing.knockoutMatches, incoming.knockoutMatches),
    actualGroupWinners: {...existing.actualGroupWinners, ...incoming.actualGroupWinners},
    actualTopScorer: incoming.actualTopScorer || existing.actualTopScorer,
    actualChampion: incoming.actualChampion || existing.actualChampion,
    specialsLocked: existing.specialsLocked || incoming.specialsLocked
  };
}

export const handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(200, {ok: true});

  try {
    connectLambda(event);
    const store = getStore('mundial-state');

    if (event.httpMethod === 'GET') {
      const state = await store.get('state', {type: 'json'});
      return json(200, {state: sanitizeState(state || defaults)});
    }

    if (event.httpMethod === 'POST') {
      const payload = JSON.parse(event.body || '{}');
      const existing = payload.replace ? defaults : (await store.get('state', {type: 'json'}));
      const state = mergeState(existing, payload.state, !!payload.replace);
      await store.setJSON('state', state);
      return json(200, {ok: true, state});
    }

    return json(405, {error: 'Method not allowed'});
  } catch (error) {
    console.error('State function failed', error);
    return json(500, {error: 'State storage unavailable'});
  }
};
