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
// "3 6 * * *" (09:03 TR), "3 11 * * *" (14:03 TR), "3 17 * * *" (20:03 TR):
// bunlar cron-job.org'un tam saatinde (09:00/14:00/20:00) attığı workflow_dispatch
// isteği kaçarsa devreye giren GitHub-native yedek zamanlamalar.
const IS_DAILY_RUN = TRIGGER_SOURCE === "3 6 * * *" || TRIGGER_SOURCE === "3 11 * * *" || TRIGGER_SOURCE === "3 17 * * *" || TRIGGER_SOURCE === "workflow_dispatch" || !TRIGGER_SOURCE;

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

// ---------- Kademeli hatırlatma saatleri ----------
// Vade tarihine kalan gün azaldıkça gönderim sıklığı artar:
//  - 30 gün ve 15 gün kala (sadece bu iki gün, aradaki günler DAHİL DEĞİL):
//    tek seferlik, sadece 09:00
//  - 7-2 gün kala  : HER GÜN 09:00 + 20:00
//  - 1-0 gün kala  : HER GÜN 09:00 + 14:00 + 20:00
// cron-job.org bu üç saatte de GitHub'ın workflow_dispatch API'sini çağırıyor
// (bkz. cron-job.org paneli). Aşağıdaki HOUR_SLOTS_TR listesi, hem hangi
// saatlerde bildirim gönderilebileceğini hem de aşağıdaki yedek (catch-up)
// mekanizmanın hangi saatleri "geçerli dilim" sayacağını belirliyor.
const HOUR_SLOTS_TR = [9, 14, 20];

function currentTRHour() {
  // Türkiye sabit UTC+3 kullanıyor (yaz/kış saati uygulamıyor).
  const trNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return trNow.getUTCHours();
}

// Şu an HOUR_SLOTS_TR içindeki saatlerden birinin içindeysek (örn. 09:00-09:59
// arası herhangi bir an) o dilimi döndürür, değilse null. Saat aralığının tamamı
// eşleşmesi -tam dakikasında değil- kasıtlı: cron-job.org'un isteği gecikirse ya
// da yedek GitHub cron'u devreye girerse bile aynı saat diliminde sayılır.
function matchedHourSlot() {
  const h = currentTRHour();
  return HOUR_SLOTS_TR.includes(h) ? h : null;
}

function requiredSlotsForDays(days) {
  if (days <= 1) return [9, 14, 20];
  if (days <= 7) return [9, 20];
  if (days === 30 || days === 15) return [9]; // sadece tam 30. ve 15. günde tek seferlik
  return []; // 8-30 gün arası (30 ve 15 hariç): artık gönderim yok
}

