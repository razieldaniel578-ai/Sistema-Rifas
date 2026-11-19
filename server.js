const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MercadoPagoConfig, Order } = require('mercadopago');

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

// Ruta para crear orden de pago en Mercado Pago (API Orders)
app.post('/api/crear-pago', async (req, res) => {
  const { rifaId, tituloRifa, numeroBoleto, precio } = req.body;

  const accessToken = process.env.MP_ACCESS_TOKEN;

  if (!accessToken) {
    return res.status(400).json({
      error: 'Falta configurar MP_ACCESS_TOKEN en las variables de entorno del servidor.'
    });
  }

  const montoNumerico = Number(precio);
  if (!Number.isFinite(montoNumerico) || montoNumerico <= 0) {
    return res.status(400).json({
      error: 'El precio del boleto no es válido.'
    });
  }

  const montoFormateado = montoNumerico.toFixed(2);

  try {
    const client = new MercadoPagoConfig({
      accessToken,
      options: {
        idempotencyKey: crypto.randomUUID()
      }
    });

    const order = new Order(client);

    const resultado = await order.create({
      body: {
        type: 'online',
        processing_mode: 'manual',
        total_amount: montoFormateado,
        external_reference: `${rifaId || 'rifa'}-boleto-${numeroBoleto}`,
        items: [
          {
            title: `${tituloRifa || 'Rifa'} - Boleto #${numeroBoleto}`,
            quantity: 1,
            unit_price: montoFormateado
          }
        ]
      }
    });

    const checkoutUrl = resultado.checkout_url;

    res.json({
      id: resultado.id,
      checkout_url: checkoutUrl,
      init_point: checkoutUrl
    });
  } catch (error) {
    console.error('Error al crear orden en Mercado Pago:', error);
    res.status(500).json({
      error: 'Error al conectar con Mercado Pago'
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
