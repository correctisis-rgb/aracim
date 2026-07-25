/**
 * Garaj Defteri — Ücretsiz Plan Aktivasyonu / Otomatik Yenileme
 * (Vercel Serverless Function)
 *
 * create-license.js / redeem-license.js akışının aksine burada ADMIN KODU
 * YOK. Herhangi bir giriş yapmış kullanıcı bu endpoint'i çağırabilir.
 *
 * Ne zaman çağrılır:
 *  1) Yeni kayıt olan kullanıcıda (onboarding sonunda) — ilk 30 günlük
 *     ücretsiz lisansı açar.
 *  2) Uygulama her açılışında (ya da günlük bir arka plan görevinde) —
 *     ücretsiz plan süresi dolmaya yakınsa (<= 2 gün) otomatik uzatır.
 *     Bu, "ücretsiz plan sürekli otomatik yenilensin" isteğinin karşılığı.
 *
 * Davranış kuralları:
 *  - Kullanıcının halihazırda AKTİF ve SÜRESİ DOLMAMIŞ standard/fleet
 *    planı varsa BU ENDPOINT ONA DOKUNMAZ (ücretli kullanıcı asla free'ye
 *    düşürülmez). Sadece mevcut durumu döner.
 *  - Ücretsiz plan zaten aktifse ve süresi 2 günden uzunsa hiçbir şey
 *    yapmaz (gereksiz Firestore yazımını önler), mevcut expiresAt'i döner.
 *  - Ücretsiz plan süresi dolmuşsa VEYA bitmesine <=2 gün kalmışsa,
 *    süreyi yeniden 30 güne uzatır.
 *  - Ücretli plan süresi dolmuşsa (ödeme yenilenmemiş), kullanıcı otomatik
 *    olarak free plana düşürülür (1 araç limiti ile devam edebilsin diye).
 */

const admin = require("firebase-admin");
const { PLANS } = require("./plan-config");

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const RENEWAL_WINDOW_MS = 2 * 24 * 60 * 60 * 1000; // son 2 gün içinde otomatik uzat

function getAdmin() {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin;
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
      res.status(403).json({ error: "Sadece hane sahibi plan durumunu değiştirebilir." });
      return;
    }

    const householdRef = db.collection("users").doc(householdId);
    const freeConfig = PLANS.free;

    const result = await db.runTransaction(async (tx) => {
      const householdSnap = await tx.get(householdRef);
      const existing = (householdSnap.data() || {}).license;
      const now = new Date();

      const existingExpiry = existing && existing.expiresAt && existing.expiresAt.toDate
        ? existing.expiresAt.toDate()
        : null;
      const isPaidPlan = existing && (existing.plan === "standard" || existing.plan === "fleet");
      const isPaidActive = isPaidPlan && existingExpiry && existingExpiry > now;

      // Ücretli plan hâlâ aktif -> dokunma
      if (isPaidActive) {
        return { changed: false, plan: existing.plan, expiresAt: existingExpiry.toISOString() };
      }

      // Ücretsiz plan zaten aktif ve yenileme penceresine girmemiş -> dokunma
      const isFreeStillFresh =
        existing &&
        existing.plan === "free" &&
        existingExpiry &&
        existingExpiry.getTime() - now.getTime() > RENEWAL_WINDOW_MS;

      if (isFreeStillFresh) {
        return { changed: false, plan: "free", expiresAt: existingExpiry.toISOString() };
      }

      // Yeni free süresi: mevcut free süresi henüz dolmadıysa üzerine ekle,
      // doldu/hiç yoksa/ücretli plan süresi dolduysa şimdiden başlat.
      const baseDate =
        existing && existing.plan === "free" && existingExpiry && existingExpiry > now
          ? existingExpiry
          : now;

      const expiresAt = new Date(baseDate.getTime() + freeConfig.days * 86400000);

      tx.set(householdRef, {
        license: {
          code: null,
          plan: "free",
          days: freeConfig.days,
          maxVehicles: freeConfig.maxVehicles,
          maxUsers: freeConfig.maxUsers,
          features: freeConfig.features,
          activatedAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
          active: true
        }
      }, { merge: true });

      return { changed: true, plan: "free", expiresAt: expiresAt.toISOString() };
    });

    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("Hata:", err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
