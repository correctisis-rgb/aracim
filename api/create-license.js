/**
 * Garaj Defteri — Admin Lisans Kodu Oluşturma (Vercel Serverless Function)
 */

const admin = require("firebase-admin");

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

  const days = Number(req.body && req.body.days);
  const count = Math.min(Math.max(Number(req.body && req.body.count) || 1, 1), 20);
  const label = (req.body && req.body.label) ? String(req.body.label).slice(0, 40) : "";

  if (!days || days <= 0 || days > 3650) {
    res.status(400).json({ error: "Geçerli bir gün sayısı gir (1-3650)." });
    return;
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
        days: days,
        label: label,
        used: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdBy: decoded.uid,
        usedBy: null,
        usedByHousehold: null,
        usedAt: null
      });
    }

    await batch.commit();

    res.status(200).json({ ok: true, codes: codes, days: days });
  } catch (err) {
    console.error("Hata:", err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