// ---------- Saat dilimi bazlı yedek (catch-up) mekanizması ----------
// Aynı dakikaya birden fazla cron ifadesi denk geldiğinde GitHub Actions
// bazen sadece TEK bir run tetikliyor ve bu run'ın github.event.schedule
// değeri beklenen cron string'iyle eşleşmeyebiliyor. Bu durumda IS_DAILY_RUN
// yanlışlıkla false olur, script kendini "sık kontrol" sanır ve manuel
// bayrak da yoksa hiçbir şey yapmadan çıkar. Bunu tamamen cron string'ine
// güvenmek yerine, Firestore'da "bu saat diliminde bugün tarama yapıldı mı"
// bilgisini tutarak garanti altına alıyoruz: HOUR_SLOTS_TR'den birinin
// içindeki ilk çalıştırma — hangi cron tetiklerse tetiklesin — o dilimin
// taramasını yedek olarak yapar.
function todayDateStrTR() {
  const trNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return trNow.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function claimSlotScanIfDue() {
  const slot = matchedHourSlot();
  if (slot == null) return false; // şu an tanımlı gönderim saatlerinden birinde değiliz
  const ref = db.collection("admin").doc("reminderTrigger");
  const snap = await ref.get();
  const data = snap.exists ? snap.data() : null;
  const claimKey = todayDateStrTR() + ":" + slot;
  if (data && data.lastSlotScan === claimKey) return false; // bu dilimde bugün zaten yapıldı
  await ref.set({ lastSlotScan: claimKey }, { merge: true });
  return true;
}

async function markSlotScanDoneIfApplicable() {
  const slot = matchedHourSlot();
  if (slot == null) return;
  const ref = db.collection("admin").doc("reminderTrigger");
  await ref.set({ lastSlotScan: todayDateStrTR() + ":" + slot }, { merge: true }).catch(function () {});
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

// 7 gün ve altında kalan gün sayısı düştüğü andan itibaren -tarih
// güncellenene ya da bugüne (0. gün) kadar- HER GÜN en az bir kez bildirim
// gönderiliyor. 8-30 gün aralığında ise artık her gün DEĞİL, sadece tam
// 30. ve 15. günde birer kez tek seferlik bildirim gidiyor (aradaki diğer
// günlerde sessiz kalınıyor). Kaç kez/hangi günler gönderileceği
// requiredSlotsForDays()'te tanımlı (30. ve 15. gün: sadece 09:00 — 7-2
// gün: HER GÜN 09:00+20:00 — 1-0 gün: HER GÜN 09:00+14:00+20:00). Aynı
// dilimde ikinci kez göndermeyi aşağıdaki notifState dedup mekanizması
// engelliyor. Vade tarihi geçtikten sonra (days negatif) artık hatırlatma
// GÖNDERİLMİYOR — son bildirim tam vade gününde (days === 0) gidiyor,
// sonrasında sessiz kalınıyor.
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
    // Gerçek tetikleme (cron-job.org'un workflow_dispatch çağrısı, GitHub'ın
    // yedek saatlik cron'larından biri, ya da elle "Run workflow" testi):
    // tam taramayı yap ve -eğer şu an tanımlı saat dilimlerinden birindeysek-
    // bu dilimi "yapıldı" olarak işaretle (aşağıdaki yedek mekanizmanın
    // gereksiz yere tekrar taramaması için).
    await markSlotScanDoneIfApplicable();
  } else {
    const manualTriggered = await checkManualTriggerFlag();
    if (manualTriggered) {
      // Admin panelinden bilerek tekrar tetiklendi: saat dilimi/gün/km eşiği
      // daha önce bildirildiyse bile bu taramada tekrar gönder.
      bypassDedup = true;
    } else {
      const slotCatchUp = await claimSlotScanIfDue();
      if (!slotCatchUp) {
        console.log("Sık kontrol çalıştırması: manuel istek yok, şu an geçerli bir gönderim saati değil ya da bu dilim zaten taranmış, çıkılıyor.");
        return;
      }
      console.log("Beklenen tetikleme bu run'da doğru tanınmamış olabilir; geçerli saat dilimi (09/14/20) yedek şekilde taranıyor.");
    }
  }

  const usersSnap = await db.collection("users").get();
  console.log(`Toplam ${usersSnap.size} kullanıcı taranıyor...`);

  // ---------- Ortak hane (household) token birleştirme ----------
  // Bir kullanıcı başka birinin ortak hanesine katıldığında kendi FCM
  // token'ı KENDİ doc'unda tutulur (bkz. index.html enableNotifications ->
  // users/{currentUser.id}), ama araç/tarih verileri (cars) her zaman
  // hanenin asıl doc'unda tutulur (bkz. persistCars -> users/{dataDocId()},
  // dataDocId() = householdId || kendi id). Yani katılan bir üye hanenin
  // araçlarını görür ama kendi cihaz token'ı o araçların bulunduğu doc'ta
  // değildir — bu yüzden önceden sadece hane sahibi bildirim alıyordu.
  // Burada her doc için "etkin hane id'si"ni (householdId alanı varsa o,
  // yoksa kendi doc id'si) hesaplayıp, aynı haneye ait TÜM kullanıcıların
  // token'larını birleştiriyoruz. Ayrıca geçersiz token temizliğinin doğru
  // doc'a yazılabilmesi için her token'ın asıl sahibi doc'unu da saklıyoruz.
  const tokensByHousehold = {}; // householdId -> Set(token)
  const tokenOwnerDoc = {}; // token -> gerçekte kayıtlı olduğu doc id
  usersSnap.forEach((doc) => {
    const u = doc.data();
    const effectiveHouseholdId = u.householdId || doc.id;
    if (!tokensByHousehold[effectiveHouseholdId]) tokensByHousehold[effectiveHouseholdId] = new Set();
    (u.fcmTokens || []).forEach((t) => {
      tokensByHousehold[effectiveHouseholdId].add(t);
      tokenOwnerDoc[t] = doc.id;
    });
  });

  let usersNotified = 0;
  let totalSent = 0;
  let totalFailed = 0;

  for (const userDoc of usersSnap.docs) {
    const user = userDoc.data();

    // Bu doc, başka bir hanenin üyesiyse (householdId kendi id'sinden
    // farklıysa) araç verisi burada değil, hane sahibinin doc'undadır —
    // bu doc'u atlıyoruz; ilgili araçlar hane sahibinin sırasında,
    // birleştirilmiş token listesiyle zaten işlenecek.
    if (user.householdId && user.householdId !== userDoc.id) continue;

    const tokens = Array.from(tokensByHousehold[userDoc.id] || []);
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
        const slot = matchedHourSlot();

        if (!bypassDedup) {
          if (slot == null) return; // şu an 09/14/20 dilimlerinden birinde değiliz
          if (!requiredSlotsForDays(days).includes(slot)) return; // bu gün sayısı için bu dilim gerekli değil
          const sentMarker = todayDateStrTR() + ":" + slot;
          if (newNotifState[stateKey] === sentMarker) return; // bu dilimde bugün zaten gönderildi
          newNotifState[stateKey] = sentMarker;
        } else {
          // Admin panelinden elle tetiklendi: saat/dedup kısıtlaması yok, hemen gönder.
          newNotifState[stateKey] = todayDateStrTR() + ":" + (slot != null ? slot : "manual");
        }

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

    // Geçersiz token'lar birden fazla farklı doc'tan (hane sahibi + ortak
    // haneye katılan üyeler) gelmiş olabilir — her birini KENDİ sahibi
    // olduğu doc'tan silmemiz gerekir, hepsini userDoc.id'ye yazamayız.
    const invalidTokensByOwnerDoc = {}; // ownerDocId -> [token, ...]
    response.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error && r.error.code;
        if (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered") {
          const tok = tokens[i];
          const ownerDocId = tokenOwnerDoc[tok] || userDoc.id;
          if (!invalidTokensByOwnerDoc[ownerDocId]) invalidTokensByOwnerDoc[ownerDocId] = [];
          invalidTokensByOwnerDoc[ownerDocId].push(tok);
        }
      }
    });

    // notifState her zaman hanenin asıl (araçların bulunduğu) doc'una yazılır.
    await db.collection("users").doc(userDoc.id).set({ notifState: newNotifState }, { merge: true });

    // Geçersiz token'ları kendi asıl sahibi doc'undan temizle (userDoc.id
    // ile aynıysa yukarıdaki yazımla birlikte de yapılabilirdi, ama farklı
    // doc'lar için ayrı ayrı update gerekir).
    for (const ownerDocId of Object.keys(invalidTokensByOwnerDoc)) {
      await db.collection("users").doc(ownerDocId).set({
        fcmTokens: admin.firestore.FieldValue.arrayRemove(...invalidTokensByOwnerDoc[ownerDocId])
      }, { merge: true }).catch((e) => console.error(`  Token temizleme hatası (${ownerDocId}):`, e && e.message ? e.message : e));
    }
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
