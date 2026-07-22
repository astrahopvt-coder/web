const fs = require('fs/promises');

const STREAMLABS_TOKEN = process.env.STREAMLABS_TOKEN;
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;

// 1. Obtener Token de Twitch
async function getTwitchAppToken() {
  const url = `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`;
  const response = await fetch(url, { method: 'POST' });
  
  if (!response.ok) {
    throw new Error(`Error autenticando con Twitch: ${response.statusText}`);
  }
  
  const data = await response.json();
  return data.access_token;
}

// 2. Obtener Avatares de Twitch
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

// 3. Obtener TODAS las donaciones de Streamlabs (Paginación)
async function getAllStreamlabsDonations() {
  let allDonations = [];
  let beforeId = null;
  let hasMore = true;
  let page = 1;

  console.log('🔄 Iniciando descarga del historial completo de donaciones...');

  while (hasMore) {
    let url = `https://streamlabs.com/api/v1.0/donations?access_token=${STREAMLABS_TOKEN}&currency=USD&limit=100`;
    if (beforeId) {
      url += `&before=${beforeId}`;
    }

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Error en la página ${page} de Streamlabs: ${response.statusText}`);
    }

    const result = await response.json();
    const donations = result.data || [];

    if (donations.length === 0) {
      hasMore = false;
    } else {
      allDonations = allDonations.concat(donations);
      // El último elemento devuelto define el punto de inicio para la siguiente página
      beforeId = donations[donations.length - 1].donation_id;
      console.log(`   📄 Página ${page} procesada (${donations.length} donaciones obtenidas. Total acumulado: ${allDonations.length})`);
      page++;
    }
  }

  console.log(`✅ ¡Descarga completada! Total de donaciones históricas: ${allDonations.length}`);
  return allDonations;
}

// 4. Función Principal
async function fetchDonationsAndAvatars() {
  try {
    // Descargar todas las donaciones acumuladas
    const allDonations = await getAllStreamlabsDonations();

    // Agrupar acumulados por usuario (case-insensitive)
    const totalsByUser = {};
    allDonations.forEach(donation => {
      const originalName = donation.name.trim();
      const key = originalName.toLowerCase();
      const amount = parseFloat(donation.amount) || 0;

      if (!totalsByUser[key]) {
        totalsByUser[key] = {
          username: originalName,
          total_donated: 0
        };
      }
      totalsByUser[key].total_donated += amount;
    });

    // Ordenar Top 10 y corregir precisión decimal
    const topDonators = Object.values(totalsByUser)
      .sort((a, b) => b.total_donated - a.total_donated)
      .slice(0, 10)
      .map(d => ({
        ...d,
        total_donated: Math.round(d.total_donated * 100) / 100
      }));

    // Obtener fotos de perfil en Twitch para el Top 10
    console.log('🔄 Consultando fotos de perfil en Twitch...');
    const twitchAccessToken = await getTwitchAppToken();
    const usernames = topDonators.map(d => d.username);
    const avatarMap = await getTwitchAvatars(usernames, twitchAccessToken);

    // Mapear resultado con avatares o fallbacks
    const leaderboardFinal = topDonators.map(donator => {
      const twitchAvatar = avatarMap[donator.username.toLowerCase()];
      const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(donator.username)}&background=random&color=fff`;

      return {
        username: donator.username,
        avatar: twitchAvatar || fallbackAvatar,
        total_donated: donator.total_donated
      };
    });

    // Guardar el JSON final
    await fs.writeFile('donadores.json', JSON.stringify(leaderboardFinal, null, 2));
    console.log('✅ donadores.json generado exitosamente con la información histórica.');

  } catch (error) {
    console.error('❌ Error en el proceso:', error.message);
    process.exit(1);
  }
}

fetchDonationsAndAvatars();
