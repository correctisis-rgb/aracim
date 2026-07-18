/**
 * Garaj Defteri — Günlük Hatırlatma Bildirimi (GitHub Actions ile çalışır)
 *
 * Bu script Firebase Cloud Function DEĞİLDİR — GitHub Actions'ın ücretsiz
 * zamanlanmış çalıştırıcısı (cron) tarafından her gün tetiklenir ve
 * Firebase Admin SDK ile Firestore'u okuyup FCM push bildirimi gönderir.
 * Blaze planı / kredi kartı gerektirmez.
 */

const admin = require("firebase-admin");

// Servis hesabı anahtarı GitHub Actions secret'ından JSON metni olarak gelir
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ---------- Manuel tetikleme desteği ----------
// Bu script iki farklı zamanlamayla çalıştırılabilir (bkz. daily-reminder.yml):
//  1) Günlük normal çalıştırma (her sabah 09:00 TR / 06:00 UTC) veya elle
//     "Run workflow" ile tetiklenme → HER ZAMAN tam taramayı yapar.
//  2) Sık aralıklı kontrol çalıştırması (her ~10 dakikada bir) → sadece
//     uygulama içinden admin "Bildirimleri Tetikle" butonuna basıldıysa
//     (Firestore'daki admin/reminderTrigger bayrağı true ise) tam taramayı
//     yapar, aksi halde hiçbir şey yapmadan hemen çıkar. Bu sayede sık
//     çalıştırma, gereksiz yere her 10 dakikada bir tüm kullanıcıları
//     taramaz.
const TRIGGER_SOURCE = process.env.TRIGGER_SOURCE || "";
const IS_DAILY_RUN = TRIGGER_SOURCE === "0 6 * * *" || TRIGGER_SOURCE === "workflow_dispatch" || !TRIGGER_SOURCE;

// ---------- Sağlık izleme: runLogs kaydı ----------
// Her gerçek tarama çalıştırmasının sonucunu (başarılı/başarısız, kaç
// bildirim gönderildi, hata var mı) Firestore'daki runLogs koleksiyonuna
// yazar. Uygulama içindeki admin "Sağlık" paneli bu kayıtları okuyup
// gösterir. Sık kontrol çalıştırmasının tetiklenmeden çıktığı durumlar
// (manuel bayrak yoksa) burada loglanmaz — sadece gerçek taramalar yazılır.
async function writeRunLog(logData) {
  try {
    await db.collection("runLogs").add(Object.assign({
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      triggerSource: TRIGGER_SOURCE || (IS_DAILY_RUN ? "daily" : "manual"),
      isDailyRun: IS_DAILY_RUN
    }, logData));
  } catch (e) {
    console.error("runLog yazılamadı:", e && e.message ? e.message : e);
  }
}

async function checkManualTriggerFlag() {
  const ref = db.collection("admin").doc("reminderTrigger");
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : null;
  if (data && data.requested === true) {
    console.log("Manuel tetikleme bayrağı bulundu (" + (data.requestedBy || "bilinmiyor") + "), tarama başlatılıyor...");
    await ref.set({
      requested: false,
      processedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return true;
  }
  return false;
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
  const sorted = [...KM_THRESHOLDS].sort((a, b) => a - b); // [0, 1000, 3000]
  for (const t of sorted) {
    if (remaining <= t) return t;
  }
  return null;
}

async function main() {
  let bypassDedup = false;
  if (!IS_DAILY_RUN) {
    const shouldRun = await checkManualTriggerFlag();
    if (!shouldRun) {
      console.log("Sık kontrol çalıştırması: manuel tetikleme isteği yok, çıkılıyor.");
      return;
    }
    // Admin panelinden bilerek tekrar tetiklendi: aynı gün/aynı km eşiği
    // daha önce bildirildiyse bile bu taramada tekrar gönder.
    bypassDedup = true;
  }

  const usersSnap = await db.collection("users").get();
  console.log(`Toplam ${usersSnap.size} kullanıcı taranıyor...`);

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

    console.log(`→ ${userDoc.id}: ${body}`);
    console.log(`  Gönderiliyor: ${tokens.length} cihaz token'ı bulundu.`);

    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      notification: { title, body },
      data: { url: "/aracim/" }
    });

    console.log(`  Sonuç: ${response.successCount} başarılı, ${response.failureCount} başarısız.`);
    usersNotified++;
    totalSent += response.successCount;
    totalFailed += response.failureCount;
    response.responses.forEach((r, i) => {
      if (!r.success) {
        console.log(`  ✗ Token ${i}: ${r.error && r.error.code} — ${r.error && r.error.message}`);
      }
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

    const update = { notifState: newNotifState };
    if (invalidTokens.length) {
      update.fcmTokens = admin.firestore.FieldValue.arrayRemove(...invalidTokens);
    }
    await db.collection("users").doc(userDoc.id).set(update, { merge: true });
  }

  console.log("Bitti.");

  await writeRunLog({
    success: true,
    summary: usersNotified
      ? `${usersNotified} kullanıcıya bildirim gönderildi (${totalSent} başarılı, ${totalFailed} başarısız)`
      : "Taransa bildirim gönderilecek durum bulunamadı",
    scannedUsers: usersSnap.size,
    usersNotified,
    sentCount: totalSent,
    failedCount: totalFailed
  });
}

main().catch(async (err) => {
  console.error("Hata:", err);
  await writeRunLog({
    success: false,
    summary: "Çalışma hata ile sonuçlandı",
    error: err && err.message ? err.message : String(err)
  });
  process.exit(1);
});
