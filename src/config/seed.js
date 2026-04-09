/**
 * Seed script: carga datos iniciales en MongoDB
 * Uso: npm run seed
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose     = require('mongoose');
const Organization = require('../models/Organization');
const User         = require('../models/User');
const Notice       = require('../models/Notice');
const Payment      = require('../models/Payment');
const Claim        = require('../models/Claim');
const logger       = require('./logger');

const seed = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    logger.info('Conectado a MongoDB para seed.');

    // Limpiar colecciones
    await Promise.all([
      Organization.deleteMany({}),
      User.deleteMany({}),
      Payment.deleteMany({}),
      Notice.deleteMany({}),
      Claim.deleteMany({}),
    ]);
    logger.info('Colecciones limpiadas.');

    // ── Organización ─────────────────────────────────────────
    const org = await Organization.create({
      name:           'Barrio Privado Los Pinos',
      slug:           'barrio-los-pinos',
      businessType:   'consorcio',
      feeAmount:      15000,
      feePeriodCode:  '2025-04',
      feePeriodLabel: 'Abril 2025',
      lateFeePercent: 5,
      dueDayOfMonth:  10,
      feeLabel:       'Expensa',
      memberLabel:    'Propietario',
      unitLabel:      'Lote / Casa',
      adminEmail:     'admin@consorcio.com',
    });
    logger.info(`Organización creada: ${org.name} [${org._id}]`);

    // ── Admin ────────────────────────────────────────────────
    const admin = await User.create({
      name:         'Administración Barrio',
      email:        'admin@consorcio.com',
      password:     'Admin2025!',
      role:         'admin',
      organization: org._id,
    });

    // ── Propietarios ─────────────────────────────────────────
    const owners = await Promise.all([
      User.create({ name: 'María García',    email: 'maria@mail.com',  password: 'Prop2025!', role: 'owner', unit: 'Lote 12', phone: '1122334455', balance: -15000, isDebtor: true,  organization: org._id }),
      User.create({ name: 'Carlos López',    email: 'carlos@mail.com', password: 'Prop2025!', role: 'owner', unit: 'Lote 07', phone: '1133445566', balance: 0,      isDebtor: false, organization: org._id }),
      User.create({ name: 'Ana Rodríguez',   email: 'ana@mail.com',    password: 'Prop2025!', role: 'owner', unit: 'Lote 23', phone: '1144556677', balance: 0,      isDebtor: false, organization: org._id }),
      User.create({ name: 'Diego Martínez',  email: 'diego@mail.com',  password: 'Prop2025!', role: 'owner', unit: 'Lote 05', phone: '1155667788', balance: -28500, isDebtor: true,  organization: org._id }),
      User.create({ name: 'Laura Fernández', email: 'laura@mail.com',  password: 'Prop2025!', role: 'owner', unit: 'Lote 18', phone: '1166778899', balance: 0,      isDebtor: false, organization: org._id }),
    ]);

    // ── Pagos ─────────────────────────────────────────────────
    await Payment.insertMany([
      { organization: org._id, owner: owners[0]._id, month: '2025-02', amount: 15000, status: 'rejected',  paymentMethod: 'manual', rejectionNote: 'Importe incorrecto', reviewedBy: admin._id, reviewedAt: new Date() },
      { organization: org._id, owner: owners[1]._id, month: '2025-02', amount: 15000, status: 'approved',  paymentMethod: 'manual', reviewedBy: admin._id, reviewedAt: new Date() },
      { organization: org._id, owner: owners[2]._id, month: '2025-02', amount: 15000, status: 'approved',  paymentMethod: 'manual', reviewedBy: admin._id, reviewedAt: new Date() },
      { organization: org._id, owner: owners[0]._id, month: '2025-03', amount: 15000, status: 'pending',   paymentMethod: 'manual' },
      { organization: org._id, owner: owners[4]._id, month: '2025-03', amount: 15000, status: 'approved',  paymentMethod: 'mercadopago', reviewedBy: admin._id, reviewedAt: new Date() },
      { organization: org._id, owner: owners[1]._id, month: '2025-03', amount: 15000, status: 'approved',  paymentMethod: 'manual', reviewedBy: admin._id, reviewedAt: new Date() },
      { organization: org._id, owner: owners[2]._id, month: '2025-04', amount: 15000, status: 'approved',  paymentMethod: 'mercadopago', reviewedBy: admin._id, reviewedAt: new Date() },
    ]);

    // ── Avisos ────────────────────────────────────────────────
    await Notice.insertMany([
      { organization: org._id, title: 'Reunión de Consorcio — Abril 2025', body: 'Se convoca a todos los propietarios el día 15/04 a las 19:00 hs en el SUM. Temas: presupuesto y mantenimiento.', tag: 'info', author: admin._id },
      { organization: org._id, title: 'Mantenimiento de Pileta', body: 'Del 10 al 14 de abril se realizará el mantenimiento anual. La pileta estará inhabilitada durante ese período.', tag: 'warning', author: admin._id },
      { organization: org._id, title: 'Vencimiento de Expensas', body: 'Recordamos que el vencimiento del período Abril 2025 opera el día 10/04. Pasada esa fecha se aplicará un recargo del 5%.', tag: 'urgent', author: admin._id },
    ]);

    logger.info(`✓ Seed completado:
  - 1 organización (consorcio): ${org.name}
  - 1 admin
  - ${owners.length} propietarios
  - 7 pagos
  - 3 avisos`);

    await mongoose.connection.close();
    process.exit(0);
  } catch (err) {
    logger.error(`Error en seed: ${err.message}`);
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
  }
};

seed();
