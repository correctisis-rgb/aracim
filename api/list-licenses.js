/**
 * Garaj Defteri — Admin Lisans Listesi (Vercel Serverless Function)
 * Tüm lisans kodlarını ve şu an aktif lisansı olan haneleri döner.
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

// Firestore Timestamp örnekleri JSON.stringify ile doğrudan gönderilirse
// istemcinin beklediği .toMillis()/.seconds yerine {_seconds,_nanoseconds}
// gibi iç alanlara serileşir ve istemci tarihi okuyamaz (bkz. "0 gün kaldı"
// hatası). Bu yüzden yanıta koymadan önce hepsini düz milisaniyeye çeviriyoruz.
function tsToMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts._seconds === "number") return ts._seconds * 1000 + Math.round((ts._nanoseconds || 0) / 1e6);
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  return null;
}
function serializeLicense(lic) {
  if (!lic) return null;
  return Object.assign({}, lic, {
    activatedAt: tsToMillis(lic.activatedAt),
    expiresAt: tsToMillis(lic.expiresAt)
  });
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

    const licensesSnap = await db.collection("licenses").orderBy("createdAt", "desc").limit(200).get();
    const licenses = [];
    licensesSnap.forEach((d) => {
      const data = d.data() || {};
      licenses.push(Object.assign({}, data, {
        id: d.id,
        createdAt: tsToMillis(data.createdAt),
        usedAt: tsToMillis(data.usedAt)
      }));
    });

    const now = admin.firestore.Timestamp.now();
    const householdsSnap = await db.collection("users")
      .where("license.expiresAt", ">", now)
      .orderBy("license.expiresAt", "asc")
      .limit(500)
      .get();
    const households = [];
    householdsSnap.forEach((d) => {
      const data = d.data() || {};
      households.push({
        id: d.id,
        name: data.name || "",
        email: data.email || "",
        license: serializeLicense(data.license)
      });
    });

    res.status(200).json({ ok: true, licenses: licenses, households: households });
  } catch (err) {
    console.error("Hata:", err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
