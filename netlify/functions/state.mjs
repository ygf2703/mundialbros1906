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
  dailyBonusActuals: {},
  specialsLocked: false
};
const LOCK_MINUTES = 30;
const MATCH_TIMEZONE_OFFSET_MINUTES = 180; // Israel daylight time during the tournament.

const NOAM_ARGENTINA_FIX = {
  email: 'noamfrostig@gmail.com',
  homeTeam: 'ארגנטינה',
  awayTeam: 'אלג׳יריה',
  fallbackAwayTeam: 'אלג\'יריה',
  matchId: 'match_19',
  predictedHomeScore: 2,
  predictedAwayScore: 0
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

function normalizeEmail(value) {
  return cleanText(value).replace(/\s+/g, '').toLowerCase();
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
  ['dailyBonus','dailyBonusTimes','dailyBonusScores'].forEach(key => {
    if (normalized[key] && (typeof normalized[key] !== 'object' || Array.isArray(normalized[key]))) delete normalized[key];
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
    dailyBonusActuals: sanitizeDailyBonusActuals(source.dailyBonusActuals),
    specialsLocked: !!source.specialsLocked
  };
}

function sanitizeDailyBonusActuals(actuals={}) {
  return Object.fromEntries(
    Object.entries(objectOrEmpty(actuals))
      .map(([id, actual]) => {
        if (actual && typeof actual === 'object' && !Array.isArray(actual)) {
          const source = objectOrEmpty(actual);
          const value = cleanText(source.value);
          if (!value) return null;
          return [id, {
            ...source,
            value,
            updatedAt: Number(source.updatedAt || 0),
            scoredAt: Number(source.scoredAt || 0)
          }];
        }
        const value = cleanText(actual);
        return value ? [id, {value, updatedAt: 0, scoredAt: 0}] : null;
      })
      .filter(Boolean)
  );
}

function latestTime(record) {
  return Math.max(
    Number(record?.updatedAt || 0),
    Number(record?.submittedAt || 0),
    Number(record?.scoredAt || 0),
    Number(record?.createdAt || 0)
  );
}

function predictionEditTime(record) {
  return Math.max(
    Number(record?.updatedAt || 0),
    Number(record?.submittedAt || 0),
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

function predictionKey(pred) {
  return pred?.userId && pred?.matchId ? `${pred.userId}:${pred.matchId}` : pred?.id;
}

function predictionPickChanged(base={}, incoming={}) {
  const fields = ['predictedHomeScore','predictedAwayScore','predictedOutcome','predictedAdvancingTeam'];
  return fields.some(field => (base?.[field] ?? null) !== (incoming?.[field] ?? null));
}

function parseMatchStartFromFields(match) {
  if (!match?.date || !match?.time) return null;
  const dateMatch = String(match.date).match(/(\d{1,2})\D+(\d{1,2})/);
  const timeMatch = String(match.time).match(/(\d{1,2}):(\d{1,2})/);
  if (!dateMatch || !timeMatch) return null;
  const day = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  if (![day, month, hour, minute].every(Number.isFinite)) return null;
  const ts = Date.UTC(2026, month - 1, day, hour, minute) - (MATCH_TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  return Number.isFinite(ts) ? ts : null;
}

function getMatchStartTimestamp(match) {
  const raw = Number(match?.startsAt);
  if (raw === Infinity) return Infinity;
  if (Number.isFinite(raw) && raw > 0) return raw;
  return parseMatchStartFromFields(match);
}

function matchLockTime(match) {
  const startsAt = getMatchStartTimestamp(match);
  if (startsAt === Infinity) return Infinity;
  if (!startsAt) return -Infinity;
  return startsAt - (LOCK_MINUTES * 60 * 1000);
}

function predictionIsBeforeMatchLock(pred, match) {
  return predictionEditTime(pred) <= matchLockTime(match);
}

function mergePredictions(existing=[], incoming=[], matches=[]) {
  const matchesById = new Map((matches || []).filter(m => m?.id).map(m => [m.id, m]));
  const map = new Map();
  [...existing, ...incoming].forEach(pred => {
    const key = predictionKey(pred);
    if (!key) return;
    const previous = map.get(key);
    const match = matchesById.get(pred.matchId);
    const locked = match ? Date.now() >= matchLockTime(match) : false;

    if (locked) {
      if (!previous) {
        if (predictionIsBeforeMatchLock(pred, match)) map.set(key, {...pred});
        return;
      }
      if (predictionPickChanged(previous, pred) && !predictionIsBeforeMatchLock(pred, match)) return;
    }

    if (!previous || latestTime(pred) >= latestTime(previous)) {
      map.set(key, {...previous, ...pred});
    }
  });
  return [...map.values()];
}

function hasResult(match) {
  return match?.actualHomeScore !== null && match?.actualHomeScore !== undefined
    || match?.actualAwayScore !== null && match?.actualAwayScore !== undefined
    || !!match?.actualWinner
    || !!match?.advancingTeam
    || !!match?.winnerId
    || match?.status === 'finished'
    || match?.status === 'scored';
}

function mergeMatch(base, incoming) {
  const merged = {...base, ...incoming};
  if (hasResult(base) && !hasResult(incoming)) {
    ['actualHomeScore','actualAwayScore','actualWinner','advancingTeam','winnerId','scoredAt','status'].forEach(key => {
      merged[key] = base[key];
    });
  }
  if (hasResult(base) && hasResult(incoming) && latestTime(base) >= latestTime(incoming)) {
    ['actualHomeScore','actualAwayScore','actualWinner','advancingTeam','winnerId','scoredAt','status'].forEach(key => {
      merged[key] = base[key];
    });
  }
  if (latestTime(base) >= latestTime(incoming)) {
    ['homeTeam','awayTeam','homeTeamSource','awayTeamSource','homeSourceMatchId','awaySourceMatchId','bracketPosition','isPlaceholder'].forEach(key => {
      if (key in base) merged[key] = base[key];
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
    merged[userId] = mergeSpecialRecord(merged[userId], pred);
  });
  return normalizeSpecials(merged);
}

function hasSpecialValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function specialTimeKey(key) {
  return key === 'topScorer' ? 'topScorerTime' : `${key}_time`;
}

function isSpecialTimeKey(key) {
  return key === 'topScorerTime' || key.endsWith('_time');
}

function mergeTimedSpecialFields(base={}, next={}) {
  const merged = {};
  const ignored = new Set(['dailyBonus','dailyBonusTimes','dailyBonusScores']);
  const keys = new Set([...Object.keys(base), ...Object.keys(next)]
    .filter(key => !ignored.has(key) && !isSpecialTimeKey(key)));

  keys.forEach(key => {
    const timeKey = specialTimeKey(key);
    const baseHas = hasSpecialValue(base[key]);
    const nextHas = hasSpecialValue(next[key]);
    if (!baseHas && !nextHas) return;

    const baseTime = Number(base[timeKey] || 0);
    const nextTime = Number(next[timeKey] || 0);
    const useNext = nextHas && (!baseHas || nextTime >= baseTime);
    const source = useNext ? next : base;
    const selectedTime = Number(source[timeKey] || 0) || Math.max(baseTime, nextTime);
    merged[key] = source[key];
    if (selectedTime) merged[timeKey] = selectedTime;
  });

  return merged;
}

function mergeDailyBonusPredictions(base={}, next={}) {
  const baseAnswers = objectOrEmpty(base.dailyBonus);
  const nextAnswers = objectOrEmpty(next.dailyBonus);
  const baseTimes = objectOrEmpty(base.dailyBonusTimes);
  const nextTimes = objectOrEmpty(next.dailyBonusTimes);
  const answers = {};
  const times = {};

  new Set([...Object.keys(baseAnswers), ...Object.keys(nextAnswers), ...Object.keys(baseTimes), ...Object.keys(nextTimes)]).forEach(questionId => {
    const baseHas = hasSpecialValue(baseAnswers[questionId]);
    const nextHas = hasSpecialValue(nextAnswers[questionId]);
    if (!baseHas && !nextHas) return;

    const baseTime = Number(baseTimes[questionId] || 0);
    const nextTime = Number(nextTimes[questionId] || 0);
    const useNext = nextHas && (!baseHas || nextTime >= baseTime);
    answers[questionId] = useNext ? nextAnswers[questionId] : baseAnswers[questionId];
    times[questionId] = (useNext ? nextTime : baseTime) || Math.max(baseTime, nextTime);
  });

  return {answers, times};
}

function mergeDailyBonusScores(base={}, next={}) {
  const baseScores = objectOrEmpty(base.dailyBonusScores);
  const nextScores = objectOrEmpty(next.dailyBonusScores);
  const scores = {};
  new Set([...Object.keys(baseScores), ...Object.keys(nextScores)]).forEach(questionId => {
    const baseScore = baseScores[questionId];
    const nextScore = nextScores[questionId];
    if (nextScore === undefined) {
      scores[questionId] = baseScore;
      return;
    }
    if (baseScore === undefined) {
      scores[questionId] = nextScore;
      return;
    }
    const baseTime = latestTime(objectOrEmpty(baseScore));
    const nextTime = latestTime(objectOrEmpty(nextScore));
    scores[questionId] = nextTime >= baseTime ? nextScore : baseScore;
  });
  return scores;
}

function mergeSpecialRecord(existing={}, incoming={}) {
  const base = normalizeSpecialPredictionKeys(existing);
  const next = normalizeSpecialPredictionKeys(incoming);
  const merged = mergeTimedSpecialFields(base, next);
  const daily = mergeDailyBonusPredictions(base, next);
  const scores = mergeDailyBonusScores(base, next);
  if (Object.keys(daily.answers).length) merged.dailyBonus = daily.answers;
  if (Object.keys(daily.times).length) merged.dailyBonusTimes = daily.times;
  if (Object.keys(scores).length) merged.dailyBonusScores = scores;
  return normalizeSpecialPredictionKeys(merged);
}

function mergeDailyBonusActuals(existing={}, incoming={}) {
  const merged = {...sanitizeDailyBonusActuals(existing)};
  Object.entries(sanitizeDailyBonusActuals(incoming)).forEach(([id, actual]) => {
    const previous = merged[id];
    if (!previous || latestTime(actual) >= latestTime(previous)) merged[id] = actual;
  });
  return merged;
}

function mergeState(existingState, incomingState, replace=false) {
  const existing = sanitizeState(existingState || defaults);
  const incoming = sanitizeState(incomingState || {});
  if (replace) return incoming;
  const matches = mergeMatches(existing.matches, incoming.matches);
  const knockoutMatches = mergeMatches(existing.knockoutMatches, incoming.knockoutMatches);
  return {
    predictions: mergePredictions(existing.predictions, incoming.predictions, matches),
    knockoutPredictions: mergePredictions(existing.knockoutPredictions, incoming.knockoutPredictions, knockoutMatches),
    specialPredictions: mergeSpecials(existing.specialPredictions, incoming.specialPredictions),
    matches,
    knockoutMatches,
    actualGroupWinners: {...existing.actualGroupWinners, ...incoming.actualGroupWinners},
    actualTopScorer: incoming.actualTopScorer || existing.actualTopScorer,
    actualChampion: incoming.actualChampion || existing.actualChampion,
    dailyBonusActuals: mergeDailyBonusActuals(existing.dailyBonusActuals, incoming.dailyBonusActuals),
    specialsLocked: existing.specialsLocked || incoming.specialsLocked
  };
}

function scoreOutcome(home, away) {
  if (home > away) return 'home';
  if (away > home) return 'away';
  return 'draw';
}

function sameTeamName(a, b) {
  return cleanText(a).replace(/׳/g, "'") === cleanText(b).replace(/׳/g, "'");
}

async function applyNoamArgentinaPredictionFix(state, userStore) {
  const safeState = sanitizeState(state || defaults);
  const users = await userStore.get('users', {type: 'json'});
  const user = Array.isArray(users)
    ? users.find(u => normalizeEmail(u?.email) === NOAM_ARGENTINA_FIX.email)
    : null;
  if (!user?.id) return {state: safeState, changed: false, reason: 'user_not_found'};

  const match = safeState.matches.find(m => m?.id === NOAM_ARGENTINA_FIX.matchId)
    || safeState.matches.find(m => sameTeamName(m?.homeTeam, NOAM_ARGENTINA_FIX.homeTeam)
      && (sameTeamName(m?.awayTeam, NOAM_ARGENTINA_FIX.awayTeam) || sameTeamName(m?.awayTeam, NOAM_ARGENTINA_FIX.fallbackAwayTeam)));
  if (!match?.id) return {state: safeState, changed: false, reason: 'match_not_found'};

  const fixedSubmittedAt = Math.max(1, matchLockTime(match) - 60 * 1000);
  const existing = safeState.predictions.find(p => p?.userId === user.id && p?.matchId === match.id);
  const patch = {
    id: existing?.id || `manual_noam_${match.id}`,
    userId: user.id,
    matchId: match.id,
    predictedHomeScore: NOAM_ARGENTINA_FIX.predictedHomeScore,
    predictedAwayScore: NOAM_ARGENTINA_FIX.predictedAwayScore,
    predictedOutcome: scoreOutcome(NOAM_ARGENTINA_FIX.predictedHomeScore, NOAM_ARGENTINA_FIX.predictedAwayScore),
    predictedAdvancingTeam: existing?.predictedAdvancingTeam || null,
    scoreAwarded: existing?.scoreAwarded || 0,
    isExact: !!existing?.isExact,
    isOutcomeCorrect: !!existing?.isOutcomeCorrect,
    submittedAt: fixedSubmittedAt,
    updatedAt: fixedSubmittedAt,
    lockedAt: existing?.lockedAt || null,
    manualFix: 'noam_argentina_2026_06_17'
  };

  if (existing
    && existing.predictedHomeScore === patch.predictedHomeScore
    && existing.predictedAwayScore === patch.predictedAwayScore
    && existing.predictedOutcome === patch.predictedOutcome) {
    return {state: safeState, changed: false, reason: 'already_set'};
  }

  safeState.predictions = existing
    ? safeState.predictions.map(pred => pred === existing ? {...existing, ...patch} : pred)
    : [...safeState.predictions, patch];

  return {state: safeState, changed: true, reason: 'applied'};
}

export const handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(200, {ok: true});

  try {
    connectLambda(event);
    const store = getStore('mundial-state');
    const userStore = getStore('mundial-users');

    if (event.httpMethod === 'GET') {
      const state = await store.get('state', {type: 'json'});
      const fixed = await applyNoamArgentinaPredictionFix(state || defaults, userStore);
      if (fixed.changed) await store.setJSON('state', fixed.state);
      return json(200, {state: fixed.state, manualFix: fixed.reason});
    }

    if (event.httpMethod === 'POST') {
      const payload = JSON.parse(event.body || '{}');
      const existing = payload.replace ? defaults : (await store.get('state', {type: 'json'}));
      const state = mergeState(existing, payload.state, !!payload.replace);
      const fixed = await applyNoamArgentinaPredictionFix(state, userStore);
      await store.setJSON('state', fixed.state);
      return json(200, {ok: true, state: fixed.state, manualFix: fixed.reason});
    }

    return json(405, {error: 'Method not allowed'});
  } catch (error) {
    console.error('State function failed', error);
    return json(500, {error: 'State storage unavailable'});
  }
};