const fs = require('fs');

const STREAMLABS_TOKEN = process.env.STREAMLABS_TOKEN;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

// 1. Obtener el Token de Acceso temporal de Twitch (App Access Token)
async function getTwitchAppToken() {
  const url = `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`;
  const response = await fetch(url, { method: 'POST' });
  const data = await response.json();
  
  if (!data.access_token) {
    throw new Error('No se pudo obtener el token de acceso de Twitch.');
  }
  return data.access_token;
}

// 2. Obtener los avatares reales desde la API de Twitch
async function getTwitchAvatars(usernames, appAccessToken) {
  if (usernames.length === 0) return {};

  // Formateamos la consulta: ?login=user1&login=user2...
  const queryParams = usernames.map(name => `login=${encodeURIComponent(name.toLowerCase())}`).join('&');
  const url = `https://api.twitch.tv/helix/users?${queryParams}`;

  const response = await fetch(url, {
    headers: {
      'Client-ID': TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${appAccessToken}`
    }
  });

  const data = await response.json();
  const avatarMap = {};

  if (data.data) {
    data.data.forEach(user => {
      // Guardamos la relación: nombre_en_minusculas -> url_avatar
      avatarMap[user.login.toLowerCase()] = user.profile_image_url;
    });
  }

  return avatarMap;
}

// 3. Función principal
async function fetchDonationsAndAvatars() {
  try {
    console.log('🔄 Obteniendo donaciones de Streamlabs...');
    const streamlabsRes = await fetch(`https://streamlabs.com/api/v1.0/donations?access_token=${STREAMLABS_TOKEN}&currency=USD&limit=100`);
    const streamlabsData = await streamlabsRes.json();

    if (!streamlabsData.data) {
      throw new Error("No se pudieron obtener las donaciones de Streamlabs.");
    }

    // Agrupar acumulados por usuario
    const totalsByUser = {};
    streamlabsData.data.forEach(donation => {
      const name = donation.name.trim();
      const amount = parseFloat(donation.amount);

      if (!totalsByUser[name]) {
        totalsByUser[name] = {
          username: name,
          total_donated: 0
        };
      }
      totalsByUser[name].total_donated += amount;
    });

    // Ordenar Top 10
    const topDonators = Object.values(totalsByUser)
      .sort((a, b) => b.total_donated - a.total_donated)
      .slice(0, 10);

    // Obtener las fotos de perfil de Twitch
    console.log('🔄 Consultando la API de Twitch para fotos de perfil...');
    const twitchAccessToken = await getTwitchAppToken();
    const usernames = topDonators.map(d => d.username);
    const avatarMap = await getTwitchAvatars(usernames, twitchAccessToken);

    // Asignar el avatar de Twitch (o un fallback si el usuario no existe en Twitch)
    const leaderboardFinal = topDonators.map(donator => {
      const twitchAvatar = avatarMap[donator.username.toLowerCase()];
      const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(donator.username)}&background=random&color=fff`;

      return {
        username: donator.username,
        avatar: twitchAvatar || fallbackAvatar, // Si no tiene cuenta en Twitch, usa el fallback
        total_donated: donator.total_donated
      };
    });

    // Guardar el archivo JSON
    fs.writeFileSync('donadores.json', JSON.stringify(leaderboardFinal, null, 2));
    console.log('✅ donadores.json generado correctamente con fotos de perfil de Twitch.');

  } catch (error) {
    console.error('❌ Error en el proceso:', error);
    process.exit(1);
  }
}

fetchDonationsAndAvatars();
