const path = require('path');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const db = require('./db');
const { migrate } = require('./migrate');
const { loadUser, csrf, homePath } = require('./auth');
const { bootstrapAdmin } = require('./bootstrap');
const jobs = require('./jobs');
const helpers = require('./viewHelpers');

function createApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'img-src': ["'self'", 'data:', 'blob:'],
        'script-src': ["'self'"],
      },
    },
  }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(express.json({ limit: '200kb' }));

  app.use(session({
    store: new PgSession({ pool: db.pool, createTableIfMissing: true }),
    name: 'dsd.sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 3600 * 1000,
    },
  }));

  app.use((req, res, next) => {
    Object.assign(res.locals, helpers);
    res.locals.path = req.path;
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    next();
  });
  app.use(loadUser);
  app.use(csrf);

  app.get('/healthz', async (req, res) => {
    await db.q('SELECT 1');
    res.json({ ok: true });
  });

  app.get('/', (req, res) => {
    if (req.user) return res.redirect(homePath(req.user));
    res.render('home', { title: 'Store check-in' });
  });

  app.use(require('./routes/auth'));
  app.use(require('./routes/files'));
  app.use(require('./routes/rep'));
  app.use(require('./routes/checkin'));
  app.use(require('./routes/vendorAdmin'));
  app.use(require('./routes/store'));
  app.use(require('./routes/merchant'));
  app.use(require('./routes/admin'));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || 500;
    const message = err.expose ? err.message : 'Something went wrong. Please try again.';
    if (res.headersSent) return;
    res.status(status).render('error', { title: 'Error', message });
  });
  return app;
}

async function main() {
  await migrate();
  await bootstrapAdmin();
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`DSD check-in listening on :${port}`));
  if (process.env.DISABLE_JOBS !== 'true') jobs.startScheduler();
}

module.exports = { createApp };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
