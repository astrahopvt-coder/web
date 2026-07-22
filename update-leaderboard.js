const fs = require('fs');

const STREAMLABS_TOKEN = process.env.STREAMLABS_TOKEN;

async function fetchDonations() {
  try {
    // Pedimos las donaciones a la API de Streamlabs
    const response = await fetch(`https://streamlabs.com/api/v1.0/donations?access_token=${STREAMLABS_TOKEN}&currency=USD&limit=100`);
    const data = await response.json();

    if (!data.data) {
      throw new Error("No se pudieron obtener las donaciones. Revisa tu Token.");
    }

    // Process: Agrupar donaciones por usuario y calcular el acumulado total
    const totalsByUser = {};

    data.data.forEach(donation => {
      const name = donation.name.trim();
      const amount = parseFloat(donation.amount);

      if (!totalsByUser[name]) {
        totalsByUser[name] = {
          username: name,
          // Usamos un avatar por defecto o generado dinámicamente si no hay foto de perfil
          avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=random&color=fff`,
          total_donated: 0
        };
      }
      totalsByUser[name].total_donated += amount;
    });

    // Convertir a array, ordenar de mayor a menor y tomar el Top 10
    const leaderboard = Object.values(totalsByUser)
      .sort((a, b) => b.total_donated - a.total_donated)
      .slice(0, 10);

    // Guardar el resultado en donadores.json
    fs.writeFileSync('donadores.json', JSON.stringify(leaderboard, null, 2));
    console.log('✅ donadores.json actualizado con éxito.');

  } catch (error) {
    console.error('❌ Error en el proceso:', error);
    process.exit(1);
  }
}

fetchDonations();
