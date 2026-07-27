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

// Şoför belge bitiş tarihleri — send-reminders.js (günlük otomatik tarama)
// ile BİREBİR AYNI alan kapsamı: Ehliyet/SRC/Psikoteknik/Sağlık Raporu TÜM
// şoförler için kontrol edilir; Pasaport/Vize sadece worksAbroad === true
// olan şoförler için ayrıca eklenir (bkz. aşağıdaki kullanım noktası).
// Araç alanlarıyla AYNI eşik (7/3/1/0 gün), AYNI notifState dedup
// mekanizmasını ve AYNI randevu/"unuttun mu" akışını (driver.appointments)
// kullanır, aynı bildirime ve aynı hane/üye dağıtımına dahil edilir.
// fieldKey aksiyon amaçlı her zaman null bırakılır (carId'siz olduğu için
// "Evet/Hayır" randevu düğmeleri şoför öğelerini hiç etkilemez) — şoför
// tarafında randevu/tarih girme sadece "Geçmiş Hatırlatmalar" listesinden
// (driverId + apptKey ile) yapılabilir; apptKey için ayrıca driverFieldKey
// tutulur.
const DRIVER_DATE_FIELDS = [
  { key: "licenseExpiry", label: "Ehliyet", emoji: "🪪" },
  { key: "srcExpiry", label: "SRC Belgesi", emoji: "📄" },
  { key: "psikoteknikExpiry", label: "Psikoteknik Belgesi", emoji: "🧠" },
  { key: "healthReportExpiry", label: "Sağlık Raporu", emoji: "🩺" }
];
const DRIVER_ABROAD_DATE_FIELDS = [
  { key: "passportExpiry", label: "Pasaport", emoji: "🛂" },
  { key: "visaExpiry", label: "Vize", emoji: "🌍" }
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
  // recipients: her hane bildirimi için, hane sahibi ve katılan üyelerin
  // kaç cihazına başarılı/başarısız gönderim yapıldığını tutar. Admin
  // Sağlık paneli (renderRunLogRecipients, index.html) bunu okuyup "kimlere
  // ulaştı/ulaşmadı" listesi olarak gösterir.
  const recipients = [];

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
    const drivers = user.drivers || [];
    // Önceden bir hanenin hiç aracı yoksa (ör. sadece şoför bilgisi girilmiş
    // olabilir) burada taramadan tamamen çıkılıyordu — bu da o hanenin
    // şoför pasaport/vize hatırlatmalarını hiç almamasına yol açardı.
    // Artık aracı VEYA şoförü olan her hane taranıyor.
    if (!cars.length && !drivers.length) continue;

    const notifState = user.notifState || {};
    const newNotifState = Object.assign({}, notifState);
    const triggered = [];

    cars.forEach((car) => {
      DATE_FIELDS.forEach((f) => {
        const dateVal = car[f.key];
        if (!dateVal) return;

        const stateKey = car.id + "_" + f.key;
        const carName = car.name || "Aracın";

        // ---------- Randevu tarihi varsa: vade hatırlatmaları yerine
        // randevu odaklı bildirim akışına geç (send-reminders.js ile
        // BİREBİR AYNI mantık; bkz. index.html car edit formu ->
        // "Randevu aldın mı?" alanı, car.appointments[f.key] içinde) ----------
        const apptVal = (car.appointments || {})[f.key];
        if (apptVal) {
          const apptDays = daysUntil(apptVal);
          if (apptDays != null) {
            if (apptDays > 1) {
              // Randevuya daha çok var: kademeli vade hatırlatmaları
              // tamamen durur, randevu gününe kadar sessiz kalınır.
              return;
            }
            if (apptDays === 0 || apptDays === 1) {
              // Randevudan 1 gün önce ve randevu günü: tek seferlik hatırlatma.
              const apptStateKey = stateKey + "_appt:" + apptVal;
              if (!bypassDedup && newNotifState[apptStateKey] === apptDays) return;
              newNotifState[apptStateKey] = apptDays;
              const when = apptDays === 0 ? "bugün" : "yarın";
              triggered.push({ text: `${f.emoji} ${carName}: ${f.label} randevun ${when}`, carId: car.id, fieldKey: f.key, actionable: false });
              return;
            }
            // apptDays < 0 → randevu günü geçti. Vade tarihi (dateVal) hâlâ
            // randevu girildiği andaki anlık görüntüyle (DueSnapshot) AYNIYSA
            // kullanıcı muhtemelen işlemi yaptırdı ama tarihi güncellemeyi
            // unuttu: TEK seferlik "unuttun mu?" hatırlatması gönder, sonra
            // (aynı randevu tarihi için) tamamen sessiz kal. Vade tarihi
            // değiştiyse randevu "çözülmüş" sayılır ve normal kademeli
            // akışa devam edilir.
            const dueSnapshot = (car.appointments || {})[f.key + "DueSnapshot"];
            const dueUnchanged = dueSnapshot != null && dueSnapshot === dateVal;
            if (dueUnchanged) {
              const missedKey = stateKey + "_apptMissed:" + apptVal;
              if (!bypassDedup && newNotifState[missedKey]) return;
              newNotifState[missedKey] = true;
              triggered.push({ text: `${f.emoji} ${carName}: ${f.label} tarihini güncellemeyi unuttun mu?`, carId: car.id, fieldKey: f.key, actionable: false });
              return;
            }
          }
        }

        // ---------- Normal kademeli vade hatırlatması ----------
        // (randevu hiç girilmediyse, ya da girilen randevu zaten
        // çözülmüş/geride kalmış ve vade tarihi güncellenmişse)
        const days = daysUntil(dateVal);
        if (days == null) return;
        if (!DAY_THRESHOLDS.includes(days)) return;

        if (!bypassDedup && newNotifState[stateKey] === days) return;

        newNotifState[stateKey] = days;
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
            triggered.push({ text: `🔧 ${carName}: ${kmText}`, carId: car.id, fieldKey: null });
          }
        }
      }
    });

    // ---------- Şoför belge hatırlatmaları ----------
    // Ehliyet/SRC/Psikoteknik/Sağlık Raporu TÜM şoförler için, Pasaport/Vize
    // ise sadece worksAbroad === true olanlar için kontrol edilir.
    drivers.forEach((driver) => {
      const driverDateFields = driver.worksAbroad
        ? DRIVER_DATE_FIELDS.concat(DRIVER_ABROAD_DATE_FIELDS)
        : DRIVER_DATE_FIELDS;
      driverDateFields.forEach((f) => {
        const dateVal = driver[f.key];
        if (!dateVal) return;

        const stateKey = "driver_" + driver.id + "_" + f.key;
        const driverName = driver.name || "Şoför";
        let extra = "";
        if (f.key === "visaExpiry" && driver.visaCountry) extra = ` (${driver.visaCountry})`;
        else if (f.key === "srcExpiry" && driver.srcType) extra = ` (${driver.srcType})`;
        else if (f.key === "licenseExpiry" && driver.licenseClass) extra = ` (${driver.licenseClass})`;

        // ---------- Randevu tarihi varsa: vade hatırlatmaları yerine
        // randevu odaklı bildirim akışına geç (araç bloğuyla ve
        // send-reminders.js ile BİREBİR AYNI mantık; driver.appointments[f.key]) ----------
        const apptVal = (driver.appointments || {})[f.key];
        if (apptVal) {
          const apptDays = daysUntil(apptVal);
          if (apptDays != null) {
            if (apptDays > 1) {
              // Randevuya daha çok var: kademeli vade hatırlatmaları
              // tamamen durur, randevu gününe kadar sessiz kalınır.
              return;
            }
            if (apptDays === 0 || apptDays === 1) {
              // Randevudan 1 gün önce ve randevu günü: tek seferlik hatırlatma.
              const apptStateKey = stateKey + "_appt:" + apptVal;
              if (!bypassDedup && newNotifState[apptStateKey] === apptDays) return;
              newNotifState[apptStateKey] = apptDays;
              const when = apptDays === 0 ? "bugün" : "yarın";
              triggered.push({ text: `${f.emoji} ${driverName}: ${f.label}${extra} randevun ${when}`, carId: null, fieldKey: null, driverId: driver.id, driverFieldKey: f.key });
              return;
            }
            // apptDays < 0 → randevu günü geçti; tarih hâlâ o anki
            // görüntüyle (DueSnapshot) aynıysa (güncellenmemişse) TEK
            // seferlik "unuttun mu?" hatırlatması gönder. Vade tarihi
            // değiştiyse randevu "çözülmüş" sayılır ve normal kademeli
            // akışa devam edilir.
            const dueSnapshot = (driver.appointments || {})[f.key + "DueSnapshot"];
            const dueUnchanged = dueSnapshot != null && dueSnapshot === dateVal;
            if (dueUnchanged) {
              const missedKey = stateKey + "_apptMissed:" + apptVal;
              if (!bypassDedup && newNotifState[missedKey]) return;
              newNotifState[missedKey] = true;
              triggered.push({ text: `${f.emoji} ${driverName}: ${f.label}${extra} tarihini güncellemeyi unuttun mu?`, carId: null, fieldKey: null, driverId: driver.id, driverFieldKey: f.key });
              return;
            }
          }
        }

        // ---------- Normal kademeli vade hatırlatması ----------
        // (randevu hiç girilmediyse, ya da girilen randevu zaten
        // çözülmüş/geride kalmış ve vade tarihi güncellenmişse)
        const days = daysUntil(dateVal);
        if (days == null) return;
        if (!DAY_THRESHOLDS.includes(days)) return;

        if (!bypassDedup && newNotifState[stateKey] === days) return;

        newNotifState[stateKey] = days;
        const dayText = days === 0 ? "bugün" : days + " gün içinde";
        triggered.push({ text: `${f.emoji} ${driverName}: ${f.label}${extra} süresi ${dayText} doluyor`, carId: null, fieldKey: null, driverId: driver.id, driverFieldKey: f.key });
      });
    });

    if (!triggered.length) continue;

    const title = triggered.length === 1 ? "Garaj Defteri — Hatırlatma" : `Garaj Defteri — ${triggered.length} Hatırlatma`;
    const bodyBase = triggered.slice(0, 3).map((t) => t.text).join("  •  ") + (triggered.length > 3 ? ` (+${triggered.length - 3} diğer)` : "");

    // Tek bir tarihe bağlı işlem tetiklendiyse (ör. sadece Muayene), bildirime
    // "Evet, randevu aldım / Hayır" aksiyon düğmeleri ekleyebiliriz. Birden
    // fazla işlem aynı anda tetiklenirse ya da tetiklenen tek şey km bazlı bir
    // bakım uyarısıysa (fieldKey yok), aksiyon eklemiyoruz — hangi işlem için
    // olduğu net değil.
    // Tek bir tarihe bağlı VE henüz randevusu girilmemiş işlem tetiklendiyse
    // (ör. sadece Muayene vade hatırlatması), bildirime "Evet, randevu
    // aldım / Hayır" aksiyon düğmeleri ekleyebiliriz. Km bazlı bakım uyarısı
    // gibi tarihi olmayan işlemler (fieldKey yok) ya da zaten randevusu
    // girilmiş/"unuttun mu" tipi öğeler (actionable: false) bu sayıma dahil
    // edilmez — yani "Muayene 3 gün içinde" + "bakıma 1.651 km kaldı" aynı
    // anda tetiklense bile, tarihe bağlı actionable olan tek (Muayene)
    // olduğu için yine de butonlar eklenir. Birden fazla FARKLI tarihe bağlı
    // actionable işlem aynı anda tetiklenirse (ör. hem Muayene hem Sigorta),
    // hangisi için olduğu net olmadığından buton eklenmez.
    const dateBasedItems = triggered.filter((t) => t.actionable && t.fieldKey);
    let actionData = null;
    if (dateBasedItems.length === 1) {
      actionData = { carId: dateBasedItems[0].carId, fieldKey: dateBasedItems[0].fieldKey, actionable: "true" };
    } else if (dateBasedItems.length > 1) {
      actionData = { multiAppt: dateBasedItems.map((t) => `${t.carId}:${t.fieldKey}`).join(",") };
    }

    // ---------- Uygulama içi bildirim geçmişi ("gelen kutusu") ----------
    // send-reminders.js (günlük otomatik tarama) ile BİREBİR AYNI mantık:
    // her gönderimi hane dokümanındaki notifHistory dizisine ekliyoruz ki
    // "Geçmiş Hatırlatmalar" ekranında admin tetiklemesiyle gönderilen
    // bildirimler de görünsün ve tıklanabilir olsun. items artık düz metin
    // değil, { label, carId, apptKey } biçiminde bir obje: index.html bu
    // alanlar doluysa (yani tek bir tarihe bağlı, henüz randevusu
    // girilmemiş bir hatırlatmaysa) "Randevu / Tarih Gir" düğmesi gösterir;
    // km bazlı bakım uyarısı gibi fieldKey'i olmayan öğeler ya da zaten
    // randevusu girilmiş/"unuttun mu" tipi öğeler (actionable: false) düz
    // metin olarak (carId/driverId/apptKey null) kalır — "Randevu / Tarih
    // Gir" düğmesi sadece henüz randevusu girilmemiş, tek bir tarihe bağlı
    // hatırlatmalarda gösterilir (send-reminders.js ile BİREBİR AYNI).
    const newNotifHistory = [
      {
        title,
        body: bodyBase,
        items: triggered.map((t) => ({
          label: t.text,
          carId: t.actionable && t.fieldKey ? t.carId : null,
          driverId: t.driverId || null,
          apptKey: (t.actionable && t.fieldKey) ? t.fieldKey : (t.driverFieldKey || null)
        })),
        sentAt: admin.firestore.Timestamp.now()
      }
    ].concat(user.notifHistory || []).slice(0, 40);

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

    // recipientMembers: hane sahibi + katılan üyelerin kırılımını tutar,
    // admin panelindeki "kimlere ulaştı/ulaşmadı" listesi için (bkz.
    // index.html renderRunLogRecipients). Hiç cihazı olmayan üyeler de
    // (deviceCount: 0) listede görünür.
    const recipientMembers = [{
      name: ownerName,
      email: user.email || "",
      deviceCount: ownerTokens.length,
      success: ownerTokens.length > 0 && ownerResult.failed === 0,
      failed: ownerResult.failed
    }];

    for (const memberUid of memberUids) {
      try {
        const memberSnap = await db.collection("users").doc(memberUid).get();
        if (!memberSnap.exists) continue;
        const memberData = memberSnap.data() || {};
        const memberTokens = memberData.fcmTokens || [];
        const memberName = memberData.name || memberData.email || memberUid;
        if (!memberTokens.length) {
          recipientMembers.push({ name: memberName, email: memberData.email || "", deviceCount: 0, success: false, failed: 0 });
          continue;
        }

        const memberResult = await sendToTokens(db, memberUid, memberTokens, title, memberBody, actionData);
        totalSent += memberResult.sent;
        totalFailed += memberResult.failed;
        if (memberResult.sent > 0) usersNotified++;
        recipientMembers.push({
          name: memberName,
          email: memberData.email || "",
          deviceCount: memberTokens.length,
          success: memberResult.failed === 0,
          failed: memberResult.failed
        });
      } catch (e) {
        console.error("Üyeye bildirim gönderilemedi:", memberUid, e && e.message ? e.message : e);
      }
    }

    recipients.push({ household: ownerName, members: recipientMembers });

    // notifState ve notifHistory her zaman hane sahibinin dokümanına yazılır.
    await db.collection("users").doc(ownerId).set({
      notifState: newNotifState,
      notifHistory: newNotifHistory
    }, { merge: true });
  }

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
