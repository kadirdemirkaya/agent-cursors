(function () {
  var radios = document.querySelectorAll('input[name="m"]');
  function set(v) { for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === v; }
  chrome.storage.sync.get({ mode: 'group' }, function (r) { set(r.mode); });
  for (var i = 0; i < radios.length; i++) {
    radios[i].addEventListener('change', function (e) { chrome.storage.sync.set({ mode: e.target.value }); });
  }
})();
