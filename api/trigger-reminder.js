/**
 * Garaj Defteri — Admin "Bildirimleri Tetikle" butonu (Vercel Serverless Function)
 *
 * Uygulama içindeki admin butonu artık Firestore'a bir bayrak bırakıp
 * GitHub Actions'ın ~10 dakikada bir gelip görmesini beklemek yerine,
 * doğrudan bu endpoint'e istek atar ve tarama ANINDA (birkaç saniye içinde)
 * çalışır.
 *
 * GÜVENLİK: Bu endpoint herkese açık bir URL'de durur, bu yüzden çağıran
 * kişinin gerçekten admin olduğunu doğrulamamız gerekir. İstemci, kendi
 * Firebase Auth ID token'ını gönderir; biz bunu firebase-admin ile
 * doğrulayıp e-posta adresinin ADMIN_EMAIL ile eştiğini kontrol ederiz.
 * Servis hesabı anahtarı hiçbir zaman istemciye gönderilmez.
 */

const admin = require("firebase-admin");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "emre121856031@gmail.com";
// Tarayıcıdan (uygulamanın barındırıldığı origin) çağrılara izin vermek için.
// İsterseniz bunu tam origin ile ("https://sizin-siteniz.com") sınırlayabilirsiniz.
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

const DATE_FIELDS = [
  { key: "inspectionDate", label: "Muayene", emoji: "🗓️" },
  { key: "maintenanceDate", label: "Bakım / Servis", emoji: "🔧" },
  { key: "insuranceDate", label: "Trafik Sigortası", emoji: "🛡️" },
  { key: "kaskoDate", label: "Kasko", emoji: "🚙" },
  { key: "taxDate", label: "Vergi (MTV)", emoji: "💰" },
  { key: "tireDate", label: "Lastik Değişimi", emoji: "🛞" }
];

const DAY_THRESHOLDS = [7, 3, 1, 0];
const KM_THRESHOLDS = [3000, 1000, 0];

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

function kmTier(remaining) {
  if (remaining == null) return null;
  const sorted = [...KM_THRESHOLDS].sort((a, b) => a - b);
  for (const t of sorted) {
    if (remaining <= t) return t;
  }
  return null;
}

async function runFullScan(db, bypassDedup, triggerSource) {
  const usersSnap = await db.collection("users").get();

  let usersNotified = 0;
  let totalSent = 0;
  let totalFailed = 0;

  for (const userDoc of usersSnap.docs) {
    const user = userDoc.data();
    const tokens = user.fcmTokens || [];
    if (!tokens.length) continue;

    const cars = user.cars || [];
    const notifState = user.notifState || {};
    const newNotifState = Object.assign({}, notifState);
    const triggered = [];

    cars.forEach((car) => {
      DATE_FIELDS.forEach((f) => {
        const dateVal = car[f.key];
        if (!dateVal) return;
        const days = daysUntil(dateVal);
        if (days == null) return;
        if (!DAY_THRESHOLDS.includes(days)) return;

        const stateKey = car.id + "_" + f.key;
        if (!bypassDedup && newNotifState[stateKey] === days) return;

        newNotifState[stateKey] = days;
        const carName = car.name || "Aracın";
        const dayText = days === 0 ? "bugün" : days + " gün içinde";
        triggered.push(`${f.emoji} ${carName}: ${f.label} ${dayText}`);
      });

      if (car.maintenanceKm != null && car.currentKm != null) {
        const remaining = car.maintenanceKm - car.currentKm;
        const tier = kmTier(remaining);
        if (tier != null) {
          const stateKey = car.id + "_maintenanceKm";
          if (bypassDedup || newNotifState[stateKey] !== tier) {
            newNotifState[stateKey] = tier;
            const carName = car.name || "Aracın";
            const kmText = remaining <= 0
              ? `bakım kilometresi ${Math.abs(Math.round(remaining)).toLocaleString("tr-TR")} km geçti`
              : `bakıma ${Math.round(remaining).toLocaleString("tr-TR")} km kaldı`;
            triggered.push(`🔧 ${carName}: ${kmText}`);
          }
        }
      }
    });

    if (!triggered.length) continue;

    const title = triggered.length === 1 ? "Garaj Defteri — Hatırlatma" : `Garaj Defteri — ${triggered.length} hatırlatma`;
    const body = triggered.slice(0, 3).join("  •  ") + (triggered.length > 3 ? ` (+${triggered.length - 3} diğer)` : "");

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { url: "/aracim/" }
    });

    usersNotified++;
    totalSent += response.successCount;
    totalFailed += response.failureCount;

    const invalidTokens = [];
    response.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered") {
          invalidTokens.push(tokens[i]);
        }
      }
    });

    const update = { notifState: newNotifState };
    if (invalidTokens.length) {
      update.fcmTokens = admin.firestore.FieldValue.arrayRemove(...invalidTokens);
    }
    await db.collection("users").doc(userDoc.id).set(update, { merge: true });
  }

  await writeRunLog(db, {
    success: true,
    summary: usersNotified
      ? `${usersNotified} kullanıcıya bildirim gönderildi (${totalSent} başarılı, ${totalFailed} başarısız)`
      : "Taransa bildirim gönderilecek durum bulunamadı",
    scannedUsers: usersSnap.size,
    usersNotified,
    sentCount: totalSent,
    failedCount: totalFailed
  }, triggerSource);

  return { usersScanned: usersSnap.size, usersNotified, totalSent, totalFailed };
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

  // Authorization: Bearer <Firebase ID Token>
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

    const db = admin.firestore();
    // Manuel tetikleme: admin bilerek bastığı için, aynı gün/aynı km eşiği
    // daha önce bildirildiyse bile tekrar gönderilir (bypassDedup = true).
    const result = await runFullScan(db, /* bypassDedup */ true, `manual:${decoded.email}`);

    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("Hata:", err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
