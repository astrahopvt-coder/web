const fs = require('fs/promises');

const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID;
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
const TWITCH_REFRESH_TOKEN = process.env.TWITCH_REFRESH_TOKEN;

// Login del canal (opcional). Si no se define, se detecta solo con el token de usuario.
const BROADCASTER_LOGIN = (process.env.BROADCASTER_LOGIN || '').trim();

// StreamElements (opcional pero recomendado): da el histórico EXACTO de meses
// acumulados y subs regaladas desde su Activity Feed.
// - SE_CHANNEL_ID: https://streamelements.com/dashboard/account/channels (público)
// - SE_JWT: mismo lugar (privado, va como secret)
const SE_CHANNEL_ID = (process.env.SE_CHANNEL_ID || '').trim();
const SE_JWT = (process.env.SE_JWT || '').trim();

// Equivalencia para el conteo: cada mes de suscripción y cada sub regalada valen 100 bits.
const BITS_PER_SUB = 100;

// Estado persistente para el modo fallback (sin StreamElements): estima meses.
const ESTADO_FILE = 'subs-state.json';

const DIA_MS = 24 * 3600 * 1000;
const DIAS_POR_MES = 30.44;
const DIAS_RESET_SUB = 90;

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

async function getBroadcaster(userAccessToken) {
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
  return { id: user.id, login: user.login.toLowerCase() };
}

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

// Subs activas del canal (para el modo fallback), paginado de 100 en 100.
async function getSubs(broadcasterId, userAccessToken) {
  const subs = [];
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
    subs.push(...(data.data || []));

    const cursor = data.pagination && data.pagination.cursor;
    if (!cursor || !(data.data || []).length || ++pages > 20) break;
    after = cursor;
  }

  return subs;
}

// ============================================================
// StreamElements: histórico exacto desde el Activity Feed
// ============================================================

// Descarga todas las actividades (subscriber + cheer) del feed de StreamElements.
// Usa v3 con paginación por cursor; tope de seguridad de 40 páginas x 500 eventos.
async function fetchSE(url, jwt, channelId) {
  const response = await fetch(url, { headers: { 'Authorization': `bearer ${jwt}` } });
  if (!response.ok) {
    const errText = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `StreamElements rechazó el JWT (${response.status}). Cópialo de nuevo de ` +
        `https://streamelements.com/dashboard/account/channels y actualiza el secret SE_JWT. ${errText.slice(0, 200)}`
      );
    }
    if (response.status === 404) {
      throw new Error(
        `StreamElements: channel id "${channelId}" no encontrado (404). DEBE ser el Account ID de ` +
        `https://streamelements.com/dashboard/account/channels (una cadena tipo 5f2de5dd9a474a2c2aaaaaaa), ` +
        `NO tu ID numérico de Twitch. Valor recibido empieza por: "${String(channelId).slice(0, 6)}..."`
      );
    }
    throw new Error(`Error en StreamElements activities: ${response.status} ${errText.slice(0, 300)}`);
  }
  return response.json();
}

// Pagina un endpoint de activities (v2 o v3) hasta agotar el cursor.
async function paginarSE(urlBase, jwt, channelId, maxPaginas = 40) {
  const actividades = [];
  let cursor = '';
  let paginas = 0;

  while (true) {
    const url = urlBase + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const data = await fetchSE(url, jwt, channelId);

    // La respuesta puede variar según versión: array directo, {docs}, {activities}, {items}
    const docs = Array.isArray(data)
      ? data
      : (data.docs || data.activities || data.items || []);
    actividades.push(...docs);

    if (paginas === 0 && docs.length > 0) {
      console.log(`   🔎 Primera página: ${docs.length} eventos. Tipos: ${[...new Set(docs.map(a => a.type))].join(', ')}.`);
    }

    // Cursor en distintas formas según versión de la API
    cursor = data.cursor || (data._links && data._links.next && data._links.next.cursor) || '';
    if (!cursor || !docs.length || ++paginas > maxPaginas) break;
  }

  return actividades;
}

