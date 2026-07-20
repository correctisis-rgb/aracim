/**
 * Garaj Defteri — Günlük Hatırlatma Bildirimi (Vercel Cron Job)
 *
 * Bu fonksiyon Vercel'in ücretsiz (Hobby) plandaki Cron Jobs özelliği ile
 * her gün 06:00 UTC'de (09:00 TR) otomatik olarak çağrılır (bkz. vercel.json).
 * Firebase Admin SDK ile Firestore'u okuyup FCM push bildirimi gönderir.
 *
 * GÜVENLİK: Vercel, projede bir CRON_SECRET ortam değişkeni tanımlıysa,
 * cron çağrısına otomatik olarak "Authorization: Bearer <CRON_SECRET>"
 * header'ı ekler. Bu fonksiyon bu header'ı doğrulayarak, endpoint URL'ini
 * bilen başka birinin taramayı dışarıdan tetiklemesini engeller.
 */

const admin = require("firebase-admin");

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
      isDailyRun: true
    }, logData));
  } catch (e) {
    console.error("runLog yazılamadı:", e && e.message ? e.message : e);
  }
}

async function checkAndSendAnnouncement(db) {
  const ref = db.collection("admin").doc("announcementTrigger");
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : null;
  if (!data || data.requested !== true) return;

  const title = (data.title || "Garaj Defteri").toString().slice(0, 120);
  const body = (data.body || "").toString().slice(0, 400);

  if (!body) {
    await ref.set({ requested: false, processedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return;
  }

  console.log(`Duyuru bayrağı bulundu (${data.requestedBy || "bilinmiyor"}): "${title}" gönderiliyor...`);

  const usersSnap = await db.collection("users").get();
  const tokenEntries = [];
  // userInfoById: TÜM kullanıcıları (token'ı olsun olmasın) baştan kaydeder,
  // böylece admin panelindeki "kimlere ulaştı/ulaşmadı" listesinde hiç cihaz
  // kaydı olmayan kullanıcılar da (0 cihaz olarak) görünür.
  const userInfoById = {};
  usersSnap.forEach((doc) => {
    const u = doc.data();
    userInfoById[doc.id] = { name: u.name || u.email || doc.id, email: u.email || "" };
    (u.fcmTokens || []).forEach((t) => tokenEntries.push({ token: t, ownerId: doc.id }));
  });

  if (!tokenEntries.length) {
    const recipients = Object.keys(userInfoById).map((id) => ({
      household: userInfoById[id].name,
      members: [{ name: userInfoById[id].name, email: userInfoById[id].email, deviceCount: 0, success: false, failed: 0 }]
    }));
    await ref.set({ requested: false, processedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await writeRunLog(db, Object.assign({
      kind: "announcement",
      success: true,
      summary: `Duyuru "${title}" — gönderilecek kayıtlı cihaz bulunamadı.`,
      sentCount: 0,
      failedCount: 0
    }, recipients.length ? { recipients } : {}), "vercel-cron");
    return;
  }

  const CHUNK = 500;
  let totalSuccess = 0;
  let totalFailed = 0;
  const invalidByOwner = {};
  const deviceResultsByOwner = {}; // ownerId -> { success, failed }

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
      const owner = chunk[idx].ownerId;
      if (!deviceResultsByOwner[owner]) deviceResultsByOwner[owner] = { success: 0, failed: 0 };
      if (r.success) {
        deviceResultsByOwner[owner].success++;
      } else {
        deviceResultsByOwner[owner].failed++;
        const code = r.error && r.error.code;
        if (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered") {
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

  // recipients: admin panelinin "kimlere ulaştı/ulaşmadı" listesi için —
  // her kullanıcı tek üyeli bir "hane" olarak eklenir (bkz. index.html
  // renderRunLogRecipients). Hiç cihazı olmayan kullanıcılar da (deviceCount: 0,
  // success: false) listede görünür.
  const recipients = Object.keys(userInfoById).map((id) => {
    const info = userInfoById[id];
    const res = deviceResultsByOwner[id] || { success: 0, failed: 0 };
    const deviceCount = res.success + res.failed;
    return {
      household: info.name,
      members: [{ name: info.name, email: info.email, deviceCount, success: deviceCount > 0 && res.failed === 0, failed: res.failed }]
    };
  });

  await ref.set({ requested: false, processedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

  await writeRunLog(db, {
    kind: "announcement",
    success: true,
    summary: `Duyuru gönderildi: "${title}" — ${tokenEntries.length} cihaza (${totalSuccess} başarılı, ${totalFailed} başarısız)`,
    sentCount: totalSuccess,
    failedCount: totalFailed,
    recipients
  }, "vercel-cron");
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
  console.log(`Toplam ${usersSnap.size} kullanıcı taranıyor...`);

  let usersNotified = 0;
  let totalSent = 0;
  let totalFailed = 0;
  // recipients: her bildirim gönderilen kullanıcı için admin panelindeki
  // "kimlere ulaştı/ulaşmadı" listesinde gösterilecek kırılım (bkz.
  // index.html renderRunLogRecipients). Bu dosyada hane üyesi birleştirme
  // yapılmadığından her giriş tek üyeli bir "hane"dir.
  const recipients = [];

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
        triggered.push({ text: `${f.emoji} ${carName}: ${f.label} ${dayText}`, carId: car.id, fieldKey: f.key, actionable: true });
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
            triggered.push({ text: `🔧 ${carName}: ${kmText}`, carId: car.id, fieldKey: null, actionable: false });
          }
        }
      }
    });

    if (!triggered.length) continue;

    const title = triggered.length === 1 ? "Garaj Defteri — Hatırlatma" : `Garaj Defteri — ${triggered.length} Hatırlatma`;
    const body = triggered.slice(0, 3).map((t) => t.text).join("  •  ") + (triggered.length > 3 ? ` (+${triggered.length - 3} diğer)` : "");

    // Tek bir tarihe bağlı işlem tetiklendiyse, bildirime sw.js'in okuyup
    // "Evet, randevu aldım / Hayır" aksiyon düğmelerine çevireceği carId/
    // fieldKey bilgisini ekliyoruz.
    // Tek bir tarihe bağlı işlem tetiklendiyse, butonları ekle — km bazlı
    // uyarılar bu sayıma dahil edilmez (bkz. trigger-reminder.js'teki not).
    const dateBasedItems = triggered.filter((t) => t.actionable && t.fieldKey);
    let actionData = null;
    if (dateBasedItems.length === 1) {
      actionData = { carId: dateBasedItems[0].carId, fieldKey: dateBasedItems[0].fieldKey, actionable: "true" };
    } else if (dateBasedItems.length > 1) {
      // Birden fazla farklı tarihe bağlı işlem birlikte tetiklendiğinde tek
      // bir carId/fieldKey seçemeyiz (Evet/Hayır aksiyon düğmeleri de
      // eklenmez), ama sw.js'in bildirime tıklanınca uygulamayı bir seçim
      // ekranıyla açabilmesi için hepsinin listesini "carId:fieldKey,carId:fieldKey"
      // formatında gönderiyoruz.
      actionData = { multiAppt: dateBasedItems.map((t) => `${t.carId}:${t.fieldKey}`).join(",") };
    }

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: Object.assign({ url: "/aracim/" }, actionData || {})
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

    const failedCountForUser = response.responses.filter((r) => !r.success).length;
    recipients.push({
      household: user.name || user.email || userDoc.id,
      members: [{
        name: user.name || user.email || userDoc.id,
        email: user.email || "",
        deviceCount: tokens.length,
        success: failedCountForUser === 0,
        failed: failedCountForUser
      }]
    });

    const update = { notifState: newNotifState };
    if (invalidTokens.length) {
      update.fcmTokens = admin.firestore.FieldValue.arrayRemove(...invalidTokens);
    }
    await db.collection("users").doc(userDoc.id).set(update, { merge: true });
  }

  console.log("Bitti.");

  await writeRunLog(db, Object.assign({
    success: true,
    summary: usersNotified
      ? `${usersNotified} kullanıcıya bildirim gönderildi (${totalSent} başarılı, ${totalFailed} başarısız)`
      : "Taransa bildirim gönderilecek durum bulunamadı",
    scannedUsers: usersSnap.size,
    usersNotified,
    sentCount: totalSent,
    failedCount: totalFailed
  }, recipients.length ? { recipients } : {}), triggerSource);

  return { usersScanned: usersSnap.size, usersNotified, totalSent, totalFailed };
}

module.exports = async (req, res) => {
  // Vercel Cron, CRON_SECRET tanımlıysa bu header'ı otomatik ekler.
  const authHeader = req.headers["authorization"] || "";
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: "Yetkisiz." });
    return;
  }

  try {
    getAdmin();
    const db = admin.firestore();

    // Duyuru kontrolü, hatırlatma taramasından bağımsız olarak her günlük
    // çalıştırmada da yapılır (admin panelinden ayrıca anlık gönderiliyor
    // olsa bile, günlük çalıştırma bir yedek/garanti katmanı olarak kalır).
    await checkAndSendAnnouncement(db);

    const result = await runFullScan(db, /* bypassDedup */ false, "vercel-cron");

    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("Hata:", err);
    try {
      getAdmin();
      const db = admin.firestore();
      await writeRunLog(db, {
        success: false,
        summary: "Çalışma hata ile sonuçlandı",
        error: err && err.message ? err.message : String(err)
      }, "vercel-cron");
    } catch (e) {
      console.error("runLog yazılamadı:", e);
    }
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
