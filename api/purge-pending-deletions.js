/**
 * Garaj Defteri — Bekleyen Hesap Silme İşlemlerini Sonuçlandırma (Vercel Cron Job)
 *
 * index.html'deki "Hesabı Kapat" akışında, başka üyeleri olan bir ortak
 * hane sahibi hesabını kapatmak istediğinde veri anında silinmez;
 * users/{ownerId} belgesine
 *   pendingDeletion: { requestedAt, requestedByName, deleteAt }
 * alanı yazılır ve ACCOUNT_DELETION_GRACE_DAYS (şu an 10) günlük bir
 * bekleme süresi başlar (bkz. index.html -> requestOwnerAccountDeletion).
 * Bu süre boyunca hane sahibi tekrar giriş yapıp cancelAccountDeletion()
 * ile işlemi iptal edebilir; iptal etmezse süre dolduğunda GERÇEK/KALICI
 * silme işlemini bu backend fonksiyonu yapar (istemci tarafında kimse
 * oturum açık tutmadığı için bu adım istemcide asla gerçekleşemez).
 *
 * Her çalıştığında pendingDeletion.deleteAt <= şu an olan tüm hane
 * belgelerini bulur ve her biri için:
 *   1) users/{ownerId} Firestore belgesini (tüm hane verisiyle birlikte) siler
 *   2) İlgili Firebase Authentication hesabını siler
 *   3) runLogs koleksiyonuna, admin panelinde görünecek bir kayıt yazar
 *
 * Diğer üyelerin kendi users/{uid} belgeleri silinmez; onların
 * householdId alanı artık var olmayan bir belgeyi işaret ettiği için bir
 * sonraki snapshot okumasında permission-denied alırlar ve mevcut
 * handleHouseholdAccessRevoked() akışı (index.html) onları otomatik olarak
 * kendi (boş) hanelerine döndürür — tıpkı normal "hesabı kalıcı sil"
 * akışında (deleteAccountAndData) olduğu gibi.
 *
 * GÜVENLİK: daily-reminder.js ile aynı desen — Vercel'de bir CRON_SECRET
 * ortam değişkeni tanımlıysa, cron çağrısına otomatik olarak
 * "Authorization: Bearer <CRON_SECRET>" header'ı eklenir; bu fonksiyon bu
 * header'ı doğrulayarak endpoint URL'ini bilen başka birinin taramayı
 * dışarıdan tetiklemesini engeller.
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
      isDailyRun: false
    }, logData));
  } catch (e) {
    console.error("runLog yazılamadı:", e && e.message ? e.message : e);
  }
}

// Firebase Authentication hesabını siler. Hesap zaten yoksa (daha önce
// silinmiş, örn. önceki bir çalıştırmada Firestore silindi ama Auth
// silme adımı bir sebeple başarısız oldu ve tekrar denendi) bunu hata
// saymaz, sessizce devam eder.
async function deleteAuthUserSafely(uid) {
  try {
    await admin.auth().deleteUser(uid);
    return { deleted: true };
  } catch (err) {
    if (err && err.code === "auth/user-not-found") {
      return { deleted: false, reason: "already-gone" };
    }
    throw err;
  }
}

async function purgeOneHousehold(db, ownerId, ownerData) {
  const pd = ownerData.pendingDeletion || {};
  const members = (ownerData.members || []).filter((uid) => uid !== ownerId);
  const memberProfiles = ownerData.memberProfiles || {};
  const affectedMemberNames = members.map((uid) => (memberProfiles[uid] && memberProfiles[uid].name) || uid);

  // Sıra önemli: önce Firestore verisini sil (asıl hane verisi/tüm
  // üyelerin erişimi burada sona erer), sonra Authentication hesabını sil.
  await db.collection("users").doc(ownerId).delete();
  const authResult = await deleteAuthUserSafely(ownerId);

  return {
    ownerId,
    ownerName: ownerData.name || ownerData.email || ownerId,
    requestedByName: pd.requestedByName || "",
    affectedMemberCount: members.length,
    affectedMemberNames,
    authDeleted: authResult.deleted
  };
}

async function runPurge(db, triggerSource) {
  const now = admin.firestore.Timestamp.now();
  // Tek alan üzerinde eşitsizlik filtresi olduğu için ek bir composite
  // index gerekmez.
  const snap = await db.collection("users")
    .where("pendingDeletion.deleteAt", "<=", now)
    .get();

  if (snap.empty) {
    return { purgedCount: 0, results: [] };
  }

  console.log(`${snap.size} bekleyen hesap silme işlemi bulundu, işleniyor...`);

  const results = [];
  const errors = [];

  for (const doc of snap.docs) {
    try {
      const result = await purgeOneHousehold(db, doc.id, doc.data() || {});
      results.push(result);
      console.log(`Silindi: ${result.ownerId} (${result.ownerName}) — ${result.affectedMemberCount} üye etkilendi.`);
    } catch (err) {
      console.error(`Silinemedi: ${doc.id}`, err);
      errors.push({ ownerId: doc.id, error: err && err.message ? err.message : String(err) });
    }
  }

  const summaryParts = [];
  if (results.length) {
    summaryParts.push(`${results.length} hesap kalıcı olarak silindi (toplam ${results.reduce((s, r) => s + r.affectedMemberCount, 0)} üye etkilendi)`);
  }
  if (errors.length) {
    summaryParts.push(`${errors.length} hesap silinirken hata oluştu`);
  }

  await writeRunLog(db, {
    kind: "accountPurge",
    success: errors.length === 0,
    summary: summaryParts.join(" — ") || "İşlenecek bekleyen silme bulunamadı",
    purgedCount: results.length,
    purgedAccounts: results,
    errors: errors.length ? errors : undefined
  }, triggerSource);

  return { purgedCount: results.length, results, errors };
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
    const result = await runPurge(db, "vercel-cron");
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("Hata:", err);
    try {
      getAdmin();
      const db = admin.firestore();
      await writeRunLog(db, {
        kind: "accountPurge",
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
