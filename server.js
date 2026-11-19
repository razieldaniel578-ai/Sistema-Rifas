const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MercadoPagoConfig, Order } = require('mercadopago');

const app = express();
const PORT = process.env.PORT || 3000;
const HORAS_ESPERA_SORTEO = 24;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const ARCHIVO_VENDIDOS = path.join(__dirname, 'vendidos.json');
const ARCHIVO_REGISTROS = path.join(__dirname, 'registros_compras.json');
const ARCHIVO_ESTADO_RIFAS = path.join(__dirname, 'estado_rifas.json');
const ARCHIVO_GANADORES = path.join(__dirname, 'ganadores.json');

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

function leerJsonSeguro(rutaArchivo, valorPorDefecto) {
  try {
    if (!fs.existsSync(rutaArchivo)) {
      fs.writeFileSync(rutaArchivo, JSON.stringify(valorPorDefecto, null, 2));
      return structuredClone(valorPorDefecto);
    }
    const raw = fs.readFileSync(rutaArchivo, 'utf8');
    const parsed = JSON.parse(raw || 'null');
    if (Array.isArray(valorPorDefecto)) {
      return Array.isArray(parsed) ? parsed : structuredClone(valorPorDefecto);
    }
    return parsed && typeof parsed === 'object' ? parsed : structuredClone(valorPorDefecto);
  } catch (err) {
    console.error(`Error leyendo ${path.basename(rutaArchivo)}:`, err);
    return structuredClone(valorPorDefecto);
  }
}

function guardarJsonSeguro(rutaArchivo, data) {
  fs.writeFileSync(rutaArchivo, JSON.stringify(data, null, 2));
}

// Cargar / guardar boletos vendidos
function leerVendidos() {
  return leerJsonSeguro(ARCHIVO_VENDIDOS, {});
}

function guardarVendidos(data) {
  guardarJsonSeguro(ARCHIVO_VENDIDOS, data);
}

// Cargar / guardar registros de compradores
function leerRegistros() {
  return leerJsonSeguro(ARCHIVO_REGISTROS, []);
}

function guardarRegistroCompra(registro) {
  const registros = leerRegistros();
  registros.push(registro);
  guardarJsonSeguro(ARCHIVO_REGISTROS, registros);
}

// Cargar / guardar estado de rifas (agotada, inicio de cuenta regresiva de 24h y aviso enviado)
function leerEstadoRifas() {
  return leerJsonSeguro(ARCHIVO_ESTADO_RIFAS, {});
}

function guardarEstadoRifas(data) {
  guardarJsonSeguro(ARCHIVO_ESTADO_RIFAS, data);
}

// Cargar / guardar ganadores por rifa (solo nombres de 1er, 2do y 3er lugar)
function leerGanadores() {
  return leerJsonSeguro(ARCHIVO_GANADORES, {});
}

function guardarGanadores(data) {
  guardarJsonSeguro(ARCHIVO_GANADORES, data);
}

function obtenerClaveAdmin(req) {
  return process.env.ADMIN_KEY || 'rifas2026';
}

function estaAutorizadoAdmin(req) {
  const claveAdmin = obtenerClaveAdmin(req);
  const claveEnviada = req.headers['x-admin-key'] || req.query.key || (req.body && req.body.adminKey);
  return Boolean(claveEnviada && claveEnviada === claveAdmin);
}

