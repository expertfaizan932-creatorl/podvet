// ─── Customer Portal API (/api/portal/*) ────────────────────────────────────
//
// Self-service surface for pet owners: a separate login (client_accounts) from
// clinic staff, scoped so a customer can only ever read/write their own pets,
// appointments, records, boarding and bills. Every query is filtered by the
// client_id baked into the portal JWT — the client id is never taken from the
// request, so one customer cannot address another's rows.
//
// Registered from server.js (so it shares the same db/clinicStore/auth helpers)
// before the /api catch-all. Uses the same HS256 secret as staff tokens but
// stamps scope:'portal' and clientId; server.js's authMiddleware rejects that
// scope, so a portal token can never call a staff endpoint.

const crypto = require('crypto');

const PORTAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

module.exports = function registerPortalApi(app, deps) {
  const {
    db, platConn, clinicStore, bcrypt, getTokenSecret, toCamel, P,
    notify, getClinicConn, clinicBrandingFor, guardClinicSubscription,
  } = deps;

  const withClinic = (clinicId, fn) => clinicStore.run(Number(clinicId) || 1, fn);

  const TOKEN_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const signPart = (data) => crypto.createHmac('sha256', getTokenSecret()).update(data).digest('base64url');

  function makePortalToken(accountId, clientId, clinicId) {
    const payload = Buffer.from(JSON.stringify({
      sub: accountId, clientId: Number(clientId), clinicId: Number(clinicId) || 1,
      scope: 'portal', iat: Date.now(), exp: Date.now() + PORTAL_TTL_MS,
    })).toString('base64url');
    const body = `${TOKEN_HEADER}.${payload}`;
    return `${body}.${signPart(body)}`;
  }

  function verifyPortalToken(raw) {
    const parts = String(raw || '').split('.');
    if (parts.length !== 3) return null;
    const body = `${parts[0]}.${parts[1]}`;
    const expected = signPart(body);
    if (parts[2].length !== expected.length ||
        !crypto.timingSafeEqual(Buffer.from(parts[2]), Buffer.from(expected))) return null;
    let payload;
    try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
    const expMs = Number(payload.exp) < 1e12 ? Number(payload.exp) * 1000 : Number(payload.exp);
    if (!Number.isFinite(expMs) || expMs <= Date.now()) return null;
    if (payload.scope !== 'portal') return null;
    if (payload.sub === undefined || payload.clientId === undefined) return null;
    return payload;
  }

  function portalAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: { message: 'Sign in to continue.', code: 'UNAUTHORIZED' } });
    const payload = verifyPortalToken(auth.slice(7));
    if (!payload) return res.status(401).json({ error: { message: 'Your session has expired. Please sign in again.', code: 'UNAUTHORIZED' } });
    req.portal = { accountId: Number(payload.sub), clientId: Number(payload.clientId), clinicId: Number(payload.clinicId) || 1 };
    clinicStore.run(req.portal.clinicId, () => next());
  }

  const asyncRoute = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[portal]', req.method, req.originalUrl, e.message);
    res.status(500).json({ error: { message: 'Something went wrong. Please try again.' } });
  });

  async function portalProfile(accountId, clientId) {
    const [acc] = await db.query('SELECT * FROM client_accounts WHERE id=?', [accountId]);
    if (!acc.length) return null;
    const a = acc[0];
    const [cl] = await db.query('SELECT * FROM clients WHERE id=?', [clientId]);
    const c = cl[0] || {};
    let prefs = {};
    try { prefs = a.notification_prefs ? JSON.parse(a.notification_prefs) : {}; } catch { prefs = {}; }
    return {
      id: a.id, clientId: a.client_id, email: a.email,
      fullName: a.full_name || c.client_name || '',
      phone: a.phone || c.contact_number || '',
      address: c.address || '',
      notificationPrefs: prefs,
      createdAt: a.created_at,
    };
  }

  // ── Public: clinic info (no auth) ─────────────────────────────────────────
  app.get('/api/portal/clinic-info', asyncRoute(async (req, res) => {
    const clinicId = Number(req.query.c || req.query.clinicId) || 1;
    const info = await withClinic(clinicId, () => clinicBrandingFor(clinicId));
    res.json({ data: { clinicId, ...info } });
  }));

  // ── Public: register ──────────────────────────────────────────────────────
  app.post('/api/portal/register', asyncRoute(async (req, res) => {
    const clinicId = Number(req.body.clinicId || req.query.c) || 1;
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const fullName = String(req.body.fullName || '').trim();
    const phone = String(req.body.phone || '').trim();
    const address = String(req.body.address || '').trim();
    const pet = req.body.pet && typeof req.body.pet === 'object' ? req.body.pet : null;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: { message: 'Enter a valid email address.' } });
    if (password.length < 6) return res.status(400).json({ error: { message: 'Password must be at least 6 characters.' } });
    if (!fullName) return res.status(400).json({ error: { message: 'Enter your full name.' } });

    const out = await withClinic(clinicId, async () => {
      const [dup] = await db.query('SELECT id FROM client_accounts WHERE email=?', [email]);
      if (dup.length) return { conflict: true };
      const hash = await bcrypt.hash(password, 10);
      const [cr] = await db.query('INSERT INTO clients (client_name,contact_number,address) VALUES (?,?,?)', [fullName, phone, address]);
      const clientId = cr.insertId;
      if (pet && pet.petName) {
        await db.query('INSERT INTO pets (client_id,pet_name,sex,species,breed,color,date_of_birth,is_neutered,is_microchipped) VALUES (?,?,?,?,?,?,?,?,?)',
          [clientId, pet.petName, pet.sex || 'Unknown', pet.species || 'Dog', pet.breed || '', pet.color || '', pet.dateOfBirth || null, pet.isNeutered ? 1 : 0, pet.isMicrochipped ? 1 : 0]);
      }
      const [ar] = await db.query('INSERT INTO client_accounts (client_id,email,password_hash,full_name,phone) VALUES (?,?,?,?,?)', [clientId, email, hash, fullName, phone]);
      return { accountId: ar.insertId, clientId };
    });
    if (out.conflict) return res.status(409).json({ error: { message: 'An account with this email already exists. Try signing in.' } });
    await withClinic(clinicId, async () => {
      notify({ recipientAudience: 'STAFF', title: 'New customer portal account', message: `${fullName} (${email}) signed up`, category: 'client', priority: 'low', relatedEntityType: 'client', relatedEntityId: out.clientId });
      notify({ recipientAudience: 'CLIENT', recipientClientId: out.clientId, title: 'Welcome to your pet portal', message: 'Your account is ready. Track appointments, records and bills here.', category: 'general', actionUrl: '/portal/dashboard' });
    });
    const token = makePortalToken(out.accountId, out.clientId, clinicId);
    const profile = await withClinic(clinicId, () => portalProfile(out.accountId, out.clientId));
    const clinic = await withClinic(clinicId, () => clinicBrandingFor(clinicId));
    res.json({ accessToken: token, profile, clinic });
  }));

  // ── Public: login ─────────────────────────────────────────────────────────
  app.post('/api/portal/login', asyncRoute(async (req, res) => {
    const clinicId = Number(req.body.clinicId || req.query.c) || 1;
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ error: { message: 'Email and password are required.' } });
    if (guardClinicSubscription && !(await guardClinicSubscription(clinicId))) {
      return res.status(403).json({ error: { message: 'This clinic is not accepting portal sign-ins right now.' } });
    }
    const row = await withClinic(clinicId, async () => {
      const [acc] = await db.query('SELECT * FROM client_accounts WHERE email=? AND is_active=1', [email]);
      if (!acc.length) return null;
      return acc[0];
    });
    if (!row) return res.status(401).json({ error: { message: 'Invalid email or password.' } });
    const ok = await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: { message: 'Invalid email or password.' } });
    await withClinic(clinicId, () => db.query('UPDATE client_accounts SET last_login_at=NOW() WHERE id=?', [row.id]));
    const token = makePortalToken(row.id, row.client_id, clinicId);
    const profile = await withClinic(clinicId, () => portalProfile(row.id, row.client_id));
    const clinic = await withClinic(clinicId, () => clinicBrandingFor(clinicId));
    res.json({ accessToken: token, profile, clinic });
  }));

  app.post('/api/portal/refresh', asyncRoute(async (req, res) => {
    const payload = verifyPortalToken(req.body.token || req.body.accessToken);
    if (!payload) return res.status(401).json({ error: { message: 'Session expired.' } });
    res.json({ accessToken: makePortalToken(payload.sub, payload.clientId, payload.clinicId) });
  }));

  app.post('/api/portal/forgot-password', asyncRoute(async (req, res) => {
    // Never reveal whether the email exists.
    res.json({ success: true, message: 'If that email is registered, the clinic will contact you to reset your password.' });
  }));

  // ── Protected ─────────────────────────────────────────────────────────────
  app.get('/api/portal/me', portalAuth, asyncRoute(async (req, res) => {
    const profile = await portalProfile(req.portal.accountId, req.portal.clientId);
    if (!profile) return res.status(401).json({ error: { message: 'Account not found.' } });
    const clinic = await clinicBrandingFor(req.portal.clinicId);
    res.json({ data: { profile, clinic } });
  }));

  app.patch('/api/portal/me', portalAuth, asyncRoute(async (req, res) => {
    const { fullName, phone, address, notificationPrefs } = req.body || {};
    if (fullName !== undefined || phone !== undefined) {
      await db.query('UPDATE client_accounts SET full_name=COALESCE(?,full_name), phone=COALESCE(?,phone) WHERE id=?', [fullName ?? null, phone ?? null, req.portal.accountId]);
    }
    if (fullName !== undefined || phone !== undefined || address !== undefined) {
      await db.query('UPDATE clients SET client_name=COALESCE(?,client_name), contact_number=COALESCE(?,contact_number), address=COALESCE(?,address) WHERE id=?',
        [fullName ?? null, phone ?? null, address ?? null, req.portal.clientId]);
    }
    if (notificationPrefs !== undefined) {
      await db.query('UPDATE client_accounts SET notification_prefs=? WHERE id=?', [JSON.stringify(notificationPrefs || {}), req.portal.accountId]);
    }
    res.json({ data: await portalProfile(req.portal.accountId, req.portal.clientId) });
  }));

  app.post('/api/portal/me/password', portalAuth, asyncRoute(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: { message: 'New password must be at least 6 characters.' } });
    const [acc] = await db.query('SELECT password_hash FROM client_accounts WHERE id=?', [req.portal.accountId]);
    if (!acc.length) return res.status(404).json({ error: { message: 'Account not found.' } });
    if (!(await bcrypt.compare(String(currentPassword || ''), acc[0].password_hash))) {
      return res.status(400).json({ error: { message: 'Your current password is incorrect.' } });
    }
    const hash = await bcrypt.hash(String(newPassword), 10);
    await db.query('UPDATE client_accounts SET password_hash=? WHERE id=?', [hash, req.portal.accountId]);
    res.json({ success: true });
  }));

  // ── Dashboard ─────────────────────────────────────────────────────────────
  app.get('/api/portal/dashboard', portalAuth, asyncRoute(async (req, res) => {
    const cid = req.portal.clientId;
    const [[pets], [upcoming], [boarding], [due], [unread]] = await Promise.all([
      db.query('SELECT COUNT(*) AS n FROM pets WHERE client_id=? AND (deceased IS NULL OR deceased=0)', [cid]),
      db.query(`SELECT a.id, a.appointment_date, a.appointment_time, a.status, a.doctor, p.pet_name
                FROM appointments a JOIN pets p ON a.pet_id=p.id
                WHERE a.client_id=? AND a.appointment_date >= CURDATE() AND a.status='CONFIRMED'
                ORDER BY a.appointment_date ASC, a.appointment_time ASC LIMIT 5`, [cid]),
      db.query("SELECT COUNT(*) AS n FROM boarding_stays WHERE client_id=? AND status='ACTIVE'", [cid]),
      db.query('SELECT COALESCE(SUM(final_total-amount_paid),0) AS due FROM billing WHERE client_id=? AND final_total > amount_paid', [cid]),
      db.query("SELECT COUNT(*) AS n FROM notifications WHERE recipient_audience='CLIENT' AND recipient_client_id=? AND is_read=0", [cid]),
    ]);
    res.json({ data: {
      pets: Number(pets[0].n) || 0,
      upcomingAppointments: toCamel(upcoming),
      activeBoarding: Number(boarding[0].n) || 0,
      outstandingDue: Number(due[0].due) || 0,
      unreadNotifications: Number(unread[0].n) || 0,
    } });
  }));

  // ── Pets ──────────────────────────────────────────────────────────────────
  app.get('/api/portal/pets', portalAuth, asyncRoute(async (req, res) => {
    const [rows] = await db.query('SELECT * FROM pets WHERE client_id=? ORDER BY pet_name', [req.portal.clientId]);
    res.json({ data: toCamel(rows) });
  }));
  app.post('/api/portal/pets', portalAuth, asyncRoute(async (req, res) => {
    const d = req.body || {};
    if (!d.petName) return res.status(400).json({ error: { message: 'Pet name is required.' } });
    const [r] = await db.query('INSERT INTO pets (client_id,pet_name,sex,species,breed,color,date_of_birth,is_neutered,is_microchipped) VALUES (?,?,?,?,?,?,?,?,?)',
      [req.portal.clientId, d.petName, d.sex || 'Unknown', d.species || 'Dog', d.breed || '', d.color || '', d.dateOfBirth || null, d.isNeutered ? 1 : 0, d.isMicrochipped ? 1 : 0]);
    notify({ recipientAudience: 'STAFF', title: 'New pet added via portal', message: `${d.petName} (${d.species || 'pet'})`, category: 'pet', priority: 'low', relatedEntityType: 'pet', relatedEntityId: r.insertId, eventKey: `portal-pet-${r.insertId}` });
    res.json({ data: { id: r.insertId } });
  }));
  async function ownedPet(petId, clientId) {
    const [rows] = await db.query('SELECT * FROM pets WHERE id=? AND client_id=?', [petId, clientId]);
    return rows[0] || null;
  }
  app.patch('/api/portal/pets/:id', portalAuth, asyncRoute(async (req, res) => {
    if (!(await ownedPet(req.params.id, req.portal.clientId))) return res.status(404).json({ error: { message: 'Pet not found.' } });
    const d = req.body || {};
    await db.query('UPDATE pets SET pet_name=COALESCE(?,pet_name),sex=COALESCE(?,sex),species=COALESCE(?,species),breed=COALESCE(?,breed),color=COALESCE(?,color),date_of_birth=COALESCE(?,date_of_birth),is_neutered=COALESCE(?,is_neutered),is_microchipped=COALESCE(?,is_microchipped) WHERE id=? AND client_id=?',
      [d.petName ?? null, d.sex ?? null, d.species ?? null, d.breed ?? null, d.color ?? null, d.dateOfBirth ?? null,
       d.isNeutered === undefined ? null : (d.isNeutered ? 1 : 0), d.isMicrochipped === undefined ? null : (d.isMicrochipped ? 1 : 0),
       req.params.id, req.portal.clientId]);
    res.json({ data: await ownedPet(req.params.id, req.portal.clientId) });
  }));

  // ── Appointments ──────────────────────────────────────────────────────────
  app.get('/api/portal/appointments', portalAuth, asyncRoute(async (req, res) => {
    const [rows] = await db.query(
      `SELECT a.id, a.appointment_date, a.appointment_time, a.notes, a.status, a.doctor, a.pet_id, p.pet_name, p.species
       FROM appointments a JOIN pets p ON a.pet_id=p.id
       WHERE a.client_id=? ORDER BY a.appointment_date DESC, a.appointment_time DESC LIMIT 200`, [req.portal.clientId]);
    res.json({ data: toCamel(rows) });
  }));
  app.post('/api/portal/appointments', portalAuth, asyncRoute(async (req, res) => {
    const d = req.body || {};
    const pet = await ownedPet(d.petId, req.portal.clientId);
    if (!pet) return res.status(404).json({ error: { message: 'Select one of your pets.' } });
    if (!d.appointmentDate) return res.status(400).json({ error: { message: 'Choose a date.' } });
    const [r] = await db.query('INSERT INTO appointments (pet_id,client_id,appointment_date,appointment_time,notes,status,doctor) VALUES (?,?,?,?,?,?,?)',
      [pet.id, req.portal.clientId, d.appointmentDate, d.appointmentTime || null, String(d.notes || '').slice(0, 1000), 'CONFIRMED', '']);
    notify({ recipientAudience: 'STAFF', title: 'Appointment request from portal', message: `${pet.pet_name} — ${d.appointmentDate} ${d.appointmentTime || ''}`.trim(), category: 'appointment', priority: 'high', relatedEntityType: 'appointment', relatedEntityId: r.insertId, eventKey: `portal-appt-${r.insertId}` });
    notify({ recipientAudience: 'CLIENT', recipientClientId: req.portal.clientId, title: 'Appointment requested', message: `We have received your request for ${pet.pet_name} on ${d.appointmentDate}. The clinic will confirm shortly.`, category: 'appointment', relatedEntityType: 'appointment', relatedEntityId: r.insertId, actionUrl: '/portal/appointments', eventKey: `portal-appt-client-${r.insertId}` });
    res.json({ data: { id: r.insertId } });
  }));
  async function ownedAppointment(id, clientId) {
    const [rows] = await db.query('SELECT * FROM appointments WHERE id=? AND client_id=?', [id, clientId]);
    return rows[0] || null;
  }
  app.patch('/api/portal/appointments/:id', portalAuth, asyncRoute(async (req, res) => {
    const appt = await ownedAppointment(req.params.id, req.portal.clientId);
    if (!appt) return res.status(404).json({ error: { message: 'Appointment not found.' } });
    const d = req.body || {};
    if (d.status && String(d.status).toUpperCase() === 'CANCELLED') {
      await db.query("UPDATE appointments SET status='CANCELLED' WHERE id=? AND client_id=?", [req.params.id, req.portal.clientId]);
      notify({ recipientAudience: 'STAFF', title: 'Appointment cancelled by customer', message: `#${req.params.id}`, category: 'appointment', priority: 'high', relatedEntityType: 'appointment', relatedEntityId: Number(req.params.id), eventKey: `portal-appt-cancel-${req.params.id}` });
      return res.json({ success: true });
    }
    // Reschedule.
    await db.query('UPDATE appointments SET appointment_date=COALESCE(?,appointment_date), appointment_time=COALESCE(?,appointment_time), notes=COALESCE(?,notes) WHERE id=? AND client_id=?',
      [d.appointmentDate ?? null, d.appointmentTime ?? null, d.notes ?? null, req.params.id, req.portal.clientId]);
    if (d.appointmentDate || d.appointmentTime) {
      notify({ recipientAudience: 'STAFF', title: 'Appointment rescheduled by customer', message: `#${req.params.id} → ${d.appointmentDate || appt.appointment_date} ${d.appointmentTime || ''}`.trim(), category: 'appointment', relatedEntityType: 'appointment', relatedEntityId: Number(req.params.id), eventKey: `portal-appt-resched-${req.params.id}-${d.appointmentDate || ''}-${d.appointmentTime || ''}` });
    }
    res.json({ success: true });
  }));

  // ── Medical records ───────────────────────────────────────────────────────
  app.get('/api/portal/medical-records', portalAuth, asyncRoute(async (req, res) => {
    const cid = req.portal.clientId;
    if (req.query.petId && !(await ownedPet(req.query.petId, cid))) return res.status(404).json({ error: { message: 'Pet not found.' } });
    const petFilter = req.query.petId ? ' AND sn.pet_id=? ' : '';
    const params = req.query.petId ? [cid, req.query.petId] : [cid];
    const [notes] = await db.query(
      `SELECT sn.id, sn.pet_id, sn.appointment_id, sn.doctor, sn.subjective, sn.objective, sn.assessment, sn.diagnosis, sn.plan, sn.created_at, p.pet_name
       FROM soap_notes sn JOIN pets p ON sn.pet_id=p.id
       WHERE p.client_id=? ${petFilter} ORDER BY sn.created_at DESC LIMIT 200`, params);
    const vparams = req.query.petId ? [cid, req.query.petId] : [cid];
    const [vacc] = await db.query(
      `SELECT v.id, v.pet_id, v.vaccine_name, v.administered_on, v.next_due_date, v.batch_number, p.pet_name
       FROM vaccinations v JOIN pets p ON v.pet_id=p.id
       WHERE p.client_id=? ${req.query.petId ? ' AND v.pet_id=? ' : ''} ORDER BY v.administered_on DESC LIMIT 200`, vparams);
    const [deworm] = await db.query(
      `SELECT d.id, d.pet_id, d.product_name, d.administered_on, d.next_due_date, p.pet_name
       FROM dewormings d JOIN pets p ON d.pet_id=p.id
       WHERE p.client_id=? ${req.query.petId ? ' AND d.pet_id=? ' : ''} ORDER BY d.administered_on DESC LIMIT 200`, vparams);
    res.json({ data: { soapNotes: toCamel(notes), vaccinations: toCamel(vacc), dewormings: toCamel(deworm) } });
  }));

  // ── Boarding ──────────────────────────────────────────────────────────────
  app.get('/api/portal/boarding', portalAuth, asyncRoute(async (req, res) => {
    const [rows] = await db.query(
      `SELECT s.id, s.pet_id, s.date_in, s.date_out, s.expected_checkout_date, s.status, s.purpose, s.notes, p.pet_name
       FROM boarding_stays s JOIN pets p ON s.pet_id=p.id
       WHERE s.client_id=? ORDER BY s.id DESC LIMIT 100`, [req.portal.clientId]);
    res.json({ data: toCamel(rows) });
  }));
  app.post('/api/portal/boarding', portalAuth, asyncRoute(async (req, res) => {
    const d = req.body || {};
    const pet = await ownedPet(d.petId, req.portal.clientId);
    if (!pet) return res.status(404).json({ error: { message: 'Select one of your pets.' } });
    const [r] = await db.query('INSERT INTO boarding_stays (pet_id,client_id,date_in,expected_checkout_date,status,purpose,notes) VALUES (?,?,?,?,?,?,?)',
      [pet.id, req.portal.clientId, d.dateIn || new Date().toISOString().slice(0, 10), d.expectedCheckoutDate || null, 'REQUESTED', 'BOARDING', String(d.notes || '').slice(0, 1000)]);
    notify({ recipientAudience: 'STAFF', title: 'Boarding request from portal', message: `${pet.pet_name} — from ${d.dateIn || 'soon'}`, category: 'boarding', priority: 'high', relatedEntityType: 'boarding_stay', relatedEntityId: r.insertId, eventKey: `portal-boarding-${r.insertId}` });
    notify({ recipientAudience: 'CLIENT', recipientClientId: req.portal.clientId, title: 'Boarding request received', message: `We have received your boarding request for ${pet.pet_name}. The clinic will confirm availability.`, category: 'boarding', relatedEntityType: 'boarding_stay', relatedEntityId: r.insertId, actionUrl: '/portal/boarding', eventKey: `portal-boarding-client-${r.insertId}` });
    res.json({ data: { id: r.insertId } });
  }));

  // ── Billing ───────────────────────────────────────────────────────────────
  app.get('/api/portal/billing', portalAuth, asyncRoute(async (req, res) => {
    const [rows] = await db.query('SELECT id, appointment_id, invoice_no, subtotal, discount, final_total, amount_paid, status, payment_mode, created_at FROM billing WHERE client_id=? ORDER BY created_at DESC, id DESC LIMIT 200', [req.portal.clientId]);
    const [sum] = await db.query('SELECT COALESCE(SUM(final_total),0) AS billed, COALESCE(SUM(amount_paid),0) AS paid, COALESCE(SUM(final_total-amount_paid),0) AS due FROM billing WHERE client_id=?', [req.portal.clientId]);
    res.json({ data: toCamel(rows), summary: { billed: Number(sum[0].billed) || 0, paid: Number(sum[0].paid) || 0, due: Number(sum[0].due) || 0 } });
  }));
  app.get('/api/portal/billing/:id', portalAuth, asyncRoute(async (req, res) => {
    const [rows] = await db.query('SELECT * FROM billing WHERE id=? AND client_id=?', [req.params.id, req.portal.clientId]);
    if (!rows.length) return res.status(404).json({ error: { message: 'Invoice not found.' } });
    const [items] = await db.query('SELECT id, product_id, name, quantity, price, total FROM billing_items WHERE billing_id=?', [req.params.id]);
    const [bank] = await db.query('SELECT bank_name, bank_account_number FROM clinic_settings WHERE id=1');
    res.json({ data: { ...toCamel(rows[0]), items: toCamel(items), payment: { bankName: bank[0]?.bank_name || null, bankAccount: bank[0]?.bank_account_number || null } } });
  }));

  // ── Notifications ─────────────────────────────────────────────────────────
  app.get('/api/portal/notifications', portalAuth, asyncRoute(async (req, res) => {
    const lim = Math.min(P(req.query.limit) || 50, 200);
    const unreadOnly = String(req.query.unreadOnly) === 'true' || String(req.query.unreadOnly) === '1';
    const where = `recipient_audience='CLIENT' AND recipient_client_id=?` + (unreadOnly ? ' AND is_read=0' : '');
    const [rows] = await db.query(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, [req.portal.clientId, lim]);
    const [cnt] = await db.query("SELECT COUNT(*) AS total, SUM(is_read=0) AS unread FROM notifications WHERE recipient_audience='CLIENT' AND recipient_client_id=?", [req.portal.clientId]);
    res.json({ data: toCamel(rows), total: Number(cnt[0].total) || 0, unread: Number(cnt[0].unread) || 0 });
  }));
  app.get('/api/portal/notifications/count', portalAuth, asyncRoute(async (req, res) => {
    const [cnt] = await db.query("SELECT COUNT(*) AS total, SUM(is_read=0) AS unread FROM notifications WHERE recipient_audience='CLIENT' AND recipient_client_id=?", [req.portal.clientId]);
    res.json({ data: { total: Number(cnt[0].total) || 0, unread: Number(cnt[0].unread) || 0 } });
  }));
  app.patch('/api/portal/notifications/:id/read', portalAuth, asyncRoute(async (req, res) => {
    await db.query("UPDATE notifications SET is_read=1, read_at=IFNULL(read_at,NOW()) WHERE id=? AND recipient_audience='CLIENT' AND recipient_client_id=?", [req.params.id, req.portal.clientId]);
    res.json({ success: true });
  }));
  app.post('/api/portal/notifications/read-all', portalAuth, asyncRoute(async (req, res) => {
    await db.query("UPDATE notifications SET is_read=1, read_at=IFNULL(read_at,NOW()) WHERE is_read=0 AND recipient_audience='CLIENT' AND recipient_client_id=?", [req.portal.clientId]);
    res.json({ success: true });
  }));

  // ── Contact ───────────────────────────────────────────────────────────────
  app.get('/api/portal/contact', portalAuth, asyncRoute(async (req, res) => {
    const [s] = await db.query('SELECT clinic_name, phone, address, bank_name, bank_account_number FROM clinic_settings WHERE id=1');
    res.json({ data: { clinic: await clinicBrandingFor(req.portal.clinicId), bankName: s[0]?.bank_name || null, bankAccount: s[0]?.bank_account_number || null } });
  }));

  return { makePortalToken, verifyPortalToken, portalAuth };
};
