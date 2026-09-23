// Jump to the section whose (i) was clicked, also when the Help window is
// already open and another section's (i) is clicked.
function goto(hash) {
  const el = document.getElementById(hash);
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  document.querySelectorAll('section.flash').forEach(s => s.classList.remove('flash'));
  el.classList.add('flash');
}
if (location.hash) goto(location.hash.slice(1));
window.usage.onGoto(goto);
