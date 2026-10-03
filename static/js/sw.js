self.addEventListener('push', function (event) {
    let payload = { title: 'LockScribe Reminder', body: 'Reminder for your encrypted note!' };
    if (event.data) {
        try {
            payload = event.data.json();
        } catch (e) {
            payload.body = event.data.text();
        }
    }
    const options = {
        body: payload.body,
        icon: '/static/icons/icon-192.png',
        vibrate: [200, 100, 200]
    };
    event.waitUntil(self.registration.showNotification(payload.title, options));
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();
    event.waitUntil(clients.openWindow('/'));
});