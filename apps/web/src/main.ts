import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './style.css';
import { installClickTracking, track } from './lib/loading';

installClickTracking();
// Page loads count as loading too (the top bar shows while a page's code downloads).
let endNav: (() => void) | null = null;
router.beforeEach(() => {
  endNav?.();
  endNav = track();
});
router.afterEach(() => {
  endNav?.();
  endNav = null;
});
router.onError(() => {
  endNav?.();
  endNav = null;
});

createApp(App).use(createPinia()).use(router).mount('#app');
