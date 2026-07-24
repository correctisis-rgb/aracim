/**
 * Garaj Defteri — Admin: Bekleyen Hesap Kapatma İşlemini İptal Et
 *
 * index.html'deki hane sahibi kendi hesabını "Hesabı Kapat" ile kapatma
 * sürecine soktuğunda (bkz. requestOwnerAccountDeletion), veri hemen
 * silinmez; users/{ownerId}.pendingDeletion alanı yazılır ve
 * ACCOUNT_DELETION_GRACE_DAYS (10) gün sonra purge-pending-deletions.js
 * tarafından kalıcı olarak silinir.
 *
 * Normalde hane sahibinin KENDİSİ bu süre içinde tekrar giriş yapıp
 * cancelAccountDeletion() ile işlemi iptal edebilir (bunu doğrudan
 * istemciden yapabiliyor, çünkü firestore.rules kendi belgesine yazmasına
 * izin veriyor). Ama hane sahibi bir daha giriş yapmazsa (örn. yanlışlıkla
 * tetiklediyse ve şifresini unuttuysa, ya da diğer üyeler admine ulaşıp
 * "hesabımız kapatılıyor, bir şey yapabilir misiniz" derse) admin'in de
 * bu süreci İPTAL EDEBİLMESİ gerekir — işte bu endpoint bunun için var.
 *
 * Not: Bu, "silinen veriyi geri getirme" değildir — bekleme süresi
 * dolmadan (yani veri henüz gerçekten silinmeden) süreci durdurma
 * işlemidir. Bekleme süresi dolup purge-pending-deletions.js çalıştıktan
 * SONRA bir geri alma imkanı YOKTUR (KVKK "unutulma hakkı" gereği veri o
 * noktada kalıcı olarak silinmiş olur).
 *
 * Yetkilendirme: istemci (admin panelindeki "İptal Et" butonu),
 * auth.currentUser.getIdToken() ile aldığı Firebase ID token'ını
 * "Authorization: Bearer <idToken>" header'ında gönderir. Bu fonksiyon
 * token'ı Admin SDK ile doğrular ve içindeki e-postanın ADMIN_EMAIL ile
 * eşleştiğini kontrol eder (firestore.rules'daki isAdmin() ile birebir
 * aynı e-posta).
 */

const admin = require("firebase-admin");

const ADMIN_EMAIL = "emre121856031@gmail.com";

function getAdmin() {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return admin;
}

async function writeRunLog(db, logData) {
  try {
    await db.collection("runLogs").add(Object.assign({
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      triggerSource: "admin-panel",
      isDailyRun: false
    }, logData));
  } catch (e) {
    console.error("runLog yazılamadı:", e && e.message ? e.message : e);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Sadece POST kabul edilir." });
    return;
  }

  const authHeader = req.headers["authorization"] || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: "Yetkisiz: ID token eksik." });
    return;
  }

  const targetUid = req.body && req.body.uid;
  if (!targetUid || typeof targetUid !== "string") {
    res.status(400).json({ error: "Geçersiz istek: 'uid' alanı zorunlu." });
    return;
  }

  try {
    getAdmin();
    const decoded = await admin.auth().verifyIdToken(idToken);
    if (!decoded.email || decoded.email.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
      res.status(403).json({ error: "Bu işlem için admin yetkisi gerekiyor." });
      return;
    }

    const db = admin.firestore();
    const ref = db.collection("users").doc(targetUid);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(404).json({ error: "Hesap bulunamadı (zaten silinmiş olabilir)." });
      return;
    }
    const data = snap.data() || {};
    if (!data.pendingDeletion) {
      res.status(409).json({ error: "Bu hesap için bekleyen bir silme işlemi yok." });
      return;
    }

    await ref.set({ pendingDeletion: admin.firestore.FieldValue.delete() }, { merge: true });

    await writeRunLog(db, {
      kind: "accountPurgeCancelled",
      success: true,
      summary: `Admin, "${data.name || data.email || targetUid}" hesabının kapatma sürecini iptal etti.`,
      ownerId: targetUid,
      ownerName: data.name || data.email || targetUid,
      cancelledBy: "admin (" + decoded.email + ")"
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("Hata:", err);
    res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
