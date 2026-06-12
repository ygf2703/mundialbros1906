import { connectLambda, getStore } from '@netlify/blobs';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};
const scoreFields = ['totalScore', 'exactCount', 'outcomeCount', 'bonusScore'];

function json(statusCode, body) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
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

function normalizePhone(value) {
  return cleanText(value).replace(/[^\d+]/g, '');
}

function phoneVariants(value) {
  const phone = normalizePhone(value);
  const digits = phone.replace(/\D/g, '');
  const variants = new Set();
  if (phone) variants.add(phone);
  if (digits) variants.add(digits);

  let local = '';
  if (digits.startsWith('972') && digits.length >= 11) local = '0' + digits.slice(3);
  else if (digits.startsWith('0')) local = digits;
  else if (digits.startsWith('5') && digits.length === 9) local = '0' + digits;

  if (local) {
    variants.add(local);
    if (local.startsWith('0')) {
      variants.add('972' + local.slice(1));
      variants.add('+972' + local.slice(1));
    }
  }
  return [...variants].filter(Boolean);
}

function phonesMatch(a, b) {
  const aVariants = phoneVariants(a);
  const bVariants = new Set(phoneVariants(b));
  return aVariants.length > 0 && aVariants.some(v => bVariants.has(v));
}

function sanitizeUser(user) {
  const now = Date.now();
  return {
    id: cleanText(user.id) || `u${Math.random().toString(36).slice(2, 9)}`,
    fullName: cleanText(user.fullName || user.displayName),
    displayName: cleanText(user.displayName || user.fullName),
    teamName: cleanText(user.teamName),
    email: normalizeEmail(user.email),
    phone: cleanText(user.phone),
    passwordHash: user.passwordHash || null,
    passwordSetAt: user.passwordSetAt || null,
    totalScore: Number(user.totalScore || 0),
    exactCount: Number(user.exactCount || 0),
    outcomeCount: Number(user.outcomeCount || 0),
    bonusScore: Number(user.bonusScore || 0),
    createdAt: Number(user.createdAt || now)
  };
}

function sameUser(a, b) {
  const aEmail = normalizeEmail(a.email);
  const bEmail = normalizeEmail(b.email);
  return (aEmail && bEmail && aEmail === bEmail) || phonesMatch(a.phone, b.phone) || (a.id && b.id && a.id === b.id);
}

function mergeUsers(users) {
  const merged = [];
  users.forEach(user => {
    const normalized = sanitizeUser(user);
    if (!normalized.email && !normalized.phone) return;
    const idx = merged.findIndex(existing => sameUser(existing, normalized));
    if (idx === -1) {
      merged.push(normalized);
    } else {
      merged[idx] = sanitizeUser({...merged[idx], ...normalized});
    }
  });
  return merged;
}

function mergeUserRecord(existing, incoming, {preserveExistingScores=false}={}) {
  const normalizedExisting = sanitizeUser(existing);
  const normalizedIncoming = sanitizeUser(incoming);
  const merged = sanitizeUser({...normalizedExisting, ...normalizedIncoming});
  if (!normalizedIncoming.passwordHash && normalizedExisting.passwordHash) merged.passwordHash = normalizedExisting.passwordHash;
  if (!normalizedIncoming.passwordSetAt && normalizedExisting.passwordSetAt) merged.passwordSetAt = normalizedExisting.passwordSetAt;
  if (preserveExistingScores) {
    scoreFields.forEach(field => {
      merged[field] = Number(normalizedExisting[field] || 0);
    });
  }
  return merged;
}

function mergeUsersPreservingExistingScores(existingUsers, incomingUsers) {
  const merged = mergeUsers(existingUsers);
  incomingUsers.forEach(user => {
    const normalized = sanitizeUser(user);
    if (!normalized.email && !normalized.phone) return;
    const idx = merged.findIndex(existing => sameUser(existing, normalized));
    if (idx === -1) {
      merged.push(normalized);
    } else {
      merged[idx] = mergeUserRecord(merged[idx], normalized, {preserveExistingScores: true});
    }
  });
  return merged;
}

export const handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(200, {ok: true});

  try {
    connectLambda(event);
    const store = getStore('mundial-users');

    if (event.httpMethod === 'GET') {
      const users = await store.get('users', {type: 'json'});
      return json(200, {users: Array.isArray(users) ? users : []});
    }

    if (event.httpMethod === 'POST') {
      const payload = JSON.parse(event.body || '{}');
      const incomingUsers = Array.isArray(payload.users) ? payload.users : [];
      const existingUsers = payload.replace ? [] : (await store.get('users', {type: 'json'}));
      const users = payload.replace
        ? mergeUsers(incomingUsers)
        : mergeUsersPreservingExistingScores(Array.isArray(existingUsers) ? existingUsers : [], incomingUsers);
      await store.setJSON('users', users);
      return json(200, {ok: true, count: users.length});
    }

    return json(405, {error: 'Method not allowed'});
  } catch (error) {
    console.error('Users function failed', error);
    return json(500, {error: 'Users storage unavailable'});
  }
};
