// ---------- Firebase Cloud Messaging (Push Bildirimleri) ----------
importScripts("https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyCcfODFLDPVA4zr7L6xKPjEA6-Vle3XPio",
  authDomain: "garaj-defteri-2bcdd.firebaseapp.com",
  projectId: "garaj-defteri-2bcdd",
  storageBucket: "garaj-defteri-2bcdd.firebasestorage.app",
  messagingSenderId: "983721667235",
  appId: "1:983721667235:web:6e47457841795e700ded16"
});

var messaging = firebase.messaging();

// Uygulama kapalıyken veya arka plandayken gelen bildirimleri yakalar
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
