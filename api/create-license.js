/**
 * Garaj Defteri — Admin Lisans Kodu Oluşturma (Vercel Serverless Function)
 * DEĞİŞİKLİK: artık "plan" zorunlu (free | standard | fleet). Süre ve
 * limitler plan-config.js'den otomatik gelir; "days" admin tarafından
 * promosyon için elle override edilebilir (opsiyonel). "free" planı da
 * BURADAN üretilebilir (destek/promosyon amaçlı manuel kod), ama asıl
 * kullanıcı akışı activate-free-plan.js ile koda GEREK KALMADAN otomatik
 * çalışır — bu ikisi birbirini dışlamaz.
 */

const admin = require("firebase-admin");
const { PLANS, isValidPlan } = require("./plan-config");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "emre121856031@gmail.com";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function getAdmin() {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin;
}

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 10; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
    if (i === 4) s += "-";
  }
  return "LIC-" + s;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Sadece POST kabul edilir." }); return; }

  const authHeader = req.headers["authorization"] || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) { res.status(401).json({ error: "Kimlik doğrulama token'ı gerekli." }); return; }

  // --- Plan doğrulama ---
  // NOT: "free" planı da admin panelden manuel üretilebilir (ör. destek
  // ekibinin promosyon/telafi amaçlı elle kod vermesi için). Kullanıcıların
  // asıl otomatik ücretsiz plan akışı activate-free-plan.js üzerinden,
  // kod GEREKMEDEN çalışır — bu ikisi birbirini dışlamaz.
  const plan = String((req.body && req.body.plan) || "").toLowerCase();
  if (!isValidPlan(plan)) {
    res.status(400).json({ error: "Geçerli bir plan gir: free, standard veya fleet." });
    return;
  }
  const planConfig = PLANS[plan];

  const count = Math.min(Math.max(Number(req.body && req.body.count) || 1, 1), 20);
  const label = (req.body && req.body.label) ? String(req.body.label).slice(0, 40) : "";

  // Süre: admin özel bir gün sayısı verdiyse onu kullan (promosyon vs.), yoksa plan varsayılanı
  const requestedDays = Number(req.body && req.body.days);
  const days = requestedDays > 0 && requestedDays <= 3650 ? requestedDays : planConfig.days;

  // Filo planında araç sayısı müşteriye özel olabilir (ör. "50 araca kadar")
  let maxVehicles = planConfig.maxVehicles;
  if (plan === "fleet" && req.body && req.body.maxVehicles) {
    const customLimit = Number(req.body.maxVehicles);
    if (customLimit > 0) maxVehicles = customLimit;
  }

  try {
    getAdmin();

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      res.status(401).json({ error: "Geçersiz veya süresi dolmuş token." });
      return;
    }

    if (!decoded.email || decoded.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      res.status(403).json({ error: "Bu işlem için yetkin yok." });
      return;
    }

    const db = admin.firestore();
    const batch = db.batch();
    const codes = [];

    for (let i = 0; i < count; i++) {
      let code = generateCode();
      codes.push(code);
      const ref = db.collection("licenses").doc(code);
      batch.set(ref, {
        code: code,
        plan: plan,
        days: days,
        maxVehicles: maxVehicles,
        maxUsers: planConfig.maxUsers,
        features: planConfig.features,
        label: label,
        used: false,
        revoked: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: decoded.uid,
        usedBy: null,
        usedByHousehold: null,
        usedAt: null
      });
    }

    await batch.commit();

    res.status(200).json({ ok: true, codes: codes, plan: plan, days: days, maxVehicles: maxVehicles });
  } catch (err) {
    console.error("Hata:", err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
