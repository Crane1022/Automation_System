<script setup lang="ts">
import { computed, ref } from 'vue';
import { CircleCheck, CircleX, Table2, BarChart3 } from '@lucide/vue';
import type { DailyRunStats } from '@widebed/shared';

/**
 * Runs per day as stacked bars: successful at the bottom, failed on top (with a
 * hatch pattern so it doesn't rely on red vs green alone), other states in grey.
 * Hover a day for exact numbers; "Show numbers" switches to a table.
 */
const props = defineProps<{ days: DailyRunStats[]; title?: string }>();

const W = 640;
const H = 200;
const pad = { top: 12, right: 8, bottom: 26, left: 32 };
const plotW = W - pad.left - pad.right;
const plotH = H - pad.top - pad.bottom;

const asTable = ref(false);
const hover = ref<number | null>(null);

const total = (d: DailyRunStats) => d.success + d.failed + d.other;
const max = computed(() => Math.max(1, ...props.days.map(total)));
/** Round numbers for the axis: a step of 1, 2 or 5 × 10^n with at most 5 gridlines. */
const step = computed(() => {
  const raw = max.value / 4;
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  return [1, 2, 5, 10].map((k) => k * p).find((v) => v >= raw) ?? p * 10;
});
const top = computed(() => Math.max(step.value, Math.ceil(max.value / step.value) * step.value));
const ticks = computed(() => {
  const out: number[] = [];
  for (let v = 0; v <= top.value; v += step.value) out.push(v);
  return out;
});
const y = (v: number) => pad.top + plotH - (v / top.value) * plotH;

const slot = computed(() => plotW / Math.max(1, props.days.length));
const barW = computed(() => Math.max(4, Math.min(28, slot.value * 0.6)));

