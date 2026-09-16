const fs = require('fs/promises');

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_REFRESH_TOKEN = process.env.TWITCH_REFRESH_TOKEN;

// Login del canal (opcional). Si no se define, se detecta solo con el token de usuario.
const BROADCASTER_LOGIN = (process.env.BROADCASTER_LOGIN || '').trim();

// Equivalencia para el conteo: cada sub activa vale 100 bits (independientemente del tier).
const BITS_PER_SUB = 100;

async function getUserAccessToken() {
  const url = `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=refresh_token&refresh_token=${encodeURIComponent(TWITCH_REFRESH_TOKEN)}`;
  const response = await fetch(url, { method: 'POST' });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Error refrescando token de Twitch: ${response.status} ${errText}`);
  }
  const data = await response.json();
  return data.access_token;
}

async function getTwitchAppToken() {
  const url = `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`;
  const response = await fetch(url, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Error autenticando con Twitch: ${response.statusText}`);
  }
  const data = await response.json();
  return data.access_token;
}

// Resuelve el ID del canal: el indicado en BROADCASTER_LOGIN o el dueño del token de usuario.
async function getBroadcasterId(userAccessToken) {
  const url = BROADCASTER_LOGIN
    ? `https://api.twitch.tv/helix/users?login=${encodeURIComponent(BROADCASTER_LOGIN)}`
    : 'https://api.twitch.tv/helix/users';
  const response = await fetch(url, {
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${userAccessToken}`
    }
  });
  if (!response.ok) {
    throw new Error(`Error resolviendo el canal: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const user = data.data && data.data[0];
  if (!user) {
    throw new Error(`No se encontró el canal${BROADCASTER_LOGIN ? ` "${BROADCASTER_LOGIN}"` : ' dueño del token'}.`);
  }
  console.log(`📺 Canal: ${user.display_name} (${user.id})`);
  return user.id;
}

// Bits Leaderboard completo (límite máximo permitido por Twitch: 100).
async function getBitsLeaderboard(userAccessToken) {
  const url = 'https://api.twitch.tv/helix/bits/leaderboard?period=all&count=100';
  const response = await fetch(url, {
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${userAccessToken}`
    }
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Error en Bits Leaderboard: ${response.status} ${errText}`);
  }
  const data = await response.json();
  return data.data || [];
}

// Subs activas del canal, paginado de 100 en 100. Devuelve Map user_login -> { username, count }.
async function getSubs(broadcasterId, userAccessToken) {
  const subsByUser = new Map();
  let after = '';
  let pages = 0;

  while (true) {
    const url = `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${broadcasterId}&first=100${after ? `&after=${after}` : ''}`;
    const response = await fetch(url, {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${userAccessToken}`
      }
    });
    if (!response.ok) {
      const errText = await response.text();
      if (response.status === 403) {
        throw new Error(
          `Error en Subscriptions (403): el token necesita el scope "channel:read:subscriptions". ` +
          `Regenera el refresh token con los scopes "bits:read channel:read:subscriptions" y actualiza el secret TWITCH_REFRESH_TOKEN. ${errText}`
        );
      }
      throw new Error(`Error en Subscriptions: ${response.status} ${errText}`);
    }

    const data = await response.json();
    for (const sub of data.data || []) {
      const login = sub.user_login.toLowerCase();
      const current = subsByUser.get(login);
      if (current) {
        current.count += 1;
      } else {
        subsByUser.set(login, { username: sub.user_name, count: 1 });
      }
    }

    const cursor = data.pagination && data.pagination.cursor;
    if (!cursor || !(data.data || []).length || ++pages > 20) break;
    after = cursor;
  }

  return subsByUser;
}

async function getTwitchAvatars(logins, appAccessToken) {
  if (logins.length === 0) return {};

  // Dividimos en bloques de 100 por seguridad en caso de que en el futuro consultes más datos
  const chunkSize = 100;
  const avatarMap = {};

  for (let i = 0; i < logins.length; i += chunkSize) {
    const chunk = logins.slice(i, i + chunkSize);
    const queryParams = chunk.map(name => `login=${encodeURIComponent(name.toLowerCase())}`).join('&');
    const url = `https://api.twitch.tv/helix/users?${queryParams}`;

    const response = await fetch(url, {
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Authorization': `Bearer ${appAccessToken}`
      }
    });

    if (!response.ok) {
      console.warn(`⚠️ No se pudieron obtener avatares de Twitch (${response.status}). Se usarán fallbacks.`);
      continue;
    }

    const data = await response.json();
    if (data.data) {
      data.data.forEach(user => {
        avatarMap[user.login.toLowerCase()] = user.profile_image_url;
      });
    }
  }

  return avatarMap;
}

// Fusiona bits + subs en el ranking final: total_donated = bits + subs × BITS_PER_SUB.
// El orden final es por total, de mayor a menor.
function buildLeaderboard(bitsEntries, subsEntries) {
  const totals = new Map();

  for (const entry of bitsEntries) {
    const login = entry.user_login.toLowerCase();
    totals.set(login, { login, username: entry.user_name, bits: entry.score, subs: 0 });
  }

  for (const [login, { username, count }] of subsEntries) {
    const existing = totals.get(login);
    if (existing) {
      existing.subs = count;
      if (username) existing.username = username;
    } else {
      totals.set(login, { login, username: username || login, bits: 0, subs: count });
    }
  }

  return [...totals.values()]
    .map(t => ({
      login: t.login,
      username: t.username,
      bits: t.bits,
      subs: t.subs,
      total_donated: t.bits + t.subs * BITS_PER_SUB
    }))
    .sort((a, b) => b.total_donated - a.total_donated);
}

async function fetchLeaderboard() {
  try {
    console.log('🔄 Refrescando token de usuario de Twitch...');
    const userAccessToken = await getUserAccessToken();

    console.log('🔄 Obteniendo Bits Leaderboard...');
    const bitsEntries = await getBitsLeaderboard(userAccessToken);

    console.log('🔄 Obteniendo suscripciones activas...');
    const broadcasterId = await getBroadcasterId(userAccessToken);
    const subsEntries = await getSubs(broadcasterId, userAccessToken);

    if (bitsEntries.length === 0 && subsEntries.size === 0) {
      await fs.writeFile('donadores.json', JSON.stringify([], null, 2));
      console.log('✅ Sin bits ni subs, donadores.json actualizado (vacío).');
      return;
    }

    console.log('🔄 Consultando fotos de perfil en Twitch...');
    const appAccessToken = await getTwitchAppToken();
    const ranking = buildLeaderboard(bitsEntries, subsEntries);
    const avatarMap = await getTwitchAvatars(ranking.map(d => d.login), appAccessToken);

    const leaderboardFinal = ranking.map(donator => {
      const twitchAvatar = avatarMap[donator.login];
      const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(donator.username)}&background=random&color=fff`;
      return {
        username: donator.username,
        avatar: twitchAvatar || fallbackAvatar,
        total_donated: donator.total_donated,
        bits: donator.bits,
        subs: donator.subs
      };
    });

    await fs.writeFile('donadores.json', JSON.stringify(leaderboardFinal, null, 2));
    const totalSubs = leaderboardFinal.reduce((acc, d) => acc + d.subs, 0);
    console.log(`✅ donadores.json generado: ${leaderboardFinal.length} personas, ${totalSubs} subs activas (cada sub = ${BITS_PER_SUB} bits).`);
  } catch (error) {
    console.error('❌ Error en el proceso:', error.message);
    process.exit(1);
  }
}

// Solo se ejecuta al correr el script directamente (node script.js), no al hacer require para tests.
if (require.main === module) {
  fetchLeaderboard();
}

module.exports = { buildLeaderboard, BITS_PER_SUB };