// Prueba varias formas de consultar el feed y devuelve la primera con datos.
// El filtrado por tipo se hace localmente en procesarActividadesSE, así que la
// estrategia sin filtro de tipos es válida (y es la primera candidata, porque
// el filtro repetido 'types=' puede ser ignorado por v3).
async function getSEActivities(channelId, jwt) {
  const ahora = Date.now();
  const estrategias = [
    { nombre: 'v3 sin filtro de tipos', url: `https://api.streamelements.com/kappa/v3/activities/${channelId}?limit=500` },
    { nombre: 'v3 con types como array JSON', url: `https://api.streamelements.com/kappa/v3/activities/${channelId}?limit=500&types=${encodeURIComponent('["subscriber","cheer"]')}` },
    { nombre: 'v2 con rango de fechas completo', url: `https://api.streamelements.com/kappa/v2/activities/${channelId}?limit=500&after=0&before=${ahora}` }
  ];

  for (const est of estrategias) {
    try {
      const acts = await paginarSE(est.url, jwt, channelId);
      console.log(`   Estrategia "${est.nombre}": ${acts.length} evento(s).`);
      if (acts.length > 0) return acts;
    } catch (e) {
      console.warn(`   Estrategia "${est.nombre}" falló: ${e.message.slice(0, 160)}`);
      // JWT inválido o channel id equivocado no se arreglan cambiando de estrategia
      if (/JWT|channel id/.test(e.message)) throw e;
    }
  }

  return [];
}

// Procesa el feed de StreamElements y devuelve totales exactos por usuario:
// - bits: suma de todos los cheers históricos
// - meses: los meses acumulados REALES del último evento de cada suscriptor
// - regalos: total histórico de subs regaladas por gifter
// - avatares: último avatar visto en el feed (fallback si Twitch falla)
function procesarActividadesSE(actividades) {
  const bits = {};
  const meses = {};
  const regalos = {};
  const avatares = {};
  const nombres = {};
  const tipos = {};
  const muestras = [];

  const clave = s => (s || '').toLowerCase();

  for (const act of actividades) {
    const d = act.data || {};
    const username = d.username || d.displayName || '';
    tipos[act.type] = (tipos[act.type] || 0) + 1;

    if (act.type === 'subscriber' && muestras.length < 2) {
      // Para diagnosticar el formato real de los eventos en el log del workflow
      muestras.push(JSON.stringify({ type: act.type, data: { username: d.username, amount: d.amount, gifted: d.gifted, sender: d.sender } }));
    }

    if (act.type === 'cheer') {
      const k = clave(username);
      if (!k) continue;
      bits[k] = (bits[k] || 0) + (d.amount || 0);
      if (d.avatar) avatares[k] = d.avatar;
      nombres[k] = username;
    } else if (act.type === 'subscriber') {
      const k = clave(username);
      if (!k) continue;

      // Los meses acumulados reales vienen en data.amount (1 en sub nueva,
      // N en un resub de N meses). Nos quedamos con el mayor visto.
      const mesesEvento = d.amount || 1;
      meses[k] = Math.max(meses[k] || 0, mesesEvento);

      // Sub regalada: credita al sender/gifter. Los eventos individuales son la
      // fuente de verdad; communityGiftPurchase es solo el resumen y se ignora
      // para no duplicar.
      if (d.gifted && d.sender) {
        const gifter = clave(d.sender);
        if (gifter) regalos[gifter] = (regalos[gifter] || 0) + 1;
      }

      if (d.avatar) avatares[k] = d.avatar;
      nombres[k] = username;
    }
  }

  return { bits, meses, regalos, avatares, nombres, tipos, muestras };
}

// ============================================================
// Fallback sin StreamElements: estimación con estado persistente
// ============================================================

async function cargarEstado() {
  try {
    const raw = await fs.readFile(ESTADO_FILE, 'utf8');
    const estado = JSON.parse(raw);
    return { usuarios: estado.usuarios || {}, regalos: estado.regalos || {} };
  } catch {
    return { usuarios: {}, regalos: {} };
  }
}

async function guardarEstado(estado) {
  await fs.writeFile(ESTADO_FILE, JSON.stringify(estado, null, 2));
}