/** Path for a rectangle with only the top corners rounded. */
function topRounded(x: number, y0: number, w: number, h: number, r: number) {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y0 + h}V${y0 + rr}Q${x},${y0} ${x + rr},${y0}H${x + w - rr}Q${x + w},${y0} ${x + w},${y0 + rr}V${y0 + h}Z`;
}

const GAP = 2;
const bars = computed(() =>
  props.days.map((d, i) => {
    const x = pad.left + i * slot.value + (slot.value - barW.value) / 2;
    const parts = [
      { key: 'success', v: d.success },
      { key: 'failed', v: d.failed },
      { key: 'other', v: d.other },
    ].filter((p) => p.v > 0);
    let acc = 0;
    const segs = parts.map((p, idx) => {
      const y1 = y(acc);
      acc += p.v;
      const y0 = y(acc);
      const isTop = idx === parts.length - 1;
      // Leave a 2px gap below every segment except the first, so stacked parts stay distinct.
      const h = Math.max(1, y1 - y0 - (idx > 0 ? GAP : 0));
      return { key: p.key, d: isTop ? topRounded(x, y0, barW.value, h, 4) : `M${x},${y0}h${barW.value}v${h}h${-barW.value}Z` };
    });
    return { i, x, segs, d };
  }),
);

const dayLabel = (iso: string, long = false) => {
  const dt = new Date(`${iso}T12:00:00`);
  return long
    ? dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })
    : dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
/** Label every day when there's room, otherwise every 2nd/3rd day (always including the last). */
const labelEvery = computed(() => (props.days.length <= 8 ? 1 : props.days.length <= 16 ? 2 : 4));
const showLabel = (i: number) => (props.days.length - 1 - i) % labelEvery.value === 0;

const totals = computed(() => props.days.reduce((s, d) => ({ success: s.success + d.success, failed: s.failed + d.failed }), { success: 0, failed: 0 }));
const hovered = computed(() => (hover.value === null ? null : props.days[hover.value]));
const tipLeft = computed(() => (hover.value === null ? 0 : ((pad.left + (hover.value + 0.5) * slot.value) / W) * 100));
</script>

<template>
  <div class="card p-4">
    <div class="flex items-start justify-between gap-3 mb-3">
      <div>
        <h2 class="section-title">{{ title ?? 'Runs per day' }}</h2>
        <p class="text-[12px] text-subtle">Last {{ days.length }} days · {{ totals.success.toLocaleString() }} successful, {{ totals.failed.toLocaleString() }} failed</p>
      </div>
      <div class="flex items-center gap-3">
        <div class="hidden sm:flex items-center gap-3 text-[12px] text-muted" aria-hidden="true">
          <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-[3px] bg-ok" />Successful</span>
          <span class="inline-flex items-center gap-1.5">
            <svg width="10" height="10" class="rounded-[3px] overflow-hidden"><rect width="10" height="10" fill="url(#wb-hatch)" /></svg>Failed
          </span>
          <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-[3px] bg-line-strong" />Other</span>
        </div>
        <button class="btn-ghost h-7 text-[12px]" data-no-loading @click="asTable = !asTable">
          <component :is="asTable ? BarChart3 : Table2" class="size-3.5" />{{ asTable ? 'Show chart' : 'Show numbers' }}
        </button>
      </div>
    </div>

    <!-- Hatch pattern for "failed" (shared by the legend and the bars). -->
    <svg width="0" height="0" class="absolute" aria-hidden="true">
      <defs>
        <pattern id="wb-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" fill="var(--color-bad)" />
          <rect width="1.6" height="5" fill="var(--color-surface)" fill-opacity="0.45" />
        </pattern>
      </defs>
    </svg>

    <div v-if="!asTable" class="relative" @mouseleave="hover = null">
      <svg :viewBox="`0 0 ${W} ${H}`" class="w-full h-auto block" role="img" :aria-label="`${title ?? 'Runs per day'} for the last ${days.length} days`">
        <!-- Grid + y axis -->
        <g>
          <template v-for="t in ticks" :key="t">
            <line :x1="pad.left" :x2="W - pad.right" :y1="y(t)" :y2="y(t)" stroke="var(--color-line)" :stroke-width="t === 0 ? 1 : 0.6" />
            <text :x="pad.left - 6" :y="y(t) + 3.5" text-anchor="end" class="fill-subtle" font-size="10">{{ t }}</text>
          </template>
        </g>
        <!-- Bars -->
        <g v-for="b in bars" :key="b.d.date" :opacity="hover === null || hover === b.i ? 1 : 0.45" class="transition-opacity duration-150">
          <path
            v-for="s in b.segs"
            :key="s.key"
            :d="s.d"
            :fill="s.key === 'success' ? 'var(--color-ok)' : s.key === 'failed' ? 'url(#wb-hatch)' : 'var(--color-line-strong)'"
          />
          <text v-if="showLabel(b.i)" :x="b.x + barW / 2" :y="H - 8" text-anchor="middle" class="fill-subtle" font-size="10">{{ dayLabel(b.d.date) }}</text>
        </g>
        <!-- Hover targets: the whole column, wider than the bar. -->
        <rect
          v-for="b in bars"
          :key="`hit-${b.d.date}`"
          :x="pad.left + b.i * slot"
          :y="pad.top"
          :width="slot"
          :height="plotH"
          fill="transparent"
          @mouseenter="hover = b.i"
        />
      </svg>
      <div
        v-if="hovered"
        class="pointer-events-none absolute top-0 z-10 -translate-x-1/2 card shadow-[var(--shadow-pop)] px-3 py-2 text-[12px] min-w-[150px]"
        :style="{ left: `${Math.min(88, Math.max(12, tipLeft))}%` }"
      >
        <div class="font-medium text-ink mb-1">{{ dayLabel(hovered.date, true) }}</div>
        <div class="flex items-center justify-between gap-4"><span class="inline-flex items-center gap-1.5 text-muted"><CircleCheck class="size-3.5 text-ok" />Successful</span><span class="tabular-nums">{{ hovered.success }}</span></div>
        <div class="flex items-center justify-between gap-4"><span class="inline-flex items-center gap-1.5 text-muted"><CircleX class="size-3.5 text-bad" />Failed</span><span class="tabular-nums">{{ hovered.failed }}</span></div>
        <div v-if="hovered.other" class="flex items-center justify-between gap-4"><span class="text-muted pl-5">Other</span><span class="tabular-nums">{{ hovered.other }}</span></div>
      </div>
      <p v-if="max <= 1 && !days.some((d) => total(d))" class="absolute inset-0 grid place-items-center text-[13px] text-subtle pointer-events-none">No runs in these days yet</p>
    </div>

    <table v-else class="w-full text-[13px]">
      <thead>
        <tr><th class="table-head">Day</th><th class="table-head text-right">Successful</th><th class="table-head text-right">Failed</th><th class="table-head text-right">Other</th></tr>
      </thead>
      <tbody>
        <tr v-for="d in [...days].reverse()" :key="d.date">
          <td class="table-cell">{{ dayLabel(d.date, true) }}</td>
          <td class="table-cell text-right tabular-nums">{{ d.success }}</td>
          <td class="table-cell text-right tabular-nums" :class="d.failed ? 'text-bad font-medium' : ''">{{ d.failed }}</td>
          <td class="table-cell text-right tabular-nums text-muted">{{ d.other }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
