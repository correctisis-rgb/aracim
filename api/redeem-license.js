/**
 * Garaj Defteri — Lisans Kodu Kullanma (Vercel Serverless Function)
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

function normalizeCode(code) {
  return String(code || "").trim().toUpperCase().replace(/\s+/g, "");
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Sadece POST kabul edilir." });
    return;
  }

  const authHeader = req.headers["authorization"] || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: "Kimlik doğrulama token'ı gerekli." });
    return;
  }

  const code = normalizeCode(req.body && req.body.code);
  if (!code) {
    res.status(400).json({ error: "Lisans kodu gerekli." });
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

    const uid = decoded.uid;
    const db = admin.firestore();

    const userRef = db.collection("users").doc(uid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      res.status(404).json({ error: "Kullanıcı bulunamadı." });
      return;
    }
    const userData = userSnap.data() || {};

    const householdId = userData.householdId && userData.householdId !== uid
      ? null
      : uid;

    if (!householdId) {
      res.status(403).json({ error: "Sadece hane sahibi lisans girebilir." });
      return;
    }

    const licenseRef = db.collection("licenses").doc(code);
    const householdRef = db.collection("users").doc(householdId);

    const result = await db.runTransaction(async (tx) => {
      const licenseSnap = await tx.get(licenseRef);
      if (!licenseSnap.exists) {
        throw new Error("NOT_FOUND");
      }
      const license = licenseSnap.data();
      if (license.used) {
        throw new Error("ALREADY_USED");
      }
      if (license.revoked) {
        throw new Error("REVOKED");
      }

      const days = Number(license.days) || 365;
      const now = new Date();
      const householdSnap = await tx.get(householdRef);
      const existing = (householdSnap.data() || {}).license;

      let baseDate = now;
      if (existing && existing.expiresAt && existing.expiresAt.toDate) {
        const currentExpiry = existing.expiresAt.toDate();
        if (currentExpiry > now) baseDate = currentExpiry;
      }

      const expiresAt = new Date(baseDate.getTime() + days * 86400000);

      tx.set(licenseRef, {
        used: true,
        usedBy: uid,
        usedByHousehold: householdId,
        usedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      tx.set(householdRef, {
        license: {
          code: code,
          days: days,
          activatedAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
          active: true
        }
      }, { merge: true });

      return { expiresAt: expiresAt.toISOString(), days };
    });

    res.status(200).json({ ok: true, expiresAt: result.expiresAt, days: result.days });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (message === "NOT_FOUND") {
      res.status(404).json({ ok: false, error: "Geçersiz lisans kodu." });
      return;
    }
    if (message === "ALREADY_USED") {
      res.status(409).json({ ok: false, error: "Bu lisans kodu daha önce kullanılmış." });
      return;
    }
    if (message === "REVOKED") {
      res.status(410).json({ ok: false, error: "Bu lisans kodu iptal edilmiş." });
      return;
    }
    console.error("Hata:", err);
    res.status(500).json({ ok: false, error: message });
  }
};
