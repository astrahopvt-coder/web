const fs = require('fs/promises');

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_REFRESH_TOKEN = process.env.TWITCH_REFRESH_TOKEN;

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

async function getBitsLeaderboard(userAccessToken) {
  const url = `https://api.twitch.tv/helix/bits/leaderboard?period=all&count=10`;
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

async function getTwitchAvatars(usernames, appAccessToken) {
  if (usernames.length === 0) return {};
  const queryParams = usernames.map(name => `login=${encodeURIComponent(name.toLowerCase())}`).join('&');
  const url = `https://api.twitch.tv/helix/users?${queryParams}`;
  const response = await fetch(url, {
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${appAccessToken}`
    }
  });
  if (!response.ok) {
    console.warn(`⚠️ No se pudieron obtener avatares de Twitch (${response.status}). Se usarán fallbacks.`);
    return {};
  }
  const data = await response.json();
  const avatarMap = {};
  if (data.data) {
    data.data.forEach(user => {
      avatarMap[user.login.toLowerCase()] = user.profile_image_url;
    });
  }
  return avatarMap;
}

async function fetchBitsLeaderboard() {
  try {
    console.log('🔄 Refrescando token de usuario de Twitch...');
    const userAccessToken = await getUserAccessToken();

    console.log('🔄 Obteniendo Bits Leaderboard...');
    const leaderboard = await getBitsLeaderboard(userAccessToken);

    if (leaderboard.length === 0) {
      await fs.writeFile('donadores.json', JSON.stringify([], null, 2));
      console.log('✅ Leaderboard vacío, donadores.json actualizado.');
      return;
    }

    console.log('🔄 Consultando fotos de perfil en Twitch...');
    const appAccessToken = await getTwitchAppToken();
    const usernames = leaderboard.map(d => d.user_name);
    const avatarMap = await getTwitchAvatars(usernames, appAccessToken);

    const leaderboardFinal = leaderboard.map(donator => {
      const twitchAvatar = avatarMap[donator.user_name.toLowerCase()];
      const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(donator.user_name)}&background=random&color=fff`;
      return {
        username: donator.user_name,
        avatar: twitchAvatar || fallbackAvatar,
        total_donated: donator.score
      };
    });

    await fs.writeFile('donadores.json', JSON.stringify(leaderboardFinal, null, 2));
    console.log('✅ donadores.json generado exitosamente con el Bits Leaderboard.');
  } catch (error) {
    console.error('❌ Error en el proceso:', error.message);
    process.exit(1);
  }
}

fetchBitsLeaderboard();
