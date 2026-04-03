/**
 * Seed script: carga datos iniciales en MongoDB
 * Uso: npm run seed
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const User     = require('../models/User');
const Notice   = require('../models/Notice');
const Payment  = require('../models/Payment');
const Config   = require('../models/Config');
const logger   = require('./logger');

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info('Conectado a MongoDB para seed.');

    // Limpiar colecciones
    await Promise.all([
      User.deleteMany({}),
      Payment.deleteMany({}),
      Notice.deleteMany({}),
      Config.deleteMany({}),
    ]);
    logger.info('Colecciones limpiadas.');

    // ── Admin ────────────────────────────────────────────────
    const admin = await User.create({
      name:     'Administración Barrio',
      email:    'admin@consorcio.com',
      password: 'Admin2025!',
      role:     'admin',
    });

    // ── Propietarios ─────────────────────────────────────────
    const owners = await Promise.all([
      User.create({ name: 'María García',    email: 'maria@mail.com',  password: 'Prop2025!', role: 'owner', unit: 'Lote 12', phone: '1122334455', balance: -15000, isDebtor: true  }),
      User.create({ name: 'Carlos López',    email: 'carlos@mail.com', password: 'Prop2025!', role: 'owner', unit: 'Lote 07', phone: '1133445566', balance: 0,      isDebtor: false }),
      User.create({ name: 'Ana Rodríguez',   email: 'ana@mail.com',    password: 'Prop2025!', role: 'owner', unit: 'Lote 23', phone: '1144556677', balance: 0,      isDebtor: false }),
      User.create({ name: 'Diego Martínez',  email: 'diego@mail.com',  password: 'Prop2025!', role: 'owner', unit: 'Lote 05', phone: '1155667788', balance: -28500, isDebtor: true  }),
      User.create({ name: 'Laura Fernández', email: 'laura@mail.com',  password: 'Prop2025!', role: 'owner', unit: 'Lote 18', phone: '1166778899', balance: 0,      isDebtor: false }),
    ]);

    // ── Pagos ─────────────────────────────────────────────────
    await Payment.insertMany([
      { owner: owners[0]._id, month: '2025-02', amount: 15000, status: 'rejected',  paymentMethod: 'manual', rejectionNote: 'Importe incorrecto', reviewedBy: admin._id, reviewedAt: new Date() },
      { owner: owners[1]._id, month: '2025-02', amount: 15000, status: 'approved',  paymentMethod: 'manual', reviewedBy: admin._id, reviewedAt: new Date() },
      { owner: owners[2]._id, month: '2025-02', amount: 15000, status: 'approved',  paymentMethod: 'manual', reviewedBy: admin._id, reviewedAt: new Date() },
      { owner: owners[0]._id, month: '2025-03', amount: 15000, status: 'pending',   paymentMethod: 'manual' },
      { owner: owners[4]._id, month: '2025-03', amount: 15000, status: 'approved',  paymentMethod: 'mercadopago', reviewedBy: admin._id, reviewedAt: new Date() },
      { owner: owners[1]._id, month: '2025-03', amount: 15000, status: 'approved',  paymentMethod: 'manual', reviewedBy: admin._id, reviewedAt: new Date() },
      { owner: owners[2]._id, month: '2025-04', amount: 15000, status: 'approved',  paymentMethod: 'mercadopago', reviewedBy: admin._id, reviewedAt: new Date() },
    ]);

    // ── Avisos ────────────────────────────────────────────────
    await Notice.insertMany([
      { title: 'Reunión de Consorcio — Abril 2025', body: 'Se convoca a todos los propietarios el día 15/04 a las 19:00 hs en el SUM. Temas: presupuesto y mantenimiento.', tag: 'info', author: admin._id },
      { title: 'Mantenimiento de Pileta', body: 'Del 10 al 14 de abril se realizará el mantenimiento anual. La pileta estará inhabilitada durante ese período.', tag: 'warning', author: admin._id },
      { title: 'Vencimiento de Expensas', body: 'Recordamos que el vencimiento del período Abril 2025 opera el día 10/04. Pasada esa fecha se aplicará un recargo del 5%.', tag: 'urgent', author: admin._id },
    ]);

    // ── Config ────────────────────────────────────────────────
    await Config.create({
      expenseAmount:    15000,
      expenseMonth:     'Abril 2025',
      expenseMonthCode: '2025-04',
      lateFeePercent:   5,
      dueDayOfMonth:    10,
      consortiumName:   'Barrio Privado Los Pinos',
      adminEmail:       'admin@consorcio.com',
    });

    logger.info(`✓ Seed completado:
  - 1 admin
  - ${owners.length} propietarios
  - 7 pagos
  - 3 avisos
  - 1 configuración`);

    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    logger.error(`Error en seed: ${err.message}`);
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
  }
};

seed();
