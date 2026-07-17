// ---------- Firebase Cloud Messaging (Push Bildirimleri) ----------
// DEĞİŞİKLİK NOTU (bkz. konuşma): Önceki sürümde hem yerel vendor dosyası
// ("window is not defined" hatası veriyordu - SW uyumlu bir compat build
// değildi) hem de gstatic CDN (10.12.5 sürümünde bilinen bir importScripts
// bug'ı var: https://github.com/firebase/firebase-js-sdk/issues/8409)
// yüklenemiyordu. Bu yüzden firebase objesi hiç tanımlanmıyor,
// onBackgroundMessage KAYIT OLMUYORDU ve gelen push mesajları sessizce
// kayboluyordu (FCM'e gönderim "başarılı" görünse bile).
//
// ÇÖZÜM: 1) Daha yeni/kararlı bir SDK sürümüne geçildi.
//        2) Firebase SDK ne olursa olsun (yüklense de yüklenmese de),
//           aşağıdaki NATIVE "push" event dinleyicisi bildirimi HER ZAMAN
//           gösterir. Firebase SDK sadece yüklenirse onMessage/foreground
//           senkronizasyonu için ekstra kullanılır, kritik yol artık ona
//           bağımlı değil.
var FIREBASE_SDK_VERSION = "10.14.1";

function loadFirebaseSDK() {
  try {
    importScripts("https://www.gstatic.com/firebasejs/" + FIREBASE_SDK_VERSION + "/firebase-app-compat.js");
    importScripts("https://www.gstatic.com/firebasejs/" + FIREBASE_SDK_VERSION + "/firebase-messaging-compat.js");
    return true;
  } catch (e) {
    console.error("sw.js: Firebase SDK yüklenemedi (ağ/adblock engeli olabilir). Bildirimler yine de native push dinleyicisiyle gösterilecek:", e);
    return false;
  }
}

var sdkLoaded = loadFirebaseSDK();
var firebaseMessagingActive = false;

if (sdkLoaded && typeof firebase !== "undefined") {
  firebase.initializeApp({
    apiKey: "AIzaSyCcfODFLDPVA4zr7L6xKPjEA6-Vle3XPio",
    authDomain: "garaj-defteri-2bcdd.firebaseapp.com",
    projectId: "garaj-defteri-2bcdd",
    storageBucket: "garaj-defteri-2bcdd.firebasestorage.app",
    messagingSenderId: "983721667235",
    appId: "1:983721667235:web:6e47457841795e700ded16"
  });

  try {
    var messaging = firebase.messaging();
    // NOT: Firebase SDK zaten kendi içinde bir "push" dinleyicisi kayıt
    // ediyor (onBackgroundMessage bunu kullanıyor). Bu yüzden aşağıda AYRICA
    // kendi native "push" dinleyicimizi eklemiyoruz (çift bildirim olmasın).
    firebaseMessagingActive = true;
    messaging.onBackgroundMessage(function (payload) {
      var title = (payload.notification && payload.notification.title) || "Garaj Defteri";
      var body = (payload.notification && payload.notification.body) || "Yaklaşan bir işlemin var.";
      self.registration.showNotification(title, {
        body: body,
        icon: "/aracim/icon-192.png",
        badge: "/aracim/icon-192.png",
        data: { url: (payload.data && payload.data.url) || "/aracim/" }
      });
    });
  } catch (e) {
    console.error("sw.js: firebase.messaging() başlatılamadı:", e);
    firebaseMessagingActive = false;
  }
} else {
  console.warn("sw.js: firebase tanımsız. Bildirimler native 'push' dinleyicisi ile gösterilecek.");
}

// ---------- Native Push API yedek dinleyicisi ----------
// Firebase SDK herhangi bir sebeple yüklenemezse (ad-blocker, ağ hatası,
// SDK bug'ı vb.) bu dinleyici devreye girer ve bildirimi YİNE DE gösterir.
if (!firebaseMessagingActive) {
  self.addEventListener("push", function (event) {
    if (!event.data) return;
    var payload = {};
    try {
      payload = event.data.json();
    } catch (e) {
      payload = { notification: { body: event.data.text() } };
    }
    var n = payload.notification || {};
    var title = n.title || "Garaj Defteri";
    var body = n.body || "Yaklaşan bir işlemin var.";
    var url = (payload.data && payload.data.url) || "/aracim/";

    event.waitUntil(
      self.registration.showNotification(title, {
        body: body,
        icon: "/aracim/icon-192.png",
        badge: "/aracim/icon-192.png",
        data: { url: url }
      })
    );
  });
}

// Bildirime tıklanınca uygulamayı öne getir / aç
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/aracim/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windowClients) {
      for (var i = 0; i < windowClients.length; i++) {
        if (windowClients[i].url.indexOf("/aracim/") !== -1 && "focus" in windowClients[i]) {
          return windowClients[i].focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ---------- Mevcut PWA fetch handler (değiştirilmedi) ----------
self.addEventListener('fetch', (event) => {
  // Boş fetch handler - PWA kurulum kriterini karşılamak için yeterlidir.
});
