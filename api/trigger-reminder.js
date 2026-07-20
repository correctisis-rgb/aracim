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
 *
 * ORTAK HANE DÜZELTMESİ:
 * Araç/masraf verileri her zaman hane sahibinin dokümanında
 * (users/{householdId}.cars) tutulur, ama her üyenin bildirim token'ı
 * (fcmTokens) kendi kişisel dokümanında saklanır. Eskiden tarama sadece
 * "aynı doküman içindeki cars + aynı dokümandaki fcmTokens" eşleşmesine
 * bakıyordu; bu yüzden hane sahibi bildirim alırken sonradan katılan
 * üyeler hiç bildirim almıyordu. Şimdi hane dokümanındaki `members`
 * listesi kullanılarak her üyenin kendi dokümanından token'ları da
 * toplanıp ayrıca bildirim gönderiliyor (üyelere hangi ortak hesaptan
 * geldiği belli olsun diye mesaj metni farklılaştırılıyor).
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

// Bir kullanıcı dokümanındaki token listesine bildirim gönderir,
// geçersiz token'ları o dokümandan temizler ve gönderim sayaçlarını döner.
// extraData: { carId, fieldKey, actionable } gibi ek alanlar; sw.js bunları
// okuyup bildirime "Evet / Hayır" aksiyon düğmeleri ekler. FCM data
// payload'ı yalnızca string değer kabul eder, bu yüzden burada stringe
// çeviriyoruz.
async function sendToTokens(db, docId, tokens, title, body, extraData) {
  if (!tokens || !tokens.length) return { sent: 0, failed: 0 };

  var dataPayload = Object.assign({ url: "/aracim/" }, extraData || {});
  var stringData = {};
  Object.keys(dataPayload).forEach(function (k) {
    if (dataPayload[k] != null) stringData[k] = String(dataPayload[k]);
  });

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: stringData
  });

  const invalidTokens = [];
  response.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered") {
        invalidTokens.push(tokens[i]);
      }
    }
  });

  if (invalidTokens.length) {
    await db.collection("users").doc(docId).set({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokens)
    }, { merge: true }).catch((e) => console.error("Geçersiz token temizlenemedi:", docId, e && e.message ? e.message : e));
  }

  return { sent: response.successCount, failed: response.failureCount };
}

