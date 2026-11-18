<script setup lang="ts">
import { useAuthStore } from '@/stores/auth';
import ToastHost from '@/components/ui/ToastHost.vue';
import TopProgress from '@/components/ui/TopProgress.vue';

const auth = useAuthStore();
</script>

<template>
  <TopProgress />
  <Transition name="page" mode="out-in">
    <!-- Starting up: the logo breathes while sign-in is checked -->
    <div v-if="!auth.ready" key="boot" class="h-full grid place-items-center">
      <div class="flex flex-col items-center gap-3">
        <img src="/favicon.svg" alt="" class="size-10 animate-pulse" />
        <span class="dots text-subtle" aria-label="Loading"><span /><span /><span /></span>
      </div>
    </div>
    <!-- RouterView sits inside a wrapper and owns its own Transition (Vue Router's rule). -->
    <div v-else key="app" class="h-full">
      <RouterView v-slot="{ Component, route }">
        <Transition name="page" mode="out-in">
          <component :is="Component" :key="route.matched[0]?.path" />
        </Transition>
      </RouterView>
    </div>
  </Transition>
  <ToastHost />
</template>
