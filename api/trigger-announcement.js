/**
 * Garaj Defteri — Admin "📢 Duyuru / Bakım Mesajı Gönder" (Vercel Serverless Function)
 *
 * Uygulama içindeki admin duyuru ekranı artık Firestore'a bir bayrak
 * bırakıp GitHub Actions/daily-cron'un ~10 dakikada bir gelip görmesini
 * beklemek yerine, doğrudan bu endpoint'e istek atar ve duyuru ANINDA
 * (birkaç saniye içinde) tüm kullanıcılara gönderilir.
 *
 * GÜVENLİK: trigger-reminder.js ile aynı desen — çağıran kişinin ID
 * token'ı doğrulanır ve e-postası ADMIN_EMAIL ile eşleşmiyorsa reddedilir.
 * Başlık/mesaj da istemciden gelir, bu yüzden sunucu tarafında ayrıca
 * uzunluk sınırı uygulanır (istemci tarafındaki maxlength'e güvenilmez).
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

async function writeRunLog(db, logData, triggerSource) {
  try {
    await db.collection("runLogs").add(Object.assign({
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      triggerSource: triggerSource,
      isDailyRun: false
    }, logData));
  } catch (e) {
    console.error("runLog yazılamadı:", e && e.message ? e.message : e);
  }
}

async function sendAnnouncement(db, title, body, triggerSource) {
  const usersSnap = await db.collection("users").get();
  const tokenEntries = [];
  usersSnap.forEach((doc) => {
    const u = doc.data();
    (u.fcmTokens || []).forEach((t) => tokenEntries.push({ token: t, ownerId: doc.id }));
  });

  if (!tokenEntries.length) {
    await writeRunLog(db, {
      kind: "announcement",
      success: true,
      summary: `Duyuru "${title}" — gönderilecek kayıtlı cihaz bulunamadı.`,
      sentCount: 0,
      failedCount: 0
    }, triggerSource);
    return { deviceCount: 0, sentCount: 0, failedCount: 0 };
  }

  const CHUNK = 500;
  let totalSuccess = 0;
  let totalFailed = 0;
  const invalidByOwner = {};

  for (let i = 0; i < tokenEntries.length; i += CHUNK) {
    const chunk = tokenEntries.slice(i, i + CHUNK);
    const response = await admin.messaging().sendEachForMulticast({
      tokens: chunk.map((e) => e.token),
      notification: { title, body },
      data: { url: "/aracim/" }
    });
    totalSuccess += response.successCount;
    totalFailed += response.failureCount;
    response.responses.forEach((r, idx) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered") {
          const owner = chunk[idx].ownerId;
          if (!invalidByOwner[owner]) invalidByOwner[owner] = [];
          invalidByOwner[owner].push(chunk[idx].token);
        }
      }
    });
  }

  for (const ownerId of Object.keys(invalidByOwner)) {
    await db.collection("users").doc(ownerId).set({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidByOwner[ownerId])
    }, { merge: true }).catch(() => {});
  }

  await writeRunLog(db, {
    kind: "announcement",
    success: true,
    summary: `Duyuru gönderildi: "${title}" — ${tokenEntries.length} cihaza (${totalSuccess} başarılı, ${totalFailed} başarısız)`,
    sentCount: totalSuccess,
    failedCount: totalFailed
  }, triggerSource);

  return { deviceCount: tokenEntries.length, sentCount: totalSuccess, failedCount: totalFailed };
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
      res.status(403).json({ error: "Bu işlem için yetkiniz yok." });
      return;
    }

    // Vercel, body'yi Content-Type: application/json ise otomatik parse eder.
    const rawBody = req.body || {};
    const title = (rawBody.title || "").toString().trim().slice(0, 120);
    const body = (rawBody.body || "").toString().trim().slice(0, 400);

    if (!title || !body) {
      res.status(400).json({ error: "Başlık ve mesaj zorunludur." });
      return;
    }

    const db = admin.firestore();
    const result = await sendAnnouncement(db, title, body, `manual:${decoded.email}`);

    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("Hata:", err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