function procesarSubs(subsActuales, estadoPrevio, ahora = Date.now(), broadcasterLogin = '') {
  const estado = {
    usuarios: { ...estadoPrevio.usuarios },
    regalos: { ...estadoPrevio.regalos }
  };
  const broadcaster = (broadcasterLogin || '').toLowerCase();

  for (const sub of subsActuales) {
    const login = (sub.user_login || '').toLowerCase();
    if (!login) continue;

    const previo = estado.usuarios[login];
    const hueco = previo ? ahora - (previo.vistoUltimaVez || 0) : Infinity;
    const registro = previo && hueco <= DIAS_RESET_SUB * DIA_MS
      ? previo
      : { login, username: sub.user_name, desde: ahora, meses: 1, regaloCicloContado: -1 };

    // 'desde' acepta fecha ISO legible (p. ej. "2026-03-01") para sembrar a mano
    // el estado con meses reales de subs anteriores a este sistema.
    const inicio = typeof registro.desde === 'number' ? registro.desde : Date.parse(registro.desde);
    registro.desde = isNaN(inicio) ? ahora : inicio;

    registro.username = sub.user_name || registro.username;
    registro.tier = sub.tier || registro.tier;
    registro.vistoUltimaVez = ahora;

    const dias = (ahora - registro.desde) / DIA_MS;
    registro.meses = Math.max(1, Math.floor(dias / DIAS_POR_MES) + 1);
    const ciclo = Math.floor(dias / DIAS_POR_MES);

    const gifter = sub.is_gift && sub.gifter_login ? sub.gifter_login.toLowerCase() : '';
    if (gifter && gifter !== broadcaster && registro.regaloCicloContado !== ciclo) {
      registro.regaloCicloContado = ciclo;
      registro.gifterUltimo = gifter;
      estado.regalos[gifter] = (estado.regalos[gifter] || 0) + 1;
    } else if (!gifter) {
      registro.gifterUltimo = '';
    }

    estado.usuarios[login] = registro;
  }

  const porUsuario = new Map();
  for (const [login, r] of Object.entries(estado.usuarios)) {
    porUsuario.set(login, { username: r.username, meses: r.meses || 0 });
  }

  return { estado, porUsuario };
}

// ============================================================
// Ranking final
// ============================================================

function construirRanking({
  bitsTwitch = [],
  datosSE = null,
  porUsuarioEstimado = new Map(),
  porUsuarioFallback = new Map(),
  regalosFallback = {},
  broadcasterLogin = ''
} = {}) {
  const usuarios = new Map();

  const tocar = (login, username) => {
    const key = (login || '').toLowerCase();
    if (!key) return null;
    let u = usuarios.get(key);
    if (!u) {
      u = { login: key, username: username || key, bits: 0, meses: 0, regaladas: 0 };
      usuarios.set(key, u);
    }
    if (username) u.username = username;
    return u;
  };

  // Bits: el leaderboard de Twitch es autoritativo para el total de cada usuario.
  for (const b of bitsTwitch) {
    const u = tocar(b.user_login, b.user_name);
    if (u) u.bits = b.score;
  }

  const broadcaster = (broadcasterLogin || '').toLowerCase();

  if (datosSE) {
    // Modo exacto: meses y regalos desde el histórico de StreamElements.
    for (const [login, total] of Object.entries(datosSE.bits)) {
      const u = tocar(login, datosSE.nombres[login]);
      if (u) u.bits = Math.max(u.bits, total);
    }
    for (const [login, m] of Object.entries(datosSE.meses)) {
      const u = tocar(login, datosSE.nombres[login]);
      if (u) u.meses = m;
    }
    for (const [login, n] of Object.entries(datosSE.regalos)) {
      if (login === broadcaster) continue;
      const u = tocar(login, datosSE.nombres[login]);
      if (u) u.regaladas = n;
    }
    // Relleno: subs activas de Twitch sin eventos en el feed de SE (la sub
    // empezó antes de que SE registrara el canal). Su antigüedad se estima
    // con el estado; el mínimo garantizado es 1 mes (la sub existe hoy).
    for (const [login, info] of porUsuarioEstimado) {
      const u = tocar(login, info.username);
      if (u && u.meses === 0) u.meses = info.meses;
    }
  } else {
    // Fallback estimado
    for (const [login, info] of porUsuarioFallback) {
      const u = tocar(login, info.username);
      if (u) u.meses = info.meses;
    }
    for (const [login, n] of Object.entries(regalosFallback)) {
      if (login === broadcaster) continue;
      const u = tocar(login);
      if (u) u.regaladas = n;
    }
  }

  return [...usuarios.values()]
    .map(u => ({
      login: u.login,
      username: u.username,
      bits: u.bits,
      mesesSub: u.meses,
      regaladas: u.regaladas,
      subsEquivalentes: u.meses + u.regaladas,
      total_donated: u.bits + (u.meses + u.regaladas) * BITS_PER_SUB
    }))
    .sort((a, b) => b.total_donated - a.total_donated);
}

