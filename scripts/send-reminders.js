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
//  1) Günlük normal çalıştırma (her sabah ~09:03 TR / 06:03 UTC) veya elle
//     "Run workflow" ile tetiklenme → HER ZAMAN tam taramayı yapar.
//  2) Sık aralıklı kontrol çalıştırması (her ~10 dakikada bir) → sadece
//     uygulama içinden admin "Bildirimleri Tetikle" butonuna basıldıysa
//     (Firestore'daki admin/reminderTrigger bayrağı true ise) tam taramayı
//     yapar, aksi halde hiçbir şey yapmadan hemen çıkar. Bu sayede sık
//     çalıştırma, gereksiz yere her 10 dakikada bir tüm kullanıcıları
//     taramaz.
const TRIGGER_SOURCE = process.env.TRIGGER_SOURCE || "";
const IS_DAILY_RUN = TRIGGER_SOURCE === "3 6 * * *" || TRIGGER_SOURCE === "workflow_dispatch" || !TRIGGER_SOURCE;

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

// ---------- Günlük tarama yedek (catch-up) mekanizması ----------
// Aynı dakikaya birden fazla cron ifadesi denk geldiğinde GitHub Actions
// bazen sadece TEK bir run tetikliyor ve bu run'ın github.event.schedule
// değeri her zaman "0 6 * * *" olmuyor — "*/10 * * * *" olarak da
// gelebiliyor. Bu durumda IS_DAILY_RUN yanlışlıkla false olur, script
// kendini "sık kontrol" sanır ve manuel bayrak da yoksa hiçbir şey
// yapmadan çıkar — günlük tarama o gün hiç gerçekleşmez. Bunu tamamen
// cron string'ine güvenmek yerine, Firestore'da "bugün tarama yapıldı
// mı" bilgisini tutarak garanti altına alıyoruz: saat 06:00 UTC'yi
// (09:00 TR) geçtikten sonraki ilk çalıştırma — hangi cron tetiklerse
// tetiklesin — günlük taramayı yedek olarak yapar.
function todayDateStrTR() {
  // Türkiye sabit UTC+3 kullanıyor (yaz/kış saati uygulamıyor).
  const trNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return trNow.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function claimDailyScanIfDue() {
  if (new Date().getUTCHours() < 6) return false; // henüz 09:00 TR olmadı
  const ref = db.collection("admin").doc("reminderTrigger");
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : null;
  const today = todayDateStrTR();
  if (data && data.lastDailyScanDate === today) return false; // bugün zaten yapıldı
  await ref.set({ lastDailyScanDate: today }, { merge: true });
  return true;
}

async function markDailyScanDoneIfApplicable() {
  if (new Date().getUTCHours() < 6) return;
  const ref = db.collection("admin").doc("reminderTrigger");
  await ref.set({ lastDailyScanDate: todayDateStrTR() }, { merge: true }).catch(function () {});
}

// ---------- Admin: tüm kullanıcılara duyuru / bakım mesajı ----------
// Uygulama içindeki admin "📢 Duyuru / Bakım Mesajı Gönder" ekranı
// Firestore'daki admin/announcementTrigger dokümanına { requested: true,
// title, body, requestedBy } yazar. Bu fonksiyon her çalıştırmada (hem
// günlük hem 10 dakikalık kontrolde) bu bayrağı kontrol eder, varsa
// kayıtlı TÜM kullanıcıların FCM token'larına serbest metinli bir push
// bildirimi gönderir ve bayrağı sıfırlar. Hatırlatma mantığından
// tamamen bağımsızdır (belirli bir araç/tarih/km eşiğine bağlı değildir).
async function checkAndSendAnnouncement() {
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
  const tokenEntries = []; // { token, ownerId }
  usersSnap.forEach((doc) => {
    const u = doc.data();
    (u.fcmTokens || []).forEach((t) => tokenEntries.push({ token: t, ownerId: doc.id }));
  });

  if (!tokenEntries.length) {
    await ref.set({ requested: false, processedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await writeRunLog({
      kind: "announcement",
      success: true,
      summary: `Duyuru "${title}" — gönderilecek kayıtlı cihaz bulunamadı.`,
      sentCount: 0,
      failedCount: 0
    });
    return;
  }

  const CHUNK = 500; // FCM sendEachForMulticast tek çağrıda en fazla 500 token kabul eder
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

  console.log(`Duyuru sonucu: ${totalSuccess} başarılı, ${totalFailed} başarısız (${tokenEntries.length} cihaz).`);

  for (const ownerId of Object.keys(invalidByOwner)) {
    await db.collection("users").doc(ownerId).set({
      fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidByOwner[ownerId])
    }, { merge: true }).catch(() => {});
  }

  await ref.set({ requested: false, processedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });

  await writeRunLog({
    kind: "announcement",
    success: true,
    summary: `Duyuru gönderildi: "${title}" — ${tokenEntries.length} cihaza (${totalSuccess} başarılı, ${totalFailed} başarısız)`,
    sentCount: totalSuccess,
    failedCount: totalFailed
  });
}

const DATE_FIELDS = [
  { key: "inspectionDate", label: "Muayene", emoji: "🗓️" },
  { key: "maintenanceDate", label: "Bakım / Servis", emoji: "🔧" },
  { key: "insuranceDate", label: "Trafik Sigortası", emoji: "🛡️" },
  { key: "kaskoDate", label: "Kasko", emoji: "🚙" },
  { key: "taxDate", label: "Vergi (MTV)", emoji: "💰" },
  { key: "tireDate", label: "Lastik Değişimi", emoji: "🛞" }
];

// Eskiden sadece belirli gün eşiklerinde (7-3-1-0) tek seferlik bildirim
// gidiyordu. Artık kalan gün sayısı bu eşiğin altına düştüğü andan
// itibaren -tarih güncellenene ya da bugüne (0. gün) kadar- HER GÜN sabah
// taraması bir kez bildirim gönderiyor (aşağıdaki notifState dedup
// mekanizması aynı gün içinde ikinci kez göndermeyi zaten engelliyor,
// çünkü "days" değeri bir sonraki taramaya kadar aynı kalıyor).
// Vade tarihi geçtikten sonra (days negatif) artık hatırlatma GÖNDERİLMİYOR
// — son bildirim tam vade gününde (days === 0) gidiyor, sonrasında sessiz
// kalınıyor.
const DAYS_LEFT_ALERT_THRESHOLD = 30;
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
  // Duyuru kontrolü, hatırlatma taramasından tamamen bağımsız olarak her
  // çalıştırmada (hem günlük hem 10 dakikalık kontrolde) yapılır — böylece
  // admin bir duyuru gönderdiğinde en fazla ~10 dakika içinde iletilir.
  await checkAndSendAnnouncement();

  let bypassDedup = false;

  if (IS_DAILY_RUN) {
    // Gerçek günlük cron ("0 6 * * *") ya da elle "Run workflow" testi:
    // tam taramayı yap ve bugünü "yapıldı" olarak işaretle (aşağıdaki
    // yedek mekanizmanın gereksiz yere tekrar taramaması için).
    await markDailyScanDoneIfApplicable();
  } else {
    const manualTriggered = await checkManualTriggerFlag();
    if (manualTriggered) {
      // Admin panelinden bilerek tekrar tetiklendi: aynı gün/aynı km eşiği
      // daha önce bildirildiyse bile bu taramada tekrar gönder.
      bypassDedup = true;
    } else {
      const dailyCatchUp = await claimDailyScanIfDue();
      if (!dailyCatchUp) {
        console.log("Sık kontrol çalıştırması: manuel istek yok ve günlük tarama zaten yapılmış, çıkılıyor.");
        return;
      }
      console.log("Günlük cron tetiklemesi bu run'da doğru tanınmamış olabilir; 09:00 sonrası ilk kontrol olarak günlük tarama yedek şekilde çalıştırılıyor.");
    }
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
        if (days > DAYS_LEFT_ALERT_THRESHOLD || days < 0) return;

        const stateKey = car.id + "_" + f.key;
        if (!bypassDedup && newNotifState[stateKey] === days) return;

        newNotifState[stateKey] = days;
        const carName = car.name || "Aracın";
        const dayText = days === 0 ? "bugün" : days > 0 ? days + " gün içinde" : Math.abs(days) + " gün geçti";
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