async function runFullScan(db, bypassDedup, triggerSource) {
  const usersSnap = await db.collection("users").get();

  let usersNotified = 0;
  let totalSent = 0;
  let totalFailed = 0;

  for (const userDoc of usersSnap.docs) {
    const user = userDoc.data();
    const ownerId = userDoc.id;

    // Araç verisi her zaman hane sahibinin dokümanında durur. Eğer bu
    // kullanıcı başka bir hanenin üyesiyse (householdId kendi id'sinden
    // farklıysa), kendi dokümanındaki `cars` alanı eskiden kalma/aktif
    // olmayan veridir — bu dokümanı atla, gerçek veri o hanenin
    // sahibinin dokümanı taranırken zaten işlenecek.
    if (user.householdId && user.householdId !== ownerId) continue;

    const cars = user.cars || [];
    if (!cars.length) continue;

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
        triggered.push({ text: `${f.emoji} ${carName}: ${f.label} ${dayText}`, carId: car.id, fieldKey: f.key });
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
            triggered.push({ text: `🔧 ${carName}: ${kmText}`, carId: car.id, fieldKey: null });
          }
        }
      }
    });

    if (!triggered.length) continue;

    const title = triggered.length === 1 ? "Garaj Defteri — Hatırlatma" : `Garaj Defteri — ${triggered.length} Hatırlatma`;
    const bodyBase = triggered.slice(0, 3).map((t) => t.text).join("  •  ") + (triggered.length > 3 ? ` (+${triggered.length - 3} diğer)` : "");

    // Tek bir tarihe bağlı işlem tetiklendiyse (ör. sadece Muayene), bildirime
    // "Evet, randevu aldım / Hayır" aksiyon düğmeleri ekleyebiliriz. Birden
    // fazla işlem aynı anda tetiklenirse ya da tetiklenen tek şey km bazlı bir
    // bakım uyarısıysa (fieldKey yok), aksiyon eklemiyoruz — hangi işlem için
    // olduğu net değil.
    // Tek bir tarihe bağlı işlem tetiklendiyse (ör. sadece Muayene), bildirime
    // "Evet, randevu aldım / Hayır" aksiyon düğmeleri ekleyebiliriz. Km bazlı
    // bakım uyarısı gibi tarihi olmayan işlemler (fieldKey yok) bu sayıma
    // dahil edilmez — yani "Muayene 3 gün içinde" + "bakıma 1.651 km kaldı"
    // aynı anda tetiklense bile, tarihe bağlı olan tek (Muayene) olduğu için
    // yine de butonlar eklenir. Birden fazla FARKLI tarihe bağlı işlem aynı
    // anda tetiklenirse (ör. hem Muayene hem Sigorta), hangisi için olduğu
    // net olmadığından buton eklenmez.
    const dateBasedItems = triggered.filter((t) => t.fieldKey);
    let actionData = null;
    if (dateBasedItems.length === 1) {
      actionData = { carId: dateBasedItems[0].carId, fieldKey: dateBasedItems[0].fieldKey, actionable: "true" };
    }

    // --- Hane sahibine gönder ---
    const ownerTokens = user.fcmTokens || [];
    const ownerResult = await sendToTokens(db, ownerId, ownerTokens, title, bodyBase, actionData);
    totalSent += ownerResult.sent;
    totalFailed += ownerResult.failed;
    if (ownerResult.sent > 0) usersNotified++;

    // --- Ortak haneye katılmış diğer üyelere gönder ---
    const ownerProfile = (user.memberProfiles && user.memberProfiles[ownerId]) || {};
    const ownerName = ownerProfile.name || user.name || "Hane sahibi";
    const memberBody = `Ortak hesabınız (${ownerName}) — ` + bodyBase;

    const memberUids = Array.isArray(user.members)
      ? user.members.filter((uid) => uid && uid !== ownerId)
      : [];

    for (const memberUid of memberUids) {
      try {
        const memberSnap = await db.collection("users").doc(memberUid).get();
        if (!memberSnap.exists) continue;
        const memberData = memberSnap.data() || {};
        const memberTokens = memberData.fcmTokens || [];
        if (!memberTokens.length) continue;

        const memberResult = await sendToTokens(db, memberUid, memberTokens, title, memberBody, actionData);
        totalSent += memberResult.sent;
        totalFailed += memberResult.failed;
        if (memberResult.sent > 0) usersNotified++;
      } catch (e) {
        console.error("Üyeye bildirim gönderilemedi:", memberUid, e && e.message ? e.message : e);
      }
    }

    // notifState tüm hane için ortak/tek bir yerde (hane sahibinin
    // dokümanında) tutulur, böylece aynı eşik tekrar tekrar herkese
    // gönderilmez.
    await db.collection("users").doc(ownerId).set({ notifState: newNotifState }, { merge: true });
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
    const triggerDocRef = db.collection("admin").doc("reminderTrigger");

    // Sağlık panelindeki "Hatırlatma Tetikleyici" kutusu bu dokümanı okur.
    // Önce "isteniyor" durumunu yazıyoruz, tarama bitince "işlendi" olarak
    // güncelliyoruz — böylece panel her manuel tetiklemede gerçek zamanlı
    // güncelleniyor.
    await triggerDocRef.set({
      requested: true,
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
      requestedBy: decoded.email
    }, { merge: true });

    // Manuel tetikleme: admin bilerek bastığı için, aynı gün/aynı km eşiği
    // daha önce bildirildiyse bile tekrar gönderilir (bypassDedup = true).
    const result = await runFullScan(db, /* bypassDedup */ true, `manual:${decoded.email}`);

    await triggerDocRef.set({
      requested: false,
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("Hata:", err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
