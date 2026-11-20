(function () {
  // Check-in: capture location before submit (geofence check happens on the server).
  var form = document.getElementById('checkin-form');
  if (form) {
    var status = document.getElementById('geo-status');
    var btn = document.getElementById('checkin-btn');
    var got = false;
    function set(pos) {
      form.lat.value = pos.coords.latitude;
      form.lng.value = pos.coords.longitude;
      form.accuracy.value = Math.round(pos.coords.accuracy || 0);
      got = true;
      status.textContent = 'Location confirmed.';
    }
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(set, function () {
        status.textContent = 'Location is off. You can still check in, but the receiver will need to approve you.';
      }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    } else {
      status.textContent = 'This phone cannot share location. The receiver will approve you.';
    }
    form.addEventListener('submit', function (e) {
      btn.disabled = true;
      btn.textContent = 'Checking in…';
      if (!got && navigator.geolocation) {
        e.preventDefault();
        var done = false;
        var finish = function () { if (!done) { done = true; form.submit(); } };
        navigator.geolocation.getCurrentPosition(function (p) { set(p); finish(); }, finish, { enableHighAccuracy: true, timeout: 6000 });
        setTimeout(finish, 7000);
      }
    });
  }

  // Print buttons (no inline scripts under the CSP).
  document.querySelectorAll('[data-print]').forEach(function (b) {
    b.addEventListener('click', function () { window.print(); });
  });

  // Prevent double submits on every form.
  document.querySelectorAll('form').forEach(function (f) {
    if (f.id === 'checkin-form') return;
    f.addEventListener('submit', function () {
      setTimeout(function () { f.querySelectorAll('button').forEach(function (b) { b.disabled = true; }); }, 0);
    });
  });

  // Store dashboard auto-refresh, paused while someone is typing or has a panel open.
  var secs = Number(document.body.getAttribute('data-autorefresh'));
  if (secs) {
    var last = Date.now();
    ['keydown', 'input', 'focusin'].forEach(function (ev) { document.addEventListener(ev, function () { last = Date.now(); }); });
    setInterval(function () {
      var a = document.activeElement;
      var typing = a && /INPUT|TEXTAREA|SELECT/.test(a.tagName);
      var open = document.querySelector('main details[open]');
      if (!typing && !open && Date.now() - last > 10000) window.location.reload();
    }, secs * 1000);
  }
})();
