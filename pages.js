/* Keeps the document pages in step with the theme chosen in the app.
   Runs before paint (the script tag is in <head>) so there is no flash. */
(function () {
  'use strict';

  function preferred() {
    try {
      var prefs = JSON.parse(localStorage.getItem('prefs.v1') || '{}');
      if (prefs && (prefs.theme === 'dark' || prefs.theme === 'light')) return prefs.theme;
    } catch (e) {
      /* unreadable storage — fall through to the system setting */
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function apply() {
    document.documentElement.setAttribute('data-theme', preferred());
  }

  apply();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', apply);
})();
