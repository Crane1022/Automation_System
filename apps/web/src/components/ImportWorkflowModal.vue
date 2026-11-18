<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { AlertTriangle, CheckCircle2, FileJson, KeyRound, Upload, XCircle } from '@lucide/vue';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast';
import Modal from '@/components/ui/Modal.vue';

/**
 * Import a workflow from a .json file: a Widebed export or an n8n workflow.
 * Always creates a NEW inactive workflow, then shows what was converted.
 */
const props = defineProps<{ folderId?: string | null }>();
const emit = defineEmits<{ close: []; imported: [] }>();
const router = useRouter();

interface Report {
  source: 'widebed' | 'n8n';
  converted: { name: string; from: string; to: string }[];
  unsupported: { name: string; type: string; reason: string }[];
  warnings: string[];
  needsCredential: string[];
}
const fileName = ref('');
const parsed = ref<unknown>(null);
const parseError = ref<string | null>(null);
const busy = ref(false);
const result = ref<{ workflow: { workflowId: string; name: string }; report: Report } | null>(null);

async function pick(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  parsed.value = null;
  parseError.value = null;
  if (!file) return;
  fileName.value = file.name;
  if (file.size > 1.5 * 1024 * 1024) return (parseError.value = 'File is larger than 1.5 MB');
  try {
    parsed.value = JSON.parse(await file.text());
  } catch {
    parseError.value = 'This is not a valid JSON file';
  }
}

async function upload() {
  busy.value = true;
  try {
    result.value = await api('/workflows/import', { method: 'POST', body: { file: parsed.value, folderId: props.folderId ?? null } });
    emit('imported');
  } catch (err) {
    toastError(err);
  } finally {
    busy.value = false;
  }
}
const short = (t: string) => t.replace('n8n-nodes-base.', '');
</script>

<template>
  <Modal :title="result ? 'Import finished' : 'Import workflow'" width="640px" @close="emit('close')">
    <!-- Step 1: choose a file -->
    <div v-if="!result" class="space-y-4">
      <p class="text-[13px] text-muted">
        Choose a <b>.json</b> file exported from Widebed Automation, or a workflow exported from <b>n8n</b>
        (n8n → workflow menu → <i>Download</i>). A new, inactive workflow is created — nothing is overwritten.
      </p>
      <label class="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-line-strong rounded-lg py-8 cursor-pointer hover:bg-surface-2">
        <FileJson class="size-7 text-subtle" />
        <span class="text-[13px]">{{ fileName || 'Choose a .json file' }}</span>
        <input type="file" accept=".json,application/json" class="hidden" @change="pick" />
      </label>
      <p v-if="parseError" class="text-[13px] text-bad">{{ parseError }}</p>
      <p class="text-[12px] text-subtle">Passwords, API keys and connections are never inside these files. After importing, choose the connections again for Gmail / Firebase nodes.</p>
    </div>

    <!-- Step 2: report -->
    <div v-else class="space-y-4 text-[13px]">
      <div class="flex items-center gap-2 rounded-md bg-ok-soft text-ok p-3">
        <CheckCircle2 class="size-4 shrink-0" />
        <span>Created <b>{{ result.workflow.name }}</b> from a {{ result.report.source === 'n8n' ? 'n8n' : 'Widebed' }} file.</span>
      </div>

      <div v-if="result.report.converted.length">
        <h3 class="section-title mb-1.5">Converted ({{ result.report.converted.length }})</h3>
        <ul class="max-h-36 overflow-auto border border-line rounded-md divide-y divide-line">
          <li v-for="c in result.report.converted" :key="c.name" class="px-3 py-1.5 flex justify-between gap-3">
            <span class="truncate">{{ c.name }}</span><span class="text-subtle shrink-0">{{ short(c.from) }} → {{ c.to }}</span>
          </li>
        </ul>
      </div>

      <div v-if="result.report.unsupported.length">
        <h3 class="section-title mb-1.5 flex items-center gap-1.5 text-bad"><XCircle class="size-4" />Needs replacing ({{ result.report.unsupported.length }})</h3>
        <p class="text-[12px] text-muted mb-1.5">Kept as grey placeholders with their original settings. The workflow cannot be published until they are replaced.</p>
        <ul class="max-h-36 overflow-auto border border-line rounded-md divide-y divide-line">
          <li v-for="u in result.report.unsupported" :key="u.name" class="px-3 py-1.5 flex justify-between gap-3">
            <span class="truncate">{{ u.name }}</span><span class="text-subtle shrink-0">{{ u.reason }}</span>
          </li>
        </ul>
      </div>

      <div v-if="result.report.needsCredential.length">
        <h3 class="section-title mb-1.5 flex items-center gap-1.5"><KeyRound class="size-4" />Choose a connection for</h3>
        <p class="text-muted">{{ result.report.needsCredential.join(', ') }}</p>
      </div>

      <div v-if="result.report.warnings.length">
        <h3 class="section-title mb-1.5 flex items-center gap-1.5 text-warn"><AlertTriangle class="size-4" />Check these ({{ result.report.warnings.length }})</h3>
        <ul class="max-h-44 overflow-auto list-disc pl-5 space-y-1 text-muted text-[12px]">
          <li v-for="(w, i) in result.report.warnings" :key="i">{{ w }}</li>
        </ul>
      </div>
    </div>

    <template #footer>
      <template v-if="!result">
        <button class="btn-secondary" @click="emit('close')">Cancel</button>
        <button class="btn-primary" :disabled="!parsed || busy" @click="upload"><Upload class="size-4" />{{ busy ? 'Importing…' : 'Import' }}</button>
      </template>
      <template v-else>
        <button class="btn-secondary" @click="emit('close')">Close</button>
        <button class="btn-primary" @click="router.push(`/workflows/${result.workflow.workflowId}/edit`)">Open in editor</button>
      </template>
    </template>
  </Modal>
</template>
