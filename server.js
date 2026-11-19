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
const ARCHIVO_REGISTROS = path.join(__dirname, 'registros_compras.json');

// Configuración de rifas y límites máximos por compra en el servidor
const CONFIG_RIFAS = {
  rifa_whisky: {
    titulo: 'Gran Rifa: Combo Whisky Especial',
    precioUnitario: 10,
    totalNumeros: 10,
    maxPorCompra: 5
  },
  rifa_tequila: {
    titulo: 'Rifa Express: Tequila & Botana',
    precioUnitario: 15,
    totalNumeros: 50,
    maxPorCompra: 2
  },
  rifa_efectivo: {
    titulo: 'Gran Rifa en Efectivo ($1,000 MXN)',
    precioUnitario: 20,
    totalNumeros: 100,
    maxPorCompra: 10
  }
};

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

// Cargar / guardar registro de compradores y órdenes
function leerRegistros() {
  try {
    if (!fs.existsSync(ARCHIVO_REGISTROS)) {
      fs.writeFileSync(ARCHIVO_REGISTROS, JSON.stringify([], null, 2));
      return [];
    }
    const raw = fs.readFileSync(ARCHIVO_REGISTROS, 'utf8');
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Error leyendo registros_compras.json:', err);
    return [];
  }
}

function guardarRegistroCompra(registro) {
  const registros = leerRegistros();
  registros.push(registro);
  fs.writeFileSync(ARCHIVO_REGISTROS, JSON.stringify(registros, null, 2));
}

// Ruta para obtener boletos vendidos de una rifa
app.get('/api/vendidos/:rifaId', (req, res) => {
  const { rifaId } = req.params;
  const datos = leerVendidos();
  const lista = Array.isArray(datos[rifaId]) ? datos[rifaId] : [];
  res.json(lista);
});

// Ruta opcional protegida para consultar registros de compradores (nombre, teléfono, boletos)
app.get('/api/registros', (req, res) => {
  const claveAdmin = process.env.ADMIN_KEY || 'rifas2026';
  const claveEnviada = req.headers['x-admin-key'] || req.query.key;

  if (!claveEnviada || claveEnviada !== claveAdmin) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const registros = leerRegistros();
  res.json(registros);
});

// Ruta para crear orden de pago en Mercado Pago (API Orders)
app.post('/api/crear-pago', async (req, res) => {
  const {
    rifaId,
    tituloRifa,
    numerosBoletos,
    numeroBoleto,
    metodoPago,
    comprador
  } = req.body;

  const accessToken = process.env.MP_ACCESS_TOKEN;

  if (!accessToken) {
    return res.status(400).json({
      error: 'Falta configurar MP_ACCESS_TOKEN en las variables de entorno del servidor.'
    });
  }

  const rifaConfig = CONFIG_RIFAS[rifaId];
  if (!rifaConfig) {
    return res.status(400).json({
      error: 'La rifa seleccionada no es válida.'
    });
  }

  // Normalizar arreglo de boletos seleccionados
  let boletos = [];
  if (Array.isArray(numerosBoletos) && numerosBoletos.length > 0) {
    boletos = numerosBoletos.map(n => Number(n));
  } else if (numeroBoleto !== undefined && numeroBoleto !== null) {
    boletos = [Number(numeroBoleto)];
  }

  // Eliminar duplicados y validar números enteros dentro del rango
  boletos = [...new Set(boletos)];
  if (
    boletos.length === 0 ||
    boletos.some(n => !Number.isInteger(n) || n < 0 || n >= rifaConfig.totalNumeros)
  ) {
    return res.status(400).json({
      error: 'Uno o más números de boleto no son válidos para esta rifa.'
    });
  }

  // Validar límite máximo de boletos por compra en esta rifa
  if (boletos.length > rifaConfig.maxPorCompra) {
    return res.status(400).json({
      error: `En "${rifaConfig.titulo}" solo se permiten máximo ${rifaConfig.maxPorCompra} boletos por compra.`
    });
  }

  // Validar datos del comprador
  const nombreComprador = comprador && typeof comprador.nombre === 'string' ? comprador.nombre.trim() : '';
  const telefonoComprador = comprador && typeof comprador.telefono === 'string' ? comprador.telefono.trim() : '';

  if (!nombreComprador || !telefonoComprador) {
    return res.status(400).json({
      error: 'Debes ingresar tu nombre completo y tu número de teléfono.'
    });
  }

  // Verificar que ninguno de los boletos esté ya vendido
  const vendidosActuales = leerVendidos();
  const ocupadosRifa = Array.isArray(vendidosActuales[rifaId])
    ? vendidosActuales[rifaId].map(Number)
    : [];

  const yaOcupados = boletos.filter(n => ocupadosRifa.includes(n));
  if (yaOcupados.length > 0) {
    return res.status(409).json({
      error: `Los boletos #${yaOcupados.join(', #')} ya fueron vendidos. Elige otros números.`
    });
  }

  boletos.sort((a, b) => a - b);

  const montoNumerico = boletos.length * rifaConfig.precioUnitario;
  const montoFormateado = montoNumerico.toFixed(2);
  const precioUnitarioFormateado = Number(rifaConfig.precioUnitario).toFixed(2);
  const etiquetasBoletos = boletos.map(n => `#${n}`).join(', ');
  const tituloFinal = tituloRifa || rifaConfig.titulo;

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
        external_reference: `${rifaId}-boletos-${boletos.join('-')}`,
        items: [
          {
            title: `${tituloFinal} - Boletos ${etiquetasBoletos}`,
            quantity: boletos.length,
            unit_price: precioUnitarioFormateado
          }
        ]
      }
    });

    const checkoutUrl = resultado.checkout_url;

    // Guardar registro del intento/orden con datos del comprador para seguimiento
    guardarRegistroCompra({
      fecha: new Date().toISOString(),
      orderId: resultado.id,
      rifaId,
      tituloRifa: tituloFinal,
      numerosBoletos: boletos,
      cantidadBoletos: boletos.length,
      totalMonto: Number(montoFormateado),
      metodoPago: metodoPago || 'Mercado Pago',
      comprador: {
        nombre: nombreComprador,
        telefono: telefonoComprador
      }
    });

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
