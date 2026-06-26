const FIFA_KNOCKOUT_CALENDAR_URL = 'https://api.fifa.com/api/v3/calendar/matches?idCompetition=17&idSeason=285023&count=500&language=en';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'must-revalidate, max-age=0, s-maxage=60'
};

function json(statusCode, body) {
  return {statusCode, headers, body: JSON.stringify(body)};
}

export const handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(200, {ok: true});
  if (event.httpMethod !== 'GET') return json(405, {error: 'Method not allowed'});

  try {
    const response = await fetch(FIFA_KNOCKOUT_CALENDAR_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'mundialbros1906/1.0 (+https://github.com/ygf2703/mundialbros1906)'
      }
    });
    if (!response.ok) {
      return json(502, {error: `FIFA calendar unavailable: ${response.status}`});
    }
    const payload = await response.json();
    return json(200, payload);
  } catch (error) {
    console.error('FIFA knockout proxy failed', error);
    return json(502, {error: 'FIFA calendar unavailable'});
  }
};