// Enviar aviso automático al WhatsApp del creador (via CallMeBot si está configurado)
async function notificarWhatsAppCreador(mensaje) {
  const telefono = (process.env.MI_WHATSAPP || '').replace(/\D/g, '');
  const apiKey = process.env.CALLMEBOT_API_KEY || '';

  if (!telefono || !apiKey) {
    console.log('Aviso WhatsApp no enviado (falta MI_WHATSAPP o CALLMEBOT_API_KEY):', mensaje);
    return false;
  }

  try {
    const url = `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(telefono)}&text=${encodeURIComponent(mensaje)}&apikey=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url);
    return resp.ok;
  } catch (err) {
    console.error('Error enviando aviso por WhatsApp:', err);
    return false;
  }
}

// Sincroniza el estado de agotado / cuenta regresiva de 24h para una rifa
async function sincronizarEstadoRifa(rifaId) {
  const rifaConfig = CONFIG_RIFAS[rifaId];
  if (!rifaConfig) return null;

  const vendidosData = leerVendidos();
  const ocupados = Array.isArray(vendidosData[rifaId]) ? vendidosData[rifaId].map(Number) : [];
  const totalVendidos = ocupados.length;
  const disponibles = Math.max(0, rifaConfig.totalNumeros - totalVendidos);
  const agotada = totalVendidos >= rifaConfig.totalNumeros;

  const estados = leerEstadoRifas();
  let estadoActual = estados[rifaId] || {
    rifaId,
    tituloRifa: rifaConfig.titulo,
    agotada: false,
    fechaAgotada: null,
    fechaSorteo: null,
    avisoWhatsAppEnviado: false
  };

  if (agotada && !estadoActual.fechaAgotada) {
    const ahora = new Date();
    const fechaSorteo = new Date(ahora.getTime() + HORAS_ESPERA_SORTEO * 60 * 60 * 1000);

    estadoActual = {
      ...estadoActual,
      rifaId,
      tituloRifa: rifaConfig.titulo,
      agotada: true,
      fechaAgotada: ahora.toISOString(),
      fechaSorteo: fechaSorteo.toISOString()
    };

    estados[rifaId] = estadoActual;
    guardarEstadoRifas(estados);

    if (!estadoActual.avisoWhatsAppEnviado) {
      const textoAviso = `🚨 ¡Rifa agotada! Se vendieron todos los boletos de "${rifaConfig.titulo}". El sorteo en vivo en Olla Sol comienza en ${HORAS_ESPERA_SORTEO} horas (${fechaSorteo.toLocaleString('es-MX')}).`;
      const enviado = await notificarWhatsAppCreador(textoAviso);
      if (enviado) {
        estadoActual.avisoWhatsAppEnviado = true;
        estados[rifaId] = estadoActual;
        guardarEstadoRifas(estados);
      }
    }
  } else if (!agotada && estadoActual.agotada) {
    // Si por alguna razón vuelven a quedar boletos disponibles
    estadoActual.agotada = false;
    estadoActual.fechaAgotada = null;
    estadoActual.fechaSorteo = null;
    estadoActual.avisoWhatsAppEnviado = false;
    estados[rifaId] = estadoActual;
    guardarEstadoRifas(estados);
  }

  const tiempoRestanteMs = estadoActual.fechaSorteo
    ? Math.max(0, new Date(estadoActual.fechaSorteo).getTime() - Date.now())
    : 0;

  return {
    rifaId,
    tituloRifa: rifaConfig.titulo,
    totalNumeros: rifaConfig.totalNumeros,
    totalVendidos,
    disponibles,
    agotada,
    horasEspera: HORAS_ESPERA_SORTEO,
    fechaAgotada: estadoActual.fechaAgotada,
    fechaSorteo: estadoActual.fechaSorteo,
    tiempoRestanteMs
  };
}

// Ruta para obtener boletos vendidos de una rifa
app.get('/api/vendidos/:rifaId', (req, res) => {
  const { rifaId } = req.params;
  const datos = leerVendidos();
  const lista = Array.isArray(datos[rifaId]) ? datos[rifaId] : [];
  res.json(lista);
});

// Ruta para obtener estado de agotado y cuenta regresiva de 24h de una rifa
app.get('/api/estado-rifa/:rifaId', async (req, res) => {
  const { rifaId } = req.params;
  if (!CONFIG_RIFAS[rifaId]) {
    return res.status(404).json({ error: 'Rifa no encontrada.' });
  }
  const estado = await sincronizarEstadoRifa(rifaId);
  res.json(estado);
});

// Ruta para consultar ganadores de una rifa (1er, 2do y 3er lugar - solo nombres)
app.get('/api/ganadores/:rifaId', (req, res) => {
  const { rifaId } = req.params;
  if (!CONFIG_RIFAS[rifaId]) {
    return res.status(404).json({ error: 'Rifa no encontrada.' });
  }
  const ganadoresData = leerGanadores();
  const ganadoresRifa = ganadoresData[rifaId] || {
    primerLugar: '',
    segundoLugar: '',
    tercerLugar: '',
    actualizadoEn: null
  };
  res.json({
    rifaId,
    primerLugar: ganadoresRifa.primerLugar || '',
    segundoLugar: ganadoresRifa.segundoLugar || '',
    tercerLugar: ganadoresRifa.tercerLugar || '',
    actualizadoEn: ganadoresRifa.actualizadoEn || null
  });
});

// Ruta protegida para guardar o actualizar los 3 ganadores de una rifa (solo nombres)
app.post('/api/ganadores/:rifaId', (req, res) => {
  if (!estaAutorizadoAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado. Clave de administrador inválida.' });
  }

  const { rifaId } = req.params;
  if (!CONFIG_RIFAS[rifaId]) {
    return res.status(404).json({ error: 'Rifa no encontrada.' });
  }

  const primerLugar = typeof req.body.primerLugar === 'string' ? req.body.primerLugar.trim() : '';
  const segundoLugar = typeof req.body.segundoLugar === 'string' ? req.body.segundoLugar.trim() : '';
  const tercerLugar = typeof req.body.tercerLugar === 'string' ? req.body.tercerLugar.trim() : '';

  const ganadoresData = leerGanadores();
  ganadoresData[rifaId] = {
    primerLugar,
    segundoLugar,
    tercerLugar,
    actualizadoEn: new Date().toISOString()
  };

  guardarGanadores(ganadoresData);

  res.json({
    ok: true,
    rifaId,
    ganadores: ganadoresData[rifaId]
  });
});

// Ruta protegida para consultar registros de compradores (nombre, teléfono, boletos)
app.get('/api/registros', (req, res) => {
  if (!estaAutorizadoAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const registros = leerRegistros();
  res.json(registros);
});

// Ruta protegida para marcar boletos como vendidos manualmente o confirmar pago
app.post('/api/marcar-vendidos', async (req, res) => {
  if (!estaAutorizadoAdmin(req)) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const { rifaId, numerosBoletos } = req.body;
  const rifaConfig = CONFIG_RIFAS[rifaId];
  if (!rifaConfig || !Array.isArray(numerosBoletos) || numerosBoletos.length === 0) {
    return res.status(400).json({ error: 'Datos inválidos para marcar boletos.' });
  }

  const boletosValidos = [...new Set(numerosBoletos.map(Number))].filter(
    n => Number.isInteger(n) && n >= 0 && n < rifaConfig.totalNumeros
  );

  const vendidosData = leerVendidos();
  const actuales = new Set(Array.isArray(vendidosData[rifaId]) ? vendidosData[rifaId].map(Number) : []);
  boletosValidos.forEach(n => actuales.add(n));
  vendidosData[rifaId] = [...actuales].sort((a, b) => a - b);
  guardarVendidos(vendidosData);

  const estadoActualizado = await sincronizarEstadoRifa(rifaId);
  res.json({
    ok: true,
    vendidos: vendidosData[rifaId],
    estadoRifa: estadoActualizado
  });
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
