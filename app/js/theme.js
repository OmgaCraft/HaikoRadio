/* Thème clair / sombre : appliqué tout de suite (avant l'affichage) pour éviter un flash, puis bouton de bascule. */
(function () {
    function read() { try { return localStorage.getItem('theme'); } catch (e) { return null; } }
    function write(v) { try { localStorage.setItem('theme', v); } catch (e) {} }

    var stored = read();
    var theme = (stored === 'light' || stored === 'dark')
        ? stored
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);

    document.addEventListener('DOMContentLoaded', function () {
        document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
                document.documentElement.setAttribute('data-theme', next);
                write(next);
            });
        });
    });
})();
