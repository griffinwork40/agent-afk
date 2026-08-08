/**
 * Small-screen sidebar toggle — pure chrome, no dependency on the bundle's
 * state.
 *
 * Invariant: this lives in a FILE rather than an inline `<script>` because the
 * document is served under `script-src 'self'`, which blocks inline script
 * execution outright. It was inline until the CSP landed; leaving it there
 * would have silently dead-ended the menu button on narrow viewports.
 */

const btn = document.getElementById('menu-toggle');
btn?.addEventListener('click', () => {
  document.getElementById('sidebar')?.classList.toggle('is-open');
});
