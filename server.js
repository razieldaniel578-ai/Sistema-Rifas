const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ARCHIVO_VENDIDOS = path.join(__dirname, 'vendidos.json');

// Cargar boletos vendidos desde archivo JSON
function leerVendidos() {
  try {
    if (!fs.existsSync(ARCHIVO_VENDIDOS)) {
      fs.writeFileSync(ARCHIVO_VENDIDOS, JSON.stringify({}, null, 2));
      return {};
    }
    const raw = fs.readFileSync(ARCHIVO_VENDIDOS, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('Error leyendo vendidos.json:', err);
    return {};
  }
}

function guardarVendidos(data) {
  fs.writeFileSync(ARCHIVO_VENDIDOS, JSON.stringify(data, null, 2));
}

// Ruta para obtener boletos vendidos de una rifa
app.get('/api/vendidos/:rifaId', (req, res) => {
  const { rifaId } = req.params;
  const datos = leerVendidos();
  const lista = Array.isArray(datos[rifaId]) ? datos[rifaId] : [];
  res.json(lista);
});

// Ruta para crear preferencia de pago en Mercado Pago
app.post('/api/crear-pago', async (req, res) => {
  const { rifaId, tituloRifa, numeroBoleto, precio } = req.body;

  const accessToken = process.env.MP_ACCESS_TOKEN || 'TU_ACCESS_TOKEN_AQUI';

  if (!accessToken || accessToken === 'TU_ACCESS_TOKEN_AQUI') {
    return res.status(400).json({
      error: 'Falta configurar tu Access Token real de Mercado Pago en el servidor.'
    });
  }

  try {
    const client = new MercadoPagoConfig({ accessToken });
    const preference = new Preference(client);

    const resultado = await preference.create({
      body: {
        items: [
          {
            title: `${tituloRifa} - Boleto #${numeroBoleto}`,
            quantity: 1,
            unit_price: Number(precio),
            currency_id: 'MXN'
          }
        ],
        metadata: {
          rifaId,
          numeroBoleto
        }
      }
    });

    res.json({
      id: resultado.id,
      init_point: resultado.init_point
    });
  } catch (error) {
    console.error('Error al crear preferencia en Mercado Pago:', error);
    res.status(500).json({
      error: 'Error al conectar con Mercado Pago'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});