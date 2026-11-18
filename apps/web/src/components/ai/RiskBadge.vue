<script setup lang="ts">
import { computed } from 'vue';
import { Eye, ShieldAlert, ShieldCheck, ShieldQuestion } from '@lucide/vue';
import { RISK_LEVELS, type RiskLevel } from '@widebed/shared';

/** Risk level 1–4 with an icon and words (never colour alone). */
const props = defineProps<{ level: RiskLevel }>();
const look = computed(
  () =>
    ({
      1: { icon: Eye, cls: 'bg-surface-2 text-muted' },
      2: { icon: ShieldCheck, cls: 'bg-info-soft text-info' },
      3: { icon: ShieldQuestion, cls: 'bg-warn-soft text-warn' },
      4: { icon: ShieldAlert, cls: 'bg-bad-soft text-bad' },
    })[props.level],
);
</script>

<template>
  <span class="inline-flex items-center gap-1 h-5 px-2 rounded-full text-[11px] font-medium" :class="look.cls" :title="RISK_LEVELS[level].explain">
    <component :is="look.icon" class="size-3" />L{{ level }} · {{ RISK_LEVELS[level].short }}
  </span>
</template>
