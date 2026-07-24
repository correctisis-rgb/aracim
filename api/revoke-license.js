/**
 * Garaj Defteri — Admin Lisans İptali (Vercel Serverless Function)
 *
 * İki mod destekler (body.type ile seçilir):
 *  - type: "code"      -> body.code: henüz KULLANILMAMIŞ bir lisans kodunu
 *                          iptal eder (revoked:true), bir daha kullanılamaz.
 *  - type: "household"  -> body.householdId: o hanenin AKTİF lisansını
 *                          anında sona erdirir (license.expiresAt = şimdi).
 *                          Kod/gün geçmişi silinmez, sadece süresi doldurulur.
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

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Sadece POST kabul edilir." }); return; }

  const authHeader = req.headers["authorization"] || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) { res.status(401).json({ error: "Kimlik doğrulama token'ı gerekli." }); return; }

  const type = (req.body && req.body.type) === "household" ? "household" : "code";

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

    if (type === "household") {
      const householdId = req.body && req.body.householdId;
      if (!householdId) { res.status(400).json({ error: "householdId gerekli." }); return; }

      const householdRef = db.collection("users").doc(householdId);
      const snap = await householdRef.get();
      if (!snap.exists) { res.status(404).json({ ok: false, error: "Hane bulunamadı." }); return; }

      // Sadece license.expiresAt'i geçmişe çekiyoruz; code/days/activatedAt
      // gibi geçmiş bilgisi silinmiyor, hane sadece anında salt-okunur moda düşüyor.
      await householdRef.set({
        license: {
          expiresAt: admin.firestore.Timestamp.now(),
          revokedAt: admin.firestore.FieldValue.serverTimestamp(),
          revokedBy: decoded.uid
        }
      }, { merge: true });

      res.status(200).json({ ok: true });
      return;
    }

    const code = normalizeCode(req.body && req.body.code);
    if (!code) { res.status(400).json({ error: "Lisans kodu gerekli." }); return; }

    const licenseRef = db.collection("licenses").doc(code);
    const snap = await licenseRef.get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: "Kod bulunamadı." }); return; }

    const license = snap.data() || {};
    if (license.used) {
      res.status(409).json({ ok: false, error: "Bu kod zaten kullanılmış; sadece kullanılmamış kodlar iptal edilebilir. Haneyi iptal etmek için 'Lisanslı Haneler' listesindeki iptal düğmesini kullan." });
      return;
    }

    await licenseRef.set({
      revoked: true,
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
      revokedBy: decoded.uid
    }, { merge: true });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Hata:", err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
