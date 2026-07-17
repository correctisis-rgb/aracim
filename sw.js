// ---------- Push Bildirimleri ----------
// DEĞİŞİKLİK NOTU (bkz. konuşma): Firebase SDK'sını SW içinde push almak
// için ARTIK KULLANMIYORUZ. Önceki sürümde firebase.messaging() başarıyla
// başlatıldığında (firebaseMessagingActive=true) native "push" dinleyicisi
// KAYIT OLMUYORDU ve gösterim tamamen firebase'in kendi iç
// onBackgroundMessage mekanizmasına bırakılıyordu. Bu mekanizma, gelen
// payload kendi beklediği zarf formatıyla tam eşleşmezse (ör. DevTools'tan
// atılan ham test push'ları, ya da bazı SDK sürümlerinde bilinen
// importScripts/format sorunları: https://github.com/firebase/firebase-js-sdk/issues/8409)
// sessizce hiçbir şey yapmıyordu — ve devreye girecek bir yedek de yoktu.
//
// ÇÖZÜM: FCM web push'u zaten standart Push API üzerinden çalışır; firebase
// SDK olmadan da native "push" event'i her zaman tetiklenir. Bu yüzden
// firebase SDK'yı tamamen kaldırdık ve tek, koşulsuz bir native dinleyici
// kullanıyoruz. Bu hem gerçek FCM mesajlarını hem DevTools test push'larını
// güvenilir şekilde yakalar.
self.addEventListener("push", function (event) {
  var payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (e) {
      payload = { notification: { body: event.data.text() } };
    }
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