async function getTwitchAvatars(logins, appAccessToken) {
  if (logins.length === 0) return {};

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

async function fetchLeaderboard() {
  try {
    console.log('🔄 Refrescando token de usuario de Twitch...');
    const userAccessToken = await getUserAccessToken();

    console.log('🔄 Obteniendo Bits Leaderboard...');
    const bitsEntries = await getBitsLeaderboard(userAccessToken);

    const broadcaster = await getBroadcaster(userAccessToken);

    // ---- Modo exacto con StreamElements ----
    let datosSE = null;
    if (SE_CHANNEL_ID && SE_JWT) {
      console.log('🔄 Obteniendo histórico de StreamElements (activity feed)...');
      const actividades = await getSEActivities(SE_CHANNEL_ID, SE_JWT);
      console.log(`   ${actividades.length} eventos históricos (subs + cheers).`);
      datosSE = procesarActividadesSE(actividades);
      console.log(`   Desglose: ${Object.entries(datosSE.tipos).map(([t, n]) => `${t}=${n}`).join(', ') || 'SIN EVENTOS'}.`);
      datosSE.muestras.forEach(m => console.log(`   📋 Muestra: ${m}`));
      if (!datosSE.tipos.subscriber) {
        console.warn('   ⚠️ CERO eventos de suscripción en el feed. Verifica que:');
        console.warn('      1. SE_CHANNEL_ID es el Account ID de streamelements.com/dashboard/account/channels');
        console.warn('      2. El activity feed de tu canal (dashboard de SE) realmente muestra subs');
        console.warn('   Mientras tanto, las subs activas de Twitch se cuentan con antigüedad estimada (mínimo 1 mes).');
      }
    } else {
      console.log('ℹ️ SE_CHANNEL_ID/SE_JWT no configurados: usando estimación con subs-state.json');
    }

    // Subs activas de Twitch: en modo SE cubren a quienes tienen sub pagada
    // sin eventos en el feed (se suscribieron antes de usar SE); en modo
    // fallback son la base de la estimación.
    console.log('🔄 Obteniendo suscripciones activas...');
    const subsActuales = await getSubs(broadcaster.id, userAccessToken);
    const estadoPrevio = await cargarEstado();
    const resultado = procesarSubs(subsActuales, estadoPrevio, Date.now(), broadcaster.login);
    await guardarEstado(resultado.estado);

    // ---- Ranking ----
    let ranking;

    if (datosSE) {
      const sinHistorialSE = [...resultado.porUsuario.keys()].filter(l => !datosSE.meses[l]).length;
      if (sinHistorialSE > 0) {
        console.log(`ℹ️ ${sinHistorialSE} sub(s) activa(s) sin eventos en el feed de SE: se estima su antigüedad (mínimo 1 mes).`);
      }
      ranking = construirRanking({
        bitsTwitch: bitsEntries,
        datosSE,
        porUsuarioEstimado: resultado.porUsuario,
        broadcasterLogin: broadcaster.login
      });
    } else {
      ranking = construirRanking({
        bitsTwitch: bitsEntries,
        porUsuarioFallback: resultado.porUsuario,
        regalosFallback: resultado.estado.regalos,
        broadcasterLogin: broadcaster.login
      });
    }

    if (ranking.length === 0) {
      await fs.writeFile('donadores.json', JSON.stringify([], null, 2));
      console.log('✅ Sin bits ni subs, donadores.json actualizado (vacío).');
      return;
    }

    console.log('🔄 Consultando fotos de perfil en Twitch...');
    const appAccessToken = await getTwitchAppToken();
    const avatarMap = await getTwitchAvatars(ranking.map(d => d.login), appAccessToken);

    const leaderboardFinal = ranking.map(donator => {
      const twitchAvatar = avatarMap[donator.login];
      const seAvatar = datosSE ? datosSE.avatares[donator.login] : null;
      const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(donator.username)}&background=random&color=fff`;
      return {
        username: donator.username,
        avatar: twitchAvatar || seAvatar || fallbackAvatar,
        total_donated: donator.total_donated,
        bits: donator.bits,
        subs: {
          meses: donator.mesesSub,
          regaladas: donator.regaladas,
          equivalentes: donator.subsEquivalentes
        }
      };
    });

    await fs.writeFile('donadores.json', JSON.stringify(leaderboardFinal, null, 2));
    const totalMeses = leaderboardFinal.reduce((acc, d) => acc + d.subs.meses, 0);
    const totalRegaladas = leaderboardFinal.reduce((acc, d) => acc + d.subs.regaladas, 0);
    console.log(`✅ donadores.json generado: ${leaderboardFinal.length} personas.`);
    console.log(`   📅 ${totalMeses} meses de sub · 🎁 ${totalRegaladas} regaladas · 1 mes/regalo = ${BITS_PER_SUB} bits.`);
  } catch (error) {
    console.error('❌ Error en el proceso:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  fetchLeaderboard();
}

module.exports = { getSEActivities, procesarActividadesSE, procesarSubs, construirRanking, BITS_PER_SUB };
