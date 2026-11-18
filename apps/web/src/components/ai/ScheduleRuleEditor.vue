<script setup lang="ts">
import { computed } from 'vue';
import { describeSchedule, SCHEDULE_MODE_OPTIONS, WEEKDAY_OPTIONS, type AgentScheduleRule } from '@widebed/shared';

/** When an AI employee should do its work: simple choices, shown back in plain words. */
const rule = defineModel<AgentScheduleRule>({ required: true });

const ZONES = ['Asia/Kuala_Lumpur', 'Asia/Singapore', 'Asia/Jakarta', 'Asia/Bangkok', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Australia/Sydney', 'Europe/London', 'UTC'];
const DAYS = [...Array.from({ length: 28 }, (_, i) => String(i + 1)), 'L'];
const modes = SCHEDULE_MODE_OPTIONS.filter((m) => m.value !== 'cron');
const summary = computed(() => describeSchedule(rule.value));
function toggleDay(v: string) {
  const list = rule.value.weekdays ?? [];
  rule.value.weekdays = list.includes(v) ? list.filter((d) => d !== v) : [...list, v];
}
</script>

<template>
  <div class="space-y-3">
    <div class="grid sm:grid-cols-2 gap-3">
      <div>
        <label class="label">How often</label>
        <select v-model="rule.mode" class="input">
          <option v-for="m in modes" :key="m.value" :value="m.value">{{ m.label }}</option>
        </select>
      </div>
      <div v-if="rule.mode !== 'interval'">
        <label class="label">Time</label>
        <input v-model="rule.time" type="time" class="input" required />
      </div>
      <div v-else class="flex gap-2">
        <div class="w-[90px]"><label class="label">Every</label><input v-model.number="rule.every" type="number" min="1" class="input" /></div>
        <div class="flex-1">
          <label class="label">&nbsp;</label>
          <select v-model="rule.unit" class="input"><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select>
        </div>
      </div>
    </div>

    <div v-if="rule.mode === 'once'">
      <label class="label">Date</label>
      <input v-model="rule.date" type="date" class="input w-auto" />
    </div>
    <div v-if="rule.mode === 'weekly'">
      <label class="label">On these days</label>
      <div class="flex flex-wrap gap-1.5">
        <button
          v-for="d in WEEKDAY_OPTIONS"
          :key="d.value"
          type="button"
          class="h-8 min-w-[44px] px-2 rounded-md border text-[12.5px] font-medium transition-colors"
          :class="rule.weekdays?.includes(d.value) ? 'bg-brand text-white border-brand' : 'border-line-strong hover:border-brand'"
          @click="toggleDay(d.value)"
        >
          {{ d.label }}
        </button>
      </div>
    </div>
    <div v-if="rule.mode === 'monthly'">
      <label class="label">Day of the month</label>
      <select v-model="rule.dayOfMonth" class="input w-auto">
        <option v-for="d in DAYS" :key="d" :value="d">{{ d === 'L' ? 'Last day' : d }}</option>
      </select>
    </div>
    <div>
      <label class="label">Time zone</label>
      <select v-model="rule.timezone" class="input w-auto">
        <option v-for="z in ZONES" :key="z" :value="z">{{ z === 'Asia/Kuala_Lumpur' ? 'Malaysia (Kuala Lumpur)' : z }}</option>
      </select>
    </div>
    <p class="text-[12.5px] rounded-md bg-info-soft text-info px-3 py-2">{{ summary }}<template v-if="rule.timezone !== 'Asia/Kuala_Lumpur'"> ({{ rule.timezone }})</template></p>
  </div>
</template>
