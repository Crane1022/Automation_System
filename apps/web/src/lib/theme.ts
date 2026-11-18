import { ref } from 'vue';

const isDark = ref(document.documentElement.classList.contains('dark'));

export function useTheme() {
  function toggle() {
    isDark.value = !isDark.value;
    document.documentElement.classList.toggle('dark', isDark.value);
    try {
      localStorage.setItem('wb-theme', isDark.value ? 'dark' : 'light');
    } catch {
      /* storage unavailable */
    }
  }
  return { isDark, toggle };
}
