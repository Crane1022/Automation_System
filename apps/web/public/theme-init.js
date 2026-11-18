// Applies the saved theme before first paint (kept as a file so CSP can forbid inline scripts).
try {
  var t = localStorage.getItem('wb-theme');
  if (t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches)) document.documentElement.classList.add('dark');
} catch (e) {}
